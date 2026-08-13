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
 * **給与計算ソフトの書き出しをそのまま貼れる**ようにしてある。
 * 形をそろえる手間を人にかけないため、次のどれでも読む（詳しくは importShiftText を参照）。
 *
 *   A) 見出し付きの表（CSV・Excelからのコピー）… 列の並びは自由
 *   B) 月間シフト表（横に日付が並ぶ形）… セルは「夜」「明」「休」などの記号でよい
 *   C) 1行に「日付 拠点 勤務区分 氏名」（手で書くとき）
 *
 * ・拠点の列が無ければ、その人のS1の拠点を使う（本部所属など、利用者がいない所属は使わない）
 * ・「休」「公休」「×」「空欄」は取り込まない
 * ・「明（明け）」は朝で終わる勤務なので、その晩の夜勤としては扱わない
 * ・氏名はS1_スタッフマスタに登録されている氏名（一部でも可）
 * ・読めなかった行は捨てずに理由を返すので、直してもう一度貼り付ければよい
 */

/**
 * シフト表の文章を取り込む。
 *
 * 給与計算ソフトからの書き出しは、だいたい次のどれかの形になる。
 * どれで貼られても読めるようにしてある（形をそろえる手間を人にかけないため）。
 *
 *   A) 見出し付きの表（CSV・Excelからのコピー）
 *        日付,氏名,勤務区分
 *        2026-08-01,服部俊喜,夜勤
 *      … 列の並びは自由。拠点の列があれば使い、無ければS1の拠点を使う
 *
 *   B) 月間シフト表（横に日付が並ぶ形）
 *        氏名,1,2,3,...
 *        服部俊喜,夜,明,休,...
 *      … 先頭に「2026年8月」等があればその月。無ければ今月として読む
 *
 *   C) 1行に「日付 拠点 勤務区分 氏名」（手で書くとき）
 *
 * @param {string} text 貼り付けられた文章
 * @return {{追加:number, 更新:number, 読めなかった行:Array.<string>, 対象月:string, 形式:string}} 取り込み結果
 */
function importShiftText(text) {
  var proc = 'importShiftText';
  return withLock_(proc, 60000, function () {
    var parsed = parseShiftText_(text);
    var result = { 追加: 0, 更新: 0, 読めなかった行: parsed.errors, 対象月: parsed.month, 形式: parsed.format };
    var staff = findRows(SHEETS.STAFF, function (r) { return isTrue_(r['有効']); });
    // 利用者がいる拠点＝実際に夜勤が立つ場所。ここに無い所属（本部など）は拠点として使えない
    var activeSites = {};
    findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); })
      .forEach(function (u) { if (u['拠点']) activeSites[String(u['拠点']).trim()] = true; });

    parsed.rows.forEach(function (row) {
      var member = matchStaffByName_(staff, row.name);
      if (!member) {
        result.読めなかった行.push(row.raw + ' … 「' + row.name + '」がスタッフ一覧にありません');
        return;
      }
      var site = resolveShiftSite_(row.site, member, activeSites);
      if (!site) {
        result.読めなかった行.push(row.raw + ' … ' + String(member['氏名']) + 'さんの拠点が決まりません'
          + '（所属が「' + String(member['拠点'] || '未設定') + '」で、そこには利用者がいません）。'
          + '表に拠点の列を足すか、その方のS1の拠点を実際の拠点にしてください');
        return;
      }

      var exists = findRow(SHEETS.SHIFT_PLAN, function (r) {
        return toDateStr_(r['日付']) === row.date
          && String(r['staff_id']) === String(member['staff_id'])
          && String(r['拠点']) === site;
      });
      if (exists) {
        updateRow(SHEETS.SHIFT_PLAN, exists._row, { '勤務区分': row.kind, '取込元': parsed.format });
        result.更新++;
      } else {
        appendRow(SHEETS.SHIFT_PLAN, {
          '日付': row.date,
          'staff_id': String(member['staff_id']),
          '拠点': site,
          '勤務区分': row.kind,
          '開始時刻': row.from || '',
          '終了時刻': row.to || '',
          '取込元': parsed.format
        });
        result.追加++;
      }
    });

    logInfo(proc, '形式' + parsed.format + ' / 追加' + result.追加 + '件 / 更新' + result.更新
      + '件 / 読めなかった行' + result.読めなかった行.length + '件（対象月 ' + result.対象月 + '）');
    return result;
  }, function () {
    return { 追加: 0, 更新: 0, 読めなかった行: ['他の処理が実行中でした。もう一度お試しください'],
             対象月: '', 形式: '' };
  });
}

