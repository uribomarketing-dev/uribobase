/**
 * シート読み書きの共通層（06 Step2）
 *
 * すべて列名（ヘッダー文字列）でアクセスする。列順が変わっても壊れないようにするため、
 * 他のファイルからシートの列番号を直接触らないこと。
 */

/**
 * 対象スプレッドシートを返す。
 * コンテナバインド（シートに紐づいたGASプロジェクト）ならそのシート、
 * スタンドアロンならスクリプトプロパティ SPREADSHEET_ID のシートを開く。
 * @return {Spreadsheet} スプレッドシート
 */
function book_() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  var id = PropertiesService.getScriptProperties().getProperty(PROP.SPREADSHEET_ID);
  if (!id) throw new Error('SPREADSHEET_ID が未設定です（スクリプトプロパティに設定してください）');
  return SpreadsheetApp.openById(id);
}

/**
 * シートオブジェクトを取得する。存在しない場合は例外。
 * @param {string} sheetName シート名
 * @return {Sheet} シート
 */
function sheet_(sheetName) {
  var sh = book_().getSheetByName(sheetName);
  if (!sh) throw new Error('シートがありません: ' + sheetName);
  return sh;
}

/**
 * シート全体を読み、ヘッダーと行オブジェクト配列を返す。
 * 各行オブジェクトには実シート行番号 _row を持たせる。
 * @param {string} sheetName シート名
 * @return {{headers:Array.<string>, rows:Array.<Object>}} 読み取り結果
 */
function readTable(sheetName) {
  var sh = sheet_(sheetName);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastCol === 0) return { headers: [], rows: [] };
  var values = sh.getRange(1, 1, Math.max(lastRow, 1), lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = { _row: i + 1 };
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      obj[headers[c]] = values[i][c];
      if (values[i][c] !== '' && values[i][c] !== null) empty = false;
    }
    if (!empty) rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

/**
 * 条件に合う行を返す。
 * @param {string} sheetName シート名
 * @param {Object|function(Object):boolean} [criteria] 列名→値の一致条件、または判定関数
 * @return {Array.<Object>} 条件に合う行オブジェクトの配列
 */
function findRows(sheetName, criteria) {
  var rows = readTable(sheetName).rows;
  if (!criteria) return rows;
  if (typeof criteria === 'function') return rows.filter(criteria);
  return rows.filter(function (r) {
    for (var k in criteria) {
      if (!criteria.hasOwnProperty(k)) continue;
      if (String(r[k]) !== String(criteria[k])) return false;
    }
    return true;
  });
}

/**
 * 条件に合う最初の1行を返す。
 * @param {string} sheetName シート名
 * @param {Object|function(Object):boolean} criteria 条件
 * @return {Object|null} 行オブジェクト（無ければnull）
 */
function findRow(sheetName, criteria) {
  var rows = findRows(sheetName, criteria);
  return rows.length ? rows[0] : null;
}

/**
 * 1行追加する。オブジェクトのキー（列名）を見てヘッダー順に並べ替えて書き込む。
 * @param {string} sheetName シート名
 * @param {Object} obj 列名→値
 * @return {number} 追加した行番号
 */
function appendRow(sheetName, obj) {
  var sh = sheet_(sheetName);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  var line = headers.map(function (h) {
    return (obj[h] === undefined || obj[h] === null) ? '' : obj[h];
  });
  sh.appendRow(line);
  return sh.getLastRow();
}

/**
 * 既存行を部分更新する。
 * @param {string} sheetName シート名
 * @param {number} rowNumber 実シート行番号（readTableの _row）
 * @param {Object} patch 列名→新しい値
 * @return {void}
 */
function updateRow(sheetName, rowNumber, patch) {
  var sh = sheet_(sheetName);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  for (var k in patch) {
    if (!patch.hasOwnProperty(k)) continue;
    var idx = headers.indexOf(k);
    if (idx < 0) continue;
    sh.getRange(rowNumber, idx + 1).setValue(patch[k]);
  }
}

/**
 * check_idからS3チェック項目を取得する（1実行内はキャッシュして読み込みを減らす）。
 * @param {string} checkId check_id
 * @return {Object|null} S3の行オブジェクト
 */
