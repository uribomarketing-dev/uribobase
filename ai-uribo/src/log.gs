/**
 * 実行ログ（S10）記録層（06 Step2）
 *
 * 品質基準：エラーで停止せず、必ずS10に記録して処理を継続する。
 * そのためログ記録自体が失敗しても例外を投げない。
 */

/**
 * 実行ログを1行記録する。
 * @param {string} proc 処理名（例：morningBatch）
 * @param {string} result 結果（開始/正常/警告/エラー）
 * @param {*} [detail] 詳細（文字列化して保存。長い場合は先頭2000文字）
 * @return {void}
 */
function writeLog(proc, result, detail) {
  try {
    var text = (detail === undefined || detail === null) ? ''
      : (typeof detail === 'string' ? detail : JSON.stringify(detail));
    if (text.length > 2000) text = text.substring(0, 2000) + '…(以下略)';
    appendRow(SHEETS.RUN_LOG, {
      '日時': nowStr_(),
      '処理名': proc,
      '結果': result,
      '詳細': text
    });
  } catch (e) {
    Logger.log('[S10書込失敗] ' + proc + ' / ' + result + ' / ' + e);
  }
}

/**
 * 処理開始ログ。
 * @param {string} proc 処理名
 * @param {*} [detail] 詳細
 * @return {void}
 */
function logStart(proc, detail) { writeLog(proc, '開始', detail); }

/**
 * 正常終了ログ。
 * @param {string} proc 処理名
 * @param {*} [detail] 詳細
 * @return {void}
 */
function logInfo(proc, detail) { writeLog(proc, '正常', detail); }

/**
 * 警告ログ（処理は継続する）。
 * @param {string} proc 処理名
 * @param {*} [detail] 詳細
 * @return {void}
 */
function logWarn(proc, detail) { writeLog(proc, '警告', detail); }

/**
 * エラーログ。
 * @param {string} proc 処理名
 * @param {Error|string} err エラー
 * @param {*} [extra] 補足情報
 * @return {void}
 */
function logError(proc, err, extra) {
  var msg = (err && err.stack) ? (err.message + ' / ' + err.stack) : String(err);
  if (extra !== undefined) msg += ' / ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
  writeLog(proc, 'エラー', msg);
}

/**
 * 例外を投げない実行ラッパー。1件の失敗で全体を止めないために使う。
 * @param {string} proc 処理名
 * @param {function():*} fn 実行する処理
 * @param {*} [fallback] 例外時の戻り値
 * @return {*} fnの戻り値、または fallback
 */
function safely_(proc, fn, fallback) {
  try {
    return fn();
  } catch (e) {
    logError(proc, e);
    return fallback;
  }
}
