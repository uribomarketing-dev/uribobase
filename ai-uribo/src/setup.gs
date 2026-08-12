/**
 * 台帳初期化スクリプト（06 Step1）
 *
 * initSheets() を1回だけ実行すれば、02_データスキーマ.md のS1〜S12が
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
    var added = addMissingHeaders_(sh, def);
    skipped.push(def.name + (added.length ? '（列を追加: ' + added.join('・') + '）' : ''));
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
  invalidateCache_(def.name);
  return sh;
}

/**
 * すでにあるシートに、定義には有るのに実物に無い列を末尾へ足す。
 *
 * バージョンアップで列が増えたとき、藤原様が台帳を作り直さなくて済むようにするための処理。
 * 既存の列は並べ替えも改名もしない（既存データを壊さないため、足すだけ）。
 * @param {Sheet} sh シート
 * @param {{name:string, headers:Array.<string>, note:string}} def シート定義
 * @return {Array.<string>} 追加した列名
 */
function addMissingHeaders_(sh, def) {
  var width = Math.max(sh.getLastColumn(), 1);
  var current = sh.getRange(1, 1, 1, width).getValues()[0].map(function (v) { return String(v).trim(); });
  var missing = def.headers.filter(function (h) { return current.indexOf(h) < 0; });
  if (!missing.length) return [];

  var start = current.length + 1;
  if (sh.getMaxColumns() < current.length + missing.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), current.length + missing.length - sh.getMaxColumns());
  }
  sh.getRange(1, start, 1, missing.length).setValues([missing])
    .setFontWeight('bold').setBackground('#EFEFEF');
  sh.getRange(1, 1).setNote(def.note);
  invalidateCache_(def.name);
  logInfo('addMissingHeaders_', def.name + ' に列を追加: ' + missing.join('・'));
  return missing;
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
  var values = INITIAL_STAFF.map(function (row) {
    var copy = row.slice();
    copy[7] = makeRegistrationCode_();   // 登録コードを自動発行
    return copy;
  });
  sh.getRange(2, 1, values.length, values[0].length).setValues(values);
  sh.getRange(2, 4).setNote('兼崎様のフルネームは友だち追加時に確認して氏名列を更新すること');
  sh.getRange(1, 8).setNote('本人にだけ個別に伝えるコード。LINEでこのコードを送ってもらうと紐付く。'
    + '紐付いたら自動で消える。再発行はメニュー「AI Uribo」→「登録コードを発行」から');
  invalidateCache_(SHEETS.STAFF);
  return true;
}

/**
 * 登録コードを（再）発行する。メニューから実行し、表示されたコードを本人にだけ伝える。
 * すでにLINEと紐付いているスタッフに発行すると、紐付けを解除して付け直しになる。
 * @param {string} [staffId] staff_id（省略時はダイアログで入力）
 * @return {string} 発行結果のメッセージ
 */
function issueRegistrationCode(staffId) {
  var proc = 'issueRegistrationCode';
  return withLock_(proc, 20000, function () {
    var staff = staffId ? staffById_(staffId) : null;
    if (!staff) {
      var msg = 'staff_idが見つかりません: ' + staffId;
      logWarn(proc, msg);
      return msg;
    }
    var code = makeRegistrationCode_();
    updateRow(SHEETS.STAFF, staff._row, { '登録コード': code, 'line_user_id': '' });
    logInfo(proc, staff['氏名'] + ' の登録コードを再発行（コード自体はログに残さない）');
    return staff['氏名'] + ' さんの登録コード：' + code
      + '\n※本人にだけ伝えてください。LINEでこのコードを送ると登録されます。';
  });
}

/**
 * メニューから登録コードを発行する。
 * @return {void}
 */
function menuIssueCode_() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('登録コードの発行', 'staff_id を入力してください（例：STF001）', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  ui.alert('登録コード', issueRegistrationCode(String(res.getResponseText()).trim()), ui.ButtonSet.OK);
}

/**
 * S3チェック項目マスタに初期項目を投入する（既にデータがあれば何もしない）。
 * @return {boolean} 投入したらtrue
 */
function seedChecks_() {
  if (findRows(SHEETS.CHECK).length > 0) return false;
  var sh = sheet_(SHEETS.CHECK);
  var width = readTable(SHEETS.CHECK).headers.length;
  // 行ごとに列数が違っても崩れないよう、ヘッダーの列数にそろえる
  var values = INITIAL_CHECKS.map(function (row) {
    var copy = row.slice();
    while (copy.length < width) copy.push('');
    return copy.slice(0, width);
  });
  sh.getRange(2, 1, values.length, width).setValues(values);
  invalidateCache_(SHEETS.CHECK);
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
  invalidateCache_(SHEETS.SETTING);
  clearSettingCache();
  return true;
}

/**
 * はじめの設定をまとめて実行する（デプロイ直後にこれ1つ実行すればよい）。
 * 台帳を作り、テストモードをONにし、足りない設定を一覧で返す。
 * @return {string} 次にやることの案内
 */
