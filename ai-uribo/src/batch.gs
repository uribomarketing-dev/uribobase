/**
 * 定時バッチ（06 Step4 を【08】v1.1に読み替えた確定仕様）
 *
 *   morningBatch()  毎朝10:00  自動充足 → 不足検出 → まとめ確認LINE（Stage1は藤原様・服部様の2名）
 *   nightBatch()    毎晩21:00  夜勤向け「夜の確認セット」（昨日の穴＋明日の予定を本人に確認）
 *   weeklyDigest()  日曜10:00  週次ダイジェスト（未完了・わからない残件＋精度指標）
 *   flushQueue()    毎朝7:00   深夜帯に保留した送信を流す（notify.gsに実装）
 *
 * ※17:00エスカレーションは【08】で廃止。R03の滞留判定は週次ダイジェストで使う。
 *
 * 全てのバッチは withLock_ で直列化する。日曜10:00は朝バッチと週次ダイジェストが重なるため、
 * 待ち時間を長め（既定5分）にとって、片方が終わるのを待ってから動くようにしている。
 */

/** バッチがロックを待つ時間（ミリ秒） @type {number} */
var BATCH_LOCK_WAIT_MS = 300000;

/**
 * 1回のバッチで使ってよい時間（ミリ秒）。
 * GASの実行は6分で強制終了され、その瞬間に何が終わって何が終わっていないのか分からなくなる。
 * 手前で自分から切り上げ、残りは次の実行に回す（毎日動くので、翌日には必ず追いつく）。
 * @type {number}
 */
var BATCH_TIME_BUDGET_MS = 240000;

/** いまのバッチが始まった時刻（ミリ秒） @type {number} */
var BATCH_STARTED_AT_ = 0;

/**
 * バッチの時計を開始する。
 * @return {void}
 */
function startBatchClock_() {
  BATCH_STARTED_AT_ = new Date().getTime();
}

/**
 * まだ時間に余裕があるか。
 * @return {boolean} 余裕があればtrue
 */
function withinBatchBudget_() {
  if (!BATCH_STARTED_AT_) return true;
  return (new Date().getTime() - BATCH_STARTED_AT_) < BATCH_TIME_BUDGET_MS;
}

/**
 * バッチ開始からの経過秒数。
 * @return {number} 秒
 */
function batchElapsedSec_() {
  return BATCH_STARTED_AT_ ? Math.round((new Date().getTime() - BATCH_STARTED_AT_) / 1000) : 0;
}

/**
 * 朝バッチ。前日分を自動充足したうえで不足を検出し、確認LINEを送る。
 * @return {string} 実行サマリ
 */
function morningBatch() {
  var proc = 'morningBatch';
  return withLock_(proc, BATCH_LOCK_WAIT_MS, function () {
    try {
      logStart(proc);
      startBatchClock_();
      var targetDate = addDays_(todayStr_(), -1);

      safely_(proc, function () { flushQueue(); });
      var auto = safely_(proc, function () { return runAutoFill(targetDate); }, { filled: 0 });
      // 埋めた直後に噛み合わない記録を洗う。ここで聞き直しに戻した項目は、この後の検出で質問になる
      var bad = safely_(proc, function () { return checkConsistency(targetDate); },
        { 再確認: 0, 要判断: 0, 一覧: [] });
      safely_(proc, function () { scanAlerts_(targetDate); });
      var gaps = safely_(proc, function () { return detectGaps(targetDate, ['R01', 'R02', 'R05']); }, []);
      safely_(proc, function () { registerGaps(gaps); });

      var md = formatMd_(targetDate);
      var sentTotal = dispatchPendingGaps_(
        // 予定（対象種別=plan）は夜の確認セットで扱うので朝は送らない
        function (gap, check) { return !check || String(check['対象種別']) !== 'plan'; },
        '【' + md + 'までの確認】',
        proc
      );

      var summary = '自動充足' + auto.filled + '件 / 食い違い' + bad.一覧.length + '件'
        + ' / 新規検出' + gaps.length + '件 / 送信' + sentTotal + '件'
        + ' / ' + batchElapsedSec_() + '秒';
      logInfo(proc, summary);
      return summary;
    } catch (e) {
      logError(proc, e);
      return 'エラー: ' + e;
    }
  }, function () { return '他の処理が実行中のためスキップ'; });
}

/**
 * 夜バッチ（夜の確認セット）。
 * 昨日の穴のうち本人に聞けば分かるものと、明日の予定をまとめて夜勤担当に送る。
 * @return {string} 実行サマリ
 */