/**
 * その行の拠点を決める。
 *
 * 給与ソフトのシフトには拠点が無いことが多いので、その人のS1の所属で補う。
 * ただし所属が「本部」のように**利用者がいない場所**なら、そこを拠点にはできない
 * （その拠点の夜勤担当者として記録しても、誰の支援にもひもづかない）。
 * 拠点が1つしか無い法人なら迷う余地が無いので、その拠点を使う。
 *
 * @param {string} written 表に書かれていた拠点
 * @param {Object} member S1の行
 * @param {Object.<string,boolean>} activeSites 利用者がいる拠点
 * @return {string} 拠点（決められなければ空文字）
 */
function resolveShiftSite_(written, member, activeSites) {
  var site = String(written || '').trim();
  if (site) return site;

  var own = String(member['拠点'] || '').trim();
  if (own && activeSites[own]) return own;

  var names = Object.keys(activeSites);
  if (names.length === 1) return names[0];   // 拠点が1つなら迷わない
  return '';
}

/**
 * 貼り付けられた文章を、形を見分けて {日付・氏名・勤務区分} の並びにほどく。
 * @param {string} text 貼り付け本文
 * @return {{rows:Array.<Object>, errors:Array.<string>, month:string, format:string}} 解析結果
 */
function parseShiftText_(text) {
  var lines = String(text || '').split(/\r?\n/);
  var month = todayStr_().substring(0, 7);
  var out = { rows: [], errors: [], month: month, format: '手入力' };

  var headerMap = null;   // 見出し付きの表のときの 列位置→意味
  var dayColumns = null;  // 月間シフト表のときの 列位置→日

  lines.forEach(function (raw) {
    var line = String(raw).replace(/[　]/g, ' ').replace(/\s+$/, '');
    if (!line.trim()) return;

    // 年月だけの行（「2026-08」「2026年8月」「2026年8月度」など）は、以降の基準にする
    var head = line.match(/(20\d{2})[-\/年]\s*(\d{1,2})\s*月?/);
    if (head && splitCells_(line).length <= 2) {
      month = head[1] + '-' + padTwo_(head[2]);
      out.month = month;
      return;
    }

    var cells = splitCells_(line);
    if (!cells.length) return;

    // 見出し行（日付・氏名などの列名が並ぶ）
    var map = detectHeader_(cells);
    if (map) { headerMap = map; dayColumns = null; out.format = 'CSV'; return; }

    // 月間シフト表の日付行（1〜31が横に並ぶ）
    var days = detectDayRow_(cells);
    if (days) { dayColumns = days; headerMap = null; out.format = '月間シフト表'; return; }

    if (headerMap) { parseMappedRow_(cells, headerMap, month, line, out); return; }
    if (dayColumns) { parseMatrixRow_(cells, dayColumns, month, line, out); return; }
    parsePositionalRow_(cells, month, line, out);
  });

  return out;
}

/**
 * 1行をセルに分ける。ExcelやCSVからの貼り付けはタブ／カンマ区切りが多い。
 * @param {string} line 1行
 * @return {Array.<string>} セルの配列
 */
function splitCells_(line) {
  var sep = (line.indexOf('\t') >= 0) ? /\t/ : (line.indexOf(',') >= 0 ? /,/ : /[\s、]+/);
  return String(line).split(sep).map(function (c) { return String(c).trim(); })
    .filter(function (c, i, arr) { return c !== '' || i < arr.length - 1; });
}

/**
 * 見出し行かどうかを判定し、列の意味を返す。
 * @param {Array.<string>} cells セル
 * @return {Object|null} {date:i, name:i, kind:i, site:i, from:i, to:i}
 */
function detectHeader_(cells) {
  var map = {};
  cells.forEach(function (c, i) {
    var t = c.replace(/\s/g, '');
    if (/^(日付|年月日|日|勤務日)$/.test(t)) map.date = i;
    else if (/^(氏名|名前|社員名|従業員名|スタッフ名|担当者)$/.test(t)) map.name = i;
    else if (/(勤務区分|シフト|勤務|区分|勤務種別|パターン)/.test(t)) map.kind = i;
    else if (/(拠点|事業所|施設|所属|部門)/.test(t)) map.site = i;
    else if (/(開始|出勤時刻|始業)/.test(t)) map.from = i;
    else if (/(終了|退勤時刻|終業)/.test(t)) map.to = i;
  });
  // 日付と氏名の両方がある行だけを見出しとみなす（データ行を見出しと誤認しないため）
  return (map.date !== undefined && map.name !== undefined) ? map : null;
}

