/**
 * 不足検出（04_不足判定ルール仕様.md / 06 Step4）
 *
 * 判定ロジックは detectGaps() に完全分離してある。
 * Phase4でAI化する場合は、この関数の中身をAnthropic API呼び出しに差し替えるだけでよい。
 *   detectGaps(targetDate) → [{check_id, 対象, 対象日, 理由}]
 *
 * 個別ルールはS3チェック項目マスタの「判定ルールID」で切り替える。
 * S3で 有効=FALSE の項目は一切検出しない（Phase1はR01のみ有効）。
 */

/**
 * 指定日の不足を検出する（AI化の差し替えポイント）。
 * ※呼び出し前に必ず runAutoFill(targetDate) を実行すること。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @param {Array.<string>} [ruleFilter] 実行するルールIDの限定（省略時は R01/R02）
 * @return {Array.<{check_id:string, 対象:string, 対象日:string, 理由:string}>} 不足の配列
 */
function detectGaps(targetDate, ruleFilter) {
  var proc = 'detectGaps';
  var date = toDateStr_(targetDate);
  var rules = ruleFilter || ['R01', 'R02'];
  var gaps = [];

  var checks = findRows(SHEETS.CHECK, function (r) { return isTrue_(r['有効']); });
  checks.forEach(function (c) {
    var rule = String(c['判定ルールID']);
    if (rules.indexOf(rule) < 0) return;
    safely_(proc + ':' + c['check_id'], function () {
      switch (rule) {
        case 'R01': gaps = gaps.concat(ruleR01_(date, c)); break;
        case 'R02': gaps = gaps.concat(ruleR02_(date, c)); break;
        case 'R04': gaps = gaps.concat(ruleR04_(date, c)); break;
        case 'R05': gaps = gaps.concat(ruleR05_(date, c)); break;
        default: logWarn(proc, '未対応の判定ルールID: ' + rule + '（' + c['check_id'] + '）');
      }
    });
  });

  logInfo(proc, date + ' の不足 ' + gaps.length + '件（ルール: ' + rules.join(',') + '）');
  return gaps;
}

/**
 * R01：シフト希望未回答（Phase1のテスト題材）。
 * 毎月 shift_request_day 〜 shift_deadline_day の間だけ発火し、翌月分の希望が
 * S4に無い有効スタッフを不足として検出する。
 * @param {string} targetDate 対象日（判定は実行日で行う）
 * @param {Object} check S3の行
 * @return {Array.<Object>} 不足の配列
 */
function ruleR01_(targetDate, check) {
  var today = new Date();
  var day = parseInt(Utilities.formatDate(today, TZ, 'd'), 10);
  var from = getSettingNum('shift_request_day', 20);
  var to = getSettingNum('shift_deadline_day', 25);
  if (day < from || day > to) return [];

  var targetMonth = nextMonthStr_(today);          // 例：2026-09
  var monthKey = targetMonth + '-01';              // 不足の対象日（重複検出防止のキー）

  var answered = {};
  findRows(SHEETS.LOG_IMPORT, function (r) {
    return String(r['対象種別']) === 'shift' && String(r['項目名']) === String(check['項目名']);
  }).forEach(function (r) {
    if (String(r['値']).indexOf(targetMonth) >= 0) answered[String(r['対象'])] = true;
  });

  var gaps = [];
  findRows(SHEETS.STAFF, function (r) { return isTrue_(r['有効']); }).forEach(function (s) {
    if (answered[String(s['staff_id'])]) return;
    gaps.push({
      check_id: String(check['check_id']),
      対象: String(s['staff_id']),
      対象日: monthKey,
      理由: targetMonth + '分のシフト希望が未提出（締切' + to + '日）'
    });
  });
  return gaps;
}

/**
 * R02：日次記録の欠落（Phase2・清水）。
 * S2の有効な利用者 × 当該チェック項目について、S4に前日分のログが無いものを検出する。
 * 自動充足済みのものは runAutoFill() でS4に書かれているため、ここでは自然に除外される。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @param {Object} check S3の行
 * @return {Array.<Object>} 不足の配列
 */
