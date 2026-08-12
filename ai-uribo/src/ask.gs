/**
 * 確認セットの組み立てと回答処理（03_LINE会話仕様.md F2・F3 /【08】まとめ回答形式）
 *
 * 1通に質問を詰め込まず、「項目ごとにボタンをタップ → 次の質問が届く」連続フローにする。
 * 1セット＝S6の複数行（同じセットid、並び順で順番管理）。
 * 誰か1人が回答した不足は、他の人の待機タスクを自動で中止する。
 */

/**
 * 確認セットを作成し、最初の質問を送る。
 * @param {string} staffId 送信先staff_id
 * @param {Array.<Object>} gaps S5の行オブジェクト（gap_id・対象日・check_id・対象を含む）
 * @param {string} title セットの見出し（例：【昨日(8/11)の記録確認】）
 * @return {{setId:string, count:number, sent:boolean}} 作成結果
 */
function createAndSendSet(staffId, gaps, title) {
  var proc = 'createAndSendSet';
  if (!gaps || !gaps.length) return { setId: '', count: 0, sent: false };

  var setId = nextSeqId_(SHEETS.TASK, 'セットid', 'SET', 5);
  gaps.forEach(function (g, i) {
    appendRow(SHEETS.TASK, {
      'task_id': nextSeqId_(SHEETS.TASK, 'task_id', 'TSK', 5),
      'gap_id': g.gap_id,
      '送信先staff_id': staffId,
      '送信状態': SEND_STATUS.WAITING,
      '再送回数': 0,
      '追記待ち': false,
      'セットid': setId,
      '並び順': i + 1
    });
  });

  var intro = msgText_(title + '\n全' + gaps.length + '件です。ボタンで順番にお答えください。');
  var result = sendNextInSet_(setId, null, [intro]);
  logInfo(proc, staffId + ' へ ' + gaps.length + '件の確認セット（' + setId + '）を作成 / 送信=' + result);
  return { setId: setId, count: gaps.length, sent: (result === SEND_RESULT.SENT) };
}

/**
 * sendNextInSet_ の戻り値。
 * SENT=次の質問を送った / NONE=残りが無い / FAILED=送信に失敗した（replyTokenは使用済みの可能性）
 * @type {Object.<string,string>}
 */
var SEND_RESULT = { SENT: 'sent', NONE: 'none', FAILED: 'failed' };

/**
 * セット内の次の未送信タスクを1件送る。
 * @param {string} setId セットid
 * @param {string} [replyToken] 返信トークン（webhookからの応答時に指定）
 * @param {Array.<Object>} [prefixMessages] 質問の前に付けるメッセージ（お礼など）
 * @return {string} SEND_RESULT のいずれか
 */
function sendNextInSet_(setId, replyToken, prefixMessages) {
  var proc = 'sendNextInSet_';
  var tasks = findRows(SHEETS.TASK, function (r) {
    return String(r['セットid']) === String(setId) && String(r['送信状態']) === SEND_STATUS.WAITING;
  }).sort(function (a, b) { return Number(a['並び順']) - Number(b['並び順']); });

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var gap = findRow(SHEETS.GAP, { 'gap_id': t['gap_id'] });
    if (!gap) { updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED }); continue; }
    if (String(gap['状態']) === GAP_STATUS.DONE) {
      updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED });
      continue;
    }
    var check = checkById_(gap['check_id']);
    if (!check) { updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED }); continue; }

    var remain = tasks.length - i - 1;
    var messages = (prefixMessages || []).concat(buildQuestion_(t, gap, check, remain));

    if (replyToken) {
      var ok = replyRaw_(replyToken, messages);
      updateRow(SHEETS.TASK, t._row, {
        '送信本文': JSON.stringify(messages),
        // 返信に失敗した分は「失敗」にしておくと flushQueue がpushで送り直す
        '送信状態': ok ? SEND_STATUS.SENT : SEND_STATUS.FAILED,
        '送信日時': ok ? nowStr_() : '',
        '作成日時': t['作成日時'] || nowStr_()
      });
      if (ok) updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.ASKING });
      return ok ? SEND_RESULT.SENT : SEND_RESULT.FAILED;
    }

    var res = sendToStaff(t['送信先staff_id'], messages, { taskRowNumber: t._row, label: proc });
    if (res.ok && !res.queued) updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.ASKING });
    return res.ok ? SEND_RESULT.SENT : SEND_RESULT.FAILED;
  }

  // 残りが無い場合は何も送らない（呼び出し側が完了メッセージを返す）
  return SEND_RESULT.NONE;
}

