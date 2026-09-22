/**
 * LINE送信の共通層（06 Step2 / 03_LINE会話仕様.md）
 *
 * ・push送信はリトライ3回（既定。S8 line_retry_max で変更可）
 * ・深夜帯（S8 quiet_start_hour〜quiet_end_hour）はS6にキュー保存し、朝のバッチで送る
 * ・チャネルアクセストークンはスクリプトプロパティからのみ読む（コード・シートに置かない）
 */

/** LINE APIのエンドポイント @type {Object.<string,string>} */
var LINE_API = {
  PUSH: 'https://api.line.me/v2/bot/message/push',
  REPLY: 'https://api.line.me/v2/bot/message/reply',
  PROFILE: 'https://api.line.me/v2/bot/profile/'
};

/**
 * チャネルアクセストークンを取得する。
 * @return {string} トークン
 */
function lineToken_() {
  var t = PropertiesService.getScriptProperties().getProperty(PROP.TOKEN);
  if (!t) throw new Error('スクリプトプロパティ ' + PROP.TOKEN + ' が未設定です');
  return t;
}

/**
 * LINE APIを1回呼ぶ（リトライなし）。
 * @param {string} url エンドポイント
 * @param {Object} payload 送信JSON
 * @param {string} [retryKey] 冪等性キー（同じキーの再送は重複送信されない）
 * @return {{code:number, body:string}} HTTPステータスと本文
 */
function lineFetch_(url, payload, retryKey) {
  var headers = { 'Authorization': 'Bearer ' + lineToken_() };
  if (retryKey) headers['X-Line-Retry-Key'] = retryKey;
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), body: res.getContentText() };
}

/**
 * push送信（リトライ付き）。
 * @param {string} lineUserId 送信先のLINEユーザーID
 * @param {Array.<Object>} messages LINEメッセージオブジェクト配列（最大5件）
 * @param {string} [retryKey] 冪等性キー（UUID形式）
 * @return {{ok:boolean, code:number, body:string, tries:number}} 送信結果
 */
function pushRaw_(lineUserId, messages, retryKey) {
  var max = getSettingNum('line_retry_max', 3);
  var key = retryKey || Utilities.getUuid();
  var last = { ok: false, code: 0, body: '', tries: 0 };
  for (var i = 1; i <= max; i++) {
    last.tries = i;
    try {
      var r = lineFetch_(LINE_API.PUSH, { to: lineUserId, messages: messages }, key);
      last.code = r.code;
      last.body = r.body;
      if (r.code === 200) { last.ok = true; return last; }
      // 409 は「同じリトライキーの送信を既に受理済み」の意味。成功として扱う（重複送信の防止）
      if (r.code === 409) {
        last.ok = true;
        logInfo('pushRaw_', '409（送信済み）として扱う: ' + lineUserId);
        return last;
      }
      // 4xx（トークン不正・宛先不正など）はリトライしても直らないので即終了
      if (r.code >= 400 && r.code < 500 && r.code !== 429) return last;
    } catch (e) {
      last.body = String(e);
    }
    if (i < max) Utilities.sleep(Math.pow(2, i - 1) * 1000);
  }
  return last;
}

/**
 * 返信（replyToken使用。webhook応答用・リトライ不可）。
 * @param {string} replyToken 返信トークン
 * @param {Array.<Object>} messages メッセージ配列
 * @return {boolean} 成功したか
 */
function replyRaw_(replyToken, messages) {
  try {
    var r = lineFetch_(LINE_API.REPLY, { replyToken: replyToken, messages: messages });
    if (r.code !== 200) logWarn('replyRaw_', 'code=' + r.code + ' ' + r.body);
    return r.code === 200;
  } catch (e) {
    logError('replyRaw_', e);
    return false;
  }
}

/**
 * 深夜帯（送信抑止時間帯）かどうか。
 * @param {Date} [now] 判定する日時（省略時は現在）
 * @return {boolean} 深夜帯ならtrue
 */
function isQuietHours_(now) {
  var h = parseInt(Utilities.formatDate(now || new Date(), TZ, 'H'), 10);
  var start = getSettingNum('quiet_start_hour', 22);
  var end = getSettingNum('quiet_end_hour', 7);
  return (start > end) ? (h >= start || h < end) : (h >= start && h < end);
}

/**
 * staff_idからスタッフ行を取得する。
 * @param {string} staffId スタッフID
 * @return {Object|null} S1の行オブジェクト
 */
function staffById_(staffId) {
  return findRow(SHEETS.STAFF, { 'staff_id': staffId });
}

/**
 * line_user_idからスタッフ行を取得する。
 * @param {string} lineUserId LINEユーザーID
 * @return {Object|null} S1の行オブジェクト
 */
function staffByLineId_(lineUserId) {
  if (!lineUserId) return null;
  return findRow(SHEETS.STAFF, { 'line_user_id': lineUserId });
}