function nightBatch() {
  var proc = 'nightBatch';
  return withLock_(proc, BATCH_LOCK_WAIT_MS, function () {
   try {
    logStart(proc);
    startBatchClock_();
    var tomorrow = addDays_(todayStr_(), 1);

    // 明日の予定（R04）を検出して登録
    var planGaps = safely_(proc, function () { return detectGaps(tomorrow, ['R04']); }, []);
    safely_(proc, function () { registerGaps(planGaps); });

    var recipients = nightShiftStaff_();
    if (!recipients.length) {
      logWarn(proc, '夜勤担当が特定できないため送信しない');
      return '夜勤担当なし';
    }

    // 送る対象：明日の予定と、支援記録のうち利用者本人・夜勤に聞けば分かる項目
    // （シフト希望はスタッフ本人に朝送るものなので、夜の確認セットには入れない）
    var pending = pendingGaps_(function (gap, check) {
      if (!check) return false;
      var kind = String(check['対象種別']);
      if (kind === 'plan') return true;
      if (kind !== 'support') return false;
      var role = String(check['確認先役割']);
      return role === '本人' || role === '夜勤';
    });
    if (!pending.length) {
      logInfo(proc, '確認事項なし');
      return '確認事項なし';
    }

    var sent = 0;
    recipients.forEach(function (staffId) {
      safely_(proc, function () {
        var list = excludeAlreadyAsked_(pending, staffId);
        if (!list.length) return;
        var r = createAndSendSet(staffId, list, '【夜の確認セット】利用者さんに聞きながらお答えください');
        if (r.sent) sent += r.count;
      });
    });

    var summary = '予定検出' + planGaps.length + '件 / 確認' + pending.length + '件 / 送信' + sent + '件';
    logInfo(proc, summary);
    return summary;
   } catch (e) {
    logError(proc, e);
    return 'エラー: ' + e;
   }
  }, function () { return '他の処理が実行中のためスキップ'; });
}

/**
 * 週次ダイジェスト（日曜10:00）。
 * 未完了・「わからない」の残件と、精度指標（質問件数・わからない率・自動充足率）を社員へ送る。
 * @return {string} 実行サマリ
 */
