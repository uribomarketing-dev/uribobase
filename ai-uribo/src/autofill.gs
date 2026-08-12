/**
 * 自動充足（【08】v1.1 第4章）
 *
 * 原則：機械で埋められるものは人に聞かない。
 * 不足検出（detectGaps）の前に必ず runAutoFill() を実行し、
 * 自動ソース由来の生ログ（S4に 対象種別=raw_xxx で取り込まれたもの）を
 * 支援記録の項目名に正規化してS4へ書き、同時にS7補完台帳へ還元する。
 *
 * 【重要】各自動ソースの実接続（ファイル形式・置き場所）はStage2で確定する。
 * 現時点では「S4に生ログが入っていれば正規化して充足する」器として実装してある。
 * 生ログの入れ方は docs/自動ソース取込フォーマット.md を参照。
 */

/**
 * 自動充足ソースの定義。
 * 新しいソースを足すときはこの配列に1件追加するだけでよい。
 * @type {Array.<{id:string, 生ログ種別:string, 必要フラグ:string, 説明:string,
 *                map:function(Object):Array.<{項目名:string, 値:string}>}>}
 */
var AUTOFILL_SOURCES = [
  {
    id: 'switchbot_medication',
    生ログ種別: 'raw_switchbot',
    必要フラグ: '服薬自動',
    説明: 'SwitchBot服薬ログ → A6 服薬確認',
    map: function (raw) {
      // センサーが示すのは「服薬ボックスが開いた事実」であって支援の実施そのものではない。
      // 監査で誤解されないよう、値に何の記録かを明示する。
      return [{ 項目名: '服薬確認', 値: '服薬ボックスの開放を検知（SwitchBot自動記録）' }];
    }
  },
  {
    id: 'door_sensor',
    生ログ種別: 'raw_door',
    必要フラグ: '在否自動',
    説明: '開閉センサーログ → A1 在否確認 / A2 夜間の動き',
    map: function (raw) {
      var out = [{ 項目名: '在否確認', 値: '在室を検知（開閉センサー自動記録）' }];
      if (String(raw['項目名']).indexOf('夜間') >= 0) {
        // 巡回の実施そのものは人にしか記録できないため、あくまで補助情報として残す
        out.push({ 項目名: '夜間の動き', 値: '夜間の開閉を検知（開閉センサー自動記録）' });
      }
      return out;
    }
  },
  {
    id: 'labo_attendance',
    生ログ種別: 'raw_labo',
    必要フラグ: '日中自動',
    説明: 'うりぼラボ出勤情報 → A1 在否確認 / B3 日中活動',
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
    説明: '猪ノ屋業務日誌 → 天気・献立（誰にも質問せずに転記）',
    map: function (raw) {
      return [{ 項目名: String(raw['項目名']), 値: String(raw['値']) }];
    }
  }
];

/**
 * 自動充足を実行する。detectGaps の直前に必ず呼ぶこと。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {{filled:number, bySource:Object.<string,number>, skipped:number}} 充足結果
 */
function runAutoFill(targetDate) {
  var proc = 'runAutoFill';
  // 「無ければ書く」の判定と追記の間に他の実行が割り込まないよう直列化する（再入可能）
  return withLock_(proc, 120000, function () { return runAutoFillBody_(proc, targetDate); },
    function () { return { filled: 0, bySource: {}, skipped: 0 }; });
}

/**
 * 自動充足の本体（ロック取得済みの状態で呼ばれる）。
 * @param {string} proc ログ用の処理名
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {{filled:number, bySource:Object.<string,number>, skipped:number}} 充足結果
 */
function runAutoFillBody_(proc, targetDate) {
  var date = toDateStr_(targetDate);
  logStart(proc, date);

  var users = {};
  findRows(SHEETS.USER).forEach(function (u) { users[String(u['user_code'])] = u; });

  var logs = findRows(SHEETS.LOG_IMPORT, function (r) { return toDateStr_(r['発生日']) === date; });

  // すでにある支援記録ログ（対象＋項目名）を索引化して二重書き込みを防ぐ
  var have = {};
  logs.forEach(function (r) {
    if (String(r['対象種別']) === 'support') have[r['対象'] + '\t' + r['項目名']] = true;
  });

  var result = { filled: 0, bySource: {}, skipped: 0 };

  AUTOFILL_SOURCES.forEach(function (src) {
    result.bySource[src.id] = 0;
    safely_(proc + ':' + src.id, function () {
      logs.filter(function (r) { return String(r['対象種別']) === src.生ログ種別; })
        .forEach(function (raw) {
          var target = String(raw['対象'] || 'ALL');
          var user = users[target];

          // 利用者マスタで自動対応フラグがOFFなら自動充足しない（人に聞く）
          if (src.必要フラグ) {
            if (!user || !isTrue_(user[src.必要フラグ])) { result.skipped++; return; }
            if (!isTrue_(user['有効'])) { result.skipped++; return; }
          }

          src.map(raw).forEach(function (fill) {
            if (!fill.項目名) return;
            var key = target + '\t' + fill.項目名;
            if (have[key]) { result.skipped++; return; }
            have[key] = true;

            appendRow(SHEETS.LOG_IMPORT, {
              'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
              '発生日': date,
              '対象種別': 'support',
              '対象': target,
              '項目名': fill.項目名,
              '値': fill.値,
              '取込元': src.id,
              '取込日時': nowStr_()
            });
            appendRow(SHEETS.FILL, {
              'fill_id': nextSeqId_(SHEETS.FILL, 'fill_id', 'FIL', 6),
              '対象日': date,
              '対象': target,
              '項目名': fill.項目名,
              '値': fill.値,
              '記入者staff_id': 'AUTO:' + src.id,
              '取込済フラグ': false,
              '作成日時': nowStr_(),
              '情報源': '自動ログ（' + src.id + '）'
            });
            result.filled++;
            result.bySource[src.id]++;
          });
        });
    });
  });

  logInfo(proc, '自動充足 ' + result.filled + '件（' + JSON.stringify(result.bySource) + '） / スキップ ' + result.skipped + '件');
  return result;
}

/**
 * 指定日の自動充足件数を数える（週次ダイジェストの自動充足率算出用）。
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
