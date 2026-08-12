/**
 * 自己点検と自動整理（手がかからないための仕組み）
 *
 * 【考え方】
 * 常駐システムがいちばん危ないのは「止まっているのに誰も気づかない」こと。
 * トリガーが消えた、Webhookが切れた、センサーの電池が切れた、台帳が重くなった——
 * どれも現場では気づけないまま、記録だけが静かに欠けていく。
 *
 * そこで毎朝、システム自身が自分の状態を点検する。
 *   ・直せるもの（消えたトリガー等）は自分で直す
 *   ・人の手が要るものだけ、1通にまとめて社員へ知らせる
 *   ・何も問題が無ければ何も送らない（毎日「異常なし」が届くと、やがて誰も読まなくなるため）
 *
 * 台帳の肥大化も放っておくと処理時間の上限に当たるので、
 * バックアップ済みの古い行を「_保管」シートへ自動で移す（消さない）。
 */

/**
 * 自己点検を実行する。問題があれば社員へ1通だけ送る。
 * @return {string} 実行サマリ
 */
function selfCheck() {
  var proc = 'selfCheck';
  return withLock_(proc, 60000, function () { return selfCheckBody_(proc); },
    function () { return '他の処理が実行中のためスキップ'; });
}

/**
 * 自己点検の本体（ロック取得済みの状態で呼ばれる）。
 * @param {string} proc ログ用の処理名
 * @return {string} 実行サマリ
 */
function selfCheckBody_(proc) {
  logStart(proc);
  var issues = [];   // 人の手が要ること
  var fixed = [];    // 自分で直したこと

  safely_(proc, function () { checkTriggers_(issues, fixed); });
  safely_(proc, function () { checkBatchesRan_(issues); });
  safely_(proc, function () { checkSecrets_(issues); });
  safely_(proc, function () { checkStaffLinked_(issues); });
  safely_(proc, function () { checkStuckQueue_(issues); });
  safely_(proc, function () { checkTestMode_(issues); });
  safely_(proc, function () { checkDevices_(issues); });
  safely_(proc, function () { checkLearning_(issues); });
  safely_(proc, function () { checkSheetSize_(issues); });

  var summary = '要対応' + issues.length + '件 / 自動修復' + fixed.length + '件';
  if (fixed.length) logInfo(proc, '自動修復: ' + fixed.join(' / '));

  if (!issues.length) {
    logInfo(proc, summary + '（通知なし）');
    return summary;
  }

  // 同じ内容を毎日送らない（同じ知らせが続くと読まれなくなるため、内容が変わった日だけ送る）
  var body = issues.join('\n');
  var cache = CacheService.getScriptCache();
  var digest = String(body.length) + ':' + body.substring(0, 80);
  if (cache.get('selfcheck_last') === digest) {
    logInfo(proc, summary + '（前回と同じ内容のため送信省略）');
    return summary + '（通知省略）';
  }
  cache.put('selfcheck_last', digest, 21600);

  var lines = ['【AI Uribo 自己点検】' + nowStr_()];
  lines.push('次の点をご確認ください。');
  lines.push('');
  issues.forEach(function (t) { lines.push('・' + t); });
  if (fixed.length) {
    lines.push('');
    lines.push('（自動で直したもの：' + fixed.join('、') + '）');
  }
  var n = sendToEscalationStaff([msgText_(lines.join('\n'))], proc);
  logInfo(proc, summary + ' / 送信' + n + '名');
  return summary;
}

/**
 * トリガーが揃っているかを見て、足りなければ自分で入れ直す。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @param {Array.<string>} fixed 自動修復した内容の配列（追記される）
 * @return {void}
 */
function checkTriggers_(issues, fixed) {
  var required = ['morningBatch', 'nightBatch', 'weeklyDigest', 'dailyBackup', 'flushQueue', 'selfCheck'];
  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  var missing = required.filter(function (f) { return handlers.indexOf(f) < 0; });
  if (!missing.length) return;

  // トリガーは消えていても現場からは見えない。気づいた時点で自分で入れ直す
  installTriggers();
  fixed.push('トリガーの再設定（' + missing.join('・') + '）');
}