function weeklyDigest() {
  var proc = 'weeklyDigest';
  return withLock_(proc, BATCH_LOCK_WAIT_MS, function () {
   try {
    logStart(proc);
    startBatchClock_();
    var days = getSettingNum('digest_lookback_days', 7);
    var to = todayStr_();
    var from = addDays_(to, -days);

    // 集計期間は「検出日時」で切る（シフト希望のように対象日が未来の不足も拾うため）
    var gapsInRange = findRows(SHEETS.GAP, function (r) {
      var d = toDateTimeStr_(r['検出日時']).substring(0, 10);
      return d >= from && d <= to;
    });
    var done = gapsInRange.filter(function (r) { return String(r['状態']) === GAP_STATUS.DONE; });
    var open = gapsInRange.filter(function (r) { return String(r['状態']) !== GAP_STATUS.DONE; });
    var stale = safely_(proc, function () { return findStaleGaps_(); }, []);

    var answers = findRows(SHEETS.TASK, function (r) {
      var d = toDateTimeStr_(r['回答日時']);
      return d && d.substring(0, 10) >= from && d.substring(0, 10) <= to;
    });
    var unknowns = answers.filter(function (r) {
      return UNKNOWN_ANSWERS.indexOf(String(r['回答']).split('／')[0]) >= 0;
    });
    var autoFilled = safely_(proc, function () { return countAutoFilled_(from, to); }, 0);
    var needsReview = safely_(proc, function () { return countNeedsReview_(from, to); }, 0);

    // AIの読み取り通知の精度（誤検知がどれだけ多いか）
    var feedback = findRows(SHEETS.RUN_LOG, function (r) {
      var d = toDateTimeStr_(r['日時']).substring(0, 10);
      return String(r['処理名']) === 'alertFeedback' && d >= from && d <= to;
    });
    var wrong = feedback.filter(function (r) { return String(r['詳細']).indexOf('誤検知') >= 0; }).length;

    var askCount = findRows(SHEETS.TASK, function (r) {
      var d = toDateTimeStr_(r['送信日時']);
      return d && d.substring(0, 10) >= from && d.substring(0, 10) <= to;
    }).length;
    var autoRate = (autoFilled + gapsInRange.length) > 0
      ? Math.round(autoFilled * 100 / (autoFilled + gapsInRange.length)) : 0;
    var unknownRate = answers.length ? Math.round(unknowns.length * 100 / answers.length) : 0;

    var lines = [];
    lines.push('【週次ダイジェスト】' + from + '〜' + to);
    lines.push('検出' + gapsInRange.length + '件 / 完了' + done.length + '件 / 未完了' + open.length + '件');
    lines.push('質問した件数：' + askCount + '件（うち「わからない」' + unknowns.length + '件・' + unknownRate + '%）');
    lines.push('自動で埋まった件数：' + autoFilled + '件（自動充足率 ' + autoRate + '%）');
    if (needsReview) {
      lines.push('うち推定で埋めた「要精査」：' + needsReview + '件'
        + '（LINEで「精査」と送るか、S7補完台帳の要精査列をご確認ください）');
    }
    if (feedback.length) {
      lines.push('AIの読み取り通知：' + feedback.length + '件（うち誤検知 ' + wrong + '件・'
        + Math.round(wrong * 100 / feedback.length) + '%）');
    }
    if (stale.length) lines.push('※8時間以上返事待ちの項目：' + stale.length + '件');
    var conflicts = findRows(SHEETS.RUN_LOG, function (r) {
      var d = toDateTimeStr_(r['日時']).substring(0, 10);
      return String(r['結果']) === '食い違い' && d >= from && d <= to;
    }).length;
    if (conflicts) lines.push('記録の食い違い：' + conflicts + '件（聞き直しか、社員への確認を出しています）');

    // 学習の進み具合（＝どれだけ質問が減ったか）を毎週示す
    var saved = safely_(proc, function () { return countAutoConfirmed_(from, to); }, 0);
    if (saved) lines.push('学習済みのため聞かずに済んだ件数：' + saved + '件');
    lines.push('');
    safely_(proc, function () { learnSummaryLines_().forEach(function (l) { lines.push(l); }); });
    lines.push('');
    if (open.length) {
      lines.push('▼未完了の一覧（最大15件）');
      open.slice(0, 15).forEach(function (g) {
        var c = checkById_(g['check_id']);
        lines.push('・' + toDateStr_(g['対象日']) + ' ' + displayName_(String(g['対象']))
          + ' 「' + (c ? c['項目名'] : g['check_id']) + '」（' + g['状態'] + '）');
      });
      lines.push('');
      lines.push('この後、回答できる項目をボタンでお送りします。');
    } else {
      lines.push('未完了はありません。今週もありがとうございました。');
    }

    var n = sendToEscalationStaff([msgText_(lines.join('\n'))], proc);

    // 未完了分は社員がその場で回答できるよう、確認セットにして送る（最大10件）
    var answerable = pendingGaps_(function () { return true; }).slice(0, 10);
    escalationStaff_().forEach(function (s) {
      safely_(proc, function () {
        var list = excludeAlreadyAsked_(answerable, String(s['staff_id']));
        if (list.length) createAndSendSet(String(s['staff_id']), list, '【今週の未完了分】');
      });
    });

    writeLog(proc, '週次集計',
      JSON.stringify({ from: from, to: to, 検出: gapsInRange.length, 完了: done.length,
        未完了: open.length, 質問: askCount, わからない: unknowns.length,
        わからない率: unknownRate, 自動充足: autoFilled, 自動充足率: autoRate, 要精査: needsReview,
        学習で省いた質問: saved }));
    logInfo(proc, '送信 ' + n + '名');
    return '未完了' + open.length + '件 / 送信' + n + '名';
   } catch (e) {
    logError(proc, e);
    return 'エラー: ' + e;
   }
  }, function () { return '他の処理が実行中のためスキップ'; });
}

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

/**
 * 未完了（検出・確認中・エスカレーション中）の不足を返す。
 * @param {function(Object, Object):boolean} [filter] (gap, check) を受け取る絞り込み関数
 * @return {Array.<Object>} S5の行オブジェクト配列
 */
function pendingGaps_(filter) {
  return findRows(SHEETS.GAP, function (r) {
    var st = String(r['状態']);
    return st === GAP_STATUS.DETECTED || st === GAP_STATUS.ASKING || st === GAP_STATUS.ESCALATED;
  }).filter(function (g) {
    if (!filter) return true;
    var check = checkById_(g['check_id']);
    return filter(g, check);
  });
}

/**
 * そのスタッフに送る不足を絞り込む。
 *
 * 同じ日に同じことを二度聞かないのが基本。ただし、
 * **一度送ったきり返事が無い確認を放置すると、記録が空いたまま週次まで埋もれる**。
 * そこで一定時間が過ぎたものはもう一度だけお送りする（回数の上限つき。しつこくしない）。
 * 上限に達したものは催促をやめ、週次ダイジェストで社員がまとめて引き取る。
 *
 * @param {Array.<Object>} gaps S5の行オブジェクト配列
 * @param {string} staffId staff_id
 * @return {Array.<Object>} 送る不足だけの配列
 */
