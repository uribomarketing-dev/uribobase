/**
 * LINE Webhook（06 Step3 / 03_LINE会話仕様.md F1・F3・F5）
 *
 * doPost(e) が LINE からのイベントを受け取り、
 *   follow    → 名前確認クイックリプライ（F1）
 *   postback  → 回答受付（F3）・名前紐付け
 *   message   → 追記の受付、手動コマンド（F5：状況/テスト実行/ヘルプ/報告）
 * を処理する。
 *
 * 【検証方式についての注意（重要）】
 * Google Apps Script のウェブアプリは HTTP リクエストヘッダーを取得できないため、
 * X-Line-Signature ヘッダーによる署名検証を GAS 単体で行うことは技術的にできない。
 * そのため本実装では次の三段構えで正当性を担保する：
 *   (1) Webhook URL に秘密のクエリキーを付与し（?k=＜WEBHOOK_SECRET＞）、一致しないリクエストは破棄する。
 *       WEBHOOK_SECRET が未設定のときは「全部拒否」する（設定漏れが認証無効化にならないようにするため）
 *   (2) 署名検証関数 validateSignature_() は実装済みで、署名を渡せる経路（将来リバースプロキシを
 *       挟む場合など）ではそのまま利用できる。クエリ sig で署名が渡された場合は検証する
 *   (3) スタッフの紐付けは「管理者が個別に伝えた登録コード」を送ってもらう方式。
 *       友だち追加しただけの第三者が、名前を選ぶだけでスタッフになりすますことはできない
 * さらに、S1で有効=TRUEかつ紐付け済みのユーザー以外は操作を受け付けない。
 * この制約と対策は docs/デプロイ手順.md にも記載してある。
 */

/**
 * LINEからのWebhookを受け取る。
 * @param {Object} e リクエストイベント
 * @return {TextOutput} 応答（LINEは本文を見ないので固定文字列）
 */
function doPost(e) {
  var proc = 'doPost';
  try {
    if (!verifyRequest_(e)) {
      logWarn(proc, '不正なリクエストを破棄しました');
      return ContentService.createTextOutput('NG');
    }
    var body = JSON.parse(e.postData.contents);

    // SwitchBotのWebhook（機器の変化通知）
    if (!body.events && body.eventType && body.context) {
      var m = safely_(proc, function () { return ingestSwitchbotWebhook_(body); }, 0);
      return ContentService.createTextOutput('OK:' + m);
    }

    // 既存アプリからの「取り込み済み」通知
    if (!body.events && String(body.action || '') === 'markImported') {
      var marked = safely_(proc, function () { return markImported_(body); }, 0);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, marked: marked }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // LINE以外からの投入も同じ入口で受ける（送信元を本文の形で見分ける）
    if (!body.events && (body.observations || body.source)) {
      var n = ingestObservations_(body);
      return ContentService.createTextOutput('OK:' + n);
    }

    var events = body.events || [];
    events.forEach(function (ev) {
      safely_(proc, function () { handleEvent_(ev); });
    });
  } catch (err) {
    logError(proc, err, e && e.postData ? String(e.postData.contents).substring(0, 500) : '');
  }
  return ContentService.createTextOutput('OK');
}

/**
 * 外部からの観察データ（AIハブ／OpenClaw・他のアプリ）をS4に取り込む。
 *
 * 期待する本文（映像・画像は受け取らない。言葉だけ）：
 *   {
 *     "source": "openclaw",
 *     "observations": [
 *       { "date": "2026-08-11", "target": "SMZ01", "item": "食事提供", "value": "夕食を配膳（キッチンカメラ 18:05）" }
 *     ]
 *   }
 * target を "ALL" にすると、その拠点の有効な利用者全員に展開される。
 * 取り込んだ内容は翌朝の自動充足で「推定（要精査）」として記録に反映される。
 * @param {Object} body リクエスト本文
 * @return {number} 取り込んだ件数
 */
