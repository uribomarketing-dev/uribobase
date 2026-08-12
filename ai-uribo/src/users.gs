/**
 * 利用者の登録と、支援記録（Phase2）の有効化
 *
 * 【氏名の置き場所】
 * 台帳の本体（S2〜S7）に利用者の氏名は置かない。置くのは記号（user_code）だけ。
 * 氏名はS9_対応表にだけ持ち、LINEの文面を作るときにその場で差し替える。
 * こうしておくと、台帳を人に見せたりCSVで渡したりしても、そこに氏名は出てこない。
 *
 * 【使い方】
 *   メニュー「AI Uribo」→「利用者を登録する」で1人ずつ登録する（拠点と氏名だけ）。
 *   自動データを使う利用者は、S2の「服薬自動／在否自動／日中自動」をTRUEにする。
 *   全員の登録が済んだら「支援記録の質問を開始する（Phase2）」を実行する。
 *
 * 診断名・病名・障害区分などの医療情報は、この台帳では一切扱わない。
 */

/**
 * 利用者を1人登録する（すでにあれば拠点・氏名を更新する）。
 * @param {string} site 拠点（例：清水／玉里）
 * @param {string} name 氏名（S9_対応表にだけ入る）
 * @param {string} [userCode] user_code（省略すると自動採番）
 * @return {string} 実行結果のメッセージ
 */
function addUser(site, name, userCode) {
  var proc = 'addUser';
  return withLock_(proc, 20000, function () {
    var siteText = String(site || '').trim();
    var nameText = String(name || '').trim();
    if (!siteText) return '拠点を入力してください（例：清水／玉里）';
    if (!nameText) return '氏名を入力してください（氏名はS9_対応表にだけ入り、他のシートには出ません）';

    var code = String(userCode || '').trim() || nextUserCode_();
    var existing = findRow(SHEETS.USER, { 'user_code': code });
    if (existing) {
      updateRow(SHEETS.USER, existing._row, { '拠点': siteText, '有効': true });
    } else {
      appendRow(SHEETS.USER, {
        'user_code': code,
        '拠点': siteText,
        // 自動データを使うかは利用者ごとに人が決める（機器が付いている方だけTRUEにする）
        '自動ログ対応': false,
        '服薬自動': false,
        '在否自動': false,
        '日中自動': false,
        '有効': true
      });
    }
    setDisplayName_(code, nameText);
    logInfo(proc, code + ' を登録しました（拠点: ' + siteText + '／氏名はS9のみ）');
    return code + ' を登録しました（拠点：' + siteText + '）。\n'
      + '自動データを使う場合は、S2_利用者マスタの「服薬自動／在否自動／日中自動」をTRUEにしてください。';
  });
}

/**
 * 利用者を登録から外す（行は消さず、有効=FALSEにする）。
 * 過去の記録との対応が取れなくなるため、行そのものは残す。
 * @param {string} userCode user_code
 * @return {string} 実行結果のメッセージ
 */
function retireUser(userCode) {
  var proc = 'retireUser';
  return withLock_(proc, 20000, function () {
    var row = findRow(SHEETS.USER, { 'user_code': String(userCode).trim() });
    if (!row) return 'user_codeが見つかりません: ' + userCode;
    updateRow(SHEETS.USER, row._row, { '有効': false });
    logInfo(proc, userCode + ' を有効=FALSEにしました（過去の記録は残ります）');
    return userCode + ' を対象外にしました。過去の記録はそのまま残ります。';
  });
}

/**
 * 次のuser_codeを採番する。
 * @return {string} user_code
 */
function nextUserCode_() {
  return nextSeqId_(SHEETS.USER, 'user_code', 'U', 3);
}

/**
 * S9_対応表に氏名を登録する（同じコードがあれば上書き）。
 * @param {string} code user_code
 * @param {string} name 氏名
 * @return {void}
 */
function setDisplayName_(code, name) {
  var row = findRow(SHEETS.NAME_MAP, { 'コード': code });
  if (row) {
    updateRow(SHEETS.NAME_MAP, row._row, { '氏名': name, '種別': '利用者' });
  } else {
    appendRow(SHEETS.NAME_MAP, { 'コード': code, '氏名': name, '種別': '利用者' });
  }
  displayName_._src = null;   // 氏名の対応表を読み直させる
}

/**
 * 登録済みの利用者を一覧にする（この文はメニューの中だけで表示する）。
 * @return {string} 一覧
 */
