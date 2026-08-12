/**
 * 自動充足（【08】v1.1 第4章／運用方針の確定：2026-08-12）
 *
 * 【このシステムの位置づけ】
 * AI Uriboは「記録を正しく作る装置」ではなく、**記録者と利用者の実態を素早くつかむための補助**である。
 * だから帳簿の隙間は、手元にあるあらゆるデータを使って**積極的に埋めにいく**。
 * 埋めたものが推定であれば「要精査」の印を付け、現場の人がそれを見て、
 * さまざまな可能性を理解したうえで支援し、必要なら記録を直す。記録は記録、支援は支援。
 *
 * したがって：
 *   ・確実な事実（センサーの検知そのもの）→ そのまま記録する
 *   ・そこから推測できること（服薬した可能性・在宅していた可能性 等）→ 推定として埋める（要精査=TRUE）
 *   ・推定を止めたいときは S8設定 autofill_estimate を FALSE にすれば事実だけになる
 *
 * 【精度が上がる仕組み】
 * 推定で埋めても、それだけでは当たっているか分からない。そこで当面は推定で埋めたうえで
 * 人にも同じことを聞き、回答と突き合わせて情報源ごとの精度を貯める（learn.gs）。
 * 十分に当たると分かった組み合わせは質問をやめ、外れが増えたら聞き直しに戻す。
 * 結果として、使うほど質問が減り、精度は保たれる。
 *
 * 実接続（ファイル形式・置き場所）はStage2で確定。現時点では
 * 「S4に生ログが入っていれば正規化して充足する」器として実装してある。
 * 生ログの入れ方は docs/自動ソース取込フォーマット.md を参照。
 */

/**
 * 自動充足ソースの定義。
 * map() が返す各項目：
 *   項目名   … S3チェック項目マスタの項目名（これに一致すると、その質問は人に聞かなくなる）
 *   値       … 記録する値（何を根拠にしたか分かる書き方にする）
 *   推定     … true なら「データからの推定」。要精査=TRUEで記録し、現場が精査できるようにする
 *   推定回答 … AIが「たぶんこの選択肢だろう」と読んだ答え（S3の選択肢と同じ文字列）。
 *              これが入っている推定だけが、人の回答と突き合わされて学習の対象になる。
 *              センサーからは選択肢を決めようがないもの（服薬の声かけ等）には持たせない＝ずっと人に聞く
 *   全利用者 … true なら有効な利用者全員に展開する（献立など全体に効く情報）
 * @type {Array.<Object>}
 */