function ingestObservations_(body) {
  var proc = 'ingestObservations_';
  var source = String(body.source || 'external').substring(0, 40);
  var list = body.observations || [];
  if (!list.length && body.item) list = [body];   // 1件だけの簡易形式も受ける

  return withLock_(proc, 60000, function () {
    var n = 0;
    list.forEach(function (o) {
      safely_(proc, function () {
        var item = String(o.item || o['項目名'] || '').trim();
        var value = String(o.value || o['値'] || '').trim();
        if (!item || !value) return;
        appendRow(SHEETS.LOG_IMPORT, {
          'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
          '発生日': toDateStr_(o.date || o['発生日'] || todayStr_()),
          '対象種別': 'raw_' + (source === 'openclaw' ? 'openclaw' : source),
          '対象': String(o.target || o['対象'] || 'ALL'),
          '項目名': item,
          '値': truncate_(value, 300),
          '取込元': source,
          '取込日時': nowStr_()
        });
        n++;
      });
    });
    logInfo(proc, source + ' から ' + n + '件を取り込みました');
    return n;
  }, function () {
    logWarn(proc, 'ロックが取れなかったため取り込みを見送りました（送信側で再送してください）');
    return 0;
  });
}

/**
 * 動作確認用のGET応答（Webhook URLをブラウザで開いたときの表示）。
 * @param {Object} e リクエストイベント
 * @return {TextOutput} 応答
 */
function doGet(e) {
  // 既存アプリからの読み取り要求（?mode=... 付き）はAPIとして扱う
  if (e && e.parameter && e.parameter.mode) return handleApiGet_(e);
  return ContentService.createTextOutput('AI Uribo is running. ' + nowStr_());
}

/**
 * リクエストの正当性を確認する。
 * @param {Object} e リクエストイベント
 * @return {boolean} 正当ならtrue
 */
function verifyRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) return false;
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(PROP.WEBHOOK_KEY);
  // 未設定なら受け付けない（設定漏れがそのまま認証無効化にならないようにする）
  if (!key) {
    logError('verifyRequest_', 'WEBHOOK_SECRET が未設定のためリクエストを拒否しました。'
      + 'スクリプトプロパティに設定してください');
    return false;
  }
  if (!e.parameter || String(e.parameter.k) !== String(key)) return false;
  // 署名が渡せる経路の場合は署名も検証する
  if (e.parameter && e.parameter.sig) {
    if (!validateSignature_(e.postData.contents, e.parameter.sig)) return false;
  }
  return true;
}

/**
 * LINEの署名（X-Line-Signature）を検証する。
 * ※GASウェブアプリはヘッダーを取得できないため通常は呼ばれない。将来の経路変更に備えた実装。
 * @param {string} bodyText リクエストボディ
 * @param {string} signature 署名（Base64）
 * @return {boolean} 一致すればtrue
 */
function validateSignature_(bodyText, signature) {
  var secret = PropertiesService.getScriptProperties().getProperty(PROP.SECRET);
  if (!secret) {
    logWarn('validateSignature_', 'LINE_CHANNEL_SECRET が未設定です');
    return false;
  }
  var mac = Utilities.computeHmacSha256Signature(bodyText, secret);
  var expected = Utilities.base64Encode(mac);
  return expected === String(signature);
}

/**
 * 1イベントを処理する。
 * @param {Object} ev LINEイベント
 * @return {void}
 */
function handleEvent_(ev) {
  var cache = CacheService.getScriptCache();
  var key = ev.webhookEventId ? ('ev_' + ev.webhookEventId) : '';

  // 処理済み・処理中のイベントは無視する（LINEは同じイベントを再送することがある）
  if (key) {
    var state = cache.get(key);
    if (state) {
      logInfo('handleEvent_', '重複イベントを無視（' + state + '）: ' + ev.webhookEventId);
      return;
    }
    cache.put(key, 'processing', 21600); // 6時間
  }

  var userId = (ev.source && ev.source.userId) ? ev.source.userId : '';
  try {
    switch (ev.type) {
      case 'follow': onFollow_(userId, ev.replyToken); break;
      case 'unfollow': logInfo('unfollow', userId); break;
      case 'postback': onPostback_(userId, ev.postback.data, ev.replyToken); break;
      case 'message':
        if (ev.message && ev.message.type === 'text') onText_(userId, String(ev.message.text).trim(), ev.replyToken);
        else if (ev.replyToken) replyRaw_(ev.replyToken, [msgText_('ボタンでお答えください。困ったら「ヘルプ」と送ってください。')]);
        break;
      default: logInfo('handleEvent_', '未対応イベント: ' + ev.type);
    }
    if (key) cache.put(key, 'done', 21600);
  } catch (err) {
    // 途中で落ちた場合は印を消し、LINEの再送で処理し直せるようにする（回答の取りこぼし防止）
    if (key) cache.remove(key);
    throw err;
  }
}