function listUsers() {
  var rows = findRows(SHEETS.USER);
  if (!rows.length) return 'まだ登録がありません。メニュー「利用者を登録する」から追加してください。';
  var lines = ['【利用者】' + rows.length + '名'];
  rows.forEach(function (r) {
    var autos = ['服薬自動', '在否自動', '日中自動'].filter(function (k) { return isTrue_(r[k]); });
    lines.push((isTrue_(r['有効']) ? '○ ' : '－ ') + r['user_code'] + '　' + displayName_(String(r['user_code']))
      + '（' + (r['拠点'] || '拠点未設定') + '）'
      + (autos.length ? '　自動：' + autos.join('・') : '　自動：なし'));
  });
  return lines.join('\n');
}

/**
 * 支援記録の質問（Phase2の優先度A）を開始する。
 *
 * 利用者が1人も登録されていないうちに開始すると、質問が作られないまま
 * 「動いていない」ように見えてしまうため、登録を確認してから有効化する。
 * @return {string} 実行結果のメッセージ
 */
function enablePhase2() {
  var proc = 'enablePhase2';
  return withLock_(proc, 20000, function () {
    var users = findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); });
    if (!users.length) {
      return '利用者がまだ登録されていません。先にメニュー「利用者を登録する」から登録してください。';
    }

    var enabled = [];
    findRows(SHEETS.CHECK, function (r) {
      return String(r['優先度']) === 'A'
        && String(r['判定ルールID']) !== '-'
        && ['support', 'plan'].indexOf(String(r['対象種別'])) >= 0
        && !isTrue_(r['有効']);
    }).forEach(function (c) {
      updateRow(SHEETS.CHECK, c._row, { '有効': true });
      enabled.push(String(c['check_id']) + ' ' + String(c['項目名']));
    });
    checkById_._map = null;

    var summary = enabled.length
      ? '支援記録の質問を開始しました（' + enabled.length + '項目）：\n・' + enabled.join('\n・')
      : '支援記録の質問はすでに開始しています。';
    logInfo(proc, summary.replace(/\n/g, ' / '));
    return summary + '\n\n利用者' + users.length + '名が対象です。'
      + '翌朝10:00の確認から質問が届きます（すぐ試すならメニュー「朝バッチを今すぐ実行」）。';
  });
}

/**
 * 支援記録の質問をいったん止める（優先度A・Bともに無効化する）。
 * 質問が多すぎたときに、すぐ静かにできる逃げ道として用意しておく。
 * @return {string} 実行結果のメッセージ
 */
function disablePhase2() {
  var proc = 'disablePhase2';
  return withLock_(proc, 20000, function () {
    var off = 0;
    findRows(SHEETS.CHECK, function (r) {
      return ['support', 'plan'].indexOf(String(r['対象種別'])) >= 0 && isTrue_(r['有効']);
    }).forEach(function (c) {
      updateRow(SHEETS.CHECK, c._row, { '有効': false });
      off++;
    });
    checkById_._map = null;
    logInfo(proc, '支援記録の質問を' + off + '項目とめました');
    return '支援記録の質問を' + off + '項目とめました（シフト希望の確認は続きます）。';
  });
}

/**
 * メニューから利用者を登録する。
 * @return {void}
 */
function menuAddUser_() {
  var ui = SpreadsheetApp.getUi();
  var site = ui.prompt('利用者の登録（1/2）', '拠点を入力してください（例：清水／玉里）', ui.ButtonSet.OK_CANCEL);
  if (site.getSelectedButton() !== ui.Button.OK) return;
  var name = ui.prompt('利用者の登録（2/2）',
    '氏名を入力してください。\n※氏名はS9_対応表にだけ保存され、他のシートには記号だけが残ります。',
    ui.ButtonSet.OK_CANCEL);
  if (name.getSelectedButton() !== ui.Button.OK) return;
  ui.alert('利用者の登録', addUser(String(site.getResponseText()), String(name.getResponseText())),
    ui.ButtonSet.OK);
}

/**
 * メニューから利用者一覧を表示する。
 * @return {void}
 */
function menuListUsers_() {
  SpreadsheetApp.getUi().alert('登録済みの利用者', listUsers(), SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * メニューから支援記録の質問を開始する。
 * @return {void}
 */
function menuEnablePhase2_() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.alert('支援記録の質問を開始しますか？',
    listUsers() + '\n\nこの方々について、毎日の支援記録の確認（在否・食事・服薬など）が始まります。',
    ui.ButtonSet.OK_CANCEL);
  if (res !== ui.Button.OK) return;
  ui.alert('支援記録の質問', enablePhase2(), ui.ButtonSet.OK);
}
