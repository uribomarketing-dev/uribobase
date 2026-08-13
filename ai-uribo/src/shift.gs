/**
 * シフト表の取り込み（S11_勤務予定）
 *
 * 【なぜ要るか】
 * いまは毎日「その日の夜勤担当者は誰でしたか」と拠点ごとに1問ずつ聞いている。
 * 監査で「誰が支援したか」を残すために必要な質問だが、
 * **シフト表は月初にはもう決まっている**。決まっていることを毎日聞くのは無駄で、
 * しかも聞き逃した日は担当者名が空欄のまま残ってしまう。
 *
 * 月に一度シフト表を貼り付けておけば、
 *   ・その日の夜勤担当者の質問が出なくなる（記録は自動で入る）
 *   ・夜の確認セットが、実際にその日入っている人に届く
 *
 * 【貼り付ける形】
 * 1行に「日付　拠点　勤務区分　氏名」を空白区切りで書く。順番は変えない。
 *
 *   2026-08
 *   8/1  清水  夜勤  服部俊喜
 *   8/2  玉里  夜勤  兼崎
 *   8/3  清水  日勤  藤原寛
 *
 * ・先頭に「2026-08」の行があれば、以降の「8/1」をその年の日付として読む
 * ・日付は「8/1」「08/01」「2026-08-01」「1日」のいずれでもよい
 * ・氏名はS1_スタッフマスタに登録されている氏名（一部でも可）
 * ・読めなかった行は捨てずに理由を返すので、直してもう一度貼り付ければよい
 */

/**
 * シフト表の文章を取り込む。
 * @param {string} text 貼り付けられた文章
 * @return {{追加:number, 更新:number, 読めなかった行:Array.<string>, 対象月:string}} 取り込み結果
 */
function importShiftText(text) {
  var proc = 'importShiftText';
  return withLock_(proc, 60000, function () {
    var result = { 追加: 0, 更新: 0, 読めなかった行: [], 対象月: '' };
    var lines = String(text || '').split(/\r?\n/);
    var month = todayStr_().substring(0, 7);

    // 氏名 → staff_id の索引（部分一致も引けるように配列で持つ）
    var staff = findRows(SHEETS.STAFF, function (r) { return isTrue_(r['有効']); });

    lines.forEach(function (raw) {
      var line = String(raw).replace(/[　]/g, ' ').trim();
      if (!line) return;

      // 「2026-08」「2026/8」だけの行は、以降の日付の年月として扱う
      var head = line.match(/^(20\d{2})[-\/年](\d{1,2})月?$/);
      if (head) {
        month = head[1] + '-' + padTwo_(head[2]);
        result.対象月 = month;
        return;
      }

      var cols = line.split(/[\s,、]+/).filter(function (c) { return c; });
      if (cols.length < 4) { result.読めなかった行.push(line + ' … 4つに分かれていません'); return; }

      var date = parseShiftDate_(cols[0], month);
      if (!date) { result.読めなかった行.push(line + ' … 日付が読めません'); return; }

      var site = cols[1];
      var kind = cols[2];
      var name = cols.slice(3).join(' ');
      var member = matchStaffByName_(staff, name);
      if (!member) {
        result.読めなかった行.push(line + ' … 「' + name + '」がスタッフ一覧にありません');
        return;
      }

      var exists = findRow(SHEETS.SHIFT_PLAN, function (r) {
        return toDateStr_(r['日付']) === date
          && String(r['staff_id']) === String(member['staff_id'])
          && String(r['拠点']) === site;
      });
      if (exists) {
        updateRow(SHEETS.SHIFT_PLAN, exists._row, { '勤務区分': kind, '取込元': 'paste' });
        result.更新++;
      } else {
        appendRow(SHEETS.SHIFT_PLAN, {
          '日付': date,
          'staff_id': String(member['staff_id']),
          '拠点': site,
          '勤務区分': kind,
          '開始時刻': '',
          '終了時刻': '',
          '取込元': 'paste'
        });
        result.追加++;
      }
    });

    if (!result.対象月) result.対象月 = month;
    logInfo(proc, '追加' + result.追加 + '件 / 更新' + result.更新 + '件 / 読めなかった行'
      + result.読めなかった行.length + '件（対象月 ' + result.対象月 + '）');
    return result;
  }, function () {
    return { 追加: 0, 更新: 0, 読めなかった行: ['他の処理が実行中でした。もう一度お試しください'], 対象月: '' };
  });
}

/**
 * 「8/1」「08/01」「2026-08-01」「1日」を YYYY-MM-DD にする。
 * @param {string} token 日付の文字列
 * @param {string} month 基準の年月 YYYY-MM
 * @return {string} YYYY-MM-DD（読めなければ空文字）
 */
