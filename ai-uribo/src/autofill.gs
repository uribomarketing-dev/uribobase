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
      var out = [{ 項目名: '在否確認', 値: '在室（開閉センサー自動記録）' }];
      if (String(raw['項目名']).indexOf('夜間') >= 0) {
        var v = String(raw['値'] || '').trim();
        out.push({ 項目名: '夜間の動き', 値: '夜間の開閉を検知' + (v ? ' ' + v : '') + '（開閉センサー自動記録）' });
        out.push({ 項目名: '夜間巡回・就寝確認', 値: '居室で動きあり（開閉センサー自動記録・要精査）', 推定: true });
      }
      return out;
    }
  },
  {
    id: 'labo_attendance',
    生ログ種別: 'raw_labo',
    必要フラグ: '日中自動',
    説明: 'うりぼラボ出勤情報 → 在否確認・日中活動',
    map: function (raw) {
      return [
        { 項目名: '在否確認', 値: '在宅（ラボ出勤記録より）' },
        { 項目名: '日中活動', 値: 'ラボ出勤（出勤記録より）' }
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
          推定: true, 全利用者: true
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
    id: 'plan_carryover',
    生ログ種別: 'plan',           // 前夜に本人へ確認した「明日の予定」
    必要フラグ: '',
    説明: '前夜に聞いた予定 → 実績の推定（予定どおりなら聞き直さない）',
    map: function (raw) {
      var name = String(raw['項目名']);
      var value = String(raw['値']).split('／')[0].trim();
      var pairs = {
        '予定_帰省': { 'あり': { 項目名: '在否確認', 値: '外泊・帰省（前夜の予定より）' } },
        '予定_外出': {
          'あり': { 項目名: '外出・帰宅時間', 値: '外出あり（前夜の予定より）' },
          'なし': { 項目名: '外出・帰宅時間', 値: '外出なし（前夜の予定より）' }
        },
        '予定_ラボ出勤': { 'あり': { 項目名: '日中活動', 値: 'ラボ出勤（前夜の予定より）' } },
        '予定_食事': {
          '朝夕とも必要': { 項目名: '食事提供', 値: '朝夕とも提供（前夜の予定より）' },
          '不要': { 項目名: '食事提供', 値: '提供なし（前夜の予定より）' }
        }
      };
      var hit = pairs[name] && pairs[name][value];
      if (!hit) return [];
      return [{ 項目名: hit.項目名, 値: hit.値 + '（要精査）', 推定: true }];
    }
  }
];

/**
 * 自動充足を実行する。detectGaps の直前に必ず呼ぶこと。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {{filled:number, estimated:number, bySource:Object.<string,number>, skipped:number}} 充足結果
 */
function runAutoFill(targetDate) {
  var proc = 'runAutoFill';
  // 「無ければ書く」の判定と追記の間に他の実行が割り込まないよう直列化する（再入可能）
  return withLock_(proc, 120000, function () { return runAutoFillBody_(proc, targetDate); },
    function () { return { filled: 0, estimated: 0, bySource: {}, skipped: 0 }; });
}

/**
 * 自動充足の本体（ロック取得済みの状態で呼ばれる）。
 * @param {string} proc ログ用の処理名
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {{filled:number, estimated:number, bySource:Object.<string,number>, skipped:number}} 充足結果
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

  var result = { filled: 0, estimated: 0, bySource: {}, skipped: 0 };

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
              writeAutoFill_(date, target, fill, src.id);
              result.filled++;
              if (fill.推定) result.estimated++;
              result.bySource[src.id]++;
            });
          });
        });
    });
  });

  logInfo(proc, '自動充足 ' + result.filled + '件（うち推定 ' + result.estimated + '件・'
    + JSON.stringify(result.bySource) + '） / スキップ ' + result.skipped + '件');
  return result;
}

/**
 * 自動充足の1件をS4（記録）とS7（既存アプリへの還元）に書く。
 * @param {string} date 対象日
 * @param {string} target 対象（user_code など）
 * @param {{項目名:string, 値:string, 推定:boolean}} fill 充足内容
 * @param {string} sourceId 自動ソースのid
 * @return {void}
 */
function writeAutoFill_(date, target, fill, sourceId) {
  appendRow(SHEETS.LOG_IMPORT, {
    'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
    '発生日': date,
    '対象種別': 'support',
    '対象': target,
    '項目名': fill.項目名,
    '値': fill.値,
    '取込元': sourceId,
    '取込日時': nowStr_()
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
    '情報源': (fill.推定 ? '自動推定（' : '自動ログ（') + sourceId + '）',
    '要精査': fill.推定 ? true : false
  });
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
