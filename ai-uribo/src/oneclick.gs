/**
 * 手作業をなくすためのひとまとめ機能
 *
 * 【なぜ要るか】
 * 2026-08-13、本番のセットアップを通してみて、人にしか押せない操作が
 * 思ったより多く残っていることが分かった。しかもそのうちいくつかは
 * 「S8設定の値を一時的に書き換えて、試して、元に戻す」といった
 * **戻し忘れると事故になる**種類のものだった。
 *
 * ここではそれらを1クリックにまとめる。原則は3つ。
 *   ・危ない一時変更は、機能として閉じ込める（人が設定値をいじらない）
 *   ・繰り返しの入力は、まとめて貼れるようにする
 *   ・押した結果が何だったかを、必ず言葉で返す
 */

/** リハーサル中かどうかを覚えておくキャッシュキー @type {string} */
var REHEARSAL_KEY = 'ai_uribo_rehearsal';

/**
 * いまリハーサル実行中か。
 * detect.gs の R01（シフト希望）が、日付の条件を飛ばすかどうかの判定に使う。
 * @return {boolean} リハーサル中ならtrue
 */
function isRehearsal_() {
  try {
    return CacheService.getScriptCache().get(REHEARSAL_KEY) === '1';
  } catch (e) {
    return false;
  }
}

/**
 * シフト希望のリハーサルを1回だけ実行する。
 *
 * 通常は毎月20〜25日にしか出ない質問を、その場で1回だけ出す。
 * 設定値（shift_request_day）は**触らない**ので、戻し忘れの事故が起きない。
 * @return {string} 実行結果
 */
function rehearseShiftRequest() {
  var proc = 'rehearseShiftRequest';
  var cache = CacheService.getScriptCache();
  cache.put(REHEARSAL_KEY, '1', 300);   // 5分だけ有効（消し忘れても勝手に元へ戻る）
  try {
    logStart(proc);
    var result = morningBatch();
    logInfo(proc, result);
    return 'リハーサルを実行しました。\n\n' + result
      + '\n\n※設定は変えていません。次からは通常どおり、毎月'
      + getSettingNum('shift_request_day', 20) + '日〜'
      + getSettingNum('shift_deadline_day', 25) + '日にだけ届きます。';
  } finally {
    cache.remove(REHEARSAL_KEY);
  }
}

/**
 * メニューからシフト希望のリハーサルを実行する。
 * @return {void}
 */