function ruleR02_(targetDate, check) {
  var date = toDateStr_(targetDate);
  var logs = findRows(SHEETS.LOG_IMPORT, function (r) { return toDateStr_(r['発生日']) === date; });

  var have = {};
  var absent = {};
  logs.forEach(function (r) {
    var target = String(r['対象']);
    var name = String(r['項目名']);
    if (String(r['対象種別']) === 'support') {
      have[target + '\t' + name] = true;
      // 在否確認が外泊・入院・帰省なら、その日はその利用者の全項目を判定除外
      if (name === '在否確認' && /外泊|入院|帰省|不在/.test(String(r['値']))) absent[target] = true;
      if (name === '不在') absent[target] = true;
    }
    // 予定ログで帰省・外泊が入っていればその日は判定除外
    if (String(r['対象種別']) === 'plan' && name === '予定_帰省' && String(r['値']) === 'あり') absent[target] = true;
  });

  var gaps = [];
  findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); }).forEach(function (u) {
    var code = String(u['user_code']);
    if (absent[code]) return;
    if (have[code + '\t' + String(check['項目名'])]) return;
    gaps.push({
      check_id: String(check['check_id']),
      対象: code,
      対象日: date,
      理由: date + 'の「' + check['項目名'] + '」の記録なし'
    });
  });
  return gaps;
}

/**
 * R04：明日の予定の未確認（夜の確認セット用）。
 * S4に 対象種別=plan の予定ログが無い利用者を検出する。
 * @param {string} targetDate 予定を確認したい日（＝明日）YYYY-MM-DD
 * @param {Object} check S3の行
 * @return {Array.<Object>} 不足の配列
 */
function ruleR04_(targetDate, check) {
  var date = toDateStr_(targetDate);
  var have = {};
  findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date && String(r['対象種別']) === 'plan';
  }).forEach(function (r) { have[String(r['対象']) + '\t' + String(r['項目名'])] = true; });

  var gaps = [];
  findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); }).forEach(function (u) {
    var code = String(u['user_code']);
    if (have[code + '\t' + String(check['項目名'])]) return;
    gaps.push({
      check_id: String(check['check_id']),
      対象: code,
      対象日: date,
      理由: date + 'の「' + check['項目名'] + '」が未確認'
    });
  });
  return gaps;
}

/**
 * R05：その日の夜勤担当者が未記録。
 * 利用者ごとではなく「拠点ごとに1日1問」だけ聞く。この回答が、同じ日・同じ拠点の
 * 全記録の「支援担当者」になり、監査で問われる「誰が支援したか」を満たす。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @param {Object} check S3の行
 * @return {Array.<Object>} 不足の配列
 */
function ruleR05_(targetDate, check) {
  var date = toDateStr_(targetDate);
  var have = {};
  findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date && String(r['項目名']) === String(check['項目名']);
  }).forEach(function (r) { have[String(r['対象'])] = true; });

  // 有効な利用者がいる拠点だけを対象にする（誰もいない拠点には聞かない）
  var sites = {};
  findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); })
    .forEach(function (u) { if (u['拠点']) sites[String(u['拠点'])] = true; });

  var gaps = [];
  Object.keys(sites).forEach(function (site) {
    if (have[site]) return;
    gaps.push({
      check_id: String(check['check_id']),
      対象: site,
      対象日: date,
      理由: date + 'の' + site + 'の夜勤担当者が未記録'
    });
  });
  return gaps;
}

/**
 * 指定日・指定拠点の夜勤担当者名を返す（記録されていなければ空文字）。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @param {string} site 拠点
 * @return {string} 夜勤担当者名
 */
function nightStaffNameOf_(targetDate, site) {
  var row = findRow(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === toDateStr_(targetDate)
      && String(r['項目名']) === '夜勤担当者'
      && String(r['対象']) === String(site);
  });
  if (!row) return '';
  // 「その他（名前を入力）／山田太郎」のように追記されている場合は後半を採る
  var parts = String(row['値']).split('／');
  return parts.length > 1 ? parts[parts.length - 1].trim() : String(row['値']).trim();
}

/**
 * 検出した不足をS5に登録する。
 * 同一（対象日 × check_id × 対象）が既に存在する場合は登録しない（二重検出防止）。
 * @param {Array.<Object>} gaps detectGapsの戻り値
 * @return {Array.<Object>} 新規登録したS5行オブジェクト（gap_id・check・対象日などを含む）
 */
function registerGaps(gaps) {
  var proc = 'registerGaps';
  // 重複確認と追記の間に他の実行が割り込まないよう直列化する（再入可能）
  return withLock_(proc, 120000, function () { return registerGapsBody_(proc, gaps); }, function () { return []; });
}