/**
 * エスカレーション先（社員）のスタッフ行一覧を返す。
 * @return {Array.<Object>} S1の行オブジェクト配列
 */
function escalationStaff_() {
  return findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && isTrue_(r['エスカレーション先フラグ']);
  });
}

/**
 * スタッフへメッセージを送る。深夜帯はS6にキュー保存し、朝のバッチで送信する。
 * @param {string} staffId 送信先staff_id
 * @param {Array.<Object>} messages メッセージ配列
 * @param {{taskRowNumber:number, force:boolean, label:string}} [opts]
 *        taskRowNumber: 既存のS6行を更新する場合の行番号 /
 *        force: 深夜帯でも即送信する / label: ログ用の名称
 * @return {{ok:boolean, queued:boolean, detail:string}} 送信結果
 */
function sendToStaff(staffId, messages, opts) {
  opts = opts || {};
  var label = opts.label || 'sendToStaff';
  var staff = staffById_(staffId);
  if (!staff) {
    logWarn(label, 'staff_idがS1にありません: ' + staffId);
    return { ok: false, queued: false, detail: 'staff_not_found' };
  }
  var lineId = String(staff['line_user_id'] || '').trim();
  if (!lineId) {
    logWarn(label, staff['氏名'] + ' のline_user_idが未登録のため送信できません（友だち追加待ち）');
    return { ok: false, queued: false, detail: 'no_line_user_id' };
  }

  var body = JSON.stringify(messages);

  // テストモード中は実際には送らない（設定作業中に現場へ誤送信しないため）
  if (isTrue_(getSetting('test_mode', 'FALSE'))) {
    if (opts.taskRowNumber) {
      updateRow(SHEETS.TASK, opts.taskRowNumber, {
        '送信本文': body, '送信状態': SEND_STATUS.TEST, '送信日時': nowStr_()
      });
    } else {
      appendRow(SHEETS.TASK, {
        'task_id': nextSeqId_(SHEETS.TASK, 'task_id', 'TSK', 5),
        '送信先staff_id': staffId,
        '送信本文': body,
        '送信状態': SEND_STATUS.TEST,
        '送信日時': nowStr_(),
        '作成日時': nowStr_()
      });
    }
    logInfo(label, '【テストモード】送信せず記録のみ: ' + staff['氏名']);
    return { ok: true, queued: false, detail: 'test_mode' };
  }

  // 同じ内容の再送では必ず同じキーを使う（LINE側が重複を弾けるようにするため）
  var retryKey = opts.retryKey || '';
  if (!retryKey && opts.taskRowNumber) {
    var taskRow = findRow(SHEETS.TASK, function (r) { return r._row === opts.taskRowNumber; });
    retryKey = taskRow ? String(taskRow['retry_key'] || '') : '';
  }
  if (!retryKey) retryKey = Utilities.getUuid();

  // 深夜帯はキューに積む
  if (!opts.force && isQuietHours_()) {
    if (opts.taskRowNumber) {
      updateRow(SHEETS.TASK, opts.taskRowNumber, {
        '送信状態': SEND_STATUS.QUEUED, '送信本文': body, 'retry_key': retryKey
      });
    } else {
      appendRow(SHEETS.TASK, {
        'task_id': nextSeqId_(SHEETS.TASK, 'task_id', 'TSK', 5),
        '送信先staff_id': staffId,
        '送信本文': body,
        '送信状態': SEND_STATUS.QUEUED,
        '再送回数': 0,
        'retry_key': retryKey,
        '作成日時': nowStr_()
      });
    }
    logInfo(label, '深夜帯のためキュー保存: ' + staff['氏名']);
    return { ok: true, queued: true, detail: 'queued' };
  }

  var res = pushRaw_(lineId, messages, retryKey);
  if (opts.taskRowNumber) {
    updateRow(SHEETS.TASK, opts.taskRowNumber, {
      '送信本文': body,
      '送信状態': res.ok ? SEND_STATUS.SENT : SEND_STATUS.FAILED,
      '送信日時': res.ok ? nowStr_() : '',
      '再送回数': res.tries,
      'retry_key': retryKey
    });
  }
  if (res.ok) {
    logInfo(label, '送信成功: ' + staff['氏名']);
  } else {
    logError(label, '送信失敗: ' + staff['氏名'] + ' code=' + res.code + ' ' + res.body);
  }
  return { ok: res.ok, queued: false, detail: res.body };
}

/**
 * エスカレーション先の社員全員へ同じメッセージを送る。
 * @param {Array.<Object>} messages メッセージ配列
 * @param {string} label ログ用の名称
 * @return {number} 送信できた人数
 */
function sendToEscalationStaff(messages, label) {
  var n = 0;
  escalationStaff_().forEach(function (s) {
    var r = safely_(label, function () {
      return sendToStaff(s['staff_id'], messages, { label: label });
    }, { ok: false });
    if (r && r.ok) n++;
  });
  return n;
}

