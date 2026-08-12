/**
 * 回答の訂正
 *
 * 【なぜ要るか】
 * 押し間違いは必ず起きる。いまは一度答えた項目は二度と押せないので、
 * 間違いに気づいた人は「報告」で社員に伝えるしかなく、社員が台帳を手で直していた。
 * 現場の負担が増えるうえ、直したことが記録に残らない。
 *
 * 【どう扱うか】
 * 本人がその場で直せるようにする。ただし**元の回答を消さない**。
 *   ・S6の元のタスクはそのまま残す（いつ・誰が・何と答えたかの履歴）
 *   ・S7の元の記録には「訂正前」の印を付ける
 *   ・訂正後の記録を新しい行として足す（情報源に「訂正」と入る）
 *
 * 監査で問われたときに「間違えて、こう直した」まで説明できる形にしておく。
 * 既存アプリ側も、精査結果＝訂正前／訂正後 を見れば取り違えない。
 */

/** 訂正できる期間（日） @type {number} */
var CORRECT_WITHIN_DAYS = 3;

/**
 * 「訂正」コマンド。直近に自分が答えた項目を選べるようにする。
 * @param {Object} staff 送信したスタッフのS1行
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function offerCorrection_(staff, replyToken) {
  var recent = recentAnswers_(String(staff['staff_id']));
  if (!recent.length) {
    replyRaw_(replyToken, [msgText_('直近' + CORRECT_WITHIN_DAYS + '日で、直せる回答はありません。\n'
      + 'それより前の記録を直したいときは「報告」と送ってください。')]);
    return;
  }

  var actions = recent.slice(0, 4).map(function (t) {
    var gap = findRow(SHEETS.GAP, { 'gap_id': String(t['gap_id']) });
    var check = gap ? checkById_(gap['check_id']) : null;
    var label = (check ? String(check['項目名']) : String(t['gap_id']))
      + '（' + (gap ? formatMd_(toDateStr_(gap['対象日'])) : '') + '）';
    return { label: label, data: 'fix|' + String(t['task_id']) };
  });
  replyRaw_(replyToken, [msgButtons_('回答の訂正', 'どの回答を直しますか？', actions)]);
}

/**
 * その人が直近に答えた項目を新しい順に返す。
 * @param {string} staffId staff_id
 * @return {Array.<Object>} S6の行の配列
 */
function recentAnswers_(staffId) {
  var since = addDays_(todayStr_(), -CORRECT_WITHIN_DAYS);
  return findRows(SHEETS.TASK, function (r) {
    var answeredAt = toDateTimeStr_(r['回答日時']);
    return String(r['送信先staff_id']) === String(staffId)
      && String(r['回答'] || '').trim()
      && !isTrue_(r['追記待ち'])
      && answeredAt && answeredAt.substring(0, 10) >= since;
  }).sort(function (a, b) {
    // 回答日時は分までしか持たないため、同じ分の回答は台帳に入った順（新しい行が後）で並べ直す。
    // これをしないと、直したい「さっきの回答」が一覧の先頭に来ないことがある
    var d = toDateTimeStr_(b['回答日時']).localeCompare(toDateTimeStr_(a['回答日時']));
    return d !== 0 ? d : (Number(b._row || 0) - Number(a._row || 0));
  });
}