/**
 * 1件分の質問メッセージを作る。質問文・選択肢はS3チェック項目マスタの内容を使う。
 * S3の「参照ログ」に項目名が入っていれば、その自動ログを判断材料として質問の前に添える。
 * （自動データを支援の記録の代わりにせず、人が判断するための材料として見せるための仕組み）
 * @param {Object} task S6の行
 * @param {Object} gap S5の行
 * @param {Object} check S3の行
 * @param {number} remain このセットの残り件数
 * @return {Array.<Object>} LINEメッセージオブジェクトの配列
 */
function buildQuestion_(task, gap, check, remain) {
  var text = fillPlaceholders_(String(check['質問文']), gap);
  var choices = expandChoices_(String(check['選択肢'] || ''));
  if (!choices.length) choices = ['済', 'できていない', 'わからない'];

  var actions = choices.map(function (c) {
    return { label: c, data: 'ans|' + task['task_id'] + '|' + c };
  });
  var title = String(check['項目名']);
  if (remain > 0) title += '（残り' + remain + '件）';

  var messages = [];
  var context = referenceLogText_(gap, check);
  if (context) messages.push(msgText_(context));
  messages.push(msgButtons_(title, text, actions));
  return messages;
}

/**
 * 参照ログ（判断材料になる自動データ）の文面を作る。
 * @param {Object} gap S5の行
 * @param {Object} check S3の行
 * @return {string} 添える文面（無ければ空文字）
 */
function referenceLogText_(gap, check) {
  var name = String(check['参照ログ'] || '').trim();
  if (!name) return '';
  var row = safely_('referenceLogText_', function () {
    return findRow(SHEETS.LOG_IMPORT, function (r) {
      return toDateStr_(r['発生日']) === toDateStr_(gap['対象日'])
        && String(r['項目名']) === name
        && String(r['対象']) === String(gap['対象']);
    });
  }, null);
  if (!row) {
    return '（参考）' + toDateStr_(gap['対象日']) + ' の「' + name + '」の自動記録はありませんでした。';
  }
  return '（参考）' + name + '：' + String(row['値']);
}

/**
 * 選択肢を展開する。
 * `{夜勤スタッフ}` と書いておくと、S1の有効な夜勤スタッフの氏名（最大3名）＋「その他（名前を入力）」になる。
 * 名前をコードに埋め込まず、スタッフの入れ替わりに自動で追従させるための仕組み。
 * @param {string} raw S3の選択肢欄の値
 * @return {Array.<string>} 選択肢の配列
 */
function expandChoices_(raw) {
  if (String(raw).indexOf('{夜勤スタッフ}') < 0) {
    return String(raw).split('|').filter(function (s) { return s.trim(); });
  }
  var names = findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && String(r['役割']).indexOf('夜勤') >= 0;
  }).map(function (r) { return String(r['氏名']); }).slice(0, 3);
  return names.concat(['その他（名前を入力）']);
}

/**
 * 質問文のプレースホルダを埋める。
 * {対象}=利用者名またはスタッフ名 / {日付}=対象日 / {月}=対象月 / {締切日}=シフト締切日
 * @param {string} template 質問文テンプレート
 * @param {Object} gap S5の行
 * @return {string} 置換後の文字列
 */
function fillPlaceholders_(template, gap) {
  var date = toDateStr_(gap['対象日']);
  var md = date ? (Number(date.substring(5, 7)) + '/' + Number(date.substring(8, 10))) : '';
  var month = date ? (Number(date.substring(5, 7)) + '月') : '';
  return String(template)
    .replace(/\{対象\}/g, displayName_(String(gap['対象'])))
    .replace(/\{日付\}/g, md)
    .replace(/\{月\}/g, month)
    .replace(/\{締切日\}/g, String(getSettingNum('shift_deadline_day', 25)));
}

/**
 * コード（user_code / staff_id）を表示名に変換する。
 * S9対応表 → S1スタッフマスタの順で探し、見つからなければコードのまま返す。
 * @param {string} code コード
 * @return {string} 表示名
 */
