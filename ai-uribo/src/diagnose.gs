/**
 * 診断情報の出力
 *
 * 不具合が起きたとき、藤原様が「これをコピーしてAIに渡すだけ」で原因調査ができるように、
 * 必要な情報（設定状況・直近のエラー・件数・最終実行結果）を1つのテキストにまとめる。
 *
 * 使い方は3通り：
 *   ・LINEで「診断」と送る（社員・管理者のみ。要点のみ返す）
 *   ・スプレッドシートのメニュー「AI Uribo」→「診断情報をコピー」（全文をダイアログ表示）
 *   ・GASエディタで exportDiagnostics() を実行（実行ログにも残る）
 *
 * 個人情報は含めない（LINEユーザーIDは先頭4文字のみ、氏名・回答本文は出さない）。
 */

/**
 * 診断情報を作る。
 * @param {boolean} [brief] trueならLINE向けの短縮版
 * @return {string} 診断テキスト
 */
function exportDiagnostics(brief) {
  var lines = [];
  lines.push('===== AI Uribo 診断情報 =====');
  lines.push('生成日時: ' + nowStr_());

  // 1. セットアップ状況
  safely_('exportDiagnostics', function () {
    lines.push('');
    lines.push('【設定】');
    var props = PropertiesService.getScriptProperties();
    lines.push('LINEトークン: ' + (props.getProperty(PROP.TOKEN) ? '設定済' : '未設定'));
    lines.push('チャネルシークレット: ' + (props.getProperty(PROP.SECRET) ? '設定済' : '未設定'));
    lines.push('Webhook秘密キー: ' + (props.getProperty(PROP.WEBHOOK_KEY) ? '設定済' : '未設定★Webhookは全拒否になります'));
    var missing = SHEET_DEFS.filter(function (d) { return !book_().getSheetByName(d.name); })
      .map(function (d) { return d.name; });
    lines.push('シート: ' + (missing.length ? '不足あり → ' + missing.join(', ')
      : SHEET_DEFS.length + 'シートすべてあり'));
    var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
    ['morningBatch', 'nightBatch', 'weeklyDigest', 'dailyBackup', 'flushQueue'].forEach(function (f) {
      if (handlers.indexOf(f) < 0) lines.push('トリガー未設定★: ' + f);
    });
    if (['morningBatch', 'nightBatch', 'weeklyDigest', 'dailyBackup', 'flushQueue']
        .every(function (f) { return handlers.indexOf(f) >= 0; })) {
      lines.push('トリガー: 5本すべて設定済');
    }
    lines.push('テストモード: ' + (isTrue_(getSetting('test_mode', 'FALSE'))
      ? 'ON（LINEに実際には送っていません）' : 'OFF（実際に送信します）'));
    lines.push('運用ステージ: ' + getSetting('stage', '1')
      + ' / 朝' + getSetting('morning_batch_hour', '10') + '時'
      + ' 夜' + getSetting('night_batch_hour', '21') + '時');
  });

  // 2. スタッフの登録状況（氏名・IDは出さない）
  safely_('exportDiagnostics', function () {
    lines.push('');
    lines.push('【スタッフ】');
    var staff = findRows(SHEETS.STAFF);
    var active = staff.filter(function (r) { return isTrue_(r['有効']); });
    var linked = active.filter(function (r) { return String(r['line_user_id'] || '').trim(); });
    lines.push('登録' + staff.length + '名 / 有効' + active.length + '名 / LINE紐付け済み' + linked.length + '名');
    var waiting = active.filter(function (r) { return !String(r['line_user_id'] || '').trim(); })
      .map(function (r) { return String(r['staff_id']); });
    if (waiting.length) lines.push('未紐付け: ' + waiting.join(', ') + '（登録コードの配布待ち）');
  });

  // 3. 件数の状況
  safely_('exportDiagnostics', function () {
    lines.push('');
    lines.push('【件数】');
    var gaps = findRows(SHEETS.GAP);
    var byState = {};
    gaps.forEach(function (g) { byState[g['状態']] = (byState[g['状態']] || 0) + 1; });
    lines.push('不足(S5) 全' + gaps.length + '件: ' + (JSON.stringify(byState) || '{}'));
    var tasks = findRows(SHEETS.TASK);
    var bySend = {};
    tasks.forEach(function (t) { bySend[t['送信状態']] = (bySend[t['送信状態']] || 0) + 1; });
    lines.push('確認タスク(S6) 全' + tasks.length + '件: ' + JSON.stringify(bySend));
    lines.push('実績ログ(S4): ' + findRows(SHEETS.LOG_IMPORT).length + '件 / '
      + '補完台帳(S7): ' + findRows(SHEETS.FILL).length + '件');
  });

  // 4. 最後の実行結果
  safely_('exportDiagnostics', function () {
    lines.push('');
    lines.push('【各バッチの最終実行】');
    var logs = findRows(SHEETS.RUN_LOG);
    ['morningBatch', 'nightBatch', 'weeklyDigest', 'dailyBackup', 'flushQueue'].forEach(function (name) {
      var last = null;
      logs.forEach(function (r) { if (String(r['処理名']) === name && String(r['結果']) !== '開始') last = r; });
      lines.push(name + ': ' + (last ? toDateTimeStr_(last['日時']) + ' ' + last['結果'] + ' / '
        + truncate_(String(last['詳細']), 120) : '実行記録なし'));
    });
  });

  // 5. 直近のエラー・警告
  safely_('exportDiagnostics', function () {
    lines.push('');
    lines.push('【直近のエラー・警告】');
    var limit = brief ? 5 : 20;
    var bad = findRows(SHEETS.RUN_LOG, function (r) {
      return String(r['結果']) === 'エラー' || String(r['結果']) === '警告';
    });
    if (!bad.length) {
      lines.push('なし');
    } else {
      bad.slice(-limit).forEach(function (r) {
        lines.push('・' + toDateTimeStr_(r['日時']) + ' [' + r['結果'] + '] ' + r['処理名']
          + ' : ' + truncate_(String(r['詳細']), brief ? 100 : 300));
      });
      if (bad.length > limit) lines.push('（ほか' + (bad.length - limit) + '件。全文はスプレッドシートのS10をご覧ください）');
    }
  });

  lines.push('');
  lines.push('===== ここまで =====');
  var text = lines.join('\n');
  if (!brief) logInfo('exportDiagnostics', '診断情報を出力しました（' + text.length + '文字）');
  return text;
}

/**
 * メニューから診断情報を表示する（全文をコピーできる）。
 * @return {void}
 */
function menuDiagnostics_() {
  SpreadsheetApp.getUi().alert('AI Uribo 診断情報（全文をコピーしてAIに渡してください）',
    exportDiagnostics(false), SpreadsheetApp.getUi().ButtonSet.OK);
}
