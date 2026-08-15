/**
 * 記録の食い違いを見つける
 *
 * 【なぜ要るか】
 * 隙間を積極的に埋めていくと、どうしても噛み合わない記録が生まれる。
 * 「外泊していた」のに「朝夕とも食事を提供した」、「入院中」なのに「日中活動に参加した」——
 * こういう記録は、監査で最初に突かれるところであり、
 * 何より**現場が実態を取り違えたまま次の支援に入ってしまう**のがいちばん怖い。
 *
 * 【どう扱うか】
 * 食い違いを見つけたら、AI Uriboが勝手にどちらかを消すことはしない。
 *   ・片方がデータからの推定なら、その推定を「まだ確かめていない」状態に戻して人に聞き直す
 *   ・両方とも人が答えたものなら、機械には決められないので、そのまま社員に知らせる
 *
 * 直すのは人。AI Uriboの仕事は「気づいて差し出す」ところまで。
 */

/**
 * 食い違いの判定ルール。
 * 主 … 状況を決める側の項目（在否など）
 * 従 … 主と噛み合わない値を持ちうる項目
 * @type {Array.<{id:string, 主:string, 主の値:Array.<string>, 従:string, 従の値:Array.<string>, 説明:string}>}
 */
var CONSISTENCY_RULES = [
  {
    id: 'C01', 主: '在否確認', 主の値: ['外泊・帰省', '入院'],
    従: '食事提供', 従の値: ['朝夕とも提供', '朝のみ提供', '夕のみ提供'],
    説明: '不在のはずの日に食事提供の記録があります（実費請求の根拠に関わります）'
  },
  {
    id: 'C02', 主: '在否確認', 主の値: ['外泊・帰省', '入院'],
    従: '服薬確認', 従の値: ['声かけ・確認をした'],
    説明: '不在のはずの日に服薬の声かけの記録があります'
  },
  {
    id: 'C03', 主: '在否確認', 主の値: ['入院'],
    従: '日中活動', 従の値: ['参加した'],
    説明: '入院中の日に日中活動参加の記録があります'
  },
  {
    id: 'C04', 主: '在否確認', 主の値: ['外泊・帰省', '入院'],
    従: '夜間巡回・就寝確認', 従の値: ['複数回まわった', '1回まわった'],
    説明: '不在のはずの日に夜間巡回の記録があります'
  }
];

/**
 * その日の記録の食い違いを調べ、直せるものは聞き直しに戻し、残りは社員へ知らせる。
 * detectGaps の前に呼ぶこと（聞き直しに戻した項目が、その場で質問になるようにするため）。
 *
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {{再確認:number, 要判断:number, 一覧:Array.<Object>}} 結果
 */
function checkConsistency(targetDate) {
  var proc = 'checkConsistency';
  return withLock_(proc, 60000, function () { return checkConsistencyBody_(proc, targetDate); },
    function () { return { 再確認: 0, 要判断: 0, 一覧: [] }; });
}

/**
 * 食い違い確認の本体（ロック取得済みの状態で呼ばれる）。
 * @param {string} proc ログ用の処理名
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {{再確認:number, 要判断:number, 一覧:Array.<Object>}} 結果
 */
