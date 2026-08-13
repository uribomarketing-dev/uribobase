/**
 * GAS貼り付け用の「全部入り」ファイルを作る
 *
 * GASエディタに20個のファイルを1つずつ作って貼るのは手間で、
 * 1つ抜けただけで「◯◯ is not defined」で止まる。
 * 全ソースを1ファイルにまとめておけば、貼り付けは1回で済む。
 *
 *   node tools/bundle.js          … dist/AI_Uribo_全部入り.gs を作り直す
 *   node tools/bundle.js --check  … 中身が最新かどうかだけ確かめる（テストから呼ぶ）
 *
 * 不具合調査のときは、まとめる前の src/*.gs を見ること（どのファイルの何行目かが分かる）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist', 'AI_Uribo_全部入り.gs');

/**
 * まとめる順番。config を先頭にしておくと、人が読むときに全体像から入れる。
 * （GASは全ファイルをまとめて読み込むので、動作上は順番に意味はない）
 */
const ORDER = ['config', 'db', 'log', 'notify', 'secrets', 'setup', 'users', 'learn', 'shift',
  'autofill', 'consistency', 'detect', 'ask', 'correct', 'batch', 'webhook', 'api', 'monthly',
  'selfcheck', 'switchbot', 'backup', 'diagnose', 'selftest'];

/**
 * 全ソースを1つの文字列にまとめる。
 * @return {string} まとめた中身
 */
function buildBundle() {
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).map(f => f.replace(/\.gs$/, ''));
  const missing = files.filter(f => ORDER.indexOf(f) < 0);
  if (missing.length) {
    throw new Error('tools/bundle.js の ORDER に追加してください: ' + missing.join(', '));
  }

  const head = [
    '/**',
    ' * AI Uribo 全部入り（GAS貼り付け用）',
    ' *',
    ' * このファイルは tools/bundle.js が src/*.gs から自動生成しています。',
    ' * **ここを直接編集しないでください。**直すのは src/ の各ファイルです。',
    ' *',
    ' * 使い方：GASエディタにスクリプトを1つ作り、このファイルの中身を全文貼り付けるだけ。',
    ' * （appsscript.json だけは別途、プロジェクトの設定から差し替えてください）',
    ' *',
    ' * 収録: ' + ORDER.length + 'ファイル',
    ' */',
    ''
  ].join('\n');

  const body = ORDER.map(name => {
    const code = fs.readFileSync(path.join(SRC, name + '.gs'), 'utf8').replace(/\s+$/, '');
    return [
      '// ' + '='.repeat(76),
      '// ' + name + '.gs',
      '// ' + '='.repeat(76),
      '',
      code,
      ''
    ].join('\n');
  }).join('\n');

  return head + '\n' + body;
}

/**
 * ファイルに書き出す。
 * @return {string} 出力先のパス
 */
function writeBundle() {
  const text = buildBundle();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text, 'utf8');
  return OUT;
}

/**
 * 出力済みのファイルが最新かどうかを返す。
 * @return {boolean} 最新ならtrue
 */
function isBundleFresh() {
  if (!fs.existsSync(OUT)) return false;
  return fs.readFileSync(OUT, 'utf8') === buildBundle();
}

module.exports = { buildBundle, writeBundle, isBundleFresh, OUT };

if (require.main === module) {
  if (process.argv.indexOf('--check') >= 0) {
    if (isBundleFresh()) {
      console.log('OK: ' + path.relative(ROOT, OUT) + ' は最新です');
      process.exit(0);
    }
    console.error('NG: ' + path.relative(ROOT, OUT) + ' が古いです。node tools/bundle.js で作り直してください');
    process.exit(1);
  }
  const out = writeBundle();
  const size = Math.round(fs.statSync(out).size / 1024);
  console.log('作成しました: ' + path.relative(ROOT, out) + '（' + size + 'KB）');
}