function displayName_(code) {
  var staffTable = safely_('displayName_', function () { return readTable(SHEETS.STAFF); }, { rows: [] });
  if (displayName_._src !== staffTable || displayName_._len !== staffTable.rows.length) {
    var m = {};
    staffTable.rows.forEach(function (r) {
      if (r['氏名']) m[String(r['staff_id'])] = String(r['氏名']);
    });
    safely_('displayName_', function () {
      findRows(SHEETS.NAME_MAP).forEach(function (r) {
        if (r['氏名']) m[String(r['コード'])] = String(r['氏名']);
      });
    });
    displayName_._map = m;
    displayName_._src = staffTable;
    displayName_._len = staffTable.rows.length;
  }
  return displayName_._map[String(code)] || String(code);
}

/**
 * ボタン回答（postback: ans|task_id|値）を処理する。
 * @param {Object} staff 回答したスタッフのS1行
 * @param {string} taskId task_id
 * @param {string} answer 回答値
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function handleAnswer_(staff, taskId, answer, replyToken) {
  var proc = 'handleAnswer_';
  var task = findRow(SHEETS.TASK, { 'task_id': taskId });
  if (!task) {
    replyRaw_(replyToken, [msgText_('この確認は見つかりませんでした。お手数ですが「状況」と送って確認してください。')]);
    return;
  }
  if (String(task['回答'] || '').trim()) {
    replyRaw_(replyToken, [msgText_('この項目はすでに回答済みです。ありがとうございます。')]);
    return;
  }
  // 自分あての確認かどうかを必ず確認する（他人あてのタスクには回答させない）
  if (String(task['送信先staff_id']) !== String(staff['staff_id'])) {
    logWarn(proc, '回答権限のない操作: ' + staff['staff_id'] + ' → ' + taskId);
    replyRaw_(replyToken, [msgText_('この確認にはお答えいただけません。')]);
    return;
  }

  var gap = findRow(SHEETS.GAP, { 'gap_id': task['gap_id'] });
  var check = gap ? checkById_(gap['check_id']) : null;

  // すでに送信済みの質問に他の人が先に答えていた場合（同じ不足を2名に送っているため起こりうる）
  if (gap && String(gap['状態']) === GAP_STATUS.DONE) {
    updateRow(SHEETS.TASK, task._row, {
      '回答': answer + '（他の方が先に回答済み）',
      '回答日時': nowStr_(),
      '回答方法': 'ボタン'
    });
    var done = msgText_('この項目は他の方が回答済みでした。ありがとうございます。');
    if (sendNextInSet_(task['セットid'], replyToken, [done]) === SEND_RESULT.NONE) {
      replyRaw_(replyToken, [done]);
    }
    logInfo(proc, taskId + ' は他の人が回答済みのため二重記録しない');
    return;
  }

  updateRow(SHEETS.TASK, task._row, {
    '回答': answer,
    '回答日時': nowStr_(),
    '回答方法': 'ボタン'
  });

  var needNote = NEEDS_NOTE_ANSWERS.indexOf(answer) >= 0;
  var unknown = UNKNOWN_ANSWERS.indexOf(answer) >= 0;
  var later = (answer.indexOf('後で') === 0);

  if (gap) {
    if (later) {
      // 「後で」は不足のまま残し、翌日また確認する
      updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.DETECTED });
    } else if (unknown) {
      // 「わからない」は不足解消とみなさず滞留させる（04共通ルール）
      updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.ESCALATED });
    } else if (needNote) {
      // 一言待ち。追記を受け取った時点で記録として成立させる（handleNote_）
      updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.ANSWERED });
    } else {
      updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.ANSWERED });
      recordFill_(gap, check, answer, staff);
      updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.DONE, '完了日時': nowStr_() });
      cancelSiblingTasks_(gap['gap_id'], task['task_id']);
    }
  }
  logInfo(proc, staff['氏名'] + ' が ' + taskId + ' に「' + answer + '」と回答');

  if (needNote || unknown) {
    updateRow(SHEETS.TASK, task._row, { '追記待ち': true });
    replyRaw_(replyToken, [msgText_(NOTE_PROMPTS[answer] || NOTE_PROMPT_DEFAULT)]);
    return;
  }

  finishTurn_(task, replyToken);
}

/**
 * 回答受付後の締めくくり。次の質問があれば送り、無ければ完了メッセージを返す。
 * 送信に失敗した場合は同じreplyTokenを二度使わない（1回限りのため）。失敗分はflushQueueがpushで送る。
 * @param {Object} task S6の行
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function finishTurn_(task, replyToken) {
  var thanks = msgText_('ありがとうございます。記録に反映しました。');
  var result = sendNextInSet_(task['セットid'], replyToken, [thanks]);
  if (result === SEND_RESULT.NONE) {
    replyRaw_(replyToken, [msgText_('ありがとうございます。記録に反映しました。\nこれで全部完了です。おつかれさまでした。')]);
  } else if (result === SEND_RESULT.FAILED) {
    logWarn('finishTurn_', '返信に失敗したため、次の質問はpush送信に切り替えます（' + task['セットid'] + '）');
  }
}

/**
 * 自由記述（追記）を処理する。追記待ちのタスクがあれば回答に追記する。
 * @param {Object} staff スタッフのS1行
 * @param {string} text 受信テキスト
 * @param {string} replyToken 返信トークン
 * @return {boolean} 追記として処理したらtrue
 */
