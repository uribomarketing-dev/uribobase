/**
 * 台帳初期化スクリプト（06 Step1）
 *
 * initSheets() を1回だけ実行すれば、02_データスキーマ.md のS1〜S11が
 * ヘッダー付きで生成され、S1スタッフ4名・S3チェック項目・S8設定値が投入される。
 * 既存シートは上書きせずスキップし、実行ログ（S10）に記録する。
 */

/**
 * 台帳の全シートを生成し、初期データを投入する。
 * 何度実行しても既存データは壊さない（冪等）。
 * @return {string} 実行結果のサマリ
 */
function initSheets() {
  var proc = 'initSheets';
  var book = book_();
  var created = [];
  var skipped = [];

  // S10だけは先に作る（以降の処理でログを書くため）
  ensureSheet_(book, SHEET_DEFS.filter(function (d) { return d.name === SHEETS.RUN_LOG; })[0], created, skipped);
  logStart(proc);

  SHEET_DEFS.forEach(function (def) {
    if (def.name === SHEETS.RUN_LOG) return;
    safely_(proc, function () { ensureSheet_(book, def, created, skipped); });
  });

  var seeded = [];
  safely_(proc, function () { if (seedStaff_()) seeded.push('S1スタッフ4名'); });
  safely_(proc, function () { if (seedChecks_()) seeded.push('S3チェック項目' + INITIAL_CHECKS.length + '件'); });
  safely_(proc, function () { if (seedSettings_()) seeded.push('S8設定' + DEFAULT_SETTINGS.length + '件'); });
  safely_(proc, function () { removeDefaultSheet_(book); });
  clearSettingCache();

  var summary = '作成: ' + (created.join(', ') || 'なし')
    + ' / 既存のためスキップ: ' + (skipped.join(', ') || 'なし')
    + ' / 初期データ投入: ' + (seeded.join(', ') || 'なし（既にデータあり）');
  logInfo(proc, summary);
  return summary;
}

/**
 * シートが無ければ作り、ヘッダーを整える。
 * @param {Spreadsheet} book スプレッドシート
 * @param {{name:string, headers:Array.<string>, note:string}} def シート定義
 * @param {Array.<string>} created 作成したシート名の配列（追記される）
 * @param {Array.<string>} skipped スキップしたシート名の配列（追記される）
 * @return {Sheet} シート
 */
function ensureSheet_(book, def, created, skipped) {
  var sh = book.getSheetByName(def.name);
  if (sh) {
    skipped.push(def.name);
    return sh;
  }
  sh = book.insertSheet(def.name);
  sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers])
    .setFontWeight('bold').setBackground('#EFEFEF');
  sh.setFrozenRows(1);
  sh.getRange(1, 1).setNote(def.note);
  if (sh.getMaxColumns() > def.headers.length) {
    sh.deleteColumns(def.headers.length + 1, sh.getMaxColumns() - def.headers.length);
  }
  created.push(def.name);
  return sh;
}

/**
 * 新規スプレッドシートに残っている既定シート「シート1」を削除する。
 * @param {Spreadsheet} book スプレッドシート
 * @return {void}
 */
function removeDefaultSheet_(book) {
  ['シート1', 'Sheet1'].forEach(function (name) {
    var sh = book.getSheetByName(name);
    if (sh && book.getSheets().length > 1 && sh.getLastRow() === 0) book.deleteSheet(sh);
  });
}

/**
 * S1スタッフマスタに初期4名を投入する（既にデータがあれば何もしない）。
 * @return {boolean} 投入したらtrue
 */
function seedStaff_() {
  if (findRows(SHEETS.STAFF).length > 0) return false;
  var sh = sheet_(SHEETS.STAFF);
  sh.getRange(2, 1, INITIAL_STAFF.length, INITIAL_STAFF[0].length).setValues(INITIAL_STAFF);
  sh.getRange(2, 4).setNote('兼崎様のフルネームは友だち追加時に確認して氏名列を更新すること');
  return true;
}

/**
 * S3チェック項目マスタに初期項目を投入する（既にデータがあれば何もしない）。
 * @return {boolean} 投入したらtrue
 */
function seedChecks_() {
  if (findRows(SHEETS.CHECK).length > 0) return false;
  var sh = sheet_(SHEETS.CHECK);
  sh.getRange(2, 1, INITIAL_CHECKS.length, INITIAL_CHECKS[0].length).setValues(INITIAL_CHECKS);
  return true;
}

/**
 * S8設定に初期値を投入する（既にデータがあれば不足キーのみ追加）。
 * @return {boolean} 投入したらtrue
 */
function seedSettings_() {
  var existing = {};
  findRows(SHEETS.SETTING).forEach(function (r) { existing[String(r['キー'])] = true; });
  var add = DEFAULT_SETTINGS.filter(function (s) { return !existing[s[0]]; });
  if (!add.length) return false;
  var sh = sheet_(SHEETS.SETTING);
  sh.getRange(sh.getLastRow() + 1, 1, add.length, 3).setValues(add);
  clearSettingCache();
  return true;
}

/**
 * セットアップ状態を点検して結果を返す（人間の確認用）。
 * メニュー「AI Uribo」→「セットアップ点検」から実行できる。
 * @return {string} 点検結果
 */
function checkSetup() {
  var out = [];
  var props = PropertiesService.getScriptProperties();
  SHEET_DEFS.forEach(function (d) {
    out.push((book_().getSheetByName(d.name) ? '○ ' : '× ') + d.name);
  });
  out.push((props.getProperty(PROP.TOKEN) ? '○ ' : '× ') + 'スクリプトプロパティ ' + PROP.TOKEN);
  out.push((props.getProperty(PROP.SECRET) ? '○ ' : '× ') + 'スクリプトプロパティ ' + PROP.SECRET);
  out.push((props.getProperty(PROP.WEBHOOK_KEY) ? '○ ' : '× ') + 'スクリプトプロパティ ' + PROP.WEBHOOK_KEY);
  var staff = findRows(SHEETS.STAFF, function (r) { return isTrue_(r['有効']); });
  var linked = staff.filter(function (r) { return String(r['line_user_id'] || '').trim(); });
  out.push('有効スタッフ ' + staff.length + '名 / LINE紐付け済み ' + linked.length + '名');
  var triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  ['morningBatch', 'nightBatch', 'weeklyDigest', 'dailyBackup', 'flushQueue'].forEach(function (f) {
    out.push((triggers.indexOf(f) >= 0 ? '○ ' : '× ') + 'トリガー ' + f);
  });
  var text = out.join('\n');
  logInfo('checkSetup', text);
  return text;
}

/**
 * スプレッドシートを開いたときにメニューを追加する。
 * @return {void}
 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('AI Uribo')
    .addItem('台帳を初期化する（initSheets）', 'initSheets')
    .addItem('セットアップ点検', 'menuCheckSetup_')
    .addSeparator()
    .addItem('朝バッチを今すぐ実行', 'morningBatch')
    .addItem('夜の確認セットを今すぐ実行', 'nightBatch')
    .addItem('週次ダイジェストを今すぐ実行', 'weeklyDigest')
    .addItem('バックアップを今すぐ実行', 'dailyBackup')
    .addSeparator()
    .addItem('トリガーを設定する（installTriggers）', 'installTriggers')
    .addToUi();
}

/**
 * メニューからセットアップ点検を実行し、結果をダイアログ表示する。
 * @return {void}
 */
function menuCheckSetup_() {
  SpreadsheetApp.getUi().alert('AI Uribo セットアップ点検', checkSetup(), SpreadsheetApp.getUi().ButtonSet.OK);
}