function checkById_(checkId) {
  if (!checkById_._map) {
    var m = {};
    safely_('checkById_', function () {
      findRows(SHEETS.CHECK).forEach(function (r) { m[String(r['check_id'])] = r; });
    });
    checkById_._map = m;
  }
  return checkById_._map[String(checkId)] || null;
}

/**
 * S8設定の値を取得する。見つからなければ既定値を返す。
 * @param {string} key 設定キー
 * @param {string|number} [fallback] 既定値
 * @return {string} 設定値（文字列）
 */
function getSetting(key, fallback) {
  var cache = getSetting._cache;
  if (!cache) {
    cache = {};
    try {
      findRows(SHEETS.SETTING).forEach(function (r) { cache[String(r['キー'])] = String(r['値']); });
    } catch (e) { /* 設定シート未生成時は既定値で動かす */ }
    getSetting._cache = cache;
  }
  if (cache[key] !== undefined && cache[key] !== '') return cache[key];
  return (fallback === undefined || fallback === null) ? '' : String(fallback);
}

/**
 * 設定キャッシュを破棄する（S8を書き換えた直後に呼ぶ）。
 * @return {void}
 */
function clearSettingCache() { getSetting._cache = null; }

/**
 * S8設定を数値として取得する。
 * @param {string} key 設定キー
 * @param {number} fallback 既定値
 * @return {number} 数値
 */
function getSettingNum(key, fallback) {
  var v = parseInt(getSetting(key, fallback), 10);
  return isNaN(v) ? fallback : v;
}

/**
 * TRUE/FALSE 判定（チェックボックス・文字列どちらでも受ける）。
 * @param {*} v 値
 * @return {boolean} 真偽
 */
function isTrue_(v) {
  if (v === true) return true;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'はい' || s === '1' || s === '○';
}

/**
 * 日付を YYYY-MM-DD 文字列にそろえる。
 * @param {Date|string} d 日付
 * @return {string} YYYY-MM-DD
 */
function toDateStr_(d) {
  if (!d && d !== 0) return '';
  if (Object.prototype.toString.call(d) === '[object Date]') {
    return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  }
  var s = String(d).trim();
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) {
    return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  }
  return s;
}

/**
 * 日時を YYYY-MM-DD HH:mm 文字列にそろえる。
 * @param {Date|string} d 日時
 * @return {string} YYYY-MM-DD HH:mm
 */
function toDateTimeStr_(d) {
  if (!d && d !== 0) return '';
  if (Object.prototype.toString.call(d) === '[object Date]') {
    return Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm');
  }
  return String(d).trim();
}

/**
 * 現在日時（文字列）。
 * @return {string} YYYY-MM-DD HH:mm
 */
function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }

/**
 * 今日の日付（文字列）。
 * @return {string} YYYY-MM-DD
 */
function todayStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

/**
 * 日付を加減算した日付文字列を返す。
 * @param {string|Date} base 基準日
 * @param {number} days 加算日数（マイナス可）
 * @return {string} YYYY-MM-DD
 */
function addDays_(base, days) {
  var d = (Object.prototype.toString.call(base) === '[object Date]') ? new Date(base.getTime())
        : new Date(toDateStr_(base) + 'T00:00:00+09:00');
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

/**
 * 連番IDを採番する（例：TSK0001）。
 * @param {string} sheetName シート名
 * @param {string} colName ID列名
 * @param {string} prefix 接頭辞
 * @param {number} digits 桁数
 * @return {string} 新しいID
 */
function nextSeqId_(sheetName, colName, prefix, digits) {
  var rows = findRows(sheetName);
  var max = 0;
  rows.forEach(function (r) {
    var m = String(r[colName]).match(new RegExp('^' + prefix + '(\\d+)$'));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  var n = String(max + 1);
  while (n.length < digits) n = '0' + n;
  return prefix + n;
}

/**
 * gap_id を採番する（GAP-YYYYMMDD-001 形式）。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {string} gap_id
 */
function nextGapId_(targetDate) {
  var key = 'GAP-' + toDateStr_(targetDate).replace(/-/g, '') + '-';
  var max = 0;
  findRows(SHEETS.GAP).forEach(function (r) {
    var m = String(r['gap_id']).match(new RegExp('^' + key + '(\\d+)$'));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return key + ('00' + (max + 1)).slice(-3);
}