/**
 * 友だち追加時の処理（F1）。
 * @param {string} userId LINEユーザーID
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function onFollow_(userId, replyToken) {
  var proc = 'onFollow_';
  var known = staffByLineId_(userId);
  if (known) {
    var msg = isTrue_(known['有効'])
      ? known['氏名'] + 'さん、おかえりなさい。AI Uriboです。\n困ったら「ヘルプ」と送ってください。'
      : 'AI Uriboです。現在このアカウントは利用停止中です。管理者にご連絡ください。';
    replyRaw_(replyToken, [msgText_(msg)]);
    return;
  }
  // スタッフ名の一覧は出さない（第三者が名前を選ぶだけで登録できてしまうため）。
  // 管理者が本人にだけ伝えた登録コードを送ってもらう方式にする。
  replyRaw_(replyToken, [msgText_(
    'AI Uriboです。Uriboの記録の抜けを見つけて、皆さんに確認する係です。\n\n'
    + 'ご利用には登録が必要です。管理者からお伝えした「登録コード」（英数字8文字）をそのまま送ってください。\n'
    + 'お持ちでない場合は管理者にご連絡ください。')]);
  logInfo(proc, '未登録ユーザーが友だち追加: ' + userId);
}

/**
 * 登録コードによるスタッフ紐付けを試みる。
 * @param {string} userId LINEユーザーID
 * @param {string} text 受信テキスト（登録コードの候補）
 * @param {string} replyToken 返信トークン
 * @return {boolean} 登録処理として扱ったらtrue
 */
function tryRegisterByCode_(userId, text, replyToken) {
  var proc = 'tryRegisterByCode_';
  var code = String(text).trim().toUpperCase().replace(/[\s-]/g, '');
  if (!new RegExp('^[' + REGISTRATION_CODE_CHARS + ']{' + REGISTRATION_CODE_LENGTH + '}$').test(code)) {
    return false;   // 登録コードの形をしていないので、通常のメッセージとして扱う
  }

  // 総当たりを防ぐため、1時間あたりの試行回数を制限する
  var cache = CacheService.getScriptCache();
  var attemptKey = 'reg_' + userId;
  var attempts = Number(cache.get(attemptKey) || 0) + 1;
  cache.put(attemptKey, String(attempts), 3600);
  if (attempts > getSettingNum('register_attempt_limit', 10)) {
    logWarn(proc, '登録コードの試行回数超過: ' + userId);
    replyRaw_(replyToken, [msgText_('登録の試行回数が上限に達しました。しばらく待ってから、管理者にご連絡ください。')]);
    return true;
  }

  return withLock_(proc, 20000, function () {
    var staff = findRow(SHEETS.STAFF, function (r) {
      return String(r['登録コード'] || '').trim().toUpperCase() === code;
    });
    if (!staff) {
      logWarn(proc, '登録コード不一致: ' + userId);
      replyRaw_(replyToken, [msgText_('登録コードが確認できませんでした。管理者にご確認ください。')]);
      return true;
    }
    if (!isTrue_(staff['有効'])) {
      logWarn(proc, '無効なスタッフの登録コードが使われました: ' + staff['staff_id']);
      replyRaw_(replyToken, [msgText_('このコードは現在ご利用いただけません。管理者にご連絡ください。')]);
      return true;
    }
    if (String(staff['line_user_id'] || '').trim()) {
      // 既存の紐付けは絶対に自動で上書きしない（乗っ取り防止）
      logWarn(proc, staff['staff_id'] + ' は既に別のLINEと紐付いています');
      replyRaw_(replyToken, [msgText_('このスタッフ情報は登録済みです。付け替えが必要な場合は管理者にご連絡ください。')]);
      return true;
    }

    // 紐付けたらコードは使い捨てにする（同じコードで2人目が登録できないように）
    updateRow(SHEETS.STAFF, staff._row, { 'line_user_id': userId, '登録コード': '' });
    replyRaw_(replyToken, [msgText_(staff['氏名'] + 'さんですね。登録しました。\n'
      + 'これから記録の確認をお送りします。困ったら「ヘルプ」と送ってください。')]);
    logInfo(proc, staff['氏名'] + ' を登録しました');
    return true;
  }, function () {
    replyRaw_(replyToken, [msgText_('ただいま混み合っています。少し待ってからもう一度お送りください。')]);
    return true;
  });
}