var AUTOFILL_SOURCES = [
  {
    id: 'switchbot_medication',
    生ログ種別: 'raw_switchbot',
    必要フラグ: '服薬自動',
    説明: 'SwitchBot服薬ログ → 開放の事実＋服薬確認（推定）',
    map: function (raw) {
      var v = String(raw['値'] || '').trim();
      var detail = v ? ('開放を検知 ' + v) : '開放を検知';
      return [
        // 事実：箱が開いた
        { 項目名: '服薬ボックス開放', 値: detail + '（SwitchBot自動記録）' },
        // 推定：開いている以上、服薬された可能性が高い。夜勤の声かけもこのログが起点になっている
        { 項目名: '服薬確認', 値: '服薬したとみられる（' + detail + '／SwitchBot自動記録・要精査）', 推定: true }
      ];
    }
  },
  {
    id: 'door_sensor',
    生ログ種別: 'raw_door',
    必要フラグ: '在否自動',
    説明: '開閉センサーログ → 在否確認・夜間の動き・夜間巡回（推定）',
    map: function (raw) {
      var out = [{ 項目名: '在否確認', 値: '在室とみられる（開閉センサー自動記録）',
                   推定: true, 推定回答: '在宅' }];
      if (String(raw['項目名']).indexOf('夜間') >= 0) {
        var v = String(raw['値'] || '').trim();
        out.push({ 項目名: '夜間の動き', 値: '夜間の開閉を検知' + (v ? ' ' + v : '') + '（開閉センサー自動記録）' });
        out.push({ 項目名: '夜間巡回・就寝確認', 値: '居室で動きあり（開閉センサー自動記録・要精査）', 推定: true });
      }
      return out;
    }
  },
  {
    id: 'motion_sensor',
    生ログ種別: 'raw_motion',
    必要フラグ: '在否自動',
    説明: '人感・Presenceセンサー → 在否確認・夜間巡回（推定）',
    map: function (raw) {
      var night = String(raw['項目名']).indexOf('夜間') >= 0;
      var out = [{ 項目名: '在否確認', 値: '在室とみられる（人感センサー自動記録）',
                   推定: true, 推定回答: '在宅' }];
      if (night) {
        out.push({ 項目名: '夜間の動き', 値: String(raw['値'] || '夜間に動きを検知') + '（人感センサー自動記録）' });
        out.push({ 項目名: '夜間巡回・就寝確認', 値: '居室で動きあり（人感センサー自動記録・要精査）', 推定: true });
      }
      return out;
    }
  },
  {
    id: 'lock_sensor',
    生ログ種別: 'raw_lock',
    必要フラグ: '',
    説明: 'スマートロック → 戸締まり確認（推定）',
    map: function (raw) {
      var v = String(raw['値'] || '');
      if (v.indexOf('施錠されている') < 0) return [];
      return [{ 項目名: '戸締まり確認', 値: v + '（スマートロック自動記録・要精査）', 推定: true }];
    }
  },
  {
    id: 'meter_sensor',
    生ログ種別: 'raw_meter',
    必要フラグ: '',
    説明: '温湿度計・Hub2 → 居室環境（実測値なので推定ではない）',
    map: function (raw) {
      var v = String(raw['値'] || '');
      if (!v) return [];
      return [{ 項目名: '居室環境', 値: v + '（自動記録）', 全利用者: String(raw['対象'] || 'ALL') === 'ALL' }];
    }
  },
  {
    id: 'labo_attendance',
    生ログ種別: 'raw_labo',
    必要フラグ: '日中自動',
    説明: 'うりぼラボ出勤情報 → 在否確認・日中活動',
    map: function (raw) {
      return [
        { 項目名: '在否確認', 値: '在宅（ラボ出勤記録より）', 推定: true, 推定回答: '在宅' },
        { 項目名: '日中活動', 値: 'ラボ出勤（出勤記録より）', 推定: true, 推定回答: '参加した' }
      ];
    }
  },
  {
    id: 'inoya_nisshi',
    生ログ種別: 'raw_inoya',
    必要フラグ: '',   // 拠点全体の情報なので利用者フラグの制約を受けない
    説明: '猪ノ屋業務日誌 → 天気・献立を転記し、献立があれば食事提供も推定',
    map: function (raw) {
      var name = String(raw['項目名']);
      var value = String(raw['値']);
      var out = [{ 項目名: name, 値: value }];
      if (name === '献立' && value) {
        out.push({
          項目名: '食事提供',
          値: '提供あり（献立記録：' + truncate_(value, 40) + '／要精査）',
          推定: true, 推定回答: '朝夕とも提供', 全利用者: true
        });
      }
      return out;
    }
  },
  {
    id: 'openclaw_vision',
    生ログ種別: 'raw_openclaw',
    必要フラグ: '',
    説明: 'AIハブ（OpenClaw）の映像解析メモ → 該当項目を推定で埋める',
    map: function (raw) {
      // AIハブのVLMが映像から読み取った内容が、すでにAI Uriboの項目名で届く前提。
      // 映像そのものは受け取らない（台帳に入るのは言葉だけ）。
      var name = String(raw['項目名'] || '').trim();
      if (!name) return [];
      return [{
        項目名: name,
        値: String(raw['値']) + '（AIハブ映像解析・要精査）',
        推定: true,
        全利用者: String(raw['対象'] || 'ALL') === 'ALL'
      }];
    }
  },
  {
    id: 'summary_scan',
    生ログ種別: 'raw_summary',
    必要フラグ: '',
    説明: 'AIまとめ等の文章をS3の検出キーワードで走査し、該当項目を推定で埋める',
    map: function (raw) {
      var text = String(raw['値'] || '');
      if (!text) return [];
      var out = [];
      findRows(SHEETS.CHECK, function (c) { return String(c['検出キーワード'] || '').trim(); })
        .forEach(function (c) {
          var words = String(c['検出キーワード']).split(',').map(function (w) { return w.trim(); })
            .filter(function (w) { return w; });
          var hit = words.filter(function (w) { return text.indexOf(w) >= 0; });
          if (!hit.length) return;
          out.push({
            項目名: String(c['項目名']),
            値: excerptAround_(text, hit[0]) + '（AIまとめより／該当語：' + hit.join('・') + '）',
            推定: true,
            全利用者: String(raw['対象'] || 'ALL') === 'ALL'
          });
        });
      return out;
    }
  },
  {
    id: 'plan_carryover',
    生ログ種別: 'plan',           // 前夜に本人へ確認した「明日の予定」
    必要フラグ: '',
    説明: '前夜に聞いた予定 → 実績の推定（予定どおりなら聞き直さない）',
    map: function (raw) {
      var name = String(raw['項目名']);
      var value = String(raw['値']).split('／')[0].trim();
      var pairs = {
        '予定_帰省': { 'あり': { 項目名: '在否確認', 値: '外泊・帰省（前夜の予定より）', 推定回答: '外泊・帰省' } },
        '予定_外出': {
          'あり': { 項目名: '外出・帰宅時間', 値: '外出あり（前夜の予定より）', 推定回答: '外出あり（一言記入）' },
          'なし': { 項目名: '外出・帰宅時間', 値: '外出なし（前夜の予定より）', 推定回答: '外出なし' }
        },
        '予定_ラボ出勤': { 'あり': { 項目名: '日中活動', 値: 'ラボ出勤（前夜の予定より）', 推定回答: '参加した' } },
        '予定_食事': {
          '朝夕とも必要': { 項目名: '食事提供', 値: '朝夕とも提供（前夜の予定より）', 推定回答: '朝夕とも提供' },
          '不要': { 項目名: '食事提供', 値: '提供なし（前夜の予定より）', 推定回答: '提供なし' }
        }
      };
      var hit = pairs[name] && pairs[name][value];
      if (!hit) return [];
      return [{ 項目名: hit.項目名, 値: hit.値 + '（要精査）', 推定: true, 推定回答: hit.推定回答 }];
    }
  }
];

