/**
 * 通し試験（実機での動作確認を、システム自身にやらせる）
 *
 * 【なぜ要るか】
 * 実機でしか分からないこと——LINEのトークンが本当に生きているか、Driveに書けるか、
 * 台帳に書き込めるか、質問が組み立つか——は、これまで人が手順書を見ながら
 * 1つずつ試すしかなかった。手間がかかるうえ、どこで失敗したのか分かりにくい。
 *
 * `selfTest()` を1回実行すれば、実際の環境で一通り動かして、
 * 「どこまで動いて、どこで止まったか」を日本語で返す。
 *
 * 【安全のために】
 *   ・実行中は必ずテストモードにする（現場にLINEは飛ばない）
 *   ・作った試験データは最後に消す（消し残しがあれば報告する）
 *   ・LINEのトークン確認は「送信」ではなく、アカウント情報の取得で行う
 *   ・終わってもテストモードはONのまま残す（勝手に本番へ戻さない）
 */

/** 通し試験で使う印。この文字が入った行は最後に消す @type {string} */
var SELFTEST_MARK = 'ZZ_SELFTEST';

/**
 * 通し試験を実行する。
 * @return {string} 結果のレポート
 */
function selfTest() {
  var proc = 'selfTest';
  return withLock_(proc, 120000, function () { return selfTestBody_(proc); },
    function () { return '他の処理が実行中です。少し待ってからもう一度実行してください。'; });
}

/**
 * 通し試験の本体（ロック取得済みの状態で呼ばれる）。
 * @param {string} proc ログ用の処理名
 * @return {string} 結果のレポート
 */
function selfTestBody_(proc) {
  logStart(proc);
  var lines = ['===== AI Uribo 通し試験 ====='];
  lines.push('実行: ' + nowStr_());
  var ng = [];

  // 現場に飛ばさないよう、必ずテストモードにしてから始める
  var beforeMode = getSetting('test_mode', 'FALSE');
  setSetting_('test_mode', 'TRUE');
  lines.push('テストモードON（この試験でLINEは実際には送りません）');
  lines.push('');

  var step = function (title, fn) {
    var r = safely_(proc, fn, { ok: false, detail: '処理が失敗しました（S10実行ログをご確認ください）' });
    lines.push((r.ok ? '○ ' : '× ') + title + '：' + r.detail);
    if (!r.ok) ng.push(title + ' … ' + r.detail);
  };

  step('台帳のシートと列', checkSheetsStep_);
  step('秘密情報の設定', checkSecretsStep_);
  step('トリガー', checkTriggersStep_);
  step('LINEの接続', checkLineStep_);
  step('台帳への書き込み', checkWriteStep_);
  step('質問の組み立てと送信', checkAskStep_);
  step('既存アプリへの受け渡し口', checkApiStep_);
  step('Driveへのバックアップ', checkDriveStep_);

  var left = cleanupSelfTest_();
  lines.push('');
  lines.push(left ? '△ 試験データの後片付け：' + left + '行が残りました（S10をご確認ください）'
    : '○ 試験データの後片付け：完了');

  lines.push('');
  if (ng.length) {
    lines.push('【直していただきたいこと】' + ng.length + '件');
    ng.forEach(function (t) { lines.push('・' + t); });
  } else {
    lines.push('すべて通りました。あとは実際のLINEでの見え方だけ、');
    lines.push('ご自身のスマホで1問だけ試してください（docs/テスト手順書.md T4）。');
  }
  lines.push('');
  lines.push('※テストモードはONのままです。本番に切り替えるときは');
  lines.push('　S8設定の test_mode を FALSE にしてください' + (isTrue_(beforeMode) ? '' : '（試験前はOFFでした）'));
  lines.push('===== ここまで =====');

  var text = lines.join('\n');
  logInfo(proc, '通し試験：NG ' + ng.length + '件');
  return text;
}

/**
 * S8設定の値を書き換える。
 * @param {string} key キー
 * @param {string} value 値
 * @return {void}
 */
function setSetting_(key, value) {
  var row = findRow(SHEETS.SETTING, { 'キー': key });
  if (row) updateRow(SHEETS.SETTING, row._row, { '値': value });
  else appendRow(SHEETS.SETTING, { 'キー': key, '値': value, '説明': '' });
  clearSettingCache();
}

/**
 * シートと列がそろっているかを見る。
 * @return {{ok:boolean, detail:string}} 結果
 */