function handleNote_(staff, text, replyToken) {
  // コマンドは一言記述として取り込まない。
  // 追記を求めたまま返事が無い状態は珍しくなく、そこへ「診断」等が来たときに
  // それを台帳の一言欄に書いてしまうと、記録が読めないものになるため。
  if (COMMAND_WORDS.indexOf(String(text).trim()) >= 0) return false;

  var pending = findRows(SHEETS.TASK, function (r) {
    return String(r['送信先staff_id']) === String(staff['staff_id']) && isTrue_(r['追記待ち']);
  }).sort(function (a, b) {
    return toDateTimeStr_(b['回答日時']).localeCompare(toDateTimeStr_(a['回答日時']));
  });
  if (!pending.length) return false;

  var task = pending[0];
  var base = String(task['回答'] || '');
  var note = (String(text).trim() === 'なし') ? '' : String(text).trim();
  var combined = base + (note ? '／' + note : '');
  updateRow(SHEETS.TASK, task._row, {
    '回答': combined,
    '回答方法': '自由記述',
    '追記待ち': false
  });

  var gap = findRow(SHEETS.GAP, { 'gap_id': task['gap_id'] });
  var check = gap ? checkById_(gap['check_id']) : null;
  if (gap && UNKNOWN_ANSWERS.indexOf(base) < 0 && String(gap['状態']) !== GAP_STATUS.DONE) {
    // 「わからない」以外は、状況が書かれた時点で記録として成立させる
    recordFill_(gap, check, combined, staff);
    updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.DONE, '完了日時': nowStr_() });
    cancelSiblingTasks_(gap['gap_id'], task['task_id']);
  }

  finishTurn_(task, replyToken);
  return true;
}

/**
 * 回答内容をS7補完台帳とS4実績ログに記録する。
 * @param {Object} gap S5の行
 * @param {Object} check S3の行
 * @param {string} value 回答値
 * @param {Object} staff 回答したスタッフのS1行
 * @return {void}
 */
function recordFill_(gap, check, value, staff) {
  var itemName = check ? String(check['項目名']) : String(gap['check_id']);
  var kind = check ? String(check['対象種別']) : 'support';
  var date = toDateStr_(gap['対象日']);
  var gapId = String(gap['gap_id']);

  // 同じ不足に対する記録が既にあれば書かない（二重記録の防止）
  if (findRow(SHEETS.FILL, { 'gap_id': gapId })) {
    logWarn('recordFill_', '既に記録済みのためスキップ: ' + gapId);
    return;
  }

  // AIが先に推定で埋めていた場合は、人の回答と突き合わせて精度の実績を貯める（learn.gs）。
  // 当たる組み合わせはやがて質問されなくなり、外れが増えれば聞き直しに戻る。
  var learned = learnFromAnswer_(date, String(gap['対象']), itemName, value);

  // シフト希望は対象月（YYYY-MM）を値に含める。R01がこの値を見て「回答済み」と判定するため。
  if (kind === 'shift') value = date.substring(0, 7) + ' ' + value;

  appendRow(SHEETS.FILL, {
    'fill_id': nextSeqId_(SHEETS.FILL, 'fill_id', 'FIL', 6),
    '対象日': date,
    '対象': String(gap['対象']),
    '項目名': itemName,
    '値': value,
    '記入者staff_id': String(staff['staff_id']),
    '取込済フラグ': false,
    '作成日時': nowStr_(),
    'gap_id': gapId,
    '情報源': fillSourceOf_(gap, staff),
    '要精査': false,
    '精査結果': ''
  });

  // 推定で先に埋めていた行があれば、そこを人の回答で上書きする（同じ項目が2行に増えないように）
  if (!supersedeEstimate_(date, String(gap['対象']), itemName, value)) {
    appendRow(SHEETS.LOG_IMPORT, {
      'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
      '発生日': date,
      '対象種別': kind,
      '対象': String(gap['対象']),
      '項目名': itemName,
      '値': value,
      '取込元': 'ai-uribo',
      '取込日時': nowStr_(),
      '確度': CERTAINTY.FIXED,
      '推定回答': ''
    });
  }

  if (learned.突合) {
    logInfo('recordFill_', '推定と回答の突き合わせ: ' + itemName + '（' + learned.情報源 + '）→ '
      + (learned.一致 ? '一致' : '不一致'));
  }
}