function checkConsistencyBody_(proc, targetDate) {
  var date = toDateStr_(targetDate);
  var result = { 再確認: 0, 要判断: 0, 一覧: [] };

  // その日の支援記録を、利用者ごと・項目ごとに並べ直す
  var byTarget = {};
  findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date && String(r['対象種別']) === 'support';
  }).forEach(function (r) {
    var t = String(r['対象']);
    if (!byTarget[t]) byTarget[t] = {};
    byTarget[t][String(r['項目名'])] = r;   // 同じ項目は1行に保たれている
  });

  Object.keys(byTarget).forEach(function (target) {
    var items = byTarget[target];
    CONSISTENCY_RULES.forEach(function (rule) {
      var main = items[rule.主];
      var sub = items[rule.従];
      if (!main || !sub) return;
      if (rule.主の値.indexOf(answerChoice_(main['値'])) < 0) return;
      if (rule.従の値.indexOf(answerChoice_(sub['値'])) < 0) return;

      var hit = {
        対象: target, 対象日: date, ルール: rule.id, 説明: rule.説明,
        主: rule.主 + '＝' + answerChoice_(main['値']),
        従: rule.従 + '＝' + answerChoice_(sub['値'])
      };
      var suspect = suspectSide_(main, sub);
      if (suspect) {
        reopenRecord_(suspect, rule.id);
        // 「確かめていない」状態に戻す。その項目がまだ質問できる状態なら質問として出るし、
        // 不在の日のようにそもそも聞かない日であれば、精査待ちとして一覧に残る
        hit.対応 = '推定だった「' + String(suspect['項目名']) + '」を確かめ直しの対象にしました';
        result.再確認++;
      } else {
        hit.対応 = '両方とも人の回答のため、判断をお願いします';
        result.要判断++;
      }
      result.一覧.push(hit);
      writeLog(proc, '食い違い', JSON.stringify(hit));
    });
  });

  if (result.要判断) notifyContradictions_(proc, result.一覧);
  if (result.一覧.length) {
    logInfo(proc, date + ' の食い違い ' + result.一覧.length + '件（聞き直し'
      + result.再確認 + '件 / 要判断' + result.要判断 + '件）');
  }
  return result;
}

/**
 * 食い違った2つの記録のうち、疑わしい方（推定で入った方）を返す。
 * 両方とも人の回答なら、機械には決められないのでnullを返す。
 * @param {Object} main 主側のS4行
 * @param {Object} sub 従側のS4行
 * @return {Object|null} 疑わしい行
 */
function suspectSide_(main, sub) {
  var mainFixed = String(main['確度']) === CERTAINTY.FIXED;
  var subFixed = String(sub['確度']) === CERTAINTY.FIXED;
  if (mainFixed && subFixed) return null;
  if (mainFixed) return sub;
  if (subFixed) return main;
  // どちらも推定なら、状況を決める側（主）を残し、従を聞き直す
  return sub;
}

/**
 * 疑わしい記録を「まだ確かめていない」状態に戻す。
 * 値は消さない（何が入っていたかを人が見て判断できるようにするため）。
 * @param {Object} row S4の行
 * @param {string} ruleId ルールID
 * @return {void}
 */
function reopenRecord_(row, ruleId) {
  updateRow(SHEETS.LOG_IMPORT, row._row, { '確度': CERTAINTY.ESTIMATED });

  // 補完台帳側にも「食い違いあり」を残す（既存アプリが取り込む前に気づけるように）
  findRows(SHEETS.FILL, function (r) {
    return toDateStr_(r['対象日']) === toDateStr_(row['発生日'])
      && String(r['対象']) === String(row['対象'])
      && String(r['項目名']) === String(row['項目名'])
      && !isTrue_(r['取込済フラグ']);
  }).forEach(function (r) {
    updateRow(SHEETS.FILL, r._row, { '要精査': true, '精査結果': '食い違い(' + ruleId + ')' });
  });
}

/**
 * 人が判断するしかない食い違いを社員へ知らせる。
 * @param {string} proc ログ用の処理名
 * @param {Array.<Object>} list 食い違いの一覧
 * @return {void}
 */
function notifyContradictions_(proc, list) {
  var need = list.filter(function (h) { return h.対応.indexOf('判断') >= 0; });
  if (!need.length) return;

  var lines = ['【記録の食い違い】どちらが実際か、ご確認ください。'];
  need.slice(0, 10).forEach(function (h) {
    lines.push('');
    lines.push('・' + h.対象日 + ' ' + displayName_(String(h.対象)));
    lines.push('　' + h.主 + ' ／ ' + h.従);
    lines.push('　' + h.説明);
  });
  if (need.length > 10) lines.push('…ほか' + (need.length - 10) + '件');
  lines.push('');
  lines.push('※AI Uriboは勝手に書き換えません。S7補完台帳で正しい方に直してください。');
  sendToEscalationStaff([msgText_(lines.join('\n'))], proc);
}
