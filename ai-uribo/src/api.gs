/**
 * 既存アプリ向けの受け渡し口（読み取りAPI）
 *
 * 【何のためにあるか】
 * AI Uriboが埋めた記録は、最後は既存アプリのDBに戻らないと意味がない。
 * 人がスプレッドシートを開いてコピーする運用にすると、そこだけ手作業が残り、
 * しかも「まだ取り込んでいない分」が分からなくなる。
 * そこで、既存アプリが自分で取りに来られる口を用意する。
 *
 *   1. GET  ?k=＜秘密キー＞&mode=fills          … まだ渡していない補完台帳を受け取る
 *   2. POST {"action":"markImported","fill_ids":[...]} … 取り込んだものに済みを付ける
 *
 * 2まで済ませて初めて「渡した」とみなす。取り込みに失敗したら済みを付けなければ、
 * 次の呼び出しでまた同じものが返るので、取りこぼしが起きない。
 *
 * 【個人情報の扱い】
 * 記録には利用者の氏名を含めない（user_codeだけ）。氏名が要るときは mode=users を
 * 1回だけ呼んで対応表を作ること。どちらも秘密キーが無ければ何も返さない。
 * 診断名・病名などの医療情報はそもそも台帳に無いので、当然ここからも出ない。
 */

/**
 * オブジェクトをJSONとして返す。
 * @param {Object} obj 応答オブジェクト
 * @return {TextOutput} 応答
 */
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 1回の呼び出しで返す最大件数 @type {number} */
var API_MAX_ROWS = 500;

/**
 * 読み取りAPI（GET）の入口。
 * @param {Object} e リクエストイベント
 * @return {TextOutput} 応答
 */
function handleApiGet_(e) {
  var proc = 'api';
  var mode = String((e && e.parameter && e.parameter.mode) || '').trim();

  if (!verifyApiKey_(e)) {
    logWarn(proc, '秘密キーが違うためAPIの要求を拒否しました（mode=' + mode + '）');
    return jsonOut_({ ok: false, error: 'unauthorized' });
  }

  switch (mode) {
    case 'fills': return jsonOut_(apiFills_(e));
    case 'users': return jsonOut_(apiUsers_());
    case 'ping': return jsonOut_(apiPing_());
    default:
      return jsonOut_({ ok: false, error: 'unknown mode',
        modes: ['fills', 'users', 'ping'] });
  }
}

/**
 * APIの秘密キーを確認する。
 * API_SECRET が設定されていればそれを使い、無ければWebhookと同じ鍵を使う。
 * どちらも未設定なら受け付けない（設定漏れがそのまま認証無効化にならないようにする）。
 * @param {Object} e リクエストイベント
 * @return {boolean} 正当ならtrue
 */
function verifyApiKey_(e) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('API_SECRET') || props.getProperty(PROP.WEBHOOK_KEY);
  if (!key) {
    logError('verifyApiKey_', 'API_SECRET も WEBHOOK_SECRET も未設定のため要求を拒否しました');
    return false;
  }
  return !!(e && e.parameter && String(e.parameter.k) === String(key));
}

/**
 * まだ既存アプリに渡していない補完台帳を返す。
 *
 * 既定では「要精査」の行も含めて渡す（隙間を残さないため）。
 * 確かめ済みのものだけが欲しい場合は reviewed=1 を付ける。
 * @param {Object} e リクエストイベント
 * @return {Object} 応答オブジェクト
 */
function apiFills_(e) {
  var p = (e && e.parameter) || {};
  var from = String(p.from || '').trim();
  var to = String(p.to || '').trim();
  var onlyReviewed = String(p.reviewed || '') === '1';
  var limit = Math.min(Number(p.limit || API_MAX_ROWS) || API_MAX_ROWS, API_MAX_ROWS);

  var rows = findRows(SHEETS.FILL, function (r) {
    if (isTrue_(r['取込済フラグ'])) return false;
    var d = toDateStr_(r['対象日']);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (onlyReviewed && isTrue_(r['要精査'])) return false;
    return true;
  });

  var items = rows.slice(0, limit).map(function (r) {
    return {
      fill_id: String(r['fill_id']),
      対象日: toDateStr_(r['対象日']),
      対象: String(r['対象']),
      項目名: String(r['項目名']),
      値: String(r['値']),
      情報源: String(r['情報源'] || ''),
      要精査: isTrue_(r['要精査']),
      精査結果: String(r['精査結果'] || ''),
      記入者staff_id: String(r['記入者staff_id'] || ''),
      作成日時: toDateTimeStr_(r['作成日時'])
    };
  });

  logInfo('api', 'fills を ' + items.length + '件返しました（未取込 全' + rows.length + '件）');
  return {
    ok: true, count: items.length, remaining: Math.max(0, rows.length - items.length),
    items: items,
    note: '取り込めたものは POST {"action":"markImported","fill_ids":[...]} で済みを付けてください'
  };
}

/**
 * user_code と氏名の対応表を返す（既存アプリ側のひも付け用）。
 * @return {Object} 応答オブジェクト
 */
function apiUsers_() {
  var items = findRows(SHEETS.USER).map(function (u) {
    var code = String(u['user_code']);
    return { user_code: code, 氏名: displayName_(code), 拠点: String(u['拠点'] || ''),
             有効: isTrue_(u['有効']) };
  });
  logInfo('api', 'users を ' + items.length + '件返しました');
  return { ok: true, count: items.length, items: items };
}

/**
 * 生きているかどうかと、いまの残件を返す（既存アプリ側の監視用）。
 * @return {Object} 応答オブジェクト
 */
function apiPing_() {
  return {
    ok: true,
    時刻: nowStr_(),
    未取込の補完: findRows(SHEETS.FILL, function (r) { return !isTrue_(r['取込済フラグ']); }).length,
    未完了の不足: findRows(SHEETS.GAP, function (r) { return String(r['状態']) !== GAP_STATUS.DONE; }).length,
    テストモード: isTrue_(getSetting('test_mode', 'FALSE'))
  };
}

/**
 * 取り込みが済んだ補完台帳に済みを付ける（POST）。
 * @param {Object} body リクエストボディ
 * @return {number} 済みを付けた件数
 */
function markImported_(body) {
  var proc = 'markImported';
  var ids = body.fill_ids || [];
  if (!ids.length) return 0;

  return withLock_(proc, 60000, function () {
    var want = {};
    ids.forEach(function (id) { want[String(id)] = true; });
    var n = 0;
    findRows(SHEETS.FILL, function (r) {
      return want[String(r['fill_id'])] && !isTrue_(r['取込済フラグ']);
    }).forEach(function (r) {
      updateRow(SHEETS.FILL, r._row, { '取込済フラグ': true });
      n++;
    });
    logInfo(proc, ids.length + '件の指定のうち ' + n + '件に取込済みを付けました');
    return n;
  }, function () { return 0; });
}