function quickStart() {
  var proc = 'quickStart';
  var lines = ['=== AI Uribo はじめの設定 ==='];
  lines.push(safely_(proc, function () { return initSheets(); }, '台帳の作成に失敗しました'));

  // 設定作業中に現場へ誤送信しないよう、最初はテストモードで始める
  safely_(proc, function () {
    var row = findRow(SHEETS.SETTING, { 'キー': 'test_mode' });
    if (row) updateRow(SHEETS.SETTING, row._row, { '値': 'TRUE' });
    clearSettingCache();
    lines.push('テストモードをONにしました（LINEには実際には送りません）');
  });

  lines.push('');
  lines.push(safely_(proc, function () { return checkSetup(); }, ''));
  lines.push('');
  lines.push('【次にやること】');
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP.TOKEN)) lines.push('1. スクリプトプロパティに LINE_CHANNEL_TOKEN を入れる');
  if (!props.getProperty(PROP.WEBHOOK_KEY)) lines.push('2. スクリプトプロパティに WEBHOOK_SECRET を入れる（未設定だとWebhookは全拒否）');
  lines.push('3. ウェブアプリとしてデプロイし、URLの末尾に ?k=＜WEBHOOK_SECRET＞ を付けてLINEに登録');
  lines.push('4. S1の登録コードを本人に伝え、LINEで送ってもらう');
  lines.push('5. installTriggers() を実行');
  lines.push('6. メニュー「利用者を登録する」で利用者を登録し、'
    + '「支援記録の質問を開始する（Phase2）」を実行');
  lines.push('7. テストが済んだら S8設定の test_mode を FALSE にする（これで本番運用開始）');
  var text = lines.join('\n');
  logInfo(proc, '実行しました');
  return text;
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
  if (props.getProperty(PROP.WEBHOOK_KEY)) {
    out.push('○ スクリプトプロパティ ' + PROP.WEBHOOK_KEY);
  } else {
    out.push('× スクリプトプロパティ ' + PROP.WEBHOOK_KEY
      + ' 【未設定のためWebhookは全リクエストを拒否します。運用開始前に必ず設定してください】');
  }
  out.push((props.getProperty('SWITCHBOT_TOKEN') ? '○ ' : '－ ') + 'スクリプトプロパティ SWITCHBOT_TOKEN（任意）');
  var devices = safely_('checkSetup', function () {
    return findRows(SHEETS.DEVICE, function (r) { return isTrue_(r['有効']); }).length;
  }, 0);
  out.push('SwitchBot機器（有効） ' + devices + '件');
  if (isTrue_(getSetting('test_mode', 'FALSE'))) {
    out.push('★テストモード：ON（LINEには実際に送りません。運用開始時はS8のtest_modeをFALSEに）');
  } else {
    out.push('テストモード：OFF（実際にLINEへ送信します）');
  }
  var staff = findRows(SHEETS.STAFF, function (r) { return isTrue_(r['有効']); });
  var linked = staff.filter(function (r) { return String(r['line_user_id'] || '').trim(); });
  out.push('有効スタッフ ' + staff.length + '名 / LINE紐付け済み ' + linked.length + '名');
  var users = safely_('checkSetup', function () {
    return findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); }).length;
  }, 0);
  var supportOn = safely_('checkSetup', function () {
    return findRows(SHEETS.CHECK, function (r) {
      return String(r['対象種別']) === 'support' && isTrue_(r['有効']);
    }).length;
  }, 0);
  out.push('有効な利用者 ' + users + '名'
    + (users ? '' : '【メニュー「利用者を登録する」から登録してください】'));
  out.push('支援記録の質問 ' + (supportOn ? supportOn + '項目が有効' : '未開始【メニュー「支援記録の質問を開始する（Phase2）」】'));
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
    .addItem('はじめの設定（quickStart）', 'menuQuickStart_')
    .addItem('台帳を初期化する（initSheets）', 'initSheets')
    .addItem('セットアップ点検', 'menuCheckSetup_')
    .addItem('登録コードを発行', 'menuIssueCode_')
    .addSeparator()
    .addItem('利用者を登録する', 'menuAddUser_')
    .addItem('登録済みの利用者を見る', 'menuListUsers_')
    .addItem('支援記録の質問を開始する（Phase2）', 'menuEnablePhase2_')
    .addSeparator()
    .addItem('診断情報をコピー', 'menuDiagnostics_')
    .addSeparator()
    .addItem('朝バッチを今すぐ実行', 'morningBatch')
    .addItem('夜の確認セットを今すぐ実行', 'nightBatch')
    .addItem('週次ダイジェストを今すぐ実行', 'weeklyDigest')
    .addItem('バックアップを今すぐ実行', 'dailyBackup')
    .addItem('自己点検を今すぐ実行', 'selfCheck')
    .addItem('古い行を保管シートへ移す', 'archiveOldRows')
    .addSeparator()
    .addItem('SwitchBot機器を読み込む', 'switchbotSyncDevices')
    .addItem('SwitchBotの状態を今すぐ取得', 'switchbotPoll')
    .addItem('SwitchBotのWebhookを登録', 'switchbotSetupWebhook')
    .addSeparator()
    .addItem('トリガーを設定する（installTriggers）', 'installTriggers')
    .addToUi();
}

/**
 * メニューからはじめの設定を実行する。
 * @return {void}
 */
function menuQuickStart_() {
  SpreadsheetApp.getUi().alert('AI Uribo はじめの設定', quickStart(), SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * メニューからセットアップ点検を実行し、結果をダイアログ表示する。
 * @return {void}
 */
function menuCheckSetup_() {
  SpreadsheetApp.getUi().alert('AI Uribo セットアップ点検', checkSetup(), SpreadsheetApp.getUi().ButtonSet.OK);
}
