/**
 * 自動バックアップ 第1層（05_バックアップ運用仕様.md / 06 Step5）
 *
 * 毎日3:00に実行し、
 *   1. 全シートをCSV（UTF-8 BOM付き）で AI_Uribo_Backup/daily/YYYY-MM-DD/ に保存
 *   2. スプレッドシート自体の複製を AI_Uribo_Backup/snapshot/ に1部（前日分は上書き）
 *   3. dailyは直近30日分を保持。月末日分は monthly/ へ移して永久保存
 *   4. 結果をS10に記録し、失敗時はエスカレーション先社員にLINE通知
 *
 * 本体バッチと独立して動くよう、他ファイルの関数への依存は最小限にしてある。
 */

/**
 * 日次バックアップを実行する。
 * @return {string} 実行サマリ
 */
function dailyBackup() {
  var proc = 'dailyBackup';
  logStart(proc);
  var today = todayStr_();
  try {
    var root = getOrCreateFolder_(DriveApp.getRootFolder(), getSetting('backup_folder_name', 'AI_Uribo_Backup'));
    var dailyRoot = getOrCreateFolder_(root, 'daily');
    var snapRoot = getOrCreateFolder_(root, 'snapshot');
    var monthlyRoot = getOrCreateFolder_(root, 'monthly');

    // 1. CSVエクスポート
    var dayFolder = getOrCreateFolder_(dailyRoot, today);
    var book = book_();
    var count = 0;
    book.getSheets().forEach(function (sh) {
      try {
        var csv = sheetToCsv_(sh);
        var name = sh.getName() + '.csv';
        // 同名ファイルがあれば消してから作る（再実行時の重複防止）
        var existing = dayFolder.getFilesByName(name);
        while (existing.hasNext()) existing.next().setTrashed(true);
        // 先頭にBOM（\uFEFF）を付けてExcelでの文字化けを防ぐ
        dayFolder.createFile(Utilities.newBlob('', 'text/csv', name)
          .setDataFromString('\uFEFF' + csv, 'UTF-8'));
        count++;
      } catch (e) {
        logError(proc, e, 'シート: ' + sh.getName());
      }
    });

    // 2. スプレッドシートの複製（1部だけ保持）
    safely_(proc, function () {
      var snapName = 'AI_Uribo_台帳_snapshot';
      var old = snapRoot.getFilesByName(snapName);
      while (old.hasNext()) old.next().setTrashed(true);
      DriveApp.getFileById(book.getId()).makeCopy(snapName, snapRoot);
    });

    // 3. 保持ルールの適用
    var rotated = safely_(proc, function () { return rotateBackups_(dailyRoot, monthlyRoot); }, { moved: 0, trashed: 0 });

    // 4. 復旧手順書を同梱
    safely_(proc, function () { ensureRestoreGuide_(root); });

    var summary = today + ' のバックアップ完了：CSV ' + count + '件 / monthly移動 ' + rotated.moved
      + '件 / 削除 ' + rotated.trashed + '件';
    logInfo(proc, summary);
    return summary;
  } catch (e) {
    logError(proc, e);
    safely_(proc, function () {
      sendToEscalationStaff([msgText_('【AI Uribo】バックアップに失敗しました（' + nowStr_() + '）\n'
        + String(e).substring(0, 300) + '\nS10実行ログをご確認ください。')], proc);
    });
    return 'エラー: ' + e;
  }
}

/**
 * 指定フォルダ配下の子フォルダを取得（無ければ作成）する。
 * @param {Folder} parent 親フォルダ
 * @param {string} name フォルダ名
 * @return {Folder} フォルダ
 */
function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/**
 * シートをCSV文字列に変換する。
 * @param {Sheet} sheet シート
 * @return {string} CSV
 */
function sheetToCsv_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) return '';
  var values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  return values.map(function (row) {
    return row.map(function (v) {
      var s = String(v === null || v === undefined ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\r\n');
}

/**
 * 保持ルールを適用する。
 * 保持日数を過ぎたdailyフォルダのうち、月末日分は monthly/ へ移動し、それ以外はゴミ箱へ。
 * @param {Folder} dailyRoot dailyフォルダ
 * @param {Folder} monthlyRoot monthlyフォルダ
 * @return {{moved:number, trashed:number}} 処理件数
 */
function rotateBackups_(dailyRoot, monthlyRoot) {
  var keep = getSettingNum('backup_keep_days', 30);
  var limit = addDays_(todayStr_(), -keep);
  var moved = 0, trashed = 0;
  var it = dailyRoot.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    var name = f.getName();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    if (name >= limit) continue;
    if (isMonthEnd_(name)) {
      f.moveTo(monthlyRoot);
      moved++;
    } else {
      f.setTrashed(true);
      trashed++;
    }
  }
  return { moved: moved, trashed: trashed };
}

/**
 * その日付が月末日かどうか判定する。
 * @param {string} dateStr YYYY-MM-DD
 * @return {boolean} 月末ならtrue
 */
function isMonthEnd_(dateStr) {
  var d = new Date(dateStr + 'T00:00:00+09:00');
  var next = new Date(d.getTime());
  next.setDate(next.getDate() + 1);
  return next.getDate() === 1;
}

/**
 * バックアップフォルダに復旧手順書を置く（無ければ作成する）。
 * @param {Folder} root バックアップのルートフォルダ
 * @return {void}
 */
function ensureRestoreGuide_(root) {
  var name = '復旧手順.txt';
  if (root.getFilesByName(name).hasNext()) return;
  var text = [
    'AI Uribo バックアップ 復旧手順',
    '',
    '■ 軽微な誤記（数セルを戻したい）',
    '  スプレッドシート「AI_Uribo_台帳」を開き、ファイル → 版履歴 → 版履歴を表示 から復元する。',
    '',
    '■ シートが壊れた（1シートだけ戻したい）',
    '  snapshot/AI_Uribo_台帳_snapshot を開き、該当シートを右クリック →「他のスプレッドシートにコピー」で',
    '  本番の台帳にコピーし、壊れたシートを削除して名前を元に戻す。',
    '',
    '■ Googleアカウント事故（台帳ごと失った）',
    '  1. 新規スプレッドシートを作成し「AI_Uribo_台帳」と命名',
    '  2. NAS または monthly/daily の最新フォルダから各CSVをインポート',
    '     （ファイル → インポート → アップロード → 「新しいシートを挿入する」）',
    '  3. シート名をCSVのファイル名（S1_スタッフマスタ 等）に合わせる',
    '  4. GASプロジェクトを新台帳に紐付け直し、スクリプトプロパティを再設定、installTriggers() を実行',
    '',
    '■ 第2バックアップ（清水NAS）',
    '  \\\\192.168.1.20\\ウリボ単体\\AI_Uribo_Backup\\ に週次でミラーされている。',
    '',
    '※CSVはUTF-8（BOM付き）。Excelでそのまま開いても文字化けしない。'
  ].join('\n');
  root.createFile(Utilities.newBlob('', 'text/plain', name).setDataFromString(text, 'UTF-8'));
}