function parseShiftDate_(token, month) {
  var t = String(token).trim();
  var y = month.substring(0, 4);

  var full = t.match(/^(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (full) return buildDate_(full[1], full[2], full[3]);

  var md = t.match(/^(\d{1,2})[-\/月](\d{1,2})日?$/);
  if (md) return buildDate_(y, md[1], md[2]);

  var d = t.match(/^(\d{1,2})日?$/);
  if (d) return buildDate_(y, month.substring(5, 7), d[1]);

  return '';
}

/**
 * 実在する日付なら YYYY-MM-DD を返す。
 * 「8/99」のような打ち間違いをそのまま台帳に入れると、
 * 永久に対象日が来ない予定が残り続けるため、ここで弾く。
 * @param {string|number} y 年
 * @param {string|number} m 月
 * @param {string|number} d 日
 * @return {string} YYYY-MM-DD（実在しなければ空文字）
 */
function buildDate_(y, m, d) {
  var year = Number(y);
  var mon = Number(m);
  var day = Number(d);
  if (!year || mon < 1 || mon > 12 || day < 1 || day > 31) return '';
  var dt = new Date(year, mon - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== mon - 1 || dt.getDate() !== day) return '';
  return year + '-' + padTwo_(mon) + '-' + padTwo_(day);
}

/**
 * 1桁の数字を2桁にそろえる。
 * @param {string|number} n 数字
 * @return {string} 2桁の文字列
 */
function padTwo_(n) {
  var s = String(n);
  return s.length < 2 ? '0' + s : s;
}

/**
 * 氏名からスタッフを探す（完全一致 → 部分一致の順）。
 * 同じ書き方で2人以上に当たるときは、取り違えるより読めなかった扱いにする。
 * @param {Array.<Object>} staff S1の行の配列
 * @param {string} name 氏名
 * @return {Object|null} スタッフの行
 */
function matchStaffByName_(staff, name) {
  var key = String(name).replace(/[\s　]/g, '');
  var exact = staff.filter(function (r) {
    return String(r['氏名']).replace(/[\s　]/g, '') === key;
  });
  if (exact.length === 1) return exact[0];

  var partial = staff.filter(function (r) {
    var n = String(r['氏名']).replace(/[\s　]/g, '');
    return n && (n.indexOf(key) >= 0 || key.indexOf(n) >= 0);
  });
  return partial.length === 1 ? partial[0] : null;
}

/**
 * シフト表に夜勤の予定があれば、その日の「夜勤担当者」を記録として入れておく。
 *
 * これが入っていると、その拠点・その日の夜勤担当者の質問は出なくなり、
 * それでいて記録には「支援担当者：〇〇」が残る（監査で問われるのはこの名前）。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {number} 記録した件数
 */
function fillNightStaffFromShift_(targetDate) {
  var date = toDateStr_(targetDate);

  var planned = findRows(SHEETS.SHIFT_PLAN, function (r) {
    return toDateStr_(r['日付']) === date && String(r['勤務区分']).indexOf('夜勤') >= 0;
  });
  if (!planned.length) return 0;

  var have = {};
  findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date && String(r['項目名']) === '夜勤担当者';
  }).forEach(function (r) { have[String(r['対象'])] = true; });

  var n = 0;
  planned.forEach(function (p) {
    var site = String(p['拠点'] || '').trim();
    if (!site || have[site]) return;
    var member = staffById_(String(p['staff_id']));
    if (!member) return;
    have[site] = true;

    appendRow(SHEETS.LOG_IMPORT, {
      'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
      '発生日': date,
      '対象種別': 'support',
      '対象': site,
      '項目名': '夜勤担当者',
      '値': String(member['氏名']),
      '取込元': 'shift-table',
      '取込日時': nowStr_(),
      '確度': CERTAINTY.FIXED,   // 人が組んだシフト表そのもの。推測ではない
      '推定回答': ''
    });
    n++;
  });
  if (n) logInfo('fillNightStaffFromShift_', date + ' の夜勤担当者を' + n + '拠点分、シフト表から記録しました');
  return n;
}

/**
 * メニューからシフト表を取り込む。
 * @return {void}
 */
function menuImportShift_() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('シフト表の取り込み',
    '1行に「日付 拠点 勤務区分 氏名」を空白区切りで貼り付けてください。\n'
    + '例：8/1 清水 夜勤 服部俊喜',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  ui.alert('シフト表の取り込み', shiftResultText_(importShiftText(String(res.getResponseText()))),
    ui.ButtonSet.OK);
}

/**
 * 取り込み結果を人が読める文にする。
 * @param {Object} r importShiftText の戻り値
 * @return {string} 結果の文章
 */