function excludeAlreadyAsked_(gaps, staffId) {
  var remindAfter = getSettingNum('remind_after_hours', 20);
  var remindMax = getSettingNum('remind_max', 2);

  var answered = {};
  var times = {};   // gap_id → その人に送った回数
  var latest = {};  // gap_id → 最後に送った（または作った）日時

  findRows(SHEETS.TASK, function (r) {
    var st = String(r['送信状態']);
    return String(r['送信先staff_id']) === String(staffId)
      && (st === SEND_STATUS.WAITING || st === SEND_STATUS.QUEUED || st === SEND_STATUS.SENT);
  }).forEach(function (t) {
    var id = String(t['gap_id']);
    // 「後で（明日また聞いて）」と答えた項目は、翌日また聞くので数に入れない
    if (String(t['回答'] || '').indexOf('後で') === 0) return;
    if (String(t['回答'] || '').trim()) { answered[id] = true; return; }

    times[id] = (times[id] || 0) + 1;
    var when = toDateTimeStr_(t['送信日時']) || toDateTimeStr_(t['作成日時']);
    if (!latest[id] || when > latest[id]) latest[id] = when;
  });

  return gaps.filter(function (g) {
    var id = String(g['gap_id']);
    if (answered[id]) return false;              // もう答えていただいている
    if (!times[id]) return true;                 // まだ送っていない
    if (times[id] > remindMax) return false;     // これ以上は催促しない（週次で社員へ）
    return hoursSince_(latest[id]) >= remindAfter;
  });
}

/**
 * その一覧に「一度送ったが返事が無いもの」が含まれるか。
 * 見出しに一言添えて、催促されたと感じさせないための判定。
 * @param {Array.<Object>} gaps 送る不足
 * @param {string} staffId staff_id
 * @return {boolean} 含まれていればtrue
 */
function includesReask_(gaps, staffId) {
  var sent = {};
  findRows(SHEETS.TASK, function (r) {
    return String(r['送信先staff_id']) === String(staffId)
      && String(r['送信状態']) === SEND_STATUS.SENT;
  }).forEach(function (t) { sent[String(t['gap_id'])] = true; });
  return gaps.some(function (g) { return sent[String(g['gap_id'])]; });
}

/**
 * 未完了の不足を一次確認先ごとにまとめて送る。
 * @param {function(Object):boolean} gapFilter 対象にする不足の絞り込み
 * @param {string} title セットの見出し
 * @param {string} proc ログ用の処理名
 * @return {number} 送信した件数
 */
function dispatchPendingGaps_(gapFilter, title, proc) {
  var pending = pendingGaps_().filter(gapFilter);
  if (!pending.length) {
    logInfo(proc, '送る不足なし');
    return 0;
  }
  var byStaff = {};
  pending.forEach(function (g) {
    String(g['一次確認先staff_id'] || '').split(',').forEach(function (id) {
      id = id.trim();
      if (!id) return;
      if (!byStaff[id]) byStaff[id] = [];
      byStaff[id].push(g);
    });
  });

  var sent = 0;
  var skipped = 0;
  Object.keys(byStaff).forEach(function (staffId) {
    // 時間切れで強制終了されると、送ったのか送っていないのか分からない状態が残る。
    // 手前で自分から止めれば、残りは翌日の実行がそのまま拾う（不足は消えないため）
    if (!withinBatchBudget_()) { skipped++; return; }
    safely_(proc, function () {
      var list = excludeAlreadyAsked_(byStaff[staffId], staffId);
      if (!list.length) return;
      var head = includesReask_(list, staffId)
        ? title + '\n※前回お答えいただけなかった分も入っています'
        : title;
      var r = createAndSendSet(staffId, list, head);
      if (r.sent) sent += r.count;
    });
  });
  if (skipped) {
    logWarn(proc, '実行時間が長くなったため' + skipped + '名分の送信を次回に回しました'
      + '（経過' + batchElapsedSec_() + '秒）');
  }
  return sent;
}

/**
 * 今夜の夜勤担当のstaff_id一覧を返す。
 * S11勤務予定 → S1の役割=夜勤 → エスカレーション先社員 の順にフォールバックする。
 * @return {Array.<string>} staff_idの配列
 */