/**
 * 自動充足を実行する。detectGaps の直前に必ず呼ぶこと。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {{filled:number, estimated:number, autoConfirmed:number, bySource:Object.<string,number>, skipped:number}} 充足結果
 */
function runAutoFill(targetDate) {
  var proc = 'runAutoFill';
  // 「無ければ書く」の判定と追記の間に他の実行が割り込まないよう直列化する（再入可能）
  return withLock_(proc, 120000, function () { return runAutoFillBody_(proc, targetDate); },
    function () { return { filled: 0, estimated: 0, autoConfirmed: 0, bySource: {}, skipped: 0 }; });
}

/**
 * 自動充足の本体（ロック取得済みの状態で呼ばれる）。
 * @param {string} proc ログ用の処理名
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {{filled:number, estimated:number, autoConfirmed:number, bySource:Object.<string,number>, skipped:number}} 充足結果
 */
function runAutoFillBody_(proc, targetDate) {
  var date = toDateStr_(targetDate);
  logStart(proc, date);

  var useEstimate = isTrue_(getSetting('autofill_estimate', 'TRUE'));
  var users = {};
  var activeCodes = [];
  findRows(SHEETS.USER).forEach(function (u) {
    users[String(u['user_code'])] = u;
    if (isTrue_(u['有効'])) activeCodes.push(String(u['user_code']));
  });

  var logs = findRows(SHEETS.LOG_IMPORT, function (r) { return toDateStr_(r['発生日']) === date; });

  // すでにある支援記録ログ（対象＋項目名）を索引化して二重書き込みを防ぐ
  var have = {};
  logs.forEach(function (r) {
    if (String(r['対象種別']) === 'support') have[r['対象'] + '\t' + r['項目名']] = true;
  });

  var result = { filled: 0, estimated: 0, autoConfirmed: 0, bySource: {}, skipped: 0 };

  AUTOFILL_SOURCES.forEach(function (src) {
    result.bySource[src.id] = 0;
    safely_(proc + ':' + src.id, function () {
      logs.filter(function (r) { return String(r['対象種別']) === src.生ログ種別; })
        .forEach(function (raw) {
          var rawTarget = String(raw['対象'] || 'ALL');

          src.map(raw).forEach(function (fill) {
            if (!fill.項目名) return;
            if (fill.推定 && !useEstimate) { result.skipped++; return; }

            // 全体情報（献立など）は有効な利用者全員に展開する
            var targets = fill.全利用者 ? activeCodes : [rawTarget];
            targets.forEach(function (target) {
              var user = users[target];

              // 利用者マスタで自動対応フラグがOFFなら自動充足しない（人に聞く）
              if (src.必要フラグ) {
                if (!user || !isTrue_(user[src.必要フラグ]) || !isTrue_(user['有効'])) {
                  result.skipped++;
                  return;
                }
              } else if (user && !isTrue_(user['有効'])) {
                result.skipped++;
                return;
              }

              var key = target + '\t' + fill.項目名;
              if (have[key]) { result.skipped++; return; }
              have[key] = true;
              var certainty = certaintyOf_(src.id, fill);
              writeAutoFill_(date, target, fill, src.id, certainty);
              result.filled++;
              if (fill.推定) result.estimated++;
              if (certainty === CERTAINTY.AUTO) result.autoConfirmed++;
              result.bySource[src.id]++;
            });
          });
        });
    });
  });

  logInfo(proc, '自動充足 ' + result.filled + '件（うち推定 ' + result.estimated + '件'
    + '／学習済みで質問を省いたもの ' + result.autoConfirmed + '件・'
    + JSON.stringify(result.bySource) + '） / スキップ ' + result.skipped + '件');
  return result;
}