function checkSheetsStep_() {
  var missingSheets = [];
  var missingCols = [];
  SHEET_DEFS.forEach(function (def) {
    var sh = book_().getSheetByName(def.name);
    if (!sh) { missingSheets.push(def.name); return; }
    var width = Math.max(sh.getLastColumn(), 1);
    var headers = sh.getRange(1, 1, 1, width).getValues()[0].map(function (v) { return String(v).trim(); });
    def.headers.forEach(function (h) {
      if (headers.indexOf(h) < 0) missingCols.push(def.name + '.' + h);
    });
  });
  if (missingSheets.length) {
    return { ok: false, detail: 'シートが足りません（' + missingSheets.join('・')
      + '）。メニュー「はじめの設定（quickStart）」を実行してください' };
  }
  if (missingCols.length) {
    return { ok: false, detail: '列が足りません（' + missingCols.slice(0, 5).join('・')
      + '）。メニュー「はじめの設定（quickStart）」を実行すると自動で足されます' };
  }
  return { ok: true, detail: SHEET_DEFS.length + 'シートすべて、列もそろっています' };
}

/**
 * 秘密情報が入っているかを見る。
 * @return {{ok:boolean, detail:string}} 結果
 */
function checkSecretsStep_() {
  var props = PropertiesService.getScriptProperties();
  var missing = [];
  if (!props.getProperty(PROP.TOKEN)) missing.push('LINE_CHANNEL_TOKEN');
  if (!props.getProperty(PROP.WEBHOOK_KEY)) missing.push('WEBHOOK_SECRET');
  return missing.length
    ? { ok: false, detail: missing.join('・') + ' が未設定です（プロジェクトの設定→スクリプトプロパティ）' }
    : { ok: true, detail: '設定済み' };
}

/**
 * トリガーがそろっているかを見る。
 * @return {{ok:boolean, detail:string}} 結果
 */
function checkTriggersStep_() {
  var required = ['selfCheck', 'morningBatch', 'nightBatch', 'weeklyDigest',
                  'monthlyReport', 'dailyBackup', 'flushQueue'];
  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  var missing = required.filter(function (f) { return handlers.indexOf(f) < 0; });
  return missing.length
    ? { ok: false, detail: missing.join('・') + ' が未設定です。メニュー「トリガーを設定する」を実行してください' }
    : { ok: true, detail: required.length + '本すべて設定済み' };
}

/**
 * LINEのトークンが生きているかを見る。
 * メッセージは送らず、アカウント情報の取得だけで確かめる（誤送信をしないため）。
 * @return {{ok:boolean, detail:string}} 結果
 */
function checkLineStep_() {
  var token = PropertiesService.getScriptProperties().getProperty(PROP.TOKEN);
  if (!token) return { ok: false, detail: 'トークンが未設定のため確認できません' };

  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 200) {
    var body = safely_('checkLineStep_', function () { return JSON.parse(res.getContentText()); }, {});
    return { ok: true, detail: 'つながりました（' + (body.displayName || 'アカウント名不明') + '）' };
  }
  if (code === 401) {
    return { ok: false, detail: 'トークンが無効です。LINE Developersで再発行して入れ直してください' };
  }
  return { ok: false, detail: 'LINEに届きませんでした（HTTP ' + code + '）' };
}

/**
 * 台帳に書けるかを見る（実行ログに1行書いて読み返す）。
 * @return {{ok:boolean, detail:string}} 結果
 */
function checkWriteStep_() {
  var mark = SELFTEST_MARK + ':' + nowStr_();
  writeLog('selfTest', '試験', mark);
  var found = findRows(SHEETS.RUN_LOG, function (r) { return String(r['詳細']) === mark; }).length;
  return found
    ? { ok: true, detail: '書き込みと読み出しができました' }
    : { ok: false, detail: '書いた行を読み返せませんでした（権限か共有設定をご確認ください）' };
}

/**
 * 自動充足→不足検出→質問の組み立て→送信 までを一巡させる。
 * テストモード中なので、送信内容はS6に記録されるだけで現場には届かない。
 * @return {{ok:boolean, detail:string}} 結果
 */
