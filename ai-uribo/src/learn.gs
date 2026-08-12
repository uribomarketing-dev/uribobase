/**
 * 学習（精度がひとりでに上がっていく仕組み）
 *
 * 【考え方】
 * AI Uriboは帳簿の隙間を積極的に埋める。ただし埋めた中身が当たっているかどうかは、
 * 最初のうちは分からない。そこで、
 *
 *   1. 推定で埋める（記録は空にしない）
 *   2. それでも人にも同じことを聞く（回答は1タップ）
 *   3. 人の回答とAIの推定を突き合わせ、「この情報源はこの項目でどれくらい当たるか」を貯める
 *   4. 十分に当たると分かった組み合わせは、質問そのものをやめる（＝手がかからなくなる）
 *   5. 外れが増えたら自動で聞き直しに戻す（＝センサーの故障や運用変更に自分で気づく）
 *
 * この4と5があるので、使えば使うほど質問が減り、それでいて精度は落ちない。
 * 実績はS13_学習ログに人が読める形で残るので、「なぜ聞かれなくなったのか」を後から説明できる。
 *
 * 学習を止めたいときは S8設定 learning_enabled を FALSE にする（常に人に聞くようになる）。
 */

/** 直近の当たり外れを何件まで覚えておくか @type {number} */
var LEARN_RECENT_MAX = 20;

/** 直近判定に使う件数と、そのうち何件外したら降格させるか @type {number} */
var LEARN_RECENT_WINDOW = 10;
var LEARN_RECENT_MISS_LIMIT = 3;

/**
 * 学習キーを作る（情報源×項目名の単位で精度を貯める）。
 * @param {string} sourceId 自動ソースのid
 * @param {string} itemName 項目名
 * @return {string} 学習キー
 */
function learnKey_(sourceId, itemName) {
  return String(sourceId) + '/' + String(itemName);
}

/**
 * 学習ログの行を取る。
 * @param {string} sourceId 自動ソースのid
 * @param {string} itemName 項目名
 * @return {Object|null} S13の行（無ければnull）
 */
function learnRow_(sourceId, itemName) {
  return findRow(SHEETS.LEARN, { '学習キー': learnKey_(sourceId, itemName) });
}

/**
 * いまこの組み合わせをどう扱うかを返す。
 *
 * @param {string} sourceId 自動ソースのid
 * @param {string} itemName 項目名
 * @return {string} LEARN_STAGE のいずれか
 */
function learnStage_(sourceId, itemName) {
  if (!isTrue_(getSetting('learning_enabled', 'TRUE'))) return LEARN_STAGE.LEARNING;
  var row = learnRow_(sourceId, itemName);
  if (!row) return LEARN_STAGE.LEARNING;
  var stage = String(row['段階'] || '').trim();
  return stage || LEARN_STAGE.LEARNING;
}

/**
 * 自動確定の組み合わせについて「今回は抜き打ちで人にも確認するか」を判定し、件数を進める。
 *
 * 自動確定にしたあとも一定件数に1回は聞く。センサーの位置がずれた・運用が変わったといった
 * 「今までどおりでは当たらなくなった」変化に、システム自身が気づけるようにするため。
 * @param {string} sourceId 自動ソースのid
 * @param {string} itemName 項目名
 * @return {boolean} trueなら今回は人にも確認する
 */
function learnSpotCheckDue_(sourceId, itemName) {
  var row = learnRow_(sourceId, itemName);
  if (!row) return true;
  var every = getSettingNum('learn_spotcheck_every', 20);
  var count = Number(row['自動確定件数'] || 0) + 1;
  var due = every > 0 && count % every === 0;
  updateRow(SHEETS.LEARN, row._row, { '自動確定件数': count });
  return due;
}

/**
 * AIの推定と人の回答を突き合わせた結果を1件記録し、段階を更新する。
 *
 * @param {string} sourceId 自動ソースのid
 * @param {string} itemName 項目名
 * @param {boolean} agreed 人の回答とAIの推定が一致したか
 * @return {{段階:string, 昇格:boolean, 降格:boolean, 正答率:number}} 更新後の状態
 */