/**
 * 不足登録の本体（ロック取得済みの状態で呼ばれる）。
 * @param {string} proc ログ用の処理名
 * @param {Array.<Object>} gaps detectGapsの戻り値
 * @return {Array.<Object>} 新規登録した不足の配列
 */
function registerGapsBody_(proc, gaps) {
  var existing = {};
  findRows(SHEETS.GAP).forEach(function (r) {
    existing[toDateStr_(r['対象日']) + '\t' + r['check_id'] + '\t' + r['対象']] = true;
  });

  var created = [];
  gaps.forEach(function (g) {
    safely_(proc, function () {
      var key = toDateStr_(g.対象日) + '\t' + g.check_id + '\t' + g.対象;
      if (existing[key]) return;
      existing[key] = true;

      var check = checkById_(g.check_id);
      var assignees = resolveAssignees_(check, g.対象日, g.対象);
      var gapId = nextGapId_(todayStr_());
      appendRow(SHEETS.GAP, {
        'gap_id': gapId,
        '対象日': toDateStr_(g.対象日),
        'check_id': g.check_id,
        '対象': g.対象,
        '状態': GAP_STATUS.DETECTED,
        '検出日時': nowStr_(),
        '一次確認先staff_id': assignees.join(','),
        '完了日時': ''
      });
      created.push({
        gap_id: gapId,
        対象日: toDateStr_(g.対象日),
        check_id: g.check_id,
        対象: g.対象,
        理由: g.理由,
        assignees: assignees,
        check: check
      });
    });
  });

  logInfo(proc, '新規登録 ' + created.length + '件 / 検出 ' + gaps.length + '件');
  return created;
}

/**
 * 一次確認先のstaff_idを決める。
 * ・シフト希望（確認先役割=本人・対象がstaff_id）→ 本人
 * ・Stage1 → 藤原様・服部様（エスカレーション先フラグ=TRUE）にまとめて確認
 * ・Stage2以降 → S11勤務予定から該当役割の担当者を特定（居なければエスカレーション先へ）
 * @param {Object} check S3の行
 * @param {string} targetDate 対象日
 * @param {string} target 対象（user_code または staff_id）
 * @return {Array.<string>} staff_idの配列
 */
function resolveAssignees_(check, targetDate, target) {
  var fallback = escalationStaff_().map(function (s) { return String(s['staff_id']); });
  if (!check) return fallback;

  // 本人（＝スタッフ自身）に聞く項目
  if (String(check['対象種別']) === 'shift' && String(check['確認先役割']) === '本人') {
    var self = staffById_(target);
    if (self && isTrue_(self['有効'])) return [String(self['staff_id'])];
    return fallback;
  }

  var stage = getSettingNum('stage', 1);
  if (stage <= 1) return fallback;

  // Stage2以降：勤務予定から確認先役割の担当者を探す
  var role = String(check['確認先役割']);
  var onDuty = findRows(SHEETS.SHIFT_PLAN, function (r) {
    return toDateStr_(r['日付']) === toDateStr_(targetDate) && String(r['勤務区分']).indexOf(role) >= 0;
  }).map(function (r) { return String(r['staff_id']); });

  var valid = onDuty.filter(function (id) {
    var s = staffById_(id);
    return s && isTrue_(s['有効']) && String(s['line_user_id'] || '').trim();
  });
  return valid.length ? valid : fallback;
}

/**
 * 翌月を YYYY-MM 形式で返す。
 * @param {Date} base 基準日
 * @return {string} YYYY-MM
 */
function nextMonthStr_(base) {
  var d = new Date(base.getTime());
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  return Utilities.formatDate(d, TZ, 'yyyy-MM');
}

/**
 * 滞留している不足（確認中のまま stale_hours 時間以上経過）を返す（R03の判定部）。
 * 【08】v1.1で17:00エスカレーションは廃止したため、週次ダイジェストから使う。
 * @return {Array.<Object>} S5の行オブジェクト配列
 */
function findStaleGaps_() {
  var limit = getSettingNum('stale_hours', 8) * 3600 * 1000;
  var now = new Date().getTime();
  return findRows(SHEETS.GAP, function (r) {
    if (String(r['状態']) !== GAP_STATUS.ASKING) return false;
    var t = toDateTimeStr_(r['検出日時']);
    if (!t) return false;
    var d = new Date(t.replace(' ', 'T') + ':00+09:00');
    return !isNaN(d.getTime()) && (now - d.getTime()) >= limit;
  });
}