/**
 * 各バッチがちゃんと動いているかを、実行ログの最終記録から見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkBatchesRan_(issues) {
  var logs = findRows(SHEETS.RUN_LOG);
  var limits = { morningBatch: 2, nightBatch: 2, dailyBackup: 2, weeklyDigest: 9 };
  var labels = { morningBatch: '朝の確認', nightBatch: '夜の確認セット',
                 dailyBackup: 'バックアップ', weeklyDigest: '週次ダイジェスト' };

  Object.keys(limits).forEach(function (name) {
    var last = '';
    logs.forEach(function (r) {
      if (String(r['処理名']) === name && String(r['結果']) !== '開始') last = toDateTimeStr_(r['日時']);
    });
    if (!last) return;   // 一度も動いていない＝まだ運用前。ここでは騒がない
    var days = daysBetween_(last.substring(0, 10), todayStr_());
    if (days > limits[name]) {
      issues.push(labels[name] + 'が' + days + '日動いていません（最後：' + last + '）。'
        + 'スプレッドシートのメニュー「AI Uribo」→「トリガーを設定」をもう一度実行してください');
    }
  });
}

/**
 * 秘密情報が設定されているかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkSecrets_(issues) {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP.TOKEN)) issues.push('LINEのアクセストークンが未設定です（送信できません）');
  if (!props.getProperty(PROP.WEBHOOK_KEY)) issues.push('Webhook秘密キーが未設定です（LINEからの操作をすべて拒否します）');
}

/**
 * 有効なスタッフでLINE紐付けが済んでいない人がいないかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkStaffLinked_(issues) {
  var waiting = findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && !String(r['line_user_id'] || '').trim();
  });
  if (waiting.length) {
    issues.push('LINEの登録が済んでいない方が' + waiting.length + '名います（'
      + waiting.map(function (r) { return String(r['staff_id']); }).join('・')
      + '）。登録コードをお渡しください');
  }
}

/**
 * 送れないまま溜まっている送信がないかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkStuckQueue_(issues) {
  var expire = getSettingNum('queue_expire_hours', 24);
  var stuck = findRows(SHEETS.TASK, function (r) {
    var st = String(r['送信状態']);
    if (st !== SEND_STATUS.QUEUED && st !== SEND_STATUS.FAILED) return false;
    var created = toDateTimeStr_(r['作成日時']).substring(0, 10);
    return created && daysBetween_(created, todayStr_()) * 24 > expire;
  });
  if (stuck.length) {
    issues.push('送れないまま残っている確認が' + stuck.length + '件あります'
      + '（LINEのトークンか、相手の友だち登録をご確認ください）');
  }
}

/**
 * テストモードが入ったままになっていないかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkTestMode_(issues) {
  if (!isTrue_(getSetting('test_mode', 'FALSE'))) return;
  // 運用が始まっているのにテストモードのままだと、誰にも届かないまま記録だけが溜まる
  var sent = findRows(SHEETS.TASK, function (r) { return String(r['送信状態']) === SEND_STATUS.TEST; });
  if (sent.length >= 20) {
    issues.push('テストモードがONのままです（' + sent.length + '件がLINEに届いていません）。'
      + 'S8設定の test_mode を FALSE にすると実際に送られます');
  }
}

/**
 * 機器から情報が届かなくなっていないかを見る（電池切れ・置き場所の変更など）。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkDevices_(issues) {
  var devices = findRows(SHEETS.DEVICE, function (r) { return isTrue_(r['有効']); });
  if (!devices.length) return;

  // 自動データの取込元は「switchbot-poll:<deviceId>」の形で入っているので、機器ごとに追える
  var since = addDays_(todayStr_(), -3);
  var recent = findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) >= since && String(r['対象種別']).indexOf('raw_') === 0;
  }).map(function (r) { return String(r['取込元']); }).join('\n');

  var silent = devices.filter(function (d) {
    return recent.indexOf(String(d['deviceId'])) < 0;
  });
  // 全機器が黙っているときは、機器側ではなく連携そのものが止まっている可能性が高い
  if (silent.length && silent.length === devices.length) {
    issues.push('SwitchBotから3日間なにも届いていません（連携かWebhookの設定をご確認ください）');
  } else if (silent.length) {
    issues.push('3日間なにも届いていない機器があります：'
      + silent.slice(0, 5).map(function (d) { return String(d['deviceName']); }).join('・')
      + '（電池切れ・置き場所の変更かもしれません）');
  }
}

/**
 * 自動データの精度が落ちた組み合わせがないかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkLearning_(issues) {
  var review = findRows(SHEETS.LEARN, function (r) { return String(r['段階']) === LEARN_STAGE.REVIEW; });
  if (!review.length) return;
  issues.push('自動データが当たらなくなった項目があります：'
    + review.map(function (r) { return String(r['項目名']) + '（' + String(r['情報源']) + '）'; }).join('・')
    + '。機器の位置ずれ・故障や、運用の変更が考えられます（当面は人に確認しています）');
}

/**
 * 台帳が重くなっていないかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkSheetSize_(issues) {
  var limit = getSettingNum('sheet_warn_rows', 20000);
  var big = [];
  [SHEETS.LOG_IMPORT, SHEETS.TASK, SHEETS.FILL, SHEETS.GAP, SHEETS.RUN_LOG].forEach(function (name) {
    var sh = book_().getSheetByName(name);
    if (sh && sh.getLastRow() > limit) big.push(name + '（' + sh.getLastRow() + '行）');
  });
  if (big.length) {
    issues.push('台帳が大きくなっています：' + big.join('・')
      + '。自動整理が効いているかご確認ください（S8設定 archive_enabled）');
  }
}

/**
 * 2つの日付の差（日数）を返す。
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 * @return {number} 日数
 */
