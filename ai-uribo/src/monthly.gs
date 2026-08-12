/**
 * 月次まとめ（実地指導・監査に備えるための一覧）
 *
 * 【なぜ要るか】
 * 監査で問われるのは「その日、その人に、何をしたか」が残っているかどうか。
 * 日々の運用では、どの項目がどれだけ埋まっているのかが見えないまま月が過ぎる。
 * 月が変わったところで、拠点ごと・利用者ごと・項目ごとに
 * 「対象だった日数のうち、何日ぶん記録が残っているか」を一覧にする。
 *
 * 【見方】
 *   対象日数 … その利用者について記録が要る日数（外泊・入院の日は除く）
 *   記録あり … 実際に記録が残っている日数
 *   うち推定 … データからの推定で埋めたまま、まだ人が確かめていない日数
 *   充足率   … 記録あり ÷ 対象日数
 *
 * 充足率が低い項目が、そのまま「監査で突かれるところ」であり、
 * 「現場が実態をつかめていないところ」でもある。数字を見て手当てするのは人。
 */

/**
 * 月次まとめを作る。
 * @param {string} [yyyymm] 対象月 YYYY-MM（省略時は前月）
 * @return {string} 実行サマリ
 */
function monthlyReport(yyyymm) {
  var proc = 'monthlyReport';
  return withLock_(proc, BATCH_LOCK_WAIT_MS, function () {
    try {
      logStart(proc);
      var month = String(yyyymm || '').trim() || previousMonth_();
      var days = monthDays_(month);
      var rows = buildMonthlyRows_(month, days);
      writeMonthlySheet_(month, rows);
      var n = sendMonthlySummary_(proc, month, days.length, rows);

      var summary = month + ' の月次まとめ：' + rows.length + '行 / 送信' + n + '名';
      logInfo(proc, summary);
      writeLog(proc, '月次集計', JSON.stringify({ 対象月: month, 日数: days.length, 行数: rows.length }));
      return summary;
    } catch (e) {
      logError(proc, e);
      return 'エラー: ' + e;
    }
  }, function () { return '他の処理が実行中のためスキップ'; });
}

/**
 * 前月（YYYY-MM）を返す。
 * @return {string} YYYY-MM
 */
function previousMonth_() {
  var today = todayStr_();
  var firstOfThisMonth = today.substring(0, 8) + '01';
  return addDays_(firstOfThisMonth, -1).substring(0, 7);
}

/**
 * その月の日付（YYYY-MM-DD）を並べる。未来の日は含めない。
 * @param {string} month YYYY-MM
 * @return {Array.<string>} 日付の配列
 */
function monthDays_(month) {
  var days = [];
  var today = todayStr_();
  var d = month + '-01';
  while (d.substring(0, 7) === month) {
    if (d <= today) days.push(d);
    d = addDays_(d, 1);
  }
  return days;
}

/**
 * 月次まとめの明細を作る。
 * @param {string} month YYYY-MM
 * @param {Array.<string>} days 対象日の配列
 * @return {Array.<Object>} 明細
 */
function buildMonthlyRows_(month, days) {
  var users = findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); });
  var checks = findRows(SHEETS.CHECK, function (r) {
    return String(r['対象種別']) === 'support' && isTrue_(r['有効']) && String(r['判定ルールID']) !== '-';
  });
  if (!users.length || !checks.length) return [];

  // その月の支援記録を 対象＋日付＋項目名 で引けるようにする
  var recorded = {};
  var absent = {};
  findRows(SHEETS.LOG_IMPORT, function (r) {
    return String(r['対象種別']) === 'support' && toDateStr_(r['発生日']).substring(0, 7) === month;
  }).forEach(function (r) {
    var day = toDateStr_(r['発生日']);
    var key = r['対象'] + '\t' + day + '\t' + r['項目名'];
    recorded[key] = String(r['確度']) === CERTAINTY.ESTIMATED ? '推定' : '記録';
    // 外泊・入院の日は、その利用者のその日を対象から外す（検出の考え方と合わせる）
    if (String(r['項目名']) === '在否確認' && /外泊|入院|帰省|不在/.test(String(r['値']))) {
      absent[r['対象'] + '\t' + day] = true;
    }
  });

  var out = [];
  users.forEach(function (u) {
    var code = String(u['user_code']);
    var targetDays = days.filter(function (d) { return !absent[code + '\t' + d]; });

    checks.forEach(function (c) {
      var item = String(c['項目名']);
      var have = 0;
      var estimated = 0;
      var missing = [];
      targetDays.forEach(function (d) {
        var state = recorded[code + '\t' + d + '\t' + item];
        if (!state) { missing.push(d.substring(8)); return; }
        have++;
        if (state === '推定') estimated++;
      });
      out.push({
        拠点: String(u['拠点'] || ''),
        user_code: code,
        項目: item,
        対象日数: targetDays.length,
        記録あり: have,
        うち推定: estimated,
        充足率: targetDays.length ? Math.round(have * 100 / targetDays.length) : 100,
        未記録日: missing.slice(0, 15).join('・') + (missing.length > 15 ? '…' : '')
      });
    });
  });
  return out;
}