function learnObserve_(sourceId, itemName, agreed) {
  var row = learnRow_(sourceId, itemName);
  var mark = agreed ? '○' : '×';

  if (!row) {
    appendRow(SHEETS.LEARN, {
      '学習キー': learnKey_(sourceId, itemName),
      '情報源': sourceId,
      '項目名': itemName,
      '確認回数': 1,
      '一致': agreed ? 1 : 0,
      '不一致': agreed ? 0 : 1,
      '正答率': agreed ? 1 : 0,
      '直近': mark,
      '段階': LEARN_STAGE.LEARNING,
      '自動確定件数': 0,
      '最終更新': nowStr_()
    });
    return { 段階: LEARN_STAGE.LEARNING, 昇格: false, 降格: false, 正答率: agreed ? 1 : 0 };
  }

  var hit = Number(row['一致'] || 0) + (agreed ? 1 : 0);
  var miss = Number(row['不一致'] || 0) + (agreed ? 0 : 1);
  var total = hit + miss;
  var rate = total ? hit / total : 0;
  var recent = (mark + String(row['直近'] || '')).substring(0, LEARN_RECENT_MAX);

  var before = String(row['段階'] || LEARN_STAGE.LEARNING);
  var after = decideStage_(before, total, rate, recent);

  updateRow(SHEETS.LEARN, row._row, {
    '確認回数': total,
    '一致': hit,
    '不一致': miss,
    '正答率': Math.round(rate * 100) / 100,
    '直近': recent,
    '段階': after,
    '自動確定件数': after === LEARN_STAGE.AUTO ? Number(row['自動確定件数'] || 0) : 0,
    '最終更新': nowStr_()
  });

  if (after !== before) {
    logInfo('learnObserve_', learnKey_(sourceId, itemName) + ' を「' + before + '」から「' + after
      + '」へ（' + total + '回中' + hit + '回一致・正答率' + Math.round(rate * 100) + '%）');
  }
  return {
    段階: after,
    昇格: before !== LEARN_STAGE.AUTO && after === LEARN_STAGE.AUTO,
    降格: before === LEARN_STAGE.AUTO && after !== LEARN_STAGE.AUTO,
    正答率: rate
  };
}

/**
 * 実績から次の段階を決める。
 *
 * ・直近で立て続けに外していれば、通算成績が良くても必ず聞き直しに戻す（劣化への即応）
 * ・十分な回数と正答率がそろって初めて自動確定にする（早すぎる自動化を避ける）
 * @param {string} before いまの段階
 * @param {number} total 通算の確認回数
 * @param {number} rate 通算の正答率
 * @param {string} recent 直近の当たり外れ（新しい順）
 * @return {string} 新しい段階
 */
function decideStage_(before, total, rate, recent) {
  var window = recent.substring(0, LEARN_RECENT_WINDOW);
  var misses = window.split('×').length - 1;
  if (window.length >= LEARN_RECENT_WINDOW && misses >= LEARN_RECENT_MISS_LIMIT) return LEARN_STAGE.REVIEW;

  var min = getSettingNum('learn_min_samples', 8);
  var promote = Number(getSetting('learn_promote_rate', '0.9'));
  var demote = Number(getSetting('learn_demote_rate', '0.6'));

  if (total < min) return before === LEARN_STAGE.REVIEW ? LEARN_STAGE.REVIEW : LEARN_STAGE.LEARNING;
  if (rate < demote) return LEARN_STAGE.REVIEW;
  if (rate >= promote) return LEARN_STAGE.AUTO;
  return LEARN_STAGE.LEARNING;
}

/**
 * 人の回答から、比較に使う部分だけを取り出す。
 * 一言記述を足した回答は「選択肢／一言」の形になっているため、選択肢の部分だけを見る。
 * @param {string} value 回答値
 * @return {string} 比較用の文字列
 */
function answerChoice_(value) {
  return String(value || '').split('／')[0].trim();
}

/**
 * 人が答えたとき、その日の同じ項目に推定の記録があれば突き合わせて学習する。
 *
 * 突き合わせられるのは「AIがどの選択肢だと読んだか（推定回答）」が入っている推定だけ。
 * 服薬の声かけのように、センサーからは選択肢を決めようがないものは推定回答を持たせていないので、
 * 学習の対象にならず、いつまでも人に聞く。機械に分かることだけを機械に任せるための線引き。
 *
 * @param {string} date 対象日 YYYY-MM-DD
 * @param {string} target 対象（user_code）
 * @param {string} itemName 項目名
 * @param {string} value 人の回答
 * @return {{突合:boolean, 一致:boolean, 情報源:string}} 突き合わせ結果
 */