function daysBetween_(from, to) {
  var a = new Date(String(from) + 'T00:00:00+09:00').getTime();
  var b = new Date(String(to) + 'T00:00:00+09:00').getTime();
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------------
// 自動整理（古い行を「_保管」シートへ移す）
// ---------------------------------------------------------------------------

/**
 * 自動整理の対象。
 * まだ使っている行（未完了の不足・返事待ちの確認・既存アプリが未取込の補完）は動かさない。
 * @type {Array.<Object>}
 */
var ARCHIVE_RULES = [
  {
    sheet: SHEETS.LOG_IMPORT, 日付列: '発生日', 設定: 'archive_after_days',
    説明: '実績ログ（取込済みの過去分）',
    条件: function () { return true; }
  },
  {
    sheet: SHEETS.GAP, 日付列: '対象日', 設定: 'archive_after_days',
    説明: '完了した不足検出',
    条件: function (r) { return String(r['状態']) === GAP_STATUS.DONE; }
  },
  {
    sheet: SHEETS.TASK, 日付列: '作成日時', 設定: 'archive_after_days',
    説明: '送信・回答が済んだ確認タスク',
    条件: function (r) {
      return !isTrue_(r['追記待ち'])
        && [SEND_STATUS.SENT, SEND_STATUS.CANCELED, SEND_STATUS.TEST, SEND_STATUS.FAILED]
          .indexOf(String(r['送信状態'])) >= 0;
    }
  },
  {
    sheet: SHEETS.FILL, 日付列: '対象日', 設定: 'archive_after_days',
    説明: '既存アプリが取り込み済みの補完台帳',
    条件: function (r) { return isTrue_(r['取込済フラグ']); }
  },
  {
    sheet: SHEETS.RUN_LOG, 日付列: '日時', 設定: 'log_keep_days',
    説明: '実行ログ',
    条件: function () { return true; }
  }
];

/**
 * 古い行を「_保管」シートへ移す。
 *
 * バックアップの直後に呼ぶこと（保管シートへ移す前のCSVが必ず1本残るようにするため）。
 * 消さずに同じ台帳の中へ移すだけなので、後から見返せる。
 * @return {string} 実行サマリ
 */
function archiveOldRows() {
  var proc = 'archiveOldRows';
  if (!isTrue_(getSetting('archive_enabled', 'TRUE'))) return '自動整理はOFF';

  var moved = [];
  ARCHIVE_RULES.forEach(function (rule) {
    safely_(proc, function () {
      var days = getSettingNum(rule.設定, 180);
      var n = archiveSheet_(rule, days);
      if (n) moved.push(rule.sheet + ' ' + n + '行');
    });
  });

  var summary = moved.length ? '保管へ移動: ' + moved.join(' / ') : '移動なし';
  logInfo(proc, summary);
  return summary;
}

/**
 * 1シート分の自動整理を行う。
 * @param {Object} rule ARCHIVE_RULESの1件
 * @param {number} keepDays 何日分を手元に残すか
 * @return {number} 移動した行数
 */
function archiveSheet_(rule, keepDays) {
  var table = readTable(rule.sheet);
  if (!table.rows.length) return 0;

  var cutoff = addDays_(todayStr_(), -keepDays);
  var older = [];
  var keep = [];
  table.rows.forEach(function (r) {
    var d = String(toDateTimeStr_(r[rule.日付列]) || toDateStr_(r[rule.日付列]) || '').substring(0, 10);
    if (d && d < cutoff && rule.条件(r)) older.push(r); else keep.push(r);
  });
  if (!older.length) return 0;

  var toValues = function (list) {
    return list.map(function (r) {
      return table.headers.map(function (h) {
        return (r[h] === undefined || r[h] === null) ? '' : r[h];
      });
    });
  };

  // 1. 保管シートへ追記
  var store = ensureArchiveSheet_(rule.sheet, table.headers);
  var values = toValues(older);
  store.getRange(store.getLastRow() + 1, 1, values.length, table.headers.length).setValues(values);

  // 2. 元シートを「ヘッダー＋残す行」で書き直す（1行ずつ消すより速く、途中で止まりにくい）
  var sh = sheet_(rule.sheet);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, table.headers.length).clearContent();
  if (keep.length) {
    sh.getRange(2, 1, keep.length, table.headers.length).setValues(toValues(keep));
  }
  invalidateCache_(rule.sheet);
  logInfo('archiveSheet_', rule.sheet + ' の' + cutoff + 'より前 ' + older.length + '行を保管へ移動（'
    + rule.説明 + '）');
  return older.length;
}

/**
 * 保管シートを用意する（無ければヘッダー付きで作る）。
 * @param {string} sheetName 元のシート名
 * @param {Array.<string>} headers ヘッダー
 * @return {Sheet} 保管シート
 */
function ensureArchiveSheet_(sheetName, headers) {
  var name = sheetName + '_保管';
  var book = book_();
  var sh = book.getSheetByName(name);
  if (sh) return sh;
  sh = book.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#EFEFEF');
  sh.setFrozenRows(1);
  sh.getRange(1, 1).setNote('古くなった行の保管先。' + sheetName + 'から自動で移される（消してはいない）。'
    + '移す前のCSVはDriveのバックアップに残っている');
  return sh;
}
