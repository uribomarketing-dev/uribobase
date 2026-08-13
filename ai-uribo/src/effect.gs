/**
 * 効き目の測定（自動データが本当に役に立っているか）
 *
 * 【なぜ要るか】
 * センサーやAIハブを増やすと、月々の費用と手間が増える。
 * それを続けるかどうかを「なんとなく便利そう」で決めると、
 * 効いていないものに払い続けるか、効いているものを止めてしまう。
 *
 * AI Uriboは、質問に自動データを「（参考）」として添えることがある。
 * ただし材料が無い日は「その日の自動記録はありませんでした」と正直に書いて送っている。
 *
 * そこで比べるのは **同じ種類の質問の中で、材料があった日と無かった日** である。
 *   ・材料があった日の「わからない」率
 *   ・材料が無かった日の「わからない」率
 *
 * 「材料を添える質問」と「そもそも添えない質問（シフト希望など）」を比べてしまうと、
 * 質問の種類の違いを材料の効果と読み違える。それでは費用の判断材料にならない。
 * 現場に余計な操作をさせずに、勝手に貯まる指標なのが利点。
 *
 * 材料が効いていれば「わからない」が減る。減っていなければ、
 * その材料は現場の役に立っていない＝やめる判断ができる。
 */

/** 判定に必要な最低件数（少なすぎる比較は誤解を生むため） @type {number} */
var EFFECT_MIN_SAMPLES = 15;

/**
 * 「（参考）」を添えた質問と添えなかった質問で、答えやすさを比べる。
 * @param {string} from 開始日 YYYY-MM-DD
 * @param {string} to 終了日 YYYY-MM-DD
 * @return {{withRef:Object, without:Object, ready:boolean}} 集計結果
 */
function effectStats_(from, to) {
  // 「（参考）」が付く質問だけを対象にする＝同じ種類の質問どうしで比べるため。
  // 材料が無い日も「ありませんでした」と書いて送っているので、同じ土俵に乗っている
  var tasks = findRows(SHEETS.TASK, function (r) {
    var d = toDateTimeStr_(r['送信日時']).substring(0, 10);
    if (!d || d < from || d > to) return false;
    if (!String(r['回答'] || '').trim()) return false;
    return String(r['送信本文'] || '').indexOf('（参考）') >= 0;
  });

  var acc = function () { return { 件数: 0, わからない: 0 }; };
  var withRef = acc();
  var without = acc();

  tasks.forEach(function (t) {
    // 「…はありませんでした」＝その日は材料が無かった。ここを取り違えると
    // 「材料あり」に材料の無い日が混ざり、数字が意味を失う
    var body = String(t['送信本文'] || '');
    var box = (body.indexOf('ありませんでした') >= 0) ? without : withRef;
    box.件数++;
    var ans = String(t['回答']).split('／')[0];
    if (UNKNOWN_ANSWERS.indexOf(ans) >= 0) box.わからない++;
  });

  return {
    withRef: withRef,
    without: without,
    ready: (withRef.件数 >= EFFECT_MIN_SAMPLES && without.件数 >= EFFECT_MIN_SAMPLES)
  };
}

/**
 * 割合（%）を出す。0件なら0。
 * @param {number} part 分子
 * @param {number} whole 分母
 * @return {number} 小数第1位までのパーセント
 */
function ratePct_(part, whole) {
  if (!whole) return 0;
  return Math.round(part / whole * 1000) / 10;
}

/**
 * 効き目の報告文を作る（LINE用）。
 * @param {number} [days] 集計日数（既定は設定の digest_lookback_days）
 * @return {Array.<string>} 行の配列
 */
function effectLines_(days) {
  var n = days || getSettingNum('effect_lookback_days', 30);
  var to = todayStr_();
  var from = addDays_(to, -n);
  var s = safely_('effectLines_', function () { return effectStats_(from, to); },
    { withRef: { 件数: 0, わからない: 0 }, without: { 件数: 0, わからない: 0 }, ready: false });

  var lines = ['【材料の効き目】' + formatMd_(from) + '〜' + formatMd_(to)];

  if (!s.withRef.件数 && !s.without.件数) {
    lines.push('まだ回答が貯まっていません。');
    return lines;
  }

  var a = ratePct_(s.withRef.わからない, s.withRef.件数);
  var b = ratePct_(s.without.わからない, s.without.件数);
  lines.push('材料があった日：' + s.withRef.件数 + '件 → わからない '
    + s.withRef.わからない + '件（' + a + '%）');
  lines.push('材料が無かった日：' + s.without.件数 + '件 → わからない '
    + s.without.わからない + '件（' + b + '%）');
  lines.push('');

  if (!s.ready) {
    lines.push('※どちらかが' + EFFECT_MIN_SAMPLES + '件に満たないため、まだ判断できません。');
    lines.push('　このまま運用を続けてください。数字が揃えば自動で出ます。');
    return lines;
  }

  var diff = Math.round((b - a) * 10) / 10;
  if (diff >= 5) {
    lines.push('材料があると「わからない」が' + diff + 'ポイント少ないです。');
    lines.push('**センサー・カメラは現場の役に立っています。**');
  } else if (diff <= -5) {
    lines.push('材料を添えた質問の方が「わからない」が' + Math.abs(diff) + 'ポイント多いです。');
    lines.push('材料の中身が現場の判断に合っていない可能性があります（見せ方を見直す価値があります）。');
  } else {
    lines.push('差はほとんどありません（' + diff + 'ポイント）。');
    lines.push('いまの材料は答えやすさを変えていません。費用がかかるものは、止めても影響が小さいと考えられます。');
  }
  return lines;
}

/**
 * 材料の内訳（どの自動データが、何件の質問に添えられたか）。
 * どれが効いているかを個別に見るために使う。
 * @param {number} [days] 集計日数
 * @return {Array.<string>} 行の配列
 */
function effectBySourceLines_(days) {
  var n = days || getSettingNum('effect_lookback_days', 30);
  var to = todayStr_();
  var from = addDays_(to, -n);

  var counts = {};
  findRows(SHEETS.TASK, function (r) {
    var d = toDateTimeStr_(r['送信日時']).substring(0, 10);
    if (!d || d < from || d > to) return false;
    var body = String(r['送信本文'] || '');
    // 材料が無かった日は数えない（「何件に材料を添えられたか」を見る欄なので）
    return body.indexOf('（参考）') >= 0 && body.indexOf('ありませんでした') < 0;
  }).forEach(function (t) {
    // 「（参考）夜間の動き：…」の項目名だけを取り出す
    var m = String(t['送信本文']).match(/（参考）([^：\n]+)[：\n]/);
    var name = m ? m[1].trim() : '不明';
    counts[name] = (counts[name] || 0) + 1;
  });

  var names = Object.keys(counts).sort(function (x, y) { return counts[y] - counts[x]; });
  if (!names.length) return [];

  var lines = ['', '内訳（どの材料を何件の質問に添えたか）'];
  names.slice(0, 6).forEach(function (name) {
    lines.push('・' + name + '：' + counts[name] + '件');
  });
  return lines;
}

/**
 * その月で最初の週次ダイジェストか（＝月に1回だけ効き目を載せるため）。
 * @param {string} dateStr 実行日 YYYY-MM-DD
 * @return {boolean} 月内最初の1週間ならtrue
 */
function isFirstDigestOfMonth_(dateStr) {
  var day = Number(toDateStr_(dateStr).substring(8, 10));
  return day <= 7;
}
