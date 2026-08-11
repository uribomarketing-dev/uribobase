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
 * そのため本実装では次の二段構えで正当性を担保する：
 *   (1) Webhook URL に秘密のクエリキーを付与し（?k=＜WEBHOOK_SECRET＞）、一致しないリクエストは破棄する
 *   (2) 署名検証関数 validateSignature_() は実装済みで、署名を渡せる経路（将来リバースプロキシを
 *       挟む場合など）ではそのまま利用できる。クエリ sig で署名が渡された場合は検証する
 * さらに、送信元ユーザーIDがS1スタッフマスタに無いイベントは操作を受け付けない。
 * この制約と対策は docs/03_デプロイ手順.md にも記載してある。
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
 * 動作確認用のGET応答（Webhook URLをブラウザで開いたときの表示）。
 * @param {Object} e リクエストイベント
 * @return {TextOutput} 応答
 */
function doGet(e) {
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
  if (key) {
    if (!e.parameter || String(e.parameter.k) !== String(key)) return false;
  } else {
    logWarn('verifyRequest_', 'WEBHOOK_SECRET が未設定です。設定するまでURLを知る全員が送信できます');
  }
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
  if (isDuplicateEvent_(ev)) return;
  var userId = (ev.source && ev.source.userId) ? ev.source.userId : '';
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
}

/**
 * 同じWebhookイベントの二重処理を防ぐ（LINEは再送することがある）。
 * @param {Object} ev LINEイベント
 * @return {boolean} 処理済みならtrue
 */
function isDuplicateEvent_(ev) {
  var id = ev.webhookEventId;
  if (!id) return false;
  var cache = CacheService.getScriptCache();
  if (cache.get('ev_' + id)) {
    logInfo('isDuplicateEvent_', '重複イベントを無視: ' + id);
    return true;
  }
  cache.put('ev_' + id, '1', 21600); // 6時間
  return false;
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
    replyRaw_(replyToken, [msgText_(known['氏名'] + 'さん、おかえりなさい。AI Uriboです。\n困ったら「ヘルプ」と送ってください。')]);
    return;
  }
  var candidates = findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && !String(r['line_user_id'] || '').trim();
  });
  if (!candidates.length) {
    replyRaw_(replyToken, [msgText_('AI Uriboです。恐れ入りますが、管理者の登録をお待ちください。')]);
    logWarn(proc, '未登録ユーザーが友だち追加しました: ' + userId);
    return;
  }
  var items = candidates.map(function (s) {
    return { label: String(s['氏名']), data: 'iam|' + s['staff_id'] };
  });
  replyRaw_(replyToken, [msgQuickReply_(
    'AI Uriboです。Uriboの記録の抜けを見つけて、皆さんに確認する係です。\nお名前を教えてください。', items)]);
  logInfo(proc, '友だち追加: ' + userId);
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
  var lock = LockService.getScriptLock();
  lock.tryLock(20000);
  try {
    if (parts[0] === 'iam') {
      bindStaff_(userId, parts[1], replyToken);
      return;
    }
    var staff = staffByLineId_(userId);
    if (!staff) {
      replyRaw_(replyToken, [msgText_('恐れ入りますが、管理者の登録をお待ちください。')]);
      return;
    }
    if (parts[0] === 'ans') {
      handleAnswer_(staff, parts[1], parts.slice(2).join('|'), replyToken);
      return;
    }
    logWarn(proc, '未対応のpostback: ' + data);
    replyRaw_(replyToken, [msgText_('うまく受け取れませんでした。もう一度ボタンを押してみてください。')]);
  } catch (e) {
    logError(proc, e, data);
    replyRaw_(replyToken, [msgText_('申し訳ありません、処理中に問題が起きました。担当者に記録しました。')]);
  } finally {
    lock.releaseLock();
  }
}

/**
 * スタッフとLINEユーザーIDを紐付ける。
 * @param {string} userId LINEユーザーID
 * @param {string} staffId staff_id
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function bindStaff_(userId, staffId, replyToken) {
  var staff = staffById_(staffId);
  if (!staff) {
    replyRaw_(replyToken, [msgText_('登録情報が見つかりませんでした。管理者にご連絡ください。')]);
    return;
  }
  if (String(staff['line_user_id'] || '').trim() && String(staff['line_user_id']) !== userId) {
    logWarn('bindStaff_', staff['氏名'] + ' は既に別のLINEアカウントに紐付いています');
  }
  updateRow(SHEETS.STAFF, staff._row, { 'line_user_id': userId });
  replyRaw_(replyToken, [msgText_(staff['氏名'] + 'さんですね。登録しました。\nこれから記録の確認をお送りします。困ったら「ヘルプ」と送ってください。')]);
  logInfo('bindStaff_', staff['氏名'] + ' を ' + userId + ' に紐付け');
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
  var staff = staffByLineId_(userId);
  if (!staff) {
    replyRaw_(replyToken, [msgText_('AI Uriboです。恐れ入りますが、管理者の登録をお待ちください。')]);
    return;
  }
  var lock = LockService.getScriptLock();
  lock.tryLock(20000);
  try {
    // 「報告」コマンドの本文待ち
    var cache = CacheService.getScriptCache();
    if (cache.get('report_' + userId)) {
      cache.remove('report_' + userId);
      saveReport_(staff, text, replyToken);
      return;
    }
    // 回答への一言追記
    if (handleNote_(staff, text, replyToken)) return;

    switch (text) {
      case '状況': replyRaw_(replyToken, [msgText_(buildStatusText_())]); return;
      case 'ヘルプ': replyRaw_(replyToken, [msgText_(HELP_TEXT_)]); return;
      case '報告':
        cache.put('report_' + userId, '1', 600);
        replyRaw_(replyToken, [msgText_('報告の内容を送ってください（日時・何があったか・どう対応したか）。\n社員にもそのまま共有します。')]);
        return;
      case 'テスト実行':
        if (String(staff['役割']) === '夜勤' || String(staff['役割']) === '世話人') {
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
  } finally {
    lock.releaseLock();
  }
}

/** ヘルプ本文 @type {string} */
var HELP_TEXT_ = 'AI Uriboの使い方\n'
  + '・届いた質問はボタンを押すだけでOKです\n'
  + '・「未実施だった」「わからない」を選んだときだけ、一言だけ理由を送ってください（不要なら「なし」）\n'
  + '・「状況」…今の未完了件数を確認できます\n'
  + '・「報告」…事故・体調急変などをその場で報告できます\n'
  + '・「ヘルプ」…このメッセージ\n'
  + '答えられないときは無理をせず「わからない」で大丈夫です。社員が引き取ります。';

/**
 * 「状況」コマンドの本文を作る。
 * @return {string} 本文
 */
function buildStatusText_() {
  var pending = pendingGaps_();
  var lines = ['【現在の状況】' + nowStr_()];
  lines.push('未完了：' + pending.length + '件');
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