/**
 * postback（ボタンタップ）の処理。
 * @param {string} userId LINEユーザーID
 * @param {string} data postbackデータ
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function onPostback_(userId, data, replyToken) {
  var proc = 'onPostback_';
  var parts = String(data).split('|');
  withLock_(proc, 20000, function () {
    try {
      var staff = activeStaffByLineId_(userId, replyToken);
      if (!staff) return;
      if (parts[0] === 'ans') {
        handleAnswer_(staff, parts[1], parts.slice(2).join('|'), replyToken);
        return;
      }
      if (parts[0] === 'alert') {
        handleAlertFeedback_(staff, parts[1], parts.slice(2).join('|'), replyToken);
        return;
      }
      logWarn(proc, '未対応のpostback: ' + data);
      replyRaw_(replyToken, [msgText_('うまく受け取れませんでした。もう一度ボタンを押してみてください。')]);
    } catch (e) {
      logError(proc, e, data);
      replyRaw_(replyToken, [msgText_('申し訳ありません、処理中に問題が起きました。担当者に記録しました。')]);
    }
  }, function () {
    // ロックを取れないまま処理を続けると二重記録の原因になるため、必ず中断して案内する
    replyRaw_(replyToken, [msgText_('ただいま処理が混み合っています。少し待ってからもう一度お試しください。')]);
  });
}

/**
 * AIの読み取り通知に対する判定（事実／誤検知／判断できない）を記録する。
 * カメラのAIが書く文章は誤りが多いため、人の判定を貯めて精度を測り、
 * 検出キーワードの調整に使う。
 * @param {Object} staff 判定したスタッフのS1行
 * @param {string} judge ok / ng / unknown
 * @param {string} key 対象日|該当語|対象
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function handleAlertFeedback_(staff, judge, key, replyToken) {
  var label = { ok: '事実だった', ng: '誤検知', unknown: '判断できない' }[judge] || judge;
  writeLog('alertFeedback', 'AI判定', JSON.stringify({
    判定: label, キー: key, 判定者: String(staff['staff_id'])
  }));
  var msg = (judge === 'ng')
    ? 'ありがとうございます。誤検知として記録しました。\n同じような誤りが続く場合は、S8設定の alert_keywords から語を外せます。'
    : 'ありがとうございます。記録しました。';
  replyRaw_(replyToken, [msgText_(msg)]);
}

/**
 * 紐付け済みかつ有効なスタッフを取得する。該当しない場合は案内を返してnullを返す。
 * @param {string} userId LINEユーザーID
 * @param {string} replyToken 返信トークン
 * @return {Object|null} S1の行オブジェクト
 */
function activeStaffByLineId_(userId, replyToken) {
  var staff = staffByLineId_(userId);
  if (!staff) {
    replyRaw_(replyToken, [msgText_('恐れ入りますが、登録がお済みでないようです。'
      + '管理者からお伝えした登録コードを送ってください。')]);
    return null;
  }
  if (!isTrue_(staff['有効'])) {
    logWarn('activeStaffByLineId_', '無効なスタッフからの操作: ' + staff['staff_id']);
    replyRaw_(replyToken, [msgText_('現在このアカウントは利用停止中です。管理者にご連絡ください。')]);
    return null;
  }
  return staff;
}