function learnFromAnswer_(date, target, itemName, value) {
  var none = { 突合: false, 一致: false, 情報源: '' };
  if (!isTrue_(getSetting('learning_enabled', 'TRUE'))) return none;

  var est = findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date
      && String(r['対象']) === String(target)
      && String(r['項目名']) === String(itemName)
      && String(r['確度']) !== CERTAINTY.FIXED
      && String(r['推定回答'] || '').trim();
  })[0];
  if (!est) return none;

  // 「わからない」は正解が分からないので、当たり外れの材料にしない
  var choice = answerChoice_(value);
  if (UNKNOWN_ANSWERS.indexOf(choice) >= 0) return none;

  var agreed = String(est['推定回答']).trim() === choice;
  var source = String(est['取込元'] || '');
  learnObserve_(source, itemName, agreed);
  markReviewed_(date, target, itemName, agreed);
  return { 突合: true, 一致: agreed, 情報源: source };
}

/**
 * 補完台帳（S7）の推定行に、人が確かめた結果を書き込む。
 * 「要精査のまま放置されている行」と「人が確かめ済みの行」を区別できるようにするため。
 * @param {string} date 対象日
 * @param {string} target 対象
 * @param {string} itemName 項目名
 * @param {boolean} agreed 一致したか
 * @return {void}
 */
function markReviewed_(date, target, itemName, agreed) {
  findRows(SHEETS.FILL, function (r) {
    return toDateStr_(r['対象日']) === date
      && String(r['対象']) === String(target)
      && String(r['項目名']) === String(itemName)
      && isTrue_(r['要精査'])
      && !String(r['精査結果'] || '').trim();
  }).forEach(function (r) {
    updateRow(SHEETS.FILL, r._row, { '要精査': false, '精査結果': agreed ? '一致' : '訂正' });
  });
}

/**
 * 学習の状況を人が読める文にする（週次ダイジェスト・診断・LINEの「精度」コマンド用）。
 * @return {Array.<string>} 行の配列
 */
function learnSummaryLines_() {
  var rows = findRows(SHEETS.LEARN);
  if (!rows.length) return ['自動データの精度：まだ突き合わせの実績がありません（人の回答が貯まると出ます）'];

  var lines = [];
  var auto = rows.filter(function (r) { return String(r['段階']) === LEARN_STAGE.AUTO; });
  var review = rows.filter(function (r) { return String(r['段階']) === LEARN_STAGE.REVIEW; });

  lines.push('自動データの精度（' + rows.length + '通りを学習中）');
  if (auto.length) {
    lines.push('・もう聞かなくてよくなったもの（' + auto.length + '件）');
    auto.forEach(function (r) { lines.push('　○ ' + learnLabel_(r)); });
  }
  var learning = rows.filter(function (r) { return String(r['段階']) === LEARN_STAGE.LEARNING; });
  if (learning.length) {
    lines.push('・確認しながら覚えている途中（' + learning.length + '件）');
    learning.slice(0, 5).forEach(function (r) { lines.push('　… ' + learnLabel_(r)); });
  }
  if (review.length) {
    lines.push('・当たらなくなったので聞き直しています（' + review.length + '件）★機器の位置ずれ・故障の可能性');
    review.forEach(function (r) { lines.push('　× ' + learnLabel_(r)); });
  }
  return lines;
}

/**
 * 学習ログ1行を1行の文にする。
 * @param {Object} r S13の行
 * @return {string} 表示用の文字列
 */
function learnLabel_(r) {
  var total = Number(r['確認回数'] || 0);
  var rate = Math.round(Number(r['正答率'] || 0) * 100);
  return String(r['項目名']) + '（' + String(r['情報源']) + '）'
    + ' ' + total + '回中' + Number(r['一致'] || 0) + '回一致・' + rate + '%';
}

/**
 * 学習によって減った質問の件数を数える（週次ダイジェストで効果を示すため）。
 * @param {string} fromDate 集計開始日 YYYY-MM-DD
 * @param {string} toDate 集計終了日 YYYY-MM-DD
 * @return {number} 自動確定で人に聞かずに済んだ件数
 */
function countAutoConfirmed_(fromDate, toDate) {
  return findRows(SHEETS.LOG_IMPORT, function (r) {
    var d = toDateStr_(r['発生日']);
    return d >= toDateStr_(fromDate) && d <= toDateStr_(toDate)
      && String(r['確度']) === CERTAINTY.AUTO;
  }).length;
}