/**
 * 月間シフト表の日付行かどうかを判定する。
 * @param {Array.<string>} cells セル
 * @return {Object|null} 列位置→日 の対応
 */
function detectDayRow_(cells) {
  var days = {};
  var count = 0;
  cells.forEach(function (c, i) {
    var m = String(c).match(/^(\d{1,2})[日]?$/);
    if (m) {
      var n = Number(m[1]);
      if (n >= 1 && n <= 31) { days[i] = n; count++; }
    }
  });
  // 1〜31が10個以上並んでいれば、月間シフト表の日付行とみなす
  return count >= 10 ? days : null;
}

/**
 * 見出し付きの表の1行を読む。
 * @param {Array.<string>} cells セル
 * @param {Object} map 列の意味
 * @param {string} month 基準の年月
 * @param {string} raw 元の行（エラー表示用）
 * @param {Object} out 出力先
 * @return {void}
 */
function parseMappedRow_(cells, map, month, raw, out) {
  var date = parseShiftDate_(cells[map.date] || '', month);
  if (!date) { out.errors.push(raw + ' … 日付が読めません'); return; }
  var name = cells[map.name] || '';
  if (!name) { out.errors.push(raw + ' … 氏名が空です'); return; }
  var kind = (map.kind !== undefined ? cells[map.kind] : '') || '';
  if (isRestKind_(kind)) return;   // 休みの行は取り込まない
  out.rows.push({
    date: date, name: name, kind: kind || '勤務',
    site: map.site !== undefined ? cells[map.site] : '',
    from: map.from !== undefined ? cells[map.from] : '',
    to: map.to !== undefined ? cells[map.to] : '',
    raw: raw
  });
}

/**
 * 月間シフト表の1行（氏名＋各日の勤務記号）を読む。
 * @param {Array.<string>} cells セル
 * @param {Object} dayColumns 列位置→日
 * @param {string} month 基準の年月
 * @param {string} raw 元の行（エラー表示用）
 * @param {Object} out 出力先
 * @return {void}
 */
function parseMatrixRow_(cells, dayColumns, month, raw, out) {
  var name = String(cells[0] || '').trim();
  if (!name) return;
  var wrote = 0;
  Object.keys(dayColumns).forEach(function (i) {
    var kind = String(cells[i] || '').trim();
    if (!kind || isRestKind_(kind)) return;
    var date = buildDate_(month.substring(0, 4), month.substring(5, 7), dayColumns[i]);
    if (!date) return;
    out.rows.push({ date: date, name: name, kind: kind, site: '', raw: raw });
    wrote++;
  });
  if (!wrote) out.errors.push(raw + ' … 勤務の記号が読めませんでした（休みだけの行なら問題ありません）');
}

/**
 * 「日付 拠点 勤務区分 氏名」の1行を読む。
 * @param {Array.<string>} cells セル
 * @param {string} month 基準の年月
 * @param {string} raw 元の行（エラー表示用）
 * @param {Object} out 出力先
 * @return {void}
 */
function parsePositionalRow_(cells, month, raw, out) {
  if (cells.length < 4) { out.errors.push(raw + ' … 4つに分かれていません'); return; }
  var date = parseShiftDate_(cells[0], month);
  if (!date) { out.errors.push(raw + ' … 日付が読めません'); return; }
  out.rows.push({
    date: date, site: cells[1], kind: cells[2],
    name: cells.slice(3).join(' '), raw: raw
  });
}

/**
 * 休み・空欄を表す記号かどうか。
 * @param {string} kind 勤務区分
 * @return {boolean} 休みならtrue
 */
function isRestKind_(kind) {
  var t = String(kind).replace(/\s/g, '');
  return !t || /^(休|公休|有休|有給|希望休|×|✕|✗|-|ー|−|休み|OFF|off)$/.test(t);
}

/**
 * その勤務区分が「その晩の夜勤」かどうか。
 *
 * 2交代では「夜」の翌日が「明（明け）」になる。明けは朝で終わる勤務なので、
 * その日の夜勤担当者にしてしまうと、実際に泊まった人とずれる。
 * @param {string} kind 勤務区分
 * @return {boolean} 夜勤ならtrue
 */
function isNightKind_(kind) {
  var t = String(kind);
  if (/明/.test(t)) return false;
  return /夜/.test(t);
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
    return toDateStr_(r['日付']) === date && isNightKind_(r['勤務区分']);
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
        && isNightKind_(r['勤務区分'])
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