/**
 * テキストメッセージの処理（追記の受付・手動コマンド）。
 * @param {string} userId LINEユーザーID
 * @param {string} text 本文
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function onText_(userId, text, replyToken) {
  var proc = 'onText_';

  // 未登録ユーザーからのメッセージは、登録コードとしてのみ受け付ける
  if (!staffByLineId_(userId)) {
    if (tryRegisterByCode_(userId, text, replyToken)) return;
    replyRaw_(replyToken, [msgText_('AI Uriboです。ご利用には登録が必要です。'
      + '管理者からお伝えした登録コード（英数字8文字）を送ってください。')]);
    return;
  }

  withLock_(proc, 20000, function () {
    var staff = activeStaffByLineId_(userId, replyToken);
    if (!staff) return;
    onTextBody_(staff, userId, text, replyToken, proc);
  }, function () {
    replyRaw_(replyToken, [msgText_('ただいま処理が混み合っています。少し待ってからもう一度お試しください。')]);
  });
}

/**
 * テキストメッセージ本体の処理（ロック取得済みの状態で呼ばれる）。
 * @param {Object} staff スタッフのS1行
 * @param {string} userId LINEユーザーID
 * @param {string} text 本文
 * @param {string} replyToken 返信トークン
 * @param {string} proc ログ用の処理名
 * @return {void}
 */
function onTextBody_(staff, userId, text, replyToken, proc) {
  try {
    // 「報告」コマンドの本文待ち
    var cache = CacheService.getScriptCache();
    if (cache.get('report_' + userId)) {
      cache.remove('report_' + userId);
      saveReport_(staff, text, replyToken);
      return;
    }
    // 「まとめ」コマンドの本文待ち（SwitchBotのAIまとめを貼り付けてもらう）
    if (cache.get('summary_' + userId)) {
      cache.remove('summary_' + userId);
      saveSummary_(staff, text, replyToken);
      return;
    }
    // 回答への一言追記
    if (handleNote_(staff, text, replyToken)) return;

    switch (text) {
      case '状況': replyRaw_(replyToken, [msgText_(buildStatusText_(staff))]); return;
      case 'ヘルプ': replyRaw_(replyToken, [msgText_(HELP_TEXT_)]); return;
      case 'まとめ':
        if (!isOfficeStaff_(staff)) {
          replyRaw_(replyToken, [msgText_('このコマンドは社員のみ実行できます。')]);
          return;
        }
        cache.put('summary_' + userId, '1', 900);
        replyRaw_(replyToken, [msgText_('SwitchBotの「AIまとめ」の本文を、そのまま貼り付けて送ってください。\n'
          + '先頭に日付（例：8/11）を書くとその日の記録になります。書かなければ昨日として扱います。')]);
        return;
      case '精査':
        if (!isOfficeStaff_(staff)) {
          replyRaw_(replyToken, [msgText_('このコマンドは社員のみ実行できます。')]);
          return;
        }
        replyRaw_(replyToken, [msgText_(buildReviewText_())]);
        return;
      case '精度':
      case 'せいど':
        if (!isOfficeStaff_(staff)) {
          replyRaw_(replyToken, [msgText_('このコマンドは社員のみ実行できます。')]);
          return;
        }
        replyRaw_(replyToken, [msgText_(learnSummaryLines_().join('\n'))]);
        return;
      case '診断':
        if (!isOfficeStaff_(staff)) {
          replyRaw_(replyToken, [msgText_('このコマンドは社員のみ実行できます。')]);
          return;
        }
        replyRaw_(replyToken, [msgText_(exportDiagnostics(true))]);
        return;
      case '報告':
        cache.put('report_' + userId, '1', 600);
        replyRaw_(replyToken, [msgText_('報告の内容を送ってください（日時・何があったか・どう対応したか）。\n社員にもそのまま共有します。')]);
        return;
      case 'テスト実行':
        if (!isOfficeStaff_(staff)) {
          replyRaw_(replyToken, [msgText_('このコマンドは社員のみ実行できます。')]);
          return;
        }
        replyRaw_(replyToken, [msgText_('朝バッチを実行します。少しお待ちください。')]);
        var r = morningBatch();
        sendToStaff(staff['staff_id'], [msgText_('朝バッチの結果：' + r)], { label: proc, force: true });
        return;
      default:
        replyRaw_(replyToken, [msgText_('ボタンでお答えください。困ったら「ヘルプ」と送ってください。')]);
        logInfo(proc, staff['氏名'] + ' から想定外のテキスト: ' + truncate_(text, 100));
    }
  } catch (e) {
    logError(proc, e, text);
    replyRaw_(replyToken, [msgText_('申し訳ありません、処理中に問題が起きました。担当者に記録しました。')]);
  }
}