/**
 * この1件を「人にも確認するか、もう確認しないか」を学習の実績から決める。
 *
 * ・事実のログ（推定ではない）           → 確定。もともと質問しない
 * ・推定回答を持たない推定               → 推定。ずっと人に聞く（機械には決めようがないもの）
 * ・学習が「自動確定」まで育った推定     → 自動確定。人に聞かない（ただし抜き打ちの回だけは聞く）
 * ・それ以外の推定（学習中・要見直し）   → 推定。埋めたうえで人にも聞き、当たり外れを貯める
 * @param {string} sourceId 自動ソースのid
 * @param {{項目名:string, 推定:boolean, 推定回答:string}} fill 充足内容
 * @return {string} CERTAINTY のいずれか
 */
function certaintyOf_(sourceId, fill) {
  if (!fill.推定) return CERTAINTY.FIXED;
  if (!fill.推定回答) return CERTAINTY.ESTIMATED;
  if (learnStage_(sourceId, fill.項目名) !== LEARN_STAGE.AUTO) return CERTAINTY.ESTIMATED;
  return learnSpotCheckDue_(sourceId, fill.項目名) ? CERTAINTY.ESTIMATED : CERTAINTY.AUTO;
}

/**
 * 自動充足の1件をS4（記録）とS7（既存アプリへの還元）に書く。
 * @param {string} date 対象日
 * @param {string} target 対象（user_code など）
 * @param {{項目名:string, 値:string, 推定:boolean, 推定回答:string}} fill 充足内容
 * @param {string} sourceId 自動ソースのid
 * @param {string} certainty 確度（CERTAINTY）
 * @return {void}
 */
function writeAutoFill_(date, target, fill, sourceId, certainty) {
  var level = certainty || (fill.推定 ? CERTAINTY.ESTIMATED : CERTAINTY.FIXED);
  appendRow(SHEETS.LOG_IMPORT, {
    'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
    '発生日': date,
    '対象種別': 'support',
    '対象': target,
    '項目名': fill.項目名,
    '値': fill.値,
    '取込元': sourceId,
    '取込日時': nowStr_(),
    '確度': level,
    '推定回答': fill.推定回答 || ''
  });
  appendRow(SHEETS.FILL, {
    'fill_id': nextSeqId_(SHEETS.FILL, 'fill_id', 'FIL', 6),
    '対象日': date,
    '対象': target,
    '項目名': fill.項目名,
    '値': fill.値,
    '記入者staff_id': 'AUTO:' + sourceId,
    '取込済フラグ': false,
    '作成日時': nowStr_(),
    '情報源': (fill.推定 ? '自動推定（' : '自動ログ（') + sourceId
      + (level === CERTAINTY.AUTO ? '・学習済み' : '') + '）',
    '要精査': fill.推定 ? true : false,
    '精査結果': ''
  });
}