/**
 * 月次まとめをシートに書く（同じ月を作り直したら上書きする）。
 * @param {string} month YYYY-MM
 * @param {Array.<Object>} rows 明細
 * @return {void}
 */
function writeMonthlySheet_(month, rows) {
  var name = '月次_' + month;
  var book = book_();
  var headers = ['拠点', 'user_code', '項目', '対象日数', '記録あり', 'うち推定', '充足率(%)', '未記録日'];
  var sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#EFEFEF');
    sh.setFrozenRows(1);
    sh.getRange(1, 1).setNote('月次まとめ。対象日数は外泊・入院の日を除いた日数。'
      + '「うち推定」はデータから推定で埋めたまま、まだ人が確かめていない日数。'
      + '氏名は載せない（S9_対応表で照合すること）');
  } else if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).clearContent();
  }
  if (!rows.length) return;

  var values = rows.map(function (r) {
    return [r.拠点, r.user_code, r.項目, r.対象日数, r.記録あり, r.うち推定, r.充足率, r.未記録日];
  });
  sh.getRange(2, 1, values.length, headers.length).setValues(values);
  invalidateCache_(name);
}

/**
 * 月次まとめの要点を社員へ送る。
 * 数字を全部送っても読めないので、拠点ごとの充足率と、弱い項目だけを出す。
 * @param {string} proc ログ用の処理名
 * @param {string} month YYYY-MM
 * @param {number} dayCount 対象日数
 * @param {Array.<Object>} rows 明細
 * @return {number} 送信人数
 */
function sendMonthlySummary_(proc, month, dayCount, rows) {
  var lines = ['【月次まとめ】' + month + '（' + dayCount + '日分）'];

  if (!rows.length) {
    lines.push('');
    lines.push('対象の記録がありません（利用者の登録か、支援記録の開始をご確認ください）。');
    return sendToEscalationStaff([msgText_(lines.join('\n'))], proc);
  }

  // 拠点ごとの充足率
  var bySite = {};
  rows.forEach(function (r) {
    if (!bySite[r.拠点]) bySite[r.拠点] = { 対象: 0, 記録: 0, 推定: 0 };
    bySite[r.拠点].対象 += r.対象日数;
    bySite[r.拠点].記録 += r.記録あり;
    bySite[r.拠点].推定 += r.うち推定;
  });
  lines.push('');
  Object.keys(bySite).forEach(function (site) {
    var s = bySite[site];
    lines.push('■' + (site || '拠点未設定') + '　充足率 '
      + (s.対象 ? Math.round(s.記録 * 100 / s.対象) : 100) + '%'
      + '（記録 ' + s.記録 + '/' + s.対象 + '・うち未確認の推定 ' + s.推定 + '）');
  });

  // 弱いところから5つ
  var weak = rows.filter(function (r) { return r.充足率 < 100; })
    .sort(function (a, b) { return a.充足率 - b.充足率; });
  lines.push('');
  if (!weak.length) {
    lines.push('すべての項目が埋まっています。');
  } else {
    lines.push('▼記録が足りていない項目（弱い順に5件）');
    weak.slice(0, 5).forEach(function (r) {
      lines.push('・' + displayName_(r.user_code) + '「' + r.項目 + '」 '
        + r.記録あり + '/' + r.対象日数 + '日（' + r.充足率 + '%）');
      if (r.未記録日) lines.push('　未記録：' + r.未記録日 + '日');
    });
    if (weak.length > 5) lines.push('…ほか' + (weak.length - 5) + '項目');
  }
  lines.push('');
  lines.push('詳しくは台帳の「月次_' + month + '」シートをご覧ください。');
  return sendToEscalationStaff([msgText_(lines.join('\n'))], proc);
}

/**
 * メニューから先月の月次まとめを作る。
 * @return {void}
 */
function menuMonthlyReport_() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('月次まとめ', '対象月を YYYY-MM で入力してください（空欄なら先月）',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  ui.alert('月次まとめ', monthlyReport(String(res.getResponseText()).trim()), ui.ButtonSet.OK);
}