/**
 * キュー（深夜帯保留分・送信失敗分）をまとめて送信する。
 * 朝のバッチと、深夜帯明けの時刻トリガーから呼ばれる。
 * @return {number} 送信できた件数
 */
function flushQueue() {
  var proc = 'flushQueue';
  return withLock_(proc, 60000, function () {
    logStart(proc);
    if (isQuietHours_()) {
      logInfo(proc, '深夜帯のため送信しない');
      return 0;
    }
    var maxRetry = getSettingNum('line_retry_max', 3);
    var expireMs = getSettingNum('queue_expire_hours', 24) * 3600 * 1000;
    var now = new Date().getTime();

    var targets = findRows(SHEETS.TASK, function (r) {
      var st = String(r['送信状態']);
      if (st === SEND_STATUS.QUEUED) return true;
      return st === SEND_STATUS.FAILED && Number(r['再送回数'] || 0) < maxRetry * 2;
    });
    var sent = 0, expired = 0;

    targets.forEach(function (t) {
      safely_(proc, function () {
        var body = String(t['送信本文'] || '');
        if (!body) {
          updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED });
          return;
        }
        // 作られてから期限（既定24時間）を過ぎたものは再送しない。
        // LINEの重複防止キーの有効期間を超えると、二重送信になる恐れがあるため。
        var created = toDateTimeStr_(t['作成日時'] || t['送信日時']);
        if (created) {
          var age = now - new Date(created.replace(' ', 'T') + ':00+09:00').getTime();
          if (!isNaN(age) && age > expireMs) {
            updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED });
            logWarn(proc, '期限切れのため送信を取りやめ: ' + t['task_id']);
            expired++;
            return;
          }
        }
        // 対応する不足がすでに完了していれば送らない
        if (t['gap_id']) {
          var gap = findRow(SHEETS.GAP, { 'gap_id': t['gap_id'] });
          if (gap && String(gap['状態']) === GAP_STATUS.DONE) {
            updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED });
            return;
          }
        }
        var prevTries = Number(t['再送回数'] || 0);
        var r = sendToStaff(t['送信先staff_id'], JSON.parse(body), {
          taskRowNumber: t._row, label: proc, force: false
        });
        if (r.ok && !r.queued) {
          sent++;
        } else if (!r.ok) {
          // 再送回数は累積させる（無限リトライを防ぐため）
          updateRow(SHEETS.TASK, t._row, { '再送回数': prevTries + 1 });
        }
      });
    });
    logInfo(proc, '送信 ' + sent + '件 / 対象 ' + targets.length + '件 / 期限切れ ' + expired + '件');
    return sent;
  }, function () { return 0; });
}

// ---------------------------------------------------------------------------
// メッセージ組み立て
// ---------------------------------------------------------------------------

/**
 * テキストメッセージを作る。
 * @param {string} text 本文
 * @return {Object} LINEメッセージオブジェクト
 */
function msgText_(text) {
  return { type: 'text', text: truncate_(text, 4900) };
}

/**
 * ボタン付きテンプレートメッセージを作る（選択肢は最大4件）。
 * @param {string} title タイトル（40文字以内）
 * @param {string} text 本文（60文字以内）
 * @param {Array.<{label:string, data:string}>} actions 選択肢
 * @return {Object} LINEメッセージオブジェクト
 */
function msgButtons_(title, text, actions) {
  var acts = actions.slice(0, 4).map(function (a) {
    return { type: 'postback', label: truncate_(a.label, 20), data: a.data, displayText: truncate_(a.label, 20) };
  });
  return {
    type: 'template',
    altText: truncate_(title + ' ' + text, 400),
    template: {
      type: 'buttons',
      title: truncate_(title, 40),
      text: truncate_(text, 60),
      actions: acts
    }
  };
}

/**
 * クイックリプライ付きテキストメッセージを作る。
 * @param {string} text 本文
 * @param {Array.<{label:string, data:string}>} items 選択肢（最大13件）
 * @return {Object} LINEメッセージオブジェクト
 */
function msgQuickReply_(text, items) {
  return {
    type: 'text',
    text: truncate_(text, 4900),
    quickReply: {
      items: items.slice(0, 13).map(function (i) {
        return {
          type: 'action',
          action: { type: 'postback', label: truncate_(i.label, 20), data: i.data, displayText: truncate_(i.label, 20) }
        };
      })
    }
  };
}

/**
 * 文字列を指定長に切り詰める。
 * @param {string} s 文字列
 * @param {number} n 最大長
 * @return {string} 切り詰めた文字列
 */
function truncate_(s, n) {
  s = String(s === null || s === undefined ? '' : s);
  return s.length <= n ? s : s.substring(0, n - 1) + '…';
}