/**
 * その日・その利用者・その項目に推定の記録が既にあれば、人の回答で上書きする。
 *
 * 推定は「まだ確かめていない仮の記録」なので、人が答えた時点で役目を終える。
 * 行を増やさず上書きすることで、既存アプリが取り込む記録は常に1項目1行になる。
 * @param {string} date 対象日
 * @param {string} target 対象
 * @param {string} itemName 項目名
 * @param {string} value 人の回答
 * @return {boolean} 上書きしたらtrue
 */
function supersedeEstimate_(date, target, itemName, value) {
  var rows = findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date
      && String(r['対象']) === String(target)
      && String(r['項目名']) === String(itemName)
      && String(r['対象種別']) === 'support'
      && String(r['確度']) === CERTAINTY.ESTIMATED;
  });
  if (!rows.length) return false;

  updateRow(SHEETS.LOG_IMPORT, rows[0]._row, {
    '値': value,
    '取込元': 'ai-uribo',
    '取込日時': nowStr_(),
    '確度': CERTAINTY.FIXED
  });
  return true;
}

/**
 * その記録が「誰の情報か」を判定する。
 * 監査では「いつ・誰が・誰に・何をしたか」が問われるため、支援した人と確認した人を分けて残す。
 *
 * ・本人回答             … スタッフ本人のこと（シフト希望など）
 * ・支援担当者の記録     … 支援した本人（夜勤・世話人）がその場で答えた
 * ・支援担当者名＋管理者確認 … 社員・管理者が拠点を回り、紙台帳や口頭で担当者を確認して入力した
 *                            （代理入力ではなく、担当者名と確認者名の両方を残す形）
 * ・自動ログ             … 機械の記録（autofill.gs 側で付与）
 * @param {Object} gap S5の行
 * @param {Object} staff 回答したスタッフのS1行
 * @return {string} 情報源
 */
function fillSourceOf_(gap, staff) {
  if (String(gap['対象']) === String(staff['staff_id'])) return '本人回答';

  var role = String(staff['役割']);
  if (role !== '社員' && role !== '管理者') {
    return '支援担当者の記録（' + String(staff['氏名']) + '）';
  }

  // 社員・管理者が入力した場合は、その日の夜勤担当者名とセットで残す
  var site = siteOfTarget_(String(gap['対象']));
  var name = site ? safely_('fillSourceOf_', function () {
    return nightStaffNameOf_(gap['対象日'], site);
  }, '') : '';
  if (name) return '支援担当者：' + name + '／管理者確認：' + String(staff['氏名']);
  return '管理者確認：' + String(staff['氏名']) + '（担当者名は未記録）';
}

/**
 * 対象（user_code または拠点名）の拠点を返す。
 * @param {string} target 対象
 * @return {string} 拠点名（分からなければ空文字）
 */
function siteOfTarget_(target) {
  var user = safely_('siteOfTarget_', function () {
    return findRow(SHEETS.USER, { 'user_code': target });
  }, null);
  if (user && user['拠点']) return String(user['拠点']);
  // 夜勤担当者の質問そのものは対象が拠点名
  var isSite = safely_('siteOfTarget_', function () {
    return findRows(SHEETS.USER).some(function (u) { return String(u['拠点']) === String(target); });
  }, false);
  return isSite ? String(target) : '';
}

/**
 * 同じ不足に対する他の人の待機タスクを中止する（重複質問の防止）。
 * @param {string} gapId gap_id
 * @param {string} exceptTaskId 除外するtask_id
 * @return {void}
 */
function cancelSiblingTasks_(gapId, exceptTaskId) {
  findRows(SHEETS.TASK, function (r) {
    return String(r['gap_id']) === String(gapId)
      && String(r['task_id']) !== String(exceptTaskId)
      && (String(r['送信状態']) === SEND_STATUS.WAITING || String(r['送信状態']) === SEND_STATUS.QUEUED);
  }).forEach(function (t) {
    updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED });
  });
}