/**
 * 訂正する項目が選ばれたので、選択肢をもう一度出す。
 * @param {Object} staff スタッフのS1行
 * @param {string} taskId 直すタスクのid
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function askCorrection_(staff, taskId, replyToken) {
  var task = findRow(SHEETS.TASK, { 'task_id': String(taskId) });
  if (!task || String(task['送信先staff_id']) !== String(staff['staff_id'])) {
    replyRaw_(replyToken, [msgText_('この回答はご自身のものではないため、直せません。')]);
    return;
  }
  var gap = findRow(SHEETS.GAP, { 'gap_id': String(task['gap_id']) });
  var check = gap ? checkById_(gap['check_id']) : null;
  if (!gap || !check) {
    replyRaw_(replyToken, [msgText_('元の項目が見つかりませんでした。「報告」からお知らせください。')]);
    return;
  }

  var choices = expandChoices_(String(check['選択肢'] || ''), gap);
  if (!choices.length) {
    replyRaw_(replyToken, [msgText_('この項目は選択肢がないため、ここでは直せません。「報告」からお知らせください。')]);
    return;
  }
  var items = choices.slice(0, 12).map(function (c) {
    return { label: c, data: 'refix|' + String(task['task_id']) + '|' + c };
  });
  replyRaw_(replyToken, [msgQuickReply_(
    '【訂正】' + String(check['項目名']) + '（' + formatMd_(toDateStr_(gap['対象日'])) + '）\n'
    + '今は「' + answerChoice_(task['回答']) + '」で記録されています。正しいものを選んでください。',
    items)]);
}

/**
 * 訂正の回答を受け取り、履歴を残したまま記録を直す。
 * @param {Object} staff スタッフのS1行
 * @param {string} taskId 直すタスクのid
 * @param {string} value 新しい回答
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function applyCorrection_(staff, taskId, value, replyToken) {
  var proc = 'applyCorrection_';
  var task = findRow(SHEETS.TASK, { 'task_id': String(taskId) });
  if (!task || String(task['送信先staff_id']) !== String(staff['staff_id'])) {
    replyRaw_(replyToken, [msgText_('この回答はご自身のものではないため、直せません。')]);
    return;
  }
  var before = String(task['回答'] || '');
  if (answerChoice_(before) === String(value)) {
    replyRaw_(replyToken, [msgText_('いまと同じ内容でした。記録はそのままです。')]);
    return;
  }

  var gap = findRow(SHEETS.GAP, { 'gap_id': String(task['gap_id']) });
  var check = gap ? checkById_(gap['check_id']) : null;
  if (!gap || !check) {
    replyRaw_(replyToken, [msgText_('元の項目が見つかりませんでした。「報告」からお知らせください。')]);
    return;
  }

  // 1. 元のタスクは履歴として残し、いまの回答だけ書き換える（誰がいつ直したかも残す）
  updateRow(SHEETS.TASK, task._row, {
    '回答': String(value),
    '回答方法': '訂正（前: ' + truncate_(before, 30) + '）',
    '回答日時': nowStr_()
  });

  // 2. 補完台帳の元の記録に「訂正前」の印を付ける（消さない）
  var date = toDateStr_(gap['対象日']);
  var target = String(gap['対象']);
  var item = String(check['項目名']);
  findRows(SHEETS.FILL, function (r) {
    return String(r['gap_id']) === String(gap['gap_id'])
      && String(r['精査結果'] || '') !== '訂正前';
  }).forEach(function (r) {
    updateRow(SHEETS.FILL, r._row, { '精査結果': '訂正前' });
  });

  // 3. 訂正後の記録を新しい行として足す
  var kind = String(check['対象種別']);
  var recorded = (kind === 'shift') ? date.substring(0, 7) + ' ' + value : String(value);
  appendRow(SHEETS.FILL, {
    'fill_id': nextSeqId_(SHEETS.FILL, 'fill_id', 'FIL', 6),
    '対象日': date,
    '対象': target,
    '項目名': item,
    '値': recorded,
    '記入者staff_id': String(staff['staff_id']),
    '取込済フラグ': false,
    '作成日時': nowStr_(),
    'gap_id': String(gap['gap_id']),
    '情報源': fillSourceOf_(gap, staff) + '（訂正）',
    '要精査': false,
    '精査結果': '訂正後'
  });

  // 4. 実績ログも新しい内容にそろえる（1項目1行を保つ）
  var logRow = findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date
      && String(r['対象']) === target
      && String(r['項目名']) === item
      && String(r['対象種別']) === kind;
  })[0];
  if (logRow) {
    updateRow(SHEETS.LOG_IMPORT, logRow._row, {
      '値': recorded, '取込元': 'ai-uribo', '取込日時': nowStr_(), '確度': CERTAINTY.FIXED
    });
  }

  writeLog(proc, '訂正', JSON.stringify({
    task_id: String(task['task_id']), gap_id: String(gap['gap_id']),
    項目: item, 前: before, 後: String(value), 直した人: String(staff['staff_id'])
  }));
  replyRaw_(replyToken, [msgText_('「' + item + '」を「' + value + '」に直しました。\n'
    + '前の回答も履歴として残っています。')]);
}