function nightShiftStaff_() {
  var today = todayStr_();
  var fromPlan = safely_('nightShiftStaff_', function () {
    return findRows(SHEETS.SHIFT_PLAN, function (r) {
      return toDateStr_(r['日付']) === today && String(r['勤務区分']).indexOf('夜勤') >= 0;
    }).map(function (r) { return String(r['staff_id']); });
  }, []);

  var valid = fromPlan.filter(function (id) {
    var s = staffById_(id);
    return s && isTrue_(s['有効']) && String(s['line_user_id'] || '').trim();
  });
  if (valid.length) return valid;

  var byRole = findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && String(r['役割']).indexOf('夜勤') >= 0 && String(r['line_user_id'] || '').trim();
  }).map(function (r) { return String(r['staff_id']); });
  if (byRole.length) return byRole;

  return escalationStaff_().map(function (s) { return String(s['staff_id']); });
}

/**
 * YYYY-MM-DD を M/D 表記にする。
 * @param {string} dateStr 日付
 * @return {string} M/D
 */
function formatMd_(dateStr) {
  var d = toDateStr_(dateStr);
  if (d.length < 10) return d;
  return Number(d.substring(5, 7)) + '/' + Number(d.substring(8, 10));
}

// ---------------------------------------------------------------------------
// トリガー設定
// ---------------------------------------------------------------------------

/**
 * 時間主導トリガーを設定する（既存の同名トリガーは削除してから作り直す）。
 * S8設定の時刻を変えたあとに実行し直すこと。
 * @return {string} 設定内容のサマリ
 */
function installTriggers() {
  var proc = 'installTriggers';
  var handlers = ['morningBatch', 'nightBatch', 'weeklyDigest', 'dailyBackup', 'flushQueue',
                  'switchbotPoll', 'selfCheck', 'monthlyReport'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });

  var morning = getSettingNum('morning_batch_hour', 10);
  var night = getSettingNum('night_batch_hour', 21);
  var digestHour = getSettingNum('weekly_digest_hour', 10);
  var backup = getSettingNum('backup_hour', 3);
  var quietEnd = getSettingNum('quiet_end_hour', 7);

  ScriptApp.newTrigger('morningBatch').timeBased().atHour(morning).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('nightBatch').timeBased().atHour(night).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('dailyBackup').timeBased().atHour(backup).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('flushQueue').timeBased().atHour(quietEnd).everyDays(1).inTimezone(TZ).create();
  // 自己点検は朝バッチより前。ここでトリガーの欠けや連携の停止に自分で気づく
  ScriptApp.newTrigger('selfCheck').timeBased()
    .atHour(getSettingNum('selfcheck_hour', 8)).everyDays(1).inTimezone(TZ).create();
  // SwitchBotの状態取得は朝バッチの前に走らせる（取得した値をその日の充足に使うため）
  if (PropertiesService.getScriptProperties().getProperty('SWITCHBOT_TOKEN')) {
    ScriptApp.newTrigger('switchbotPoll').timeBased()
      .atHour(getSettingNum('switchbot_poll_hour', 9)).everyDays(1).inTimezone(TZ).create();
  }
  // 月次まとめは月初に前月分をまとめる（実地指導・監査の備え）
  ScriptApp.newTrigger('monthlyReport').timeBased()
    .onMonthDay(1).atHour(getSettingNum('monthly_report_hour', 11)).inTimezone(TZ).create();
  ScriptApp.newTrigger('weeklyDigest').timeBased()
    .onWeekDay(dayOfWeek_(getSettingNum('weekly_digest_dow', 0)))
    .atHour(digestHour).inTimezone(TZ).create();

  var summary = '自己点検' + getSettingNum('selfcheck_hour', 8) + '時 / 朝' + morning + '時 / 夜' + night
    + '時 / 週次(日)' + digestHour + '時 / 月次(1日)' + getSettingNum('monthly_report_hour', 11) + '時'
    + ' / バックアップ' + backup + '時 / キュー送信' + quietEnd + '時';
  logInfo(proc, summary);
  return summary;
}

/**
 * 数値（0=日）をScriptApp.WeekDayに変換する。
 * @param {number} n 曜日番号（0=日〜6=土）
 * @return {WeekDay} 曜日
 */
function dayOfWeek_(n) {
  var list = [ScriptApp.WeekDay.SUNDAY, ScriptApp.WeekDay.MONDAY, ScriptApp.WeekDay.TUESDAY,
               ScriptApp.WeekDay.WEDNESDAY, ScriptApp.WeekDay.THURSDAY, ScriptApp.WeekDay.FRIDAY,
               ScriptApp.WeekDay.SATURDAY];
  return list[(n % 7 + 7) % 7];
}