function checkAskStep_() {
  var staff = findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && String(r['line_user_id'] || '').trim();
  })[0];
  if (!staff) {
    return { ok: false, detail: 'LINEと紐付いたスタッフがいません（登録コードで紐付けてください）' };
  }

  // 試験用の利用者と、試験用の不足を1件だけ作る
  appendRow(SHEETS.USER, {
    'user_code': SELFTEST_MARK, '拠点': String(staff['拠点'] || '本部'),
    '自動ログ対応': false, '服薬自動': false, '在否自動': false, '日中自動': false, '有効': false
  });
  var check = findRows(SHEETS.CHECK, function (r) {
    return String(r['対象種別']) === 'support' && String(r['選択肢'] || '').indexOf('|') > 0;
  })[0];
  if (!check) return { ok: false, detail: 'S3に選択肢つきの項目がありません' };

  var gapId = 'GAP-' + SELFTEST_MARK;
  appendRow(SHEETS.GAP, {
    'gap_id': gapId, '対象日': todayStr_(), 'check_id': String(check['check_id']),
    '対象': SELFTEST_MARK, '状態': GAP_STATUS.DETECTED, '検出日時': nowStr_(),
    '一次確認先staff_id': String(staff['staff_id']), '完了日時': ''
  });

  var gap = findRow(SHEETS.GAP, { 'gap_id': gapId });
  var r = createAndSendSet(String(staff['staff_id']), [gap], '【通し試験】これは試験です');
  if (!r || !r.sent) {
    return { ok: false, detail: '質問を組み立てられませんでした（S3の質問文・選択肢をご確認ください）' };
  }
  var task = findRows(SHEETS.TASK, function (t) { return String(t['gap_id']) === gapId; })[0];
  var body = task ? String(task['送信本文'] || '') : '';
  return { ok: true, detail: '1問を組み立てて送信処理まで通りました（本文: ' + truncate_(body, 40) + '）' };
}

/**
 * 既存アプリ向けの受け渡し口が答えるかを見る。
 * @return {{ok:boolean, detail:string}} 結果
 */
function checkApiStep_() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('API_SECRET') || props.getProperty(PROP.WEBHOOK_KEY);
  if (!key) return { ok: false, detail: '秘密キーが無いため確認できません' };

  // 入口が例外を出さずに応答を返すことだけを見る（応答の中身は下で直接確かめる）。
  // ContentServiceの中身を取り出そうとすると環境差でつまずくため、そこには触れない
  if (!handleApiGet_({ parameter: { k: key, mode: 'ping' } })) {
    return { ok: false, detail: '応答がありませんでした' };
  }
  if (!handleApiGet_({ parameter: { k: key + '_wrong', mode: 'ping' } })) {
    return { ok: false, detail: '鍵が違うときの応答が返りませんでした' };
  }

  var body = apiPing_();
  return (body && body.ok)
    ? { ok: true, detail: '応答あり（未取込の補完 ' + body['未取込の補完'] + '件）' }
    : { ok: false, detail: '中身を組み立てられませんでした' };
}

/**
 * Driveに書けるかを見る（小さなファイルを作ってすぐ捨てる）。
 * @return {{ok:boolean, detail:string}} 結果
 */
function checkDriveStep_() {
  var root = getOrCreateFolder_(DriveApp.getRootFolder(),
    getSetting('backup_folder_name', 'AI_Uribo_Backup'));
  var name = SELFTEST_MARK + '.txt';
  var old = root.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  var file = root.createFile(Utilities.newBlob('', 'text/plain', name)
    .setDataFromString('通し試験 ' + nowStr_(), 'UTF-8'));
  if (file && file.setTrashed) file.setTrashed(true);
  return { ok: true, detail: 'バックアップ先に書き込めました（試験ファイルは削除済み）' };
}

/**
 * 試験で作った行を消す。
 * @return {number} 消しきれずに残った行数
 */
function cleanupSelfTest_() {
  var left = 0;
  [SHEETS.USER, SHEETS.GAP, SHEETS.TASK, SHEETS.FILL, SHEETS.LOG_IMPORT].forEach(function (name) {
    safely_('cleanupSelfTest_', function () {
      deleteRowsWhere_(name, function (r) {
        return JSON.stringify(r).indexOf(SELFTEST_MARK) >= 0;
      });
      left += findRows(name, function (r) {
        return JSON.stringify(r).indexOf(SELFTEST_MARK) >= 0;
      }).length;
    });
  });
  return left;
}

/**
 * 条件に合う行を消す（ヘッダーと残す行で書き直す）。
 * 1行ずつ消すより速く、途中で止まりにくい。
 * @param {string} sheetName シート名
 * @param {function(Object):boolean} predicate 消す行の条件
 * @return {number} 消した行数
 */
function deleteRowsWhere_(sheetName, predicate) {
  var table = readTable(sheetName);
  var keep = table.rows.filter(function (r) { return !predicate(r); });
  var removed = table.rows.length - keep.length;
  if (!removed) return 0;

  var sh = sheet_(sheetName);
  var width = table.headers.length;
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, width).clearContent();
  if (keep.length) {
    sh.getRange(2, 1, keep.length, width).setValues(keep.map(function (r) {
      return table.headers.map(function (h) {
        return (r[h] === undefined || r[h] === null) ? '' : r[h];
      });
    }));
  }
  invalidateCache_(sheetName);
  return removed;
}

/**
 * メニューから通し試験を実行する。
 * @return {void}
 */
function menuSelfTest_() {
  SpreadsheetApp.getUi().alert('AI Uribo 通し試験', selfTest(), SpreadsheetApp.getUi().ButtonSet.OK);
}
