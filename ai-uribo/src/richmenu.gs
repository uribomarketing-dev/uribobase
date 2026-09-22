/**
 * 夜勤メニュー（LINEのリッチメニュー）から届く言葉を受ける
 *
 * 【なぜ要るか】
 * 2026-08-15 0:55、LINEに「夜勤メニュー」というボタンの並びが配られた。
 * ところがボタンを押すと「ふりかえり」「食事」といった言葉が送られてくるだけで、
 * AI Uribo側にその言葉を受ける口が無く、どのボタンを押しても
 * 「ボタンでお答えください」としか返らない状態になっていた。
 *
 * ボタンは現場にとっていちばん分かりやすい入口なので、
 * ここで受けて「その場で聞き直す」動きにつなぐ。
 *
 * 【考え方】
 * 朝10時・夜の確認セットを待たずに、押したその場で不足を洗い直して質問を出す。
 * 出すものが無ければ「いまお尋ねすることはありません」と正直に返し、
 * なぜ無いのか（まだ質問を始めていない等）まで書く。
 * 黙って何も返さないのがいちばん困る。
 */

/**
 * 夜勤メニューのボタンが送ってくる言葉と、その中身。
 *
 *   rules  … その場で洗い直す検出ルール
 *   kinds  … 対象種別（support＝支援記録／plan＝明日の予定／shift＝シフト希望）
 *   checks … 特定の項目だけに絞りたいときのcheck_id
 * @type {Object.<string,Object>}
 */
var MENU_WORDS = {
  'ふりかえり': {
    title: '【ふりかえり】昨日の様子と明日の予定',
    rules: ['R02', 'R04'],
    kinds: ['support', 'plan']
  },
  '支援記録': {
    title: '【支援記録】昨日の記録で埋まっていないもの',
    rules: ['R02'],
    kinds: ['support']
  },
  '記録': {
    title: '【支援記録】昨日の記録で埋まっていないもの',
    rules: ['R02'],
    kinds: ['support']
  },
  '食事提供表': {
    title: '【食事提供】',
    rules: ['R02', 'R04'],
    checks: ['CHK105', 'CHK205']
  },
  '食事': {
    title: '【食事提供】',
    rules: ['R02', 'R04'],
    checks: ['CHK105', 'CHK205']
  },
  '予定を登録': {
    title: '【明日の予定】',
    rules: ['R04'],
    kinds: ['plan']
  },
  '予定': {
    title: '【明日の予定】',
    rules: ['R04'],
    kinds: ['plan']
  },
  'シフト希望': {
    title: '【シフト希望】',
    rules: ['R01'],
    kinds: ['shift']
  }
};

/**
 * 夜勤メニューの言葉として処理できたか。
 * @param {Object} staff スタッフのS1行
 * @param {string} text 送られてきた言葉
 * @param {string} replyToken 返信トークン
 * @param {string} proc ログ用の処理名
 * @return {boolean} 処理したらtrue（呼び出し側はそこで終わる）
 */
function handleMenuWord_(staff, text, replyToken, proc) {
  var spec = MENU_WORDS[String(text).trim()];
  if (!spec) return false;

  var staffId = String(staff['staff_id']);
  var today = todayStr_();

  // 朝10時・夜の確認セットを待たずに、その場で洗い直す
  safely_(proc, function () {
    if (spec.rules.indexOf('R02') >= 0) registerGaps(detectGaps(addDays_(today, -1), ['R02']));
    if (spec.rules.indexOf('R04') >= 0) registerGaps(detectGaps(addDays_(today, 1), ['R04']));
    if (spec.rules.indexOf('R01') >= 0) registerGaps(detectGaps(today, ['R01']));
  });

  var list = pendingGaps_(function (gap, check) {
    if (!check) return false;
    if (spec.checks) return spec.checks.indexOf(String(check['check_id'])) >= 0;
    return spec.kinds.indexOf(String(check['対象種別'])) >= 0;
  });
  list = forSiteOf_(list, staffId);
  list = excludeAlreadyAsked_(list, staffId);

  if (!list.length) {
    replyRaw_(replyToken, [msgText_(spec.title + '\n\nいまお尋ねすることはありません。\n'
      + menuEmptyReason_(spec))]);
    logInfo(proc, staff['氏名'] + ' が「' + text + '」を押した（お尋ねすることなし）');
    return true;
  }

  replyRaw_(replyToken, [msgText_(spec.title + '\n' + list.length + '件あります。'
    + '順番にお送りしますので、ボタンでお答えください。')]);
  var r = createAndSendSet(staffId, list, spec.title);
  logInfo(proc, staff['氏名'] + ' が「' + text + '」を押した（' + r.count + '件を送信）');
  return true;
}

/**
 * お尋ねすることが無いときに、なぜ無いのかを説明する。
 *
 * 「ありません」だけ返すと、壊れているのか正常なのか現場から見分けがつかない。
 * @param {Object} spec MENU_WORDS の中身
 * @return {string} 説明文
 */
function menuEmptyReason_(spec) {
  var kinds = spec.kinds || [];
  var wantSupport = kinds.indexOf('support') >= 0 || (spec.checks || []).join(',').indexOf('CHK1') >= 0;
  var wantPlan = kinds.indexOf('plan') >= 0 || (spec.checks || []).join(',').indexOf('CHK2') >= 0;

  var onSupport = enabledCheckCount_('support');
  var onPlan = enabledCheckCount_('plan');

  if (wantSupport && !onSupport && wantPlan && !onPlan) {
    return '（支援記録の質問がまだ始まっていません。'
      + '社員が台帳のメニュー「支援記録の質問を開始する」を押すと始まります）';
  }
  if (wantSupport && !onSupport) {
    return '（支援記録の質問がまだ始まっていません。'
      + '社員が台帳のメニュー「支援記録の質問を開始する」を押すと始まります）';
  }
  if (wantPlan && !onPlan) {
    return '（明日の予定の確認がまだ始まっていません。'
      + '社員が台帳のメニュー「支援記録の質問を開始する」を押すと始まります）';
  }
  if (!findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); }).length) {
    return '（利用者がまだ登録されていません）';
  }
  return '（もう埋まっているか、すでにお送りした分にお答えいただいています）';
}

/**
 * その対象種別で有効になっているチェック項目の数。
 * @param {string} kind 対象種別（support / plan / shift）
 * @return {number} 有効な項目数
 */
function enabledCheckCount_(kind) {
  return findRows(SHEETS.CHECK, function (r) {
    return String(r['対象種別']) === kind && isTrue_(r['有効']);
  }).length;
}