function menuRehearseShift_() {
  var ui = SpreadsheetApp.getUi();
  var live = !isTrue_(getSetting('test_mode', 'FALSE'));
  var res = ui.alert('シフト希望のリハーサル',
    (live ? '【本番モード】実際にLINEへ届きます。\n\n'
          : '【テストモード】LINEには送らず、S6に記録するだけです。\n\n')
    + '有効なスタッフ全員に、来月分のシフト希望の質問を1回だけお送りします。\n'
    + '設定は変更しません（戻し忘れの心配はありません）。\n\n実行しますか？',
    ui.ButtonSet.OK_CANCEL);
  if (res !== ui.Button.OK) return;
  ui.alert('リハーサル結果', rehearseShiftRequest(), ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// 本番運用の開始・停止（S8設定を人が探して書き換えなくて済むように）
// ---------------------------------------------------------------------------

/**
 * テストモードを切り替える。
 * @param {boolean} on trueでテストモードON（送らない）
 * @return {string} 結果の説明
 */
function setTestMode(on) {
  var proc = 'setTestMode';
  var row = findRow(SHEETS.SETTING, { 'キー': 'test_mode' });
  if (!row) return 'S8_設定に test_mode が見つかりません。先に「② はじめの設定」を実行してください。';
  updateRow(SHEETS.SETTING, row._row, { '値': on ? 'TRUE' : 'FALSE' });
  clearSettingCache();
  logInfo(proc, on ? 'テストモードON（送信しない）' : 'テストモードOFF（本番運用）');
  return on
    ? 'テストモードにしました。LINEには送らず、送るはずだった内容をS6に記録します。'
    : '本番運用を開始しました。ここからは実際にLINEへ届きます。';
}

/**
 * メニューから本番運用を開始する。
 * @return {void}
 */
function menuGoLive_() {
  var ui = SpreadsheetApp.getUi();
  var linked = findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && String(r['line_user_id'] || '').trim();
  }).length;
  var waiting = findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && !String(r['line_user_id'] || '').trim();
  });

  var msg = '実際にLINEへ届くようになります。\n\n'
    + '・LINE登録済み：' + linked + '名\n';
  if (waiting.length) {
    msg += '・未登録：' + waiting.length + '名（'
      + waiting.map(function (r) { return String(r['氏名']); }).join('・') + '）\n'
      + '　→ この方々には届きません。テストに入れないなら、S1の「有効」をFALSEにしてください\n';
  }
  msg += '\n開始しますか？（あとから「テストモードに戻す」でいつでも止められます）';

  if (ui.alert('本番運用の開始', msg, ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  ui.alert('本番運用', setTestMode(false), ui.ButtonSet.OK);
}

/**
 * メニューからテストモードに戻す。
 * @return {void}
 */
function menuGoTest_() {
  SpreadsheetApp.getUi().alert('テストモード', setTestMode(true), SpreadsheetApp.getUi().ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// 利用者のまとめ登録（1人ずつ入力させない）
// ---------------------------------------------------------------------------

/**
 * 利用者をまとめて登録する。
 *
 * 1人ずつダイアログに入力すると、6人で12回の入力になる。
 * 名簿から貼り付けられるようにして、1回で済ませる。
 *
 * 受ける書き方（1行1人。区切りはタブ・カンマ・スペースのどれでもよい）：
 *   清水  山田太郎
 *   玉里,佐藤花子
 *   玉里 田中一郎
 * 拠点を省いた行は、直前の行の拠点を引き継ぐ（名簿が拠点ごとに並んでいることが多いため）。
 * 「清水」「【清水】」のような拠点だけの行は、見出しとして扱う。
 *
 * @param {string} text 貼り付けた名簿
 * @return {string} 登録結果
 */
function addUsersBulk(text) {
  var proc = 'addUsersBulk';
  var lines = String(text || '').split(/\r?\n/);
  var added = [];
  var skipped = [];
  var site = '';

  lines.forEach(function (raw) {
    var line = String(raw).replace(/[【】\[\]]/g, '').trim();
    if (!line) return;

    var parts = line.split(/[\t,、，\s]+/).filter(function (p) { return p; });

    // 拠点だけの行＝見出し
    if (parts.length === 1 && isSiteWord_(parts[0])) { site = parts[0]; return; }

    var s = site;
    var name = parts.join(' ');
    if (parts.length >= 2 && isSiteWord_(parts[0])) {
      s = parts[0];
      name = parts.slice(1).join(' ');
    }
    if (!s) { skipped.push(line + '（拠点が分かりません）'); return; }
    if (!name) return;

    var r = safely_(proc, function () { return addUser(s, name); }, '');
    if (String(r).indexOf('を登録しました') >= 0) added.push(s + '：' + name);
    else skipped.push(line + '（' + r + '）');
  });

  var msg = '登録：' + added.length + '名';
  if (added.length) msg += '\n' + added.map(function (a) { return '・' + a; }).join('\n');
  if (skipped.length) msg += '\n\n登録できなかった行：\n' + skipped.map(function (a) { return '・' + a; }).join('\n');
  msg += '\n\n※氏名はS9_対応表にだけ入ります。他のシートには記号（SMZ01など）しか残りません。';
  logInfo(proc, '登録' + added.length + '名 / 見送り' + skipped.length + '件（氏名はログに残しません）');
  return msg;
}

/**
 * 拠点名らしい語かどうか。
 * @param {string} word 語
 * @return {boolean} 拠点名らしければtrue
 */
function isSiteWord_(word) {
  var w = String(word).trim();
  if (!w) return false;
  // すでに台帳にある拠点名は確実に拠点
  var known = {};
  safely_('isSiteWord_', function () {
    findRows(SHEETS.USER).forEach(function (r) { if (r['拠点']) known[String(r['拠点'])] = true; });
    findRows(SHEETS.STAFF).forEach(function (r) { if (r['拠点']) known[String(r['拠点'])] = true; });
  });
  if (known[w]) return true;
  return /^(うりぼベース)?(清水|玉里)$/.test(w) || /ホーム$|ベース$|拠点$/.test(w);
}

/**
 * メニューから利用者をまとめて登録する。
 * @return {void}
 */
function menuAddUsersBulk_() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('利用者をまとめて登録',
    '1行1人で貼り付けてください（拠点と氏名）。\n\n'
    + '例：\n'
    + '清水\n'
    + '山田太郎\n'
    + '佐藤花子\n'
    + '玉里\n'
    + '田中一郎\n\n'
    + '「玉里 田中一郎」のように1行に書いても構いません。\n'
    + '氏名はS9_対応表にだけ入り、他のシートには記号しか残りません。',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  ui.alert('登録結果', addUsersBulk(String(res.getResponseText())), ui.ButtonSet.OK);
}

// ---------------------------------------------------------------------------
// SwitchBotのトークン入力（スクリプトプロパティを手で触らせない）
// ---------------------------------------------------------------------------

/**
 * SwitchBotのトークンとシークレットを設定する。
 * @param {string} token トークン
 * @param {string} secret シークレット
 * @return {string} 結果
 */
function setSwitchbotSecrets(token, secret) {
  var proc = 'setSwitchbotSecrets';
  var props = PropertiesService.getScriptProperties();
  var t = String(token || '').trim();
  var s = String(secret || '').trim();
  if (!t || !s) return 'トークンとシークレットの両方が必要です（片方だけでは動きません）。';
  props.setProperty('SWITCHBOT_TOKEN', t);
  props.setProperty('SWITCHBOT_SECRET', s);
  logInfo(proc, 'SwitchBotの認証情報を設定しました（値はログに残しません）');
  return 'SwitchBotにつなぎました。\n\n'
    + '続けてメニュー「SwitchBot機器を読み込む」を押すと、'
    + 'アカウントにある機器がS12_機器マスタに並びます。';
}

/**
 * メニューからSwitchBotのトークンを入力する。
 * @return {void}
 */
function menuSetSwitchbot_() {
  var ui = SpreadsheetApp.getUi();
  var t = ui.prompt('SwitchBotをつなぐ（1/2）',
    'SwitchBotアプリ → プロフィール → 設定 → 「アプリバージョン」を10回連打\n'
    + '→ 開発者向けオプション → トークンをコピーして貼り付けてください。',
    ui.ButtonSet.OK_CANCEL);
  if (t.getSelectedButton() !== ui.Button.OK) return;
  var s = ui.prompt('SwitchBotをつなぐ（2/2）',
    '同じ画面の「シークレット（クライアントシークレット）」を貼り付けてください。',
    ui.ButtonSet.OK_CANCEL);
  if (s.getSelectedButton() !== ui.Button.OK) return;
  ui.alert('SwitchBot',
    setSwitchbotSecrets(String(t.getResponseText()), String(s.getResponseText())),
    ui.ButtonSet.OK);
}