function shiftResultText_(r) {
  var lines = ['シフト表を取り込みました（対象月 ' + r.対象月 + '）'];
  lines.push('追加 ' + r.追加 + '件 / 更新 ' + r.更新 + '件');
  if (r.読めなかった行.length) {
    lines.push('');
    lines.push('▼読めなかった行（' + r.読めなかった行.length + '件）');
    r.読めなかった行.slice(0, 10).forEach(function (l) { lines.push('・' + l); });
    if (r.読めなかった行.length > 10) lines.push('…ほか' + (r.読めなかった行.length - 10) + '行');
    lines.push('直してもう一度貼り付けてください（同じ行を入れ直しても二重にはなりません）。');
  } else if (r.追加 + r.更新 > 0) {
    lines.push('');
    lines.push('この期間は、夜勤担当者の質問が出なくなります（記録には担当者名が残ります）。');
  }
  return lines.join('\n');
}

/**
 * 「今日は誰が夜勤か」を、根拠つきで人が読める形にする。
 *
 * 夜の確認セットは夜勤の人に届く。だから**誰が夜勤だと思われているか**が見えないと、
 * 「送ったのに現場に届いていない」が静かに起きる。
 * どこから分かったのか（シフト表／役割／社員に代替）まで一緒に出す。
 *
 * @param {string} [targetDate] 対象日 YYYY-MM-DD（省略時は今日）
 * @return {string} 表示用の文章
 */
function nightShiftReport_(targetDate) {
  var date = toDateStr_(targetDate || todayStr_());
  var lines = ['【' + formatMd_(date) + 'の夜勤】'];

  var sites = {};
  findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); })
    .forEach(function (u) { if (u['拠点']) sites[String(u['拠点'])] = true; });
  var siteNames = Object.keys(sites);
  if (!siteNames.length) {
    lines.push('利用者がまだ登録されていないため、拠点が分かりません。');
    lines.push('メニュー「利用者を登録する」から登録してください。');
    return lines.join('\n');
  }

  var fallback = [];
  siteNames.forEach(function (site) {
    // 1. シフト表（いちばん確か）
    var planned = findRows(SHEETS.SHIFT_PLAN, function (r) {
      return toDateStr_(r['日付']) === date
        && String(r['勤務区分']).indexOf('夜勤') >= 0
        && String(r['拠点']) === site;
    }).map(function (r) { return staffById_(String(r['staff_id'])); })
      .filter(function (m) { return m; });

    if (planned.length) {
      lines.push('・' + site + '：' + planned.map(function (m) {
        return String(m['氏名']) + (String(m['line_user_id'] || '').trim() ? '' : '（LINE未登録★）');
      }).join('・') + '　←シフト表より');
      return;
    }

    // 2. 役割が夜勤の人
    var byRole = findRows(SHEETS.STAFF, function (r) {
      return isTrue_(r['有効']) && String(r['役割']).indexOf('夜勤') >= 0
        && String(r['拠点']) === site;
    });
    if (byRole.length) {
      lines.push('・' + site + '：' + byRole.map(function (m) {
        return String(m['氏名']) + (String(m['line_user_id'] || '').trim() ? '' : '（LINE未登録★）');
      }).join('・') + '　←S1の役割より（シフト表が無いため）');
      return;
    }

    fallback.push(site);
    lines.push('・' + site + '：**分かりません**　←シフト表にも、役割=夜勤の登録にもありません');
  });

  // 記録として残っている夜勤担当者（監査で問われるのはこちら）
  var recorded = findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date && String(r['項目名']) === '夜勤担当者';
  });
  if (recorded.length) {
    lines.push('');
    lines.push('記録上の担当者：' + recorded.map(function (r) {
      return String(r['対象']) + '＝' + String(r['値']);
    }).join('／'));
  }

  if (fallback.length) {
    lines.push('');
    lines.push('分からない拠点の夜の確認セットは、社員（'
      + escalationStaff_().map(function (s) { return String(s['氏名']); }).join('・')
      + '）にお送りします。');
    lines.push('直すには次のどちらかを行ってください。');
    lines.push('　A) メニュー「シフト表を取り込む」でその月の夜勤を貼り付ける（おすすめ）');
    lines.push('　B) S1_スタッフマスタに夜勤の方を追加し、役割を「夜勤」、拠点をその拠点にする');
  }
  return lines.join('\n');
}

/**
 * メニューから今日の夜勤を確認する。
 * @return {void}
 */
function menuNightShift_() {
  SpreadsheetApp.getUi().alert('今日の夜勤', nightShiftReport_(), SpreadsheetApp.getUi().ButtonSet.OK);
}