/**
 * 社員・管理者かどうか（管理コマンドを実行できる役割か）。
 * @param {Object} staff S1の行
 * @return {boolean} 社員・管理者ならtrue
 */
function isOfficeStaff_(staff) {
  var role = String(staff['役割']);
  return role === '社員' || role === '管理者';
}

/** ヘルプ本文 @type {string} */
var HELP_TEXT_ = 'AI Uriboの使い方\n'
  + '・届いた質問はボタンを押すだけでOKです\n'
  + '・「未実施だった」「わからない」を選んだときだけ、一言だけ理由を送ってください（不要なら「なし」）\n'
  + '・「状況」…今の未完了件数を確認できます\n'
  + '・「報告」…事故・体調急変などをその場で報告できます\n'
  + '・「ヘルプ」…このメッセージ\n'
  + '・「診断」…（社員のみ）不具合調査用の情報を返します\n'
  + '・「精査」…（社員のみ）データから推定して埋めた記録の一覧を返します\n'
  + '・「精度」…（社員のみ）自動データがどれくらい当たっているかを返します\n'
  + '・「まとめ」…（社員のみ）SwitchBotのAIまとめを貼り付けると記録に取り込みます\n'
  + '答えられないときは無理をせず「わからない」で大丈夫です。社員が引き取ります。';

/**
 * 「状況」コマンドの本文を作る。
 * 社員・管理者は全体を、それ以外の役割は自分に割り当てられた分だけを見られる。
 * @param {Object} staff 問い合わせたスタッフのS1行
 * @return {string} 本文
 */
function buildStatusText_(staff) {
  var role = String(staff['役割']);
  var seesAll = (role === '社員' || role === '管理者');
  var pending = pendingGaps_();
  if (!seesAll) {
    var myId = String(staff['staff_id']);
    pending = pending.filter(function (g) {
      return String(g['一次確認先staff_id'] || '').split(',').some(function (id) {
        return id.trim() === myId;
      });
    });
  }
  var lines = ['【現在の状況】' + nowStr_()];
  lines.push((seesAll ? '未完了：' : 'あなたの未完了：') + pending.length + '件');
  pending.slice(0, 10).forEach(function (g) {
    var c = checkById_(g['check_id']);
    lines.push('・' + toDateStr_(g['対象日']) + ' ' + displayName_(String(g['対象']))
      + ' 「' + (c ? c['項目名'] : g['check_id']) + '」（' + g['状態'] + '）');
  });
  if (pending.length > 10) lines.push('…ほか' + (pending.length - 10) + '件');
  if (!pending.length) lines.push('すべて記録済みです。ありがとうございます。');
  return lines.join('\n');
}