/**
 * 文章から、該当語の周辺だけを切り出す（記録に残すのは要点だけにするため）。
 * @param {string} text 全文
 * @param {string} word 該当語
 * @param {number} [span] 前後に取る文字数
 * @return {string} 抜粋
 */
function excerptAround_(text, word, span) {
  var n = span || 30;
  var i = text.indexOf(word);
  if (i < 0) return truncate_(text, n * 2);
  var from = Math.max(0, i - n);
  var to = Math.min(text.length, i + word.length + n);
  return (from > 0 ? '…' : '') + text.substring(from, to) + (to < text.length ? '…' : '');
}

/**
 * その日の文章ログ（AIまとめ等）に注意すべき語が無いか調べ、あれば社員へすぐ知らせる。
 * 「転倒」「うつ伏せ」などは、記録として埋めるだけでなく人が気づく必要があるため。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {number} 通知した件数
 */
function scanAlerts_(targetDate) {
  var proc = 'scanAlerts_';
  var words = String(getSetting('alert_keywords', '')).split(',')
    .map(function (w) { return w.trim(); }).filter(function (w) { return w; });
  if (!words.length) return 0;

  var date = toDateStr_(targetDate);
  var texts = findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date
      && (String(r['対象種別']).indexOf('raw_summary') === 0 || String(r['対象種別']).indexOf('raw_openclaw') === 0);
  });

  var sent = 0;
  texts.forEach(function (r) {
    safely_(proc, function () {
      var text = String(r['値'] || '');
      var hit = words.filter(function (w) { return text.indexOf(w) >= 0; });
      if (!hit.length) return;

      // 同じ日・同じ語で二度知らせない
      var cache = CacheService.getScriptCache();
      var key = 'alert_' + date + '_' + hit.join('_') + '_' + String(r['対象']);
      if (cache.get(key)) return;
      cache.put(key, '1', 86400);

      // AIの読み取りは誤りが多い。断定せずに知らせ、事実かどうかを人に判定してもらう
      var msg = '【AIが気にした記述】' + date + '　' + displayName_(String(r['対象'])) + '\n'
        + '「' + hit.join('・') + '」という語が見つかりました。\n\n'
        + excerptAround_(text, hit[0], 60) + '\n\n'
        + '※これはカメラのAIが書いた文章です。**誤りが多く含まれます。**\n'
        + '　事実かどうかだけ、下のボタンで教えてください。';
      var key2 = date + '|' + hit[0] + '|' + String(r['対象']);
      var buttons = msgButtons_('AIの読み取り確認', '実際にあったことですか？', [
        { label: '事実だった', data: 'alert|ok|' + key2 },
        { label: 'これは違う（誤検知）', data: 'alert|ng|' + key2 },
        { label: '判断できない', data: 'alert|unknown|' + key2 }
      ]);
      sent += sendToEscalationStaff([msgText_(msg), buttons], proc);
      logWarn(proc, date + ' に注意語を検出: ' + hit.join('・'));
    });
  });
  return sent;
}

/**
 * 指定期間の自動充足件数を数える（週次ダイジェストの自動充足率算出用）。
 * @param {string} fromDate 開始日 YYYY-MM-DD
 * @param {string} toDate 終了日 YYYY-MM-DD
 * @return {number} 自動ソース由来のS4ログ件数
 */
function countAutoFilled_(fromDate, toDate) {
  var ids = AUTOFILL_SOURCES.map(function (s) { return s.id; });
  return findRows(SHEETS.LOG_IMPORT, function (r) {
    var d = toDateStr_(r['発生日']);
    return d >= toDateStr_(fromDate) && d <= toDateStr_(toDate) && ids.indexOf(String(r['取込元'])) >= 0;
  }).length;
}

/**
 * 指定期間の「要精査」（推定で埋めた）件数を数える。
 * @param {string} fromDate 開始日 YYYY-MM-DD
 * @param {string} toDate 終了日 YYYY-MM-DD
 * @return {number} 要精査の件数
 */
function countNeedsReview_(fromDate, toDate) {
  return findRows(SHEETS.FILL, function (r) {
    var d = toDateStr_(r['対象日']);
    return d >= toDateStr_(fromDate) && d <= toDateStr_(toDate) && isTrue_(r['要精査']);
  }).length;
}