/**
 * 貼り付けられた「AIまとめ」を取り込み、その場で自動充足まで走らせる。
 * 映像は受け取らず、文章だけをS4に残す。
 * @param {Object} staff 貼り付けたスタッフのS1行
 * @param {string} text 本文（先頭に日付があれば対象日として使う）
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function saveSummary_(staff, text, replyToken) {
  var proc = 'saveSummary_';
  var body = String(text).trim();
  var date = addDays_(todayStr_(), -1);

  // 先頭の日付（2026/08/11・2026-08-11・8/11 のいずれか）を対象日として読む
  var m = body.match(/^\s*(20\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) {
    date = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    body = body.substring(m[0].length).trim();
  } else {
    var m2 = body.match(/^\s*(\d{1,2})[\/\-.](\d{1,2})/);
    if (m2) {
      date = todayStr_().substring(0, 4) + '-' + ('0' + m2[1]).slice(-2) + '-' + ('0' + m2[2]).slice(-2);
      body = body.substring(m2[0].length).trim();
    }
  }
  if (!body) {
    replyRaw_(replyToken, [msgText_('本文が読み取れませんでした。もう一度「まとめ」から始めてください。')]);
    return;
  }

  appendRow(SHEETS.LOG_IMPORT, {
    'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
    '発生日': date,
    '対象種別': 'raw_summary',
    '対象': String(staff['拠点'] === '本部' ? 'ALL' : (staff['拠点'] || 'ALL')),
    '項目名': 'AIまとめ',
    '値': truncate_(body, 1000),
    '取込元': 'switchbot-ai',
    '取込日時': nowStr_()
  });

  var auto = safely_(proc, function () { return runAutoFill(date); }, { filled: 0, estimated: 0 });
  var alerts = safely_(proc, function () { return scanAlerts_(date); }, 0);

  var lines = ['取り込みました（' + date + '分）。'];
  lines.push('この文章から ' + auto.filled + '件を記録に反映しました（うち推定 ' + auto.estimated + '件）。');
  if (alerts) lines.push('※気になる記述があったため、社員に別途お知らせしました。');
  lines.push('内容は「精査」と送ると確認できます。');
  replyRaw_(replyToken, [msgText_(lines.join('\n'))]);
  logInfo(proc, staff['氏名'] + ' がAIまとめを取り込み（' + date + '・' + auto.filled + '件反映）');
}

/**
 * 「精査」コマンドの本文を作る。
 * 推定で埋めた記録（要精査=TRUE）を新しい順に並べ、現場が中身を見て直せるようにする。
 * @return {string} 本文
 */
function buildReviewText_() {
  var rows = findRows(SHEETS.FILL, function (r) {
    return isTrue_(r['要精査']) && !String(r['精査結果'] || '').trim();
  })
    .sort(function (a, b) {
      return toDateTimeStr_(b['作成日時']).localeCompare(toDateTimeStr_(a['作成日時']));
    });
  if (!rows.length) return 'まだ確かめていない推定の記録はありません。';

  var lines = ['【推定で埋めた記録（未確認）】' + rows.length + '件'];
  rows.slice(0, 10).forEach(function (r) {
    lines.push('・' + toDateStr_(r['対象日']) + ' ' + displayName_(String(r['対象']))
      + ' 「' + r['項目名'] + '」\n　→ ' + truncate_(String(r['値']), 60));
  });
  if (rows.length > 10) lines.push('…ほか' + (rows.length - 10) + '件');
  lines.push('');
  lines.push('内容が違っていれば、台帳のS7補完台帳で値を直し、要精査列をFALSEにしてください。');
  lines.push('※同じ項目の質問に答えていただくと、この一覧からは自動で消え、AIの精度の実績になります。');
  return lines.join('\n');
}

/**
 * 「報告」コマンドの内容を保存し、社員へ共有する（A7 緊急時・異常時対応）。
 * @param {Object} staff 報告者のS1行
 * @param {string} text 報告本文
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function saveReport_(staff, text, replyToken) {
  appendRow(SHEETS.LOG_IMPORT, {
    'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
    '発生日': todayStr_(),
    '対象種別': 'report',
    '対象': String(staff['staff_id']),
    '項目名': '緊急時・異常時対応',
    '値': text,
    '取込元': 'line-report',
    '取込日時': nowStr_()
  });
  appendRow(SHEETS.FILL, {
    'fill_id': nextSeqId_(SHEETS.FILL, 'fill_id', 'FIL', 6),
    '対象日': todayStr_(),
    '対象': String(staff['staff_id']),
    '項目名': '緊急時・異常時対応',
    '値': text,
    '記入者staff_id': String(staff['staff_id']),
    '取込済フラグ': false,
    '作成日時': nowStr_()
  });
  replyRaw_(replyToken, [msgText_('報告を受け取りました。社員に共有します。ありがとうございます。')]);
  sendToEscalationStaff([msgText_('【報告】' + staff['氏名'] + 'さんより（' + nowStr_() + '）\n' + text)], 'saveReport_');
  logInfo('saveReport_', staff['氏名'] + ' からの報告を記録');
}
