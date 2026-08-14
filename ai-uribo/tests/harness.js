/**
 * AI Uribo ローカル検証ハーネス
 * GASのAPIをメモリ上に再現し、src/*.gs のロジックを実際に走らせて挙動を確認する。
 * （Google環境が無い状態で論理バグを洗い出すのが目的。LINE送信は捕捉して出力するだけ）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
const SHEET_OPS = { read: 0, write: 0 };
const TZ_OFFSET_MS = 9 * 3600 * 1000;

// ---- Sheet mock -------------------------------------------------------------
class MockSheet {
  constructor(name) { this.name = name; this.data = []; }
  getName() { return this.name; }
  _ensure(r, c) {
    while (this.data.length < r) this.data.push([]);
    for (const row of this.data) while (row.length < c) row.push('');
  }
  getLastRow() {
    let last = 0;
    this.data.forEach((row, i) => { if (row.some(v => v !== '' && v !== null && v !== undefined)) last = i + 1; });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.data.forEach(row => row.forEach((v, i) => { if (v !== '' && v !== null && v !== undefined) last = Math.max(last, i + 1); }));
    return last;
  }
  getMaxColumns() { return Math.max(this.getLastColumn(), 1); }
  deleteColumns() { }
  insertColumnsAfter() { return this; }
  setFrozenRows() { return this; }
  appendRow(values) {
    SHEET_OPS.write++;
    const r = this.getLastRow() + 1;
    this._ensure(r, values.length);
    for (let c = 0; c < values.length; c++) this.data[r - 1][c] = values[c];
    return this;
  }
  getRange(row, col, numRows = 1, numCols = 1) { return new MockRange(this, row, col, numRows, numCols); }
  // シート操作の回数を数える（件数が増えたときに処理量が跳ね上がらないかを見るため）
}
class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    SHEET_OPS.read++;
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        const src = this.sheet.data[this.row - 1 + r] || [];
        const v = src[this.col - 1 + c];
        row.push(v === undefined ? '' : v);
      }
      out.push(row);
    }
    return out;
  }
  getDisplayValues() { return this.getValues().map(r => r.map(v => String(v === null || v === undefined ? '' : v))); }
  setValues(values) {
    SHEET_OPS.write++;
    this.sheet._ensure(this.row - 1 + values.length, this.col - 1 + values[0].length);
    values.forEach((row, r) => row.forEach((v, c) => { this.sheet.data[this.row - 1 + r][this.col - 1 + c] = v; }));
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        const row = this.sheet.data[this.row - 1 + r];
        if (row) row[this.col - 1 + c] = '';
      }
    }
    return this;
  }
  setNote() { return this; }
  setFontWeight() { return this; }
  setBackground() { return this; }
}
class MockBook {
  constructor() { this.sheets = []; }
  getId() { return 'MOCK_BOOK_ID'; }
  getName() { return 'AI_Uribo_台帳'; }
  getSheets() { return this.sheets; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new MockSheet(n); this.sheets.push(s); return s; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
}

// ---- GAS globals ------------------------------------------------------------
const book = new MockBook();
const props = {};
const cache = {};
const pushes = [];   // LINE push
const replies = [];  // LINE reply

function formatDate(date, tz, fmt) {
  // 「いま何時か」で動きが変わる処理（夜の確認セットの送信時刻など）を、
  // 試験を回した時刻に左右されずに確かめるための差し替え口
  if (fmt === 'H' && sandbox.__fakeHour !== undefined && sandbox.__fakeHour !== null) {
    return String(sandbox.__fakeHour);
  }
  const d = new Date(date.getTime() + TZ_OFFSET_MS);
  const p = n => String(n).padStart(2, '0');
  return fmt
    .replace(/yyyy/g, d.getUTCFullYear())
    .replace(/MM/g, p(d.getUTCMonth() + 1))
    .replace(/dd/g, p(d.getUTCDate()))
    .replace(/HH/g, p(d.getUTCHours()))
    .replace(/mm/g, p(d.getUTCMinutes()))
    .replace(/\bH\b/g, String(d.getUTCHours()))
    .replace(/\bd\b/g, String(d.getUTCDate()));
}

const sandbox = {
  console,
  JSON, Math, String, Number, Object, Array, Date, RegExp, Error, isNaN, parseInt, parseFloat,
  Logger: { log: (...a) => console.log('[Logger]', ...a) },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => book,
    openById: () => book,
    getUi: () => { throw new Error('UI unavailable'); }
  },
  Utilities: {
    formatDate,
    getUuid: () => crypto.randomUUID(),
    sleep: () => { },
    newBlob: (s, type, name) => ({ name, setDataFromString: (str) => ({ name, str }) }),
    computeHmacSha256Signature: (body, secret) => Array.from(crypto.createHmac('sha256', secret).update(body).digest()),
    base64Encode: (bytes) => Buffer.from(bytes).toString('base64')
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: k => (props[k] === undefined ? null : props[k]),
      setProperty: (k, v) => { props[k] = v; },
      deleteProperty: k => { delete props[k]; }
    })
  },
  CacheService: {
    getScriptCache: () => ({
      get: k => (cache[k] === undefined ? null : cache[k]),
      put: (k, v) => { cache[k] = v; },
      remove: k => { delete cache[k]; }
    })
  },
  // ロックは「他の処理が実行中」を再現できるようにしておく（競合時の挙動を検証するため）
  LockService: {
    getScriptLock: () => ({
      tryLock: () => !sandbox.__lockBusy,
      releaseLock: () => { sandbox.__lockReleased = (sandbox.__lockReleased || 0) + 1; }
    })
  },
  ScriptApp: {
    getProjectTriggers: () => sandbox.__triggers.map(fn => ({ getHandlerFunction: () => fn })),
    deleteTrigger: (t) => {
      const i = sandbox.__triggers.indexOf(t.getHandlerFunction());
      if (i >= 0) sandbox.__triggers.splice(i, 1);
    },
    newTrigger: (fn) => {
      const b = {
        timeBased: () => b, atHour: () => b, everyDays: () => b, everyHours: () => b,
        onWeekDay: () => b, onMonthDay: () => b,
        inTimezone: () => b, create: () => { sandbox.__triggers.push(fn); }
      };
      return b;
    },
    WeekDay: { SUNDAY: 'SUN', MONDAY: 'MON', TUESDAY: 'TUE', WEDNESDAY: 'WED', THURSDAY: 'THU', FRIDAY: 'FRI', SATURDAY: 'SAT' }
  },
  UrlFetchApp: {
    fetch: (url, opts) => {
      // トークンの生存確認（メッセージは送らない）
      if (url.indexOf('/v2/bot/info') >= 0) {
        return sandbox.__lineInfoCode === 401
          ? { getResponseCode: () => 401, getContentText: () => '{"message":"Invalid token"}' }
          : { getResponseCode: () => 200, getContentText: () => '{"displayName":"うりぼシフト管理"}' };
      }
      const payload = JSON.parse(opts.payload);
      if (url.indexOf('/push') >= 0) pushes.push(payload); else replies.push(payload);
      return { getResponseCode: () => 200, getContentText: () => '{}' };
    }
  },
  ContentService: {
    createTextOutput: t => { const o = { text: t, setMimeType: () => o }; return o; },
    MimeType: { JSON: 'application/json' }
  },
  DriveApp: {
    getRootFolder: () => mockFolder('root'),
    getFileById: () => ({ makeCopy: () => ({}) })
  },
  Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
  __triggers: [],
  __lineInfoCode: 200,
  __lockBusy: false
};
function mockFolder(name) {
  const folders = {}, files = {};
  const f = {
    getName: () => name,
    getFoldersByName: n => iter(folders[n] ? [folders[n]] : []),
    createFolder: n => (folders[n] = mockFolder(n)),
    getFolders: () => iter(Object.values(folders)),
    getFilesByName: n => iter(files[n] ? [files[n]] : []),
    createFile: blob => (files[blob.name] = { name: blob.name, setTrashed: () => { delete files[blob.name]; } }),
    moveTo: () => { }, setTrashed: () => { }
  };
  return f;
}
function iter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; }

// 試験を回した時刻で結果が変わらないよう、時刻を固定する。
// これが無いと 22:00〜7:00（深夜帯の送信抑止）に走らせたときだけ
// 「送信されない」で落ちる＝夜に直そうとした人が原因を見誤る。
// 時刻を変えて確かめたい試験は、この値を一時的に上書きして最後に10へ戻す。
sandbox.__fakeHour = 10;

vm.createContext(sandbox);
// src/ に増えたファイルを読み忘れないよう、並び順だけ決めて残りは自動で全部読む。
// （GASは全ファイルが1つの空間に読まれるので、ここでも同じ状態を作る）
const FIRST = ['config', 'db', 'log', 'notify'];
const SRC_FILES = FIRST.concat(
  fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).map(f => f.replace(/\.gs$/, ''))
    .filter(f => FIRST.indexOf(f) < 0).sort());
SRC_FILES.forEach(f => {
  vm.runInContext(fs.readFileSync(path.join(SRC, f + '.gs'), 'utf8'), sandbox, { filename: f + '.gs' });
});

// ---- テスト実行 --------------------------------------------------------------
const run = code => vm.runInContext(code, sandbox);
let failures = 0;
function check(label, cond, extra) {
  console.log((cond ? '  OK   ' : '  NG   ') + label + (extra !== undefined && !cond ? ' → ' + JSON.stringify(extra) : ''));
  if (!cond) failures++;
}
const rows = sheet => run(`findRows(SHEETS.${sheet})`);
const clearCache = () => Object.keys(cache).forEach(k => delete cache[k]);
const toStr = v => run(`toDateStr_(${JSON.stringify(String(v))})`);
const isTrueLike = v => v === true || String(v).toLowerCase() === 'true';

console.log('\n=== T1 台帳生成 ===');
run('initSheets()');
check('13シート生成', book.sheets.length === 13, book.sheets.map(s => s.name));
check('S1に4名', rows('STAFF').length === 4);
check('S3のCHK001が有効', run(`String(checkById_('CHK001')['有効'])`) === 'true');
check('S3のCHK101は無効', run(`String(checkById_('CHK101')['有効'])`) === 'false');
check('S8にmorning_batch_hour=10', run(`getSetting('morning_batch_hour')`) === '10');
run('initSheets()');
check('再実行しても増えない（冪等）', rows('STAFF').length === 4 && book.sheets.length === 13);

console.log('\n=== T1b 利用者の登録と支援記録の開始 ===');
check('利用者が居ないうちは支援記録を始めない',
  String(run('enablePhase2()')).indexOf('先に') > 0, run('enablePhase2()'));
const addRes = run(`addUser('清水','山田テスト')`);
check('利用者を登録できる（コードは自動採番）',
  rows('USER').some(u => u.user_code === 'U001' && u.拠点 === '清水' && isTrueLike(u.有効)), addRes);
check('氏名は台帳本体に出ず、S9対応表にだけ入る',
  rows('NAME_MAP').some(r => r.コード === 'U001' && r.氏名 === '山田テスト')
    && !rows('USER').some(u => JSON.stringify(u).indexOf('山田テスト') >= 0),
  rows('USER'));
check('LINEの文面では氏名に置き換わる', run(`displayName_('U001')`) === '山田テスト');
run(`addUser('玉里','鈴木テスト')`);
check('2人目は別のコードになる', rows('USER').some(u => u.user_code === 'U002' && u.拠点 === '玉里'));
check('同じコードで登録し直しても増えない',
  (run(`addUser('清水','山田テスト','U001')`), rows('USER').filter(u => u.user_code === 'U001').length === 1));

const phase2 = run('enablePhase2()');
check('利用者を登録すると支援記録の質問を開始できる',
  String(phase2).indexOf('開始しました') > 0, phase2);
check('優先度Aの支援記録が有効になる',
  ['CHK101', 'CHK105', 'CHK106'].every(id => String(run(`String(checkById_('${id}')['有効'])`)) === 'true'));
check('優先度Bはまだ有効にしない（まずAだけ）',
  String(run(`String(checkById_('CHK111')['有効'])`)) === 'false');
check('検出対象外の項目は有効にしない',
  String(run(`String(checkById_('CHK107')['有効'])`)) === 'false');
check('セットアップ点検に利用者数と開始状況が出る',
  String(run('checkSetup()')).indexOf('有効な利用者 2名') > 0
    && String(run('checkSetup()')).indexOf('項目が有効') > 0);
// 質問が多すぎたときにすぐ静かにできること（逃げ道）
run('disablePhase2()');
check('支援記録の質問はいつでも止められる',
  String(run(`String(checkById_('CHK101')['有効'])`)) === 'false');
check('止めてもシフト希望の確認は続く',
  String(run(`String(checkById_('CHK001')['有効'])`)) === 'true');
// 以降のテストは元の状態（支援記録は無効）で続ける
run(`(function(){
  findRows(SHEETS.USER).forEach(function(u){updateRow(SHEETS.USER,u._row,{'有効':false});});
})()`);

console.log('\n=== T2 登録コードによる本人確認と紐付け ===');
props.LINE_CHANNEL_TOKEN = 'dummy-token';
const post = (events, key = 'k123') => run(`doPost(${JSON.stringify({ parameter: { k: '__KEY__' }, postData: { contents: JSON.stringify({ events }) } })})`.replace('__KEY__', key));
// LINE以外（AIハブなど）から届く本文をそのまま流し込む用
const postBody = (body, key = 'k123') => run(`doPost(${JSON.stringify({ parameter: { k: '__KEY__' }, postData: { contents: JSON.stringify(body) } })})`.replace('__KEY__', key));

// 秘密キー未設定なら全拒否（fail-close）
replies.length = 0;
post([{ type: 'follow', webhookEventId: 'e0', source: { userId: 'U_FUJI' }, replyToken: 'r0' }]);
check('WEBHOOK_SECRET未設定なら全リクエストを拒否', replies.length === 0);
props.WEBHOOK_SECRET = 'k123';

const codes = {};
rows('STAFF').forEach(s => { codes[s.staff_id] = String(s.登録コード); });
check('登録コードが自動発行されている', /^[A-Z2-9]{8}$/.test(codes.STF001), codes);

replies.length = 0;
post([{ type: 'follow', webhookEventId: 'e1', source: { userId: 'U_FUJI' }, replyToken: 'r1' }]);
check('友だち追加で登録コードを求める', JSON.stringify(replies[0]).indexOf('登録コード') > 0, replies[0]);
check('スタッフ氏名の一覧は出さない', JSON.stringify(replies[0]).indexOf('藤原') < 0, replies[0]);

replies.length = 0;
post([{ type: 'message', webhookEventId: 'e1b', source: { userId: 'U_BAD' }, message: { type: 'text', text: 'ZZZZZZZZ' }, replyToken: 'r1b' }]);
check('でたらめなコードでは登録できない', rows('STAFF').every(s => !String(s.line_user_id).trim()));
check('コード不一致を案内する', JSON.stringify(replies[0]).indexOf('確認できませんでした') > 0, replies[0]);

post([{ type: 'message', webhookEventId: 'e2', source: { userId: 'U_FUJI' }, message: { type: 'text', text: codes.STF001 }, replyToken: 'r2' }]);
post([{ type: 'message', webhookEventId: 'e3', source: { userId: 'U_HATT' }, message: { type: 'text', text: codes.STF002 }, replyToken: 'r3' }]);
const staff = rows('STAFF');
check('藤原にline_user_id', staff[0].line_user_id === 'U_FUJI', staff[0]);
check('服部にline_user_id', staff[1].line_user_id === 'U_HATT', staff[1]);
check('使用済みコードは消える', !String(staff[0].登録コード).trim(), staff[0]);

replies.length = 0;
post([{ type: 'message', webhookEventId: 'e3b', source: { userId: 'U_EVIL' }, message: { type: 'text', text: codes.STF001 }, replyToken: 'r3b' }]);
check('使用済みコードで乗っ取れない', rows('STAFF')[0].line_user_id === 'U_FUJI');

replies.length = 0;
post([{ type: 'message', webhookEventId: 'e3c', source: { userId: 'U_KIBE' }, message: { type: 'text', text: codes.STF003 }, replyToken: 'r3c' }]);
check('無効スタッフのコードでは登録できない', rows('STAFF')[2].line_user_id === '' , rows('STAFF')[2]);

console.log('\n=== T3 朝バッチ（シフト希望） ===');
const today = run('todayStr_()');
const dayNum = Number(today.substring(8, 10));
run(`(function(){var r=findRow(SHEETS.SETTING,{'キー':'shift_request_day'});updateRow(SHEETS.SETTING,r._row,{'値':${dayNum}});
     var r2=findRow(SHEETS.SETTING,{'キー':'shift_deadline_day'});updateRow(SHEETS.SETTING,r2._row,{'値':31});clearSettingCache();})()`);
pushes.length = 0;
console.log('  morningBatch → ' + run('morningBatch()'));
const gaps = rows('GAP');
check('S5に不足が登録される', gaps.length === 3, gaps.map(g => g.対象));       // 有効3名（岐部はFALSE）
check('一次確認先は本人', gaps[0]['一次確認先staff_id'] === 'STF001', gaps[0]);
check('LINE送信あり', pushes.length >= 1, pushes.length);
check('1通目は見出し＋質問', pushes[0] && pushes[0].messages.length === 2, pushes[0] && pushes[0].messages);
check('兼崎はline_user_id未登録で送信されない', pushes.length === 2, pushes.map(p => p.to));

console.log('\n=== T4/T5 ボタン回答と一言記述 ===');
const task1 = rows('TASK').find(t => t.送信先staff_id === 'STF001' && t.送信状態 === '送信済');
replies.length = 0;
post([{ type: 'postback', webhookEventId: 'e4', source: { userId: 'U_FUJI' }, postback: { data: 'ans|' + task1.task_id + '|今答える' }, replyToken: 'r4' }]);
check('「今答える」で希望入力を促す', JSON.stringify(replies[0]).indexOf('希望をこのままメッセージ') > 0, replies[0]);
post([{ type: 'message', webhookEventId: 'e5', source: { userId: 'U_FUJI' }, message: { type: 'text', text: '3日と10日は休み希望' }, replyToken: 'r5' }]);
const t1after = run(`findRow(SHEETS.TASK,{'task_id':'${task1.task_id}'})`);
check('S6に回答が記録される', String(t1after.回答).indexOf('3日と10日') > 0, t1after.回答);
const gap1 = run(`findRow(SHEETS.GAP,{'gap_id':'${task1.gap_id}'})`);
check('S5が完了になる', gap1.状態 === '完了' && !!gap1.完了日時, gap1);
const fills = rows('FILL');
check('S7補完台帳に転記', fills.length === 1 && String(fills[0].値).indexOf(run('nextMonthStr_(new Date())')) === 0, fills[0]);
check('S4に対象月付きで記録（再検出防止）', rows('LOG_IMPORT').some(l => l.対象種別 === 'shift'), rows('LOG_IMPORT'));

pushes.length = 0;
console.log('  morningBatch再実行 → ' + run('morningBatch()'));
check('回答済みは再検出されない', rows('GAP').length === 3, rows('GAP').length);
check('同じ質問を二重送信しない', pushes.length === 0, pushes.length);

console.log('\n=== T5b 「わからない」の扱い ===');
const task2 = rows('TASK').find(t => t.送信先staff_id === 'STF002' && t.送信状態 === '送信済');
replies.length = 0;
post([{ type: 'postback', webhookEventId: 'e6', source: { userId: 'U_HATT' }, postback: { data: 'ans|' + task2.task_id + '|わからない' }, replyToken: 'r6' }]);
post([{ type: 'message', webhookEventId: 'e7', source: { userId: 'U_HATT' }, message: { type: 'text', text: 'なし' }, replyToken: 'r7' }]);
const gap2 = run(`findRow(SHEETS.GAP,{'gap_id':'${task2.gap_id}'})`);
check('「わからない」は完了にしない', gap2.状態 === 'エスカレーション中', gap2);

console.log('\n=== T6 週次ダイジェスト ===');
pushes.length = 0;
console.log('  weeklyDigest → ' + run('weeklyDigest()'));
check('社員に集計が届く', pushes.length >= 1 && JSON.stringify(pushes[0]).indexOf('週次ダイジェスト') > 0);
check('S10に週次集計が残る', rows('RUN_LOG').some(r => r.結果 === '週次集計'));

console.log('\n=== T7 夜の確認セット（支援記録・予定） ===');
run(`(function(){
  appendRow(SHEETS.USER,{user_code:'TEST01',拠点:'清水',自動ログ対応:false,服薬自動:true,在否自動:false,日中自動:false,有効:true});
  ['CHK101','CHK106','CHK201'].forEach(function(id){var c=checkById_(id);updateRow(SHEETS.CHECK,c._row,{'有効':true});});
  checkById_._map=null;
  appendRow(SHEETS.LOG_IMPORT,{log_id:'RAW1',発生日:addDays_(todayStr_(),-1),対象種別:'raw_switchbot',対象:'TEST01',項目名:'服薬',値:'OK',取込元:'switchbot',取込日時:nowStr_()});
})()`);
const autoRes = run(`runAutoFill(addDays_(todayStr_(),-1))`);
check('SwitchBotログが開放の事実として記録される',
  rows('LOG_IMPORT').some(l => String(l.項目名) === '服薬ボックス開放'), autoRes);
check('そこから服薬確認も推定で埋める（隙間を残さない）',
  autoRes.estimated === 1 && rows('LOG_IMPORT').some(l => String(l.項目名) === '服薬確認'), autoRes);
check('推定で埋めたものは要精査の印が付く',
  rows('FILL').some(f => String(f.項目名) === '服薬確認' && isTrueLike(f.要精査)), rows('FILL').slice(-3));
const d2 = run(`detectGaps(addDays_(todayStr_(),-1),['R02'])`);
// 推定は「埋めてあるが、まだ確かめていない」状態。記録は残しつつ人にも確認する（learn.gs）
check('推定で埋めても、確かめるまでは質問が出る', d2.some(g => g.check_id === 'CHK106'), d2);
check('データが無い在否確認は質問として残る', d2.some(g => g.check_id === 'CHK101'), d2);
pushes.length = 0;
console.log('  morningBatch（支援記録あり） → ' + run('morningBatch()'));
check('Stage1は藤原・服部の2名にまとめて送信', pushes.length === 2 && pushes.map(p => p.to).sort().join() === 'U_FUJI,U_HATT', pushes.map(p => p.to));
check('在否確認の不足がS5に登録', rows('GAP').some(g => g.check_id === 'CHK101' && g.対象 === 'TEST01'));
// 同じ利用者・同じ日の不足を使って「参照ログが質問に添えられるか」を確認する
const medGap = rows('GAP').find(g => g.対象 === 'TEST01');
const medMsgs = run(`buildQuestion_({task_id:'TSKX'}, findRow(SHEETS.GAP,{'gap_id':'${medGap.gap_id}'}), checkById_('CHK106'), 0)`);
check('服薬確認の質問に開放ログが判断材料として添えられる',
  JSON.stringify(medMsgs).indexOf('服薬ボックス開放：開放を検知') > 0, medMsgs);
check('参照ログが無い項目には余計な情報を付けない',
  run(`buildQuestion_({task_id:'TSKX'}, findRow(SHEETS.GAP,{'gap_id':'${medGap.gap_id}'}), checkById_('CHK101'), 0)`).length === 1);
pushes.length = 0;
console.log('  nightBatch → ' + run('nightBatch(true)'));
check('夜勤不在時は社員へ送信', pushes.length >= 1, pushes.length);
check('夜の確認セットの見出し', JSON.stringify(pushes[0]).indexOf('夜の確認セット') > 0);
check('夜はシフト希望を混ぜない', JSON.stringify(pushes).indexOf('シフト希望') < 0);

console.log('\n=== T7b まとめ回答：1人が答えたら他方には送らない ===');
const setTasks = rows('TASK').filter(t => t.セットid && t.送信先staff_id === 'STF001' && t.送信状態 === '送信済');
const nightTask = setTasks[setTasks.length - 1];
replies.length = 0;
post([{ type: 'postback', webhookEventId: 'e20', source: { userId: 'U_FUJI' }, postback: { data: 'ans|' + nightTask.task_id + '|在宅' }, replyToken: 'r20' }]);
const twin = rows('TASK').filter(t => t.gap_id === nightTask.gap_id && t.task_id !== nightTask.task_id);
check('未送信の同一項目は中止される', twin.every(t => t.送信状態 !== '待機'), twin.map(t => t.送信状態));
check('回答で次の質問が返る', JSON.stringify(replies[0]).indexOf('記録に反映しました') > 0, replies[0]);
const fillsBefore = rows('FILL').length;
const sentTwin = twin.find(t => t.送信状態 === '送信済' && !String(t.回答 || ''));
if (sentTwin) {
  replies.length = 0;
  post([{ type: 'postback', webhookEventId: 'e21', source: { userId: 'U_HATT' }, postback: { data: 'ans|' + sentTwin.task_id + '|在宅' }, replyToken: 'r21' }]);
  check('送信済みの重複質問に答えても二重記録しない', rows('FILL').length === fillsBefore, [fillsBefore, rows('FILL').length]);
  check('他の人が回答済みと案内する', JSON.stringify(replies).indexOf('他の方が回答済み') > 0, replies[0]);
}

console.log('\n=== T7d 夜勤担当者の記録と情報源 ===');
run(`(function(){
  if (!staffById_('STF900')) appendRow(SHEETS.STAFF,{staff_id:'STF900',氏名:'テスト夜勤',line_user_id:'U_NIGHT',役割:'夜勤',拠点:'清水',エスカレーション先フラグ:false,有効:true});
  var c=checkById_('CHK100');updateRow(SHEETS.CHECK,c._row,{'有効':true});
  appendRow(SHEETS.USER,{user_code:'TEST02',拠点:'清水',自動ログ対応:false,服薬自動:false,在否自動:false,日中自動:false,有効:true});
})()`);
pushes.length = 0;
run('morningBatch()');
const nightGaps = rows('GAP').filter(g => g.check_id === 'CHK100');
check('夜勤担当者は拠点ごとに1問だけ', nightGaps.length === 1 && nightGaps[0].対象 === '清水', nightGaps);
check('選択肢に夜勤スタッフ名が入る', JSON.stringify(pushes).indexOf('テスト夜勤') > 0);

const dutyTask = rows('TASK').find(t => t.gap_id === nightGaps[0].gap_id && t.送信先staff_id === 'STF001');
post([{ type: 'postback', webhookEventId: 'e40', source: { userId: 'U_FUJI' }, postback: { data: 'ans|' + dutyTask.task_id + '|テスト夜勤' }, replyToken: 'r40' }]);
check('夜勤担当者がS4に記録される',
  rows('LOG_IMPORT').some(l => String(l.項目名) === '夜勤担当者' && String(l.値).indexOf('テスト夜勤') >= 0));

// 同じ日の利用者記録に「支援担当者名＋管理者確認」が入る
const userTask = rows('TASK').find(t => {
  const g = rows('GAP').find(x => x.gap_id === t.gap_id);
  return g && g.対象 === 'TEST02' && t.送信先staff_id === 'STF001' && !String(t.回答 || '');
});
if (userTask) {
  post([{ type: 'postback', webhookEventId: 'e41', source: { userId: 'U_FUJI' }, postback: { data: 'ans|' + userTask.task_id + '|在宅' }, replyToken: 'r41' }]);
  const fill = rows('FILL').filter(f => f.対象 === 'TEST02').pop();
  check('情報源が「支援担当者名＋管理者確認」になる',
    fill && String(fill.情報源).indexOf('支援担当者：テスト夜勤') === 0 && String(fill.情報源).indexOf('管理者確認：藤原寛') > 0,
    fill && fill.情報源);
}
run(`(function(){var c=checkById_('CHK100');updateRow(SHEETS.CHECK,c._row,{'有効':false});})()`);

console.log('\n=== T7e AIハブ（OpenClaw）からの観察の取り込み ===');
const yesterday = run('addDays_(todayStr_(),-1)');
run(`(function(){var c=checkById_('CHK105');updateRow(SHEETS.CHECK,c._row,{'有効':true});})()`);
const obsRes = run(`doPost(${JSON.stringify({
  parameter: { k: 'k123' },
  postData: { contents: JSON.stringify({
    source: 'openclaw',
    observations: [{ date: '__DATE__', target: 'ALL', item: '食事提供', value: '夕食を配膳している様子（キッチンカメラ 18:05）' }]
  }) }
})})`.replace('__DATE__', yesterday));
check('観察の取り込みAPIが件数を返す', String(obsRes.text) === 'OK:1', obsRes);
check('S4に raw_openclaw として入る',
  rows('LOG_IMPORT').some(l => String(l.対象種別) === 'raw_openclaw' && String(l.項目名) === '食事提供'));
const obsFill = run(`runAutoFill('${yesterday}')`);
check('映像の観察が食事提供の推定として埋まる',
  rows('LOG_IMPORT').some(l => String(l.対象種別) === 'support' && String(l.項目名) === '食事提供'
    && String(l.値).indexOf('AIハブ映像解析') > 0), obsFill);
check('AIハブ由来も要精査が付く',
  rows('FILL').some(f => String(f.項目名) === '食事提供' && isTrueLike(f.要精査)));
check('映像そのものは受け取らない（値は文字だけ）',
  !rows('LOG_IMPORT').some(l => String(l.値).indexOf('data:image') >= 0
    || String(l.値).indexOf('http') === 0));
run(`(function(){var c=checkById_('CHK105');updateRow(SHEETS.CHECK,c._row,{'有効':false});})()`);

console.log('\n=== T7f AIまとめの貼り付け取り込みと注意語アラート ===');
run(`(function(){
  ['CHK104','CHK105'].forEach(function(id){var c=checkById_(id);updateRow(SHEETS.CHECK,c._row,{'有効':true});});
})()`);
pushes.length = 0; replies.length = 0;
post([{ type: 'message', webhookEventId: 'e50', source: { userId: 'U_FUJI' }, message: { type: 'text', text: 'まとめ' }, replyToken: 'r50' }]);
check('「まとめ」で貼り付けを促す', JSON.stringify(replies[0] || '').indexOf('AIまとめ') > 0, replies[0]);

const summaryText = '2026/08/07 この時期、高齢の男性が床に座り込んだりうつ伏せになったりする様子が見られ、'
  + '周囲には食器や物が置かれていました。台所では食事の準備や食器の洗い物をしている場面もありました。';
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e51', source: { userId: 'U_FUJI' }, message: { type: 'text', text: summaryText }, replyToken: 'r51' }]);
check('AIまとめがS4に残る',
  rows('LOG_IMPORT').some(l => String(l.対象種別) === 'raw_summary' && String(l.発生日) === '2026-08-07'));
check('先頭の日付を対象日として読む', JSON.stringify(replies[0] || '').indexOf('2026-08-07') > 0, replies[0]);
check('文章から食事提供を推定で埋める',
  rows('LOG_IMPORT').some(l => String(l.発生日) === '2026-08-07' && String(l.項目名) === '食事提供'
    && String(l.値).indexOf('AIまとめより') > 0));
check('文章から利用者の状況も拾う',
  rows('LOG_IMPORT').some(l => String(l.発生日) === '2026-08-07' && String(l.項目名) === '利用者の状況'));
check('注意語（うつ伏せ・座り込）を社員へ通知',
  pushes.some(p => JSON.stringify(p).indexOf('AIが気にした') > 0), pushes.map(p => p.to));
// AIの文章は誤りが多い前提：断定せず、誤検知を人が返せるか
const alertMsg = JSON.stringify(pushes.filter(p => JSON.stringify(p).indexOf('AIが気にした') > 0)[0] || '');
check('断定せず「誤りが多い」と明示して知らせる', alertMsg.indexOf('誤りが多く含まれます') > 0, alertMsg.substring(0, 300));
check('誤検知を返すボタンが付く', alertMsg.indexOf('これは違う（誤検知）') > 0);
replies.length = 0;
post([{ type: 'postback', webhookEventId: 'e52', source: { userId: 'U_FUJI' },
  postback: { data: 'alert|ng|2026-08-07|うつ伏せ|ALL' }, replyToken: 'r52' }]);
check('誤検知の判定がS10に残る',
  rows('RUN_LOG').some(r => String(r.処理名) === 'alertFeedback' && String(r.詳細).indexOf('誤検知') > 0));
check('誤検知のときは語の外し方を案内する',
  JSON.stringify(replies[0] || '').indexOf('alert_keywords') > 0, replies[0]);

check('全文ではなく該当箇所だけを記録に残す',
  rows('LOG_IMPORT').filter(l => String(l.項目名) === '食事提供' && String(l.発生日) === '2026-08-07')
    .every(l => String(l.値).length < summaryText.length));
run(`(function(){
  ['CHK104','CHK105'].forEach(function(id){var c=checkById_(id);updateRow(SHEETS.CHECK,c._row,{'有効':false});});
})()`);

console.log('\n=== T7g SwitchBot本体との連携 ===');
props.SWITCHBOT_TOKEN = 'sb-token';
props.SWITCHBOT_SECRET = 'sb-secret';
props.WEBAPP_URL = 'https://script.google.com/macros/s/XXX/exec?k=k123';

// SwitchBot APIの応答を差し替える
const realFetch = sandbox.UrlFetchApp.fetch;
const sbCalls = [];
sandbox.UrlFetchApp.fetch = (url, opts) => {
  if (url.indexOf('switch-bot.com') < 0) return realFetch(url, opts);
  sbCalls.push({ url, headers: opts.headers, payload: opts.payload });
  let body = {};
  if (url.indexOf('/devices/') >= 0 && url.indexOf('/status') >= 0) {
    body = { deviceId: 'DEV1', deviceType: 'Meter', temperature: 28.4, humidity: 61, battery: 15 };
  } else if (url.indexOf('/devices') >= 0) {
    body = { deviceList: [
      { deviceId: 'DEV1', deviceName: '玉里リビング温湿度計', deviceType: 'Meter' },
      { deviceId: 'DEV2', deviceName: '服薬ボックス', deviceType: 'Contact Sensor' }
    ], infraredRemoteList: [] };
  } else if (url.indexOf('/webhook/setupWebhook') >= 0) {
    body = {};
  }
  return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ statusCode: 100, message: 'success', body }) };
};

check('署名ヘッダーを作れる', (() => { const h = run('switchbotHeaders_()'); return !!(h.Authorization && h.sign && h.t && h.nonce); })());
console.log('  syncDevices → ' + run('switchbotSyncDevices()'));
check('機器がS12に並ぶ', rows('DEVICE').length === 2, rows('DEVICE'));
check('用途種別を名前から推測する',
  rows('DEVICE').find(d => d.deviceName === '服薬ボックス').用途種別 === '服薬ボックス',
  rows('DEVICE').map(d => d.用途種別));
check('確認前は有効=FALSEで入る', rows('DEVICE').every(d => !isTrueLike(d.有効)));

// 人が用途を確認して有効化する想定
run(`(function(){
  findRows(SHEETS.DEVICE).forEach(function(d){
    updateRow(SHEETS.DEVICE, d._row, {'有効': true, '拠点':'玉里', 'deviceMac': d.deviceId === 'DEV2' ? 'C0:DE:B7:26:0F:48' : ''});
  });
})()`);
console.log('  poll → ' + run('switchbotPoll()'));
check('温湿度がS4に入る',
  rows('LOG_IMPORT').some(l => String(l.対象種別) === 'raw_meter' && String(l.値).indexOf('室温28.4℃') >= 0),
  rows('LOG_IMPORT').filter(l => String(l.取込元).indexOf('switchbot-poll') === 0).map(l => l.値));
// 電池は毎時ログに書くのではなく覚えておき、朝の自己点検でまとめて知らせる
// （1時間おきに同じ警告が並ぶと、本当に見てほしい行が埋もれる）
check('電池残量を覚えている',
  run('lowBatteryDevices_(20)').some(d => Number(d.percent) === 15),
  run('lowBatteryDevices_(20)'));
// 状態が読めなかった機器は黙って捨てず、何が返ってきたかを残す
check('状態を記録できなかった機器を黙って捨てない',
  rows('RUN_LOG').some(r => String(r.結果) === '警告' && String(r.詳細).indexOf('状態を記録できませんでした') >= 0),
  rows('RUN_LOG').filter(r => String(r.処理名) === 'switchbotPoll').map(r => r.詳細));

// SwitchBotのWebhook（服薬ボックスが開いた）
const sbHook = { eventType: 'changeReport', eventVersion: '1', context: {
  deviceType: 'WoContact', deviceMac: 'C0DEB7260F48', openState: 'open', detectionState: 'DETECTED', battery: 100 } };
const hookRes = run(`doPost(${JSON.stringify({ parameter: { k: 'k123' }, postData: { contents: JSON.stringify(sbHook) } })})`);
check('SwitchBotのWebhookを受け取る', String(hookRes.text) === 'OK:1', hookRes);
check('機器マスタのMACで利用者に紐付く',
  rows('LOG_IMPORT').some(l => String(l.取込元).indexOf('switchbot-webhook:') === 0 && String(l.対象種別) === 'raw_switchbot'));
check('どの機器から届いたかが取込元に残る（機器ごとに追える）',
  rows('LOG_IMPORT').some(l => String(l.取込元).indexOf('switchbot-poll:') === 0),
  rows('LOG_IMPORT').filter(l => String(l.取込元).indexOf('switchbot') === 0).map(l => l.取込元));
const unknownHook = { eventType: 'changeReport', context: { deviceMac: 'FFFFFFFFFFFF', openState: 'open' } };
const unknownRes = run(`doPost(${JSON.stringify({ parameter: { k: 'k123' }, postData: { contents: JSON.stringify(unknownHook) } })})`);
check('未登録の機器からの通知は記録しない', String(unknownRes.text) === 'OK:0', unknownRes);
console.log('  setupWebhook → ' + run('switchbotSetupWebhook()'));
check('WebhookのURL登録を要求する',
  sbCalls.some(c => c.url.indexOf('setupWebhook') > 0 && String(c.payload).indexOf('exec?k=') > 0));
sandbox.UrlFetchApp.fetch = realFetch;

console.log('\n=== T7h テストモード（設定作業中の誤送信防止） ===');
run(`(function(){var r=findRow(SHEETS.SETTING,{'キー':'test_mode'});updateRow(SHEETS.SETTING,r._row,{'値':'TRUE'});clearSettingCache();})()`);
pushes.length = 0;
const tmBefore = rows('TASK').length;
run('weeklyDigest()');
check('テストモード中はLINEに送らない', pushes.length === 0, pushes.length);
check('送るはずだった内容はS6に残る',
  rows('TASK').some(t => String(t.送信状態) === 'テスト'), rows('TASK').slice(-2).map(t => t.送信状態));
check('診断にテストモードの状態が出る',
  String(run('exportDiagnostics(true)')).indexOf('テストモード: ON') > 0);
run(`(function(){var r=findRow(SHEETS.SETTING,{'キー':'test_mode'});updateRow(SHEETS.SETTING,r._row,{'値':'FALSE'});clearSettingCache();})()`);
pushes.length = 0;
run('weeklyDigest()');
check('テストモードを切ると実際に送る', pushes.length > 0, pushes.length);

console.log('\n=== T11 学習（当たる自動データは質問しなくなる） ===');
// 在否自動をONにした利用者を用意し、開閉センサーの推定と人の回答を突き合わせていく
run(`(function(){
  appendRow(SHEETS.USER,{user_code:'TEST03',拠点:'清水',自動ログ対応:false,服薬自動:false,在否自動:true,日中自動:false,有効:true});
})()`);

// 1日分：センサーの推定で埋まるが、確かめていないので質問も出る
const learnDay = d => run(`(function(){
  var day = addDays_(todayStr_(), ${-1});
  return day;
})()`);
const seedDoor = date => run(`appendRow(SHEETS.LOG_IMPORT,{log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),発生日:'${date}',対象種別:'raw_door',対象:'TEST03',項目名:'玄関',値:'開',取込元:'test',取込日時:nowStr_()})`);
const day1 = run(`addDays_(todayStr_(),-3)`);
seedDoor(day1);
run(`runAutoFill('${day1}')`);
check('推定で埋めた記録には確度「推定」が付く',
  rows('LOG_IMPORT').some(l => l.対象 === 'TEST03' && l.項目名 === '在否確認' && l.確度 === '推定'),
  rows('LOG_IMPORT').filter(l => l.対象 === 'TEST03').map(l => l.項目名 + ':' + l.確度));
check('AIが読んだ選択肢（推定回答）も残る',
  rows('LOG_IMPORT').some(l => l.対象 === 'TEST03' && l.項目名 === '在否確認' && l.推定回答 === '在宅'));
check('確かめていないので在否確認の質問は出る',
  run(`detectGaps('${day1}',['R02'])`).some(g => g.check_id === 'CHK101' && g.対象 === 'TEST03'));

// 人が答えると、推定行が回答で上書きされ、実績が1件貯まる
const answerAs = (date, choice) => run(`(function(){
  var gaps = detectGaps('${date}',['R02']).filter(function(g){return g.check_id==='CHK101'&&g.対象==='TEST03';});
  registerGaps(gaps);
  var gap = findRows(SHEETS.GAP,function(r){return toDateStr_(r['対象日'])==='${date}'&&r['check_id']==='CHK101'&&r['対象']==='TEST03';})[0];
  var staff = findRow(SHEETS.STAFF,{'staff_id':'STF001'});
  recordFill_(gap, checkById_('CHK101'), '${choice}', staff);
  return gap.gap_id;
})()`);
answerAs(day1, '在宅');
check('人の回答で推定行が上書きされ、同じ項目が2行にならない',
  rows('LOG_IMPORT').filter(l => l.対象 === 'TEST03' && l.項目名 === '在否確認' && l.発生日 === day1).length === 1);
check('上書き後の確度は「確定」',
  rows('LOG_IMPORT').some(l => l.対象 === 'TEST03' && l.項目名 === '在否確認' && l.発生日 === day1 && l.確度 === '確定'));
check('S13学習ログに一致が1件貯まる',
  rows('LEARN').some(r => r.学習キー === 'door_sensor/在否確認' && Number(r.一致) === 1 && r.段階 === '確認中'),
  rows('LEARN'));
check('確かめた推定は「精査待ち」の一覧から外れる',
  rows('FILL').some(f => f.対象 === 'TEST03' && f.項目名 === '在否確認' && f.精査結果 === '一致'),
  rows('FILL').filter(f => f.対象 === 'TEST03').map(f => f.項目名 + ':' + f.精査結果));
// 別の情報源が入れた推定まで「確かめた」ことにしてはいけない
run(`appendRow(SHEETS.FILL,{fill_id:nextSeqId_(SHEETS.FILL,'fill_id','FIL',6),対象日:'${day1}',
  対象:'TEST03',項目名:'在否確認',値:'在室（別の機器より）',記入者staff_id:'AUTO:motion_sensor',
  取込済フラグ:false,作成日時:nowStr_(),gap_id:'',情報源:'自動推定（motion_sensor）',要精査:true,精査結果:''})`);
run(`learnFromAnswer_('${day1}','TEST03','在否確認','在宅')`);
check('突き合わせていない情報源の行は確かめた扱いにしない',
  rows('FILL').some(f => f.対象 === 'TEST03' && String(f.情報源).indexOf('motion_sensor') > 0
    && isTrueLike(f.要精査) && !String(f.精査結果).trim()),
  rows('FILL').filter(f => f.対象 === 'TEST03').map(f => f.情報源 + ':' + f.精査結果));

// 実績が規定回数そろうと自動確定に昇格する（＝もう聞かない）
run(`(function(){for(var i=0;i<7;i++){learnObserve_('door_sensor','在否確認',true);}})()`);
check('実績がそろうと「自動確定」に昇格する',
  run(`learnStage_('door_sensor','在否確認')`) === '自動確定',
  rows('LEARN').filter(r => r.学習キー === 'door_sensor/在否確認'));
const day2 = run(`addDays_(todayStr_(),-4)`);
seedDoor(day2);
run(`runAutoFill('${day2}')`);
check('昇格後は確度「自動確定」で埋まる',
  rows('LOG_IMPORT').some(l => l.対象 === 'TEST03' && l.項目名 === '在否確認' && l.発生日 === day2 && l.確度 === '自動確定'));
check('昇格後は在否確認の質問が出なくなる',
  !run(`detectGaps('${day2}',['R02'])`).some(g => g.check_id === 'CHK101' && g.対象 === 'TEST03'));
check('S7の情報源に「学習済み」と残り、後から説明できる',
  rows('FILL').some(f => f.対象 === 'TEST03' && f.項目名 === '在否確認' && String(f.情報源).indexOf('学習済み') > 0));
// 自動確定は質問が出ない＝誰も答えないので、要精査のままだと精査の一覧に永久に残ってしまう
check('自動確定で埋めた分は「精査待ち」に積み上がらない',
  rows('FILL').filter(f => f.対象 === 'TEST03' && f.項目名 === '在否確認' && f.対象日 === day2)
    .every(f => !isTrueLike(f.要精査) && String(f.精査結果) === '学習済み'),
  rows('FILL').filter(f => f.対象 === 'TEST03' && f.対象日 === day2));

// 当たらなくなったら自分で聞き直しに戻る（センサーの位置ずれ・故障に気づくため）
run(`(function(){for(var i=0;i<4;i++){learnObserve_('door_sensor','在否確認',false);}})()`);
check('外れが続くと「要見直し」に降格する',
  run(`learnStage_('door_sensor','在否確認')`) === '要見直し',
  rows('LEARN').filter(r => r.学習キー === 'door_sensor/在否確認'));
const day3 = run(`addDays_(todayStr_(),-5)`);
seedDoor(day3);
run(`runAutoFill('${day3}')`);
check('降格後は質問が復活する',
  run(`detectGaps('${day3}',['R02'])`).some(g => g.check_id === 'CHK101' && g.対象 === 'TEST03'));

// 「わからない」は当たり外れの材料にしない
const learnBefore = rows('LEARN').find(r => r.学習キー === 'door_sensor/在否確認');
const totalBefore = Number(learnBefore.確認回数);
answerAs(day3, 'わからない');
check('「わからない」は精度の材料にしない',
  Number(rows('LEARN').find(r => r.学習キー === 'door_sensor/在否確認').確認回数) === totalBefore);

// 機械には決めようがないもの（服薬の声かけ）は、いつまでも人に聞く
check('推定回答を持たない推定は学習対象にならない',
  !rows('LEARN').some(r => String(r.学習キー).indexOf('服薬確認') >= 0), rows('LEARN').map(r => r.学習キー));

// 社員は「精度」コマンドで学習の状況を確認できる
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e90', source: { userId: 'U_FUJI' }, message: { type: 'text', text: '精度' }, replyToken: 'r90' }]);
check('「精度」コマンドで学習状況を返す',
  JSON.stringify(replies[0] || '').indexOf('自動データの精度') > 0, JSON.stringify(replies));
check('一言記述の待ちが残っていてもコマンドは記録に混ざらない',
  !rows('TASK').some(t => String(t.回答).indexOf('精度') >= 0),
  rows('TASK').filter(t => String(t.回答).indexOf('精度') >= 0).map(t => t.task_id + ':' + t.回答));
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e91', source: { userId: 'U_NIGHT' }, message: { type: 'text', text: '精度' }, replyToken: 'r91' }]);
check('夜勤は精度コマンドを使えない', JSON.stringify(replies[0] || '').indexOf('社員のみ') > 0, replies[0]);

console.log('\n=== T7c 深夜帯のキュー保存と朝の送信 ===');
const setQuiet = (s, e) => run(`(function(){
  var a=findRow(SHEETS.SETTING,{'キー':'quiet_start_hour'});updateRow(SHEETS.SETTING,a._row,{'値':${s}});
  var b=findRow(SHEETS.SETTING,{'キー':'quiet_end_hour'});updateRow(SHEETS.SETTING,b._row,{'値':${e}});clearSettingCache();})()`);
setQuiet(0, 23);   // いまを深夜帯扱いにする
check('深夜帯と判定される', run('isQuietHours_()') === true);
pushes.length = 0;
run(`(function(){
  var c=checkById_('CHK111');updateRow(SHEETS.CHECK,c._row,{'有効':true});checkById_._map=null;})()`);
run('morningBatch()');
check('深夜帯は送信せずキューに積む', pushes.length === 0 && rows('TASK').some(t => t.送信状態 === 'キュー'),
  rows('TASK').filter(t => t.送信状態 === 'キュー').length);
setQuiet(22, 7);
const flushed = run('flushQueue()');
check('朝になったらキューを送信', flushed >= 1 && pushes.length >= 1, [flushed, pushes.length]);
check('キューが残らない', !rows('TASK').some(t => t.送信状態 === 'キュー'));

console.log('\n=== T8 バックアップ ===');
console.log('  dailyBackup → ' + run('dailyBackup()'));
check('S10にバックアップ完了が残る', rows('RUN_LOG').some(r => String(r.詳細).indexOf('バックアップ完了') >= 0));

console.log('\n=== T9 手動コマンド ===');
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e8', source: { userId: 'U_FUJI' }, message: { type: 'text', text: '状況' }, replyToken: 'r8' }]);
check('「状況」に未完了一覧を返す', JSON.stringify(replies[0]).indexOf('現在の状況') > 0, replies[0]);
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e9', source: { userId: 'U_FUJI' }, message: { type: 'text', text: 'ヘルプ' }, replyToken: 'r9' }]);
check('「ヘルプ」に使い方を返す', JSON.stringify(replies[0]).indexOf('AI Uriboの使い方') > 0);
replies.length = 0; pushes.length = 0;
post([{ type: 'message', webhookEventId: 'e10', source: { userId: 'U_FUJI' }, message: { type: 'text', text: '報告' }, replyToken: 'r10' }]);
post([{ type: 'message', webhookEventId: 'e11', source: { userId: 'U_FUJI' }, message: { type: 'text', text: '転倒がありましたが怪我はなし' }, replyToken: 'r11' }]);
check('報告がS4に記録される', rows('LOG_IMPORT').some(l => l.対象種別 === 'report'));
check('報告が社員へ共有される', pushes.some(p => JSON.stringify(p).indexOf('転倒がありました') > 0));
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e12', source: { userId: 'U_FUJI' }, message: { type: 'text', text: 'おはよう' }, replyToken: 'r12' }]);
check('雑談にはボタン案内を返す', JSON.stringify(replies[0]).indexOf('ボタンでお答えください') > 0);

console.log('\n=== 追加検証 ===');
replies.length = 0;
post([{ type: 'postback', webhookEventId: 'e13', source: { userId: 'U_FUJI' }, postback: { data: 'ans|' + task1.task_id + '|今答える' }, replyToken: 'r13' }]);
check('回答済みタスクの再回答を弾く', JSON.stringify(replies[0]).indexOf('すでに回答済み') > 0, replies[0]);
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e14', source: { userId: 'U_UNKNOWN' }, message: { type: 'text', text: 'こんにちは' }, replyToken: 'r14' }]);
check('未登録ユーザーは操作を受け付けない', JSON.stringify(replies[0]).indexOf('登録コード') > 0, replies[0]);
const before = replies.length;
run(`doPost(${JSON.stringify({ parameter: { k: 'wrong' }, postData: { contents: JSON.stringify({ events: [{ type: 'message', webhookEventId: 'e15', source: { userId: 'U_FUJI' }, message: { type: 'text', text: '状況' }, replyToken: 'r15' }] }) } })})`);
check('秘密キー不一致のリクエストを破棄', replies.length === before);
post([{ type: 'message', webhookEventId: 'e8', source: { userId: 'U_FUJI' }, message: { type: 'text', text: '状況' }, replyToken: 'r16' }]);
check('重複イベントIDを無視', replies.length === before);

console.log('\n=== 追加検証（レビュー指摘の再発防止） ===');
// 1. ロックを取れないときは処理を続けない
const fillsBeforeBusy = rows('FILL').length;
const tasksBeforeBusy = rows('TASK').length;
replies.length = 0;
sandbox.__lockBusy = true;
post([{ type: 'message', webhookEventId: 'e30', source: { userId: 'U_FUJI' }, message: { type: 'text', text: '状況' }, replyToken: 'r30' }]);
check('ロック取得失敗時は処理せず案内する', JSON.stringify(replies[0] || '').indexOf('混み合っています') > 0, replies[0]);
check('ロック取得失敗時はシートを書き換えない',
  rows('FILL').length === fillsBeforeBusy && rows('TASK').length === tasksBeforeBusy);
const busyResult = run('morningBatch()');
check('バッチもロック未取得ならスキップ', String(busyResult).indexOf('スキップ') >= 0, busyResult);
sandbox.__lockBusy = false;

// 2. 他人あてのタスクには回答できない
const othersTask = rows('TASK').find(t => t.送信先staff_id === 'STF002' && t.送信状態 === '送信済' && !String(t.回答 || ''));
if (othersTask) {
  replies.length = 0;
  const fillsBefore2 = rows('FILL').length;
  post([{ type: 'postback', webhookEventId: 'e31', source: { userId: 'U_FUJI' }, postback: { data: 'ans|' + othersTask.task_id + '|在宅' }, replyToken: 'r31' }]);
  check('他人あての確認には回答できない', rows('FILL').length === fillsBefore2 &&
    JSON.stringify(replies[0] || '').indexOf('お答えいただけません') > 0, replies[0]);
}

// 3. LINEが409（受理済み）を返しても失敗扱いにしない
const origFetch = sandbox.UrlFetchApp.fetch;
sandbox.UrlFetchApp.fetch = (url, opts) => ({ getResponseCode: () => 409, getContentText: () => '{"message":"conflict"}' });
const r409 = run(`pushRaw_('U_FUJI',[{type:'text',text:'x'}],'key-1')`);
check('409は送信済みとして成功扱い', r409.ok === true && r409.tries === 1, r409);
sandbox.UrlFetchApp.fetch = origFetch;

// 4. 同じ不足への二重記録をS7側でも防ぐ
const doneGap = rows('GAP').find(g => g.状態 === '完了');
if (doneGap) {
  const fillsBefore3 = rows('FILL').length;
  run(`recordFill_(findRow(SHEETS.GAP,{'gap_id':'${doneGap.gap_id}'}), checkById_('${doneGap.check_id}'), 'テスト再記録', staffById_('STF001'))`);
  check('同じgap_idの補完は1回だけ', rows('FILL').length === fillsBefore3, [fillsBefore3, rows('FILL').length]);
}

// 5. gap_idは1000件を超えても桁落ちしない
const gapIdOverflow = run(`(function(){
  appendRow(SHEETS.GAP,{gap_id:'GAP-' + todayStr_().replace(/-/g,'') + '-999', 対象日: todayStr_(), check_id:'CHK001', 対象:'STF001', 状態:'完了'});
  return nextGapId_(todayStr_());})()`);
check('gap_idが1000件目でも重複しない', /-1000$/.test(gapIdOverflow), gapIdOverflow);

// 6. 無効化されたスタッフは操作できない
run(`(function(){var s=staffById_('STF002');updateRow(SHEETS.STAFF,s._row,{'有効':false});})()`);
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e32', source: { userId: 'U_HATT' }, message: { type: 'text', text: '状況' }, replyToken: 'r32' }]);
check('無効スタッフの操作を拒否', JSON.stringify(replies[0] || '').indexOf('利用停止中') > 0, replies[0]);
run(`(function(){var s=staffById_('STF002');updateRow(SHEETS.STAFF,s._row,{'有効':true});})()`);

// 7. 夜勤スタッフの「状況」は自分の担当分だけ
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e33', source: { userId: 'U_NIGHT' }, message: { type: 'text', text: '状況' }, replyToken: 'r33' }]);
const nightStatus = JSON.stringify(replies[0] || '');
check('夜勤には自分の担当分だけ表示',
  nightStatus.indexOf('あなたの未完了') > 0 && nightStatus.indexOf('TEST02') < 0 && nightStatus.indexOf('TEST01') < 0,
  replies[0]);

// 8. 監査対応：記録の出所（情報源）が残る
const fillsWithSource = rows('FILL').filter(f => String(f.情報源 || '').trim());
check('補完台帳に情報源が残る', fillsWithSource.length > 0, rows('FILL').slice(0, 3));
check('自動ログは自動と分かる形で残る',
  rows('FILL').some(f => String(f.情報源).indexOf('自動ログ') === 0), fillsWithSource.map(f => f.情報源));
check('代理入力は代理入力と分かる形で残る',
  rows('FILL').some(f => String(f.情報源).indexOf('代理入力') === 0 || String(f.情報源).indexOf('本人回答') === 0),
  fillsWithSource.map(f => f.情報源));
check('センサー由来の値に出所を明記', rows('LOG_IMPORT').some(l => String(l.値).indexOf('自動記録') > 0),
  rows('LOG_IMPORT').filter(l => String(l.取込元).indexOf('switchbot') >= 0).map(l => l.値));

// 9. 「精査」コマンド：推定で埋めた記録を人が見て直せる
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e36', source: { userId: 'U_FUJI' }, message: { type: 'text', text: '精査' }, replyToken: 'r36' }]);
const reviewText = JSON.stringify(replies[0] || '');
check('「精査」で推定して埋めた記録の一覧が返る',
  reviewText.indexOf('推定で埋めた記録') > 0 && reviewText.indexOf('服薬確認') > 0, replies[0]);
check('精査の直し方まで案内する', reviewText.indexOf('要精査列をFALSE') > 0);

// 10. 診断コマンド（不具合報告用）
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e34', source: { userId: 'U_FUJI' }, message: { type: 'text', text: '診断' }, replyToken: 'r34' }]);
const diagText = JSON.stringify(replies[0] || '');
check('「診断」で調査用情報を返す', diagText.indexOf('診断情報') > 0 && diagText.indexOf('件数') > 0, replies[0]);
check('診断に個人情報を含めない', diagText.indexOf('U_FUJI') < 0 && diagText.indexOf('藤原') < 0);
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e35', source: { userId: 'U_NIGHT' }, message: { type: 'text', text: '診断' }, replyToken: 'r35' }]);
check('夜勤は診断コマンドを使えない', JSON.stringify(replies[0] || '').indexOf('社員のみ') > 0, replies[0]);

console.log('\n=== T15 月次まとめ（監査用） ===');
run(`(function(){
  // 先月の記録を用意する：1日は在宅で記録あり、2日は記録なし、3日は外泊（対象外）
  var m = previousMonth_();
  ['01','02','03'].forEach(function(d){
    var day = m + '-' + d;
    if (d === '01') {
      appendRow(SHEETS.LOG_IMPORT,{log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),発生日:day,
        対象種別:'support',対象:'U001',項目名:'在否確認',値:'在宅',取込元:'ai-uribo',
        取込日時:nowStr_(),確度:'確定',推定回答:''});
      appendRow(SHEETS.LOG_IMPORT,{log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),発生日:day,
        対象種別:'support',対象:'U001',項目名:'食事提供',値:'朝夕とも提供',取込元:'test',
        取込日時:nowStr_(),確度:'推定',推定回答:'朝夕とも提供'});
    }
    if (d === '03') {
      appendRow(SHEETS.LOG_IMPORT,{log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),発生日:day,
        対象種別:'support',対象:'U001',項目名:'在否確認',値:'外泊・帰省',取込元:'ai-uribo',
        取込日時:nowStr_(),確度:'確定',推定回答:''});
    }
  });
  var u=findRow(SHEETS.USER,{'user_code':'U001'});updateRow(SHEETS.USER,u._row,{'有効':true});
  findRows(SHEETS.USER,function(r){return r['user_code']!=='U001';})
    .forEach(function(r){updateRow(SHEETS.USER,r._row,{'有効':false});});
  ['CHK101','CHK105'].forEach(function(id){var c=checkById_(id);updateRow(SHEETS.CHECK,c._row,{'有効':true});});
  checkById_._map=null;
})()`);
pushes.length = 0;
const monthLabel = run('previousMonth_()');
console.log('  monthlyReport → ' + run('monthlyReport()'));
check('月次まとめのシートができる',
  book.sheets.some(sh => sh.name === '月次_' + monthLabel), book.sheets.map(s => s.name).slice(-3));
const mrows = run(`findRows('月次_${monthLabel}')`);
check('利用者×項目ごとに充足率が出る',
  mrows.some(r => r.user_code === 'U001' && r.項目 === '在否確認'), mrows);
const zaihi = mrows.find(r => r.user_code === 'U001' && r.項目 === '在否確認');
check('外泊の日は対象日数から外れる',
  Number(zaihi.対象日数) === run(`monthDays_('${monthLabel}')`).length - 1,
  zaihi.対象日数 + ' / ' + run(`monthDays_('${monthLabel}')`).length);
check('記録があった日数を数える', Number(zaihi.記録あり) === 1, zaihi);
const shokuji = mrows.find(r => r.user_code === 'U001' && r.項目 === '食事提供');
check('まだ確かめていない推定は「うち推定」で分けて数える',
  Number(shokuji.記録あり) === 1 && Number(shokuji.うち推定) === 1, shokuji);
// 自動確定は情報源としては確かめ済みでも、その日の中身は機械が入れたまま。
// これを「人が確かめた記録」に数えると、監査での備えを過大に見せてしまう
run(`(function(){
  var m = previousMonth_();
  appendRow(SHEETS.LOG_IMPORT,{log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),発生日:m+'-02',
    対象種別:'support',対象:'U001',項目名:'食事提供',値:'朝夕とも提供',取込元:'test',
    取込日時:nowStr_(),確度:'自動確定',推定回答:'朝夕とも提供'});
})()`);
run(`monthlyReport('${monthLabel}')`);
const shokuji2 = run(`findRows('月次_${monthLabel}')`)
  .find(r => r.user_code === 'U001' && r.項目 === '食事提供');
check('学習済みの自動確定も「うち推定」に数える（過大に見せない）',
  Number(shokuji2.記録あり) === 2 && Number(shokuji2.うち推定) === 2, shokuji2);
check('未記録の日が分かる（監査で聞かれるのはここ）',
  String(zaihi.未記録日).indexOf('02') >= 0, zaihi.未記録日);
check('シートに氏名は出さない',
  JSON.stringify(mrows).indexOf('山田テスト') < 0);
check('要点は社員へLINEで届く',
  JSON.stringify(pushes).indexOf('月次まとめ') > 0
    && JSON.stringify(pushes).indexOf('充足率') > 0, JSON.stringify(pushes).substring(0, 200));
check('LINEの文面では氏名に置き換える（誰の記録が足りないか分かるように）',
  JSON.stringify(pushes).indexOf('山田テスト') > 0);
const before15 = book.sheets.length;
run('monthlyReport()');
check('作り直しても同じシートを上書きする', book.sheets.length === before15);

console.log('\n=== T14 既存アプリへの受け渡し口（API） ===');
const apiGet = (params) => JSON.parse(run(`doGet(${JSON.stringify({ parameter: params })})`).text);
check('秘密キーが違えば何も返さない',
  apiGet({ k: 'wrong', mode: 'fills' }).ok === false, apiGet({ k: 'wrong', mode: 'fills' }));
check('キー無しの素のアクセスは生存確認だけ返す',
  String(run(`doGet(${JSON.stringify({ parameter: {} })})`).text).indexOf('AI Uribo is running') === 0);
const apiFillsRes = apiGet({ k: 'k123', mode: 'fills' });
check('未取込の補完台帳を渡せる', apiFillsRes.ok === true && apiFillsRes.count > 0, apiFillsRes.count);
check('渡すのは記号だけで氏名は含めない',
  JSON.stringify(apiFillsRes.items).indexOf('山田テスト') < 0 && apiFillsRes.items[0].対象 !== undefined);
check('どこから来た記録かも一緒に渡す（情報源・要精査）',
  apiFillsRes.items.every(i => i.情報源 !== undefined && i.要精査 !== undefined));
const someIds = apiFillsRes.items.slice(0, 2).map(i => i.fill_id);
const marked = JSON.parse(run(`doPost(${JSON.stringify({
  parameter: { k: 'k123' },
  postData: { contents: JSON.stringify({ action: 'markImported', fill_ids: someIds }) }
})})`).text);
check('取り込めたものに済みを付けられる', marked.marked === someIds.length, marked);
check('済みを付けたものは次から渡されない',
  apiGet({ k: 'k123', mode: 'fills' }).items.every(i => someIds.indexOf(i.fill_id) < 0));
check('済みを付けそこねた分は次も渡される（取りこぼしが起きない）',
  apiGet({ k: 'k123', mode: 'fills' }).count === apiFillsRes.count - someIds.length);
// 書き込めなかったときに「0件成功」と返すと、渡せていない記録を渡した扱いにしてしまう
sandbox.__lockBusy = true;
const busyMark = JSON.parse(run(`doPost(${JSON.stringify({
  parameter: { k: 'k123' },
  postData: { contents: JSON.stringify({ action: 'markImported', fill_ids: ['FIL000001'] }) }
})})`).text);
sandbox.__lockBusy = false;
check('書き込めなかったときは成功と返さない（やり直せるように）',
  busyMark.ok === false && busyMark.error === 'busy', busyMark);
const usersApi = apiGet({ k: 'k123', mode: 'users' });
check('氏名の対応表は別の呼び出しでだけ渡す',
  usersApi.ok === true && usersApi.items.some(u => u.氏名 === '山田テスト'), usersApi);
const ping = apiGet({ k: 'k123', mode: 'ping' });
check('生存確認で残件とテストモードが分かる',
  ping.ok === true && ping['未取込の補完'] !== undefined && ping['テストモード'] !== undefined, ping);
check('知らないmodeは何も返さない', apiGet({ k: 'k123', mode: 'nope' }).ok === false);
check('日付で絞り込める',
  apiGet({ k: 'k123', mode: 'fills', from: '2099-01-01' }).count === 0);

console.log('\n=== T17 シフト表の取り込み ===');
const shiftDate = run(`addDays_(todayStr_(),-12)`);
const shiftMonth = shiftDate.substring(0, 7);
const shiftDay = Number(shiftDate.substring(8, 10));
const shiftText = [shiftMonth,
  `${Number(shiftMonth.substring(5))}/${shiftDay} 清水 夜勤 服部俊喜`,
  `${Number(shiftMonth.substring(5))}/${shiftDay} 玉里 日勤 藤原寛`,
  '8/99 清水 夜勤 服部俊喜',
  `${Number(shiftMonth.substring(5))}/${shiftDay} 清水 夜勤 存在しない人`,
  'これは説明の行です'].join('\n');
const shiftRes = run(`importShiftText(${JSON.stringify(shiftText)})`);
check('シフト表を読み取ってS11に入る', shiftRes.追加 === 2, shiftRes);
check('読めなかった行は捨てずに理由を返す',
  shiftRes.読めなかった行.length === 3
    && shiftRes.読めなかった行.some(l => l.indexOf('存在しない人') >= 0), shiftRes.読めなかった行);
check('同じ行を入れ直しても二重にならない',
  run(`importShiftText(${JSON.stringify(shiftText)})`).追加 === 0);
check('日付・拠点・勤務区分・staff_idが入る',
  rows('SHIFT_PLAN').some(r => toStr(r.日付) === shiftDate && r.staff_id === 'STF002'
    && r.拠点 === '清水' && String(r.勤務区分).indexOf('夜勤') >= 0), rows('SHIFT_PLAN'));

// シフト表があれば、その日の夜勤担当者は聞かずに記録される
run(`(function(){
  var u=findRow(SHEETS.USER,{'user_code':'TEST01'});updateRow(SHEETS.USER,u._row,{'有効':true,'拠点':'清水'});
  var c=checkById_('CHK100');updateRow(SHEETS.CHECK,c._row,{'有効':true});checkById_._map=null;
})()`);
run(`runAutoFill('${shiftDate}')`);
check('夜勤担当者がシフト表から記録される',
  rows('LOG_IMPORT').some(l => toStr(l.発生日) === shiftDate && l.項目名 === '夜勤担当者'
    && String(l.値) === '服部俊喜' && l.取込元 === 'shift-table'),
  rows('LOG_IMPORT').filter(l => l.項目名 === '夜勤担当者').slice(-2));
check('シフト表由来は推測ではなく確定として扱う',
  rows('LOG_IMPORT').some(l => toStr(l.発生日) === shiftDate && l.項目名 === '夜勤担当者' && l.確度 === '確定'));
check('その日の夜勤担当者はもう聞かれない',
  !run(`detectGaps('${shiftDate}',['R05'])`).some(g => g.対象 === '清水'),
  run(`detectGaps('${shiftDate}',['R05'])`));
check('記録には支援担当者の名前が残る（監査で問われるのはここ）',
  run(`nightStaffNameOf_('${shiftDate}','清水')`) === '服部俊喜');

// 社員はLINEからも貼り付けられる
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e95', source: { userId: 'U_FUJI' }, message: { type: 'text', text: 'シフト' }, replyToken: 'r95' }]);
check('「シフト」で貼り付けを促す',
  JSON.stringify(replies[0] || '').indexOf('シフト表を貼り付けて') > 0, replies[0]);
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e96', source: { userId: 'U_FUJI' },
  message: { type: 'text', text: shiftMonth + '\n' + Number(shiftMonth.substring(5)) + '/' + (shiftDay + 1) + ' 清水 夜勤 服部俊喜' }, replyToken: 'r96' }]);
check('貼り付けた内容が取り込まれ、結果が返る',
  JSON.stringify(replies[0] || '').indexOf('取り込みました') > 0, replies[0]);
replies.length = 0;
post([{ type: 'message', webhookEventId: 'e97', source: { userId: 'U_NIGHT' }, message: { type: 'text', text: 'シフト' }, replyToken: 'r97' }]);
check('夜勤はシフト表を取り込めない',
  JSON.stringify(replies[0] || '').indexOf('社員のみ') > 0, replies[0]);

console.log('\n=== T13 記録の食い違い ===');
const conDate = run(`addDays_(todayStr_(),-7)`);
const putRec = (item, value, certainty) => run(`appendRow(SHEETS.LOG_IMPORT,{
  log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),発生日:'${conDate}',対象種別:'support',
  対象:'TEST01',項目名:'${item}',値:'${value}',取込元:'test',取込日時:nowStr_(),
  確度:'${certainty}',推定回答:''})`);
// 人が「外泊・帰省」と答えた日に、推定で「朝夕とも提供」が入っている
putRec('在否確認', '外泊・帰省', '確定');
putRec('食事提供', '朝夕とも提供', '推定');
run(`appendRow(SHEETS.FILL,{fill_id:nextSeqId_(SHEETS.FILL,'fill_id','FIL',6),対象日:'${conDate}',
  対象:'TEST01',項目名:'食事提供',値:'朝夕とも提供',記入者staff_id:'AUTO:test',取込済フラグ:false,
  作成日時:nowStr_(),gap_id:'',情報源:'自動推定（test）',要精査:true,精査結果:''})`);
pushes.length = 0;
const con1 = run(`checkConsistency('${conDate}')`);
check('不在の日の食事提供の食い違いに気づく', con1.一覧.length === 1, con1);
check('推定で入っていた方を聞き直しに戻す', con1.再確認 === 1 && con1.要判断 === 0, con1);
check('記録は消さずに残す（人が見て判断できる）',
  rows('LOG_IMPORT').some(l => l.発生日 === conDate && l.項目名 === '食事提供' && String(l.値) === '朝夕とも提供'));
check('補完台帳に食い違いの印が付く',
  rows('FILL').some(f => f.対象日 === conDate && f.項目名 === '食事提供'
    && String(f.精査結果).indexOf('食い違い') === 0), rows('FILL').slice(-2));
check('片方が推定なら社員を煩わせない（自動で聞き直すだけ）', pushes.length === 0, pushes.length);
// 不在の日はそもそも質問しない（食い違いを見つけても、聞かなくてよい日に質問を増やさない）
check('不在の日に余計な質問を増やさない',
  !run(`(function(){
    var u=findRow(SHEETS.USER,{'user_code':'TEST01'});updateRow(SHEETS.USER,u._row,{'有効':true});
    var c=checkById_('CHK105');updateRow(SHEETS.CHECK,c._row,{'有効':true});checkById_._map=null;
    return detectGaps('${conDate}',['R02']);
  })()`).some(g => g.check_id === 'CHK105' && g.対象 === 'TEST01'));
check('食い違った推定は「精査」の一覧に戻る',
  String(run('buildReviewText_()')).indexOf('食事提供') > 0, run('buildReviewText_()').substring(0, 200));

// 両方とも人の回答なら、機械には決められないので社員に知らせる
const conDate2 = run(`addDays_(todayStr_(),-8)`);
const putRec2 = (item, value, certainty) => run(`appendRow(SHEETS.LOG_IMPORT,{
  log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),発生日:'${conDate2}',対象種別:'support',
  対象:'TEST01',項目名:'${item}',値:'${value}',取込元:'ai-uribo',取込日時:nowStr_(),
  確度:'${certainty}',推定回答:''})`);
putRec2('在否確認', '入院', '確定');
putRec2('日中活動', '参加した', '確定');
pushes.length = 0;
const con2 = run(`checkConsistency('${conDate2}')`);
check('人の回答どうしの食い違いは勝手に直さない', con2.要判断 === 1 && con2.再確認 === 0, con2);
check('社員に両方の記録を示して判断を仰ぐ',
  JSON.stringify(pushes).indexOf('記録の食い違い') > 0
    && JSON.stringify(pushes).indexOf('在否確認＝入院') > 0, JSON.stringify(pushes).substring(0, 200));
check('食い違いはS10に残り、週次で数えられる',
  rows('RUN_LOG').some(r => String(r.結果) === '食い違い'));
// 噛み合っている記録では何も起きない
const conDate3 = run(`addDays_(todayStr_(),-9)`);
run(`appendRow(SHEETS.LOG_IMPORT,{log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),
  発生日:'${conDate3}',対象種別:'support',対象:'TEST01',項目名:'在否確認',値:'在宅',
  取込元:'ai-uribo',取込日時:nowStr_(),確度:'確定',推定回答:''})`);
run(`appendRow(SHEETS.LOG_IMPORT,{log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),
  発生日:'${conDate3}',対象種別:'support',対象:'TEST01',項目名:'食事提供',値:'朝夕とも提供',
  取込元:'ai-uribo',取込日時:nowStr_(),確度:'確定',推定回答:''})`);
check('噛み合っている記録は何も起きない',
  run(`checkConsistency('${conDate3}')`).一覧.length === 0);

console.log('\n=== T12 自己点検と自動整理（手がかからない仕組み） ===');
// 1. トリガーが消えていたら、自分で入れ直す
run('installTriggers()');
sandbox.__triggers.length = 0;      // トリガーが消えた状態を作る
pushes.length = 0;
run('selfCheck()');
check('消えたトリガーを自分で入れ直す',
  sandbox.__triggers.indexOf('morningBatch') >= 0 && sandbox.__triggers.indexOf('selfCheck') >= 0,
  sandbox.__triggers);
check('自動で直したことは実行ログに残る',
  rows('RUN_LOG').some(r => String(r.詳細).indexOf('トリガーの再設定') >= 0));

// 2. 人の手が要ることだけを1通にまとめて知らせる
const noticeText = JSON.stringify(pushes);
check('要対応があれば社員に1通だけ届く',
  pushes.length > 0 && noticeText.indexOf('自己点検') > 0, pushes.length);
check('LINE未登録の方がいることを知らせる', noticeText.indexOf('登録が済んでいない') > 0);

// 3. 同じ内容が続く日は送らない（毎日同じ知らせが届いて読まれなくなるのを防ぐ）
pushes.length = 0;
run('selfCheck()');
check('前回と同じ内容なら送らない', pushes.length === 0, pushes.length);

// 4. 問題が無ければ何も送らない
clearCache();
run(`(function(){
  // 機器から今日ぶんの通知が届いている状態にする（届いていれば知らせない、を確かめる）
  // 拠点名も利用者マスタとそろえておく（ゆれの指摘とは別の検証なので）
  findRows(SHEETS.DEVICE,function(r){return isTrue_(r['有効']);}).forEach(function(d){
    updateRow(SHEETS.DEVICE,d._row,{'拠点':'清水'});
    appendRow(SHEETS.LOG_IMPORT,{log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),
      発生日:todayStr_(),対象種別:'raw_door',対象:'TEST01',項目名:'玄関',値:'開',
      取込元:'switchbot-webhook:'+d['deviceId'],取込日時:nowStr_()});
  });
  findRows(SHEETS.STAFF,function(r){return isTrue_(r['有効'])&&!String(r['line_user_id']||'').trim();})
    .forEach(function(r){updateRow(SHEETS.STAFF,r._row,{'line_user_id':'U_DUMMY_'+r['staff_id']});});
  findRows(SHEETS.LEARN,function(r){return String(r['段階'])==='要見直し';})
    .forEach(function(r){updateRow(SHEETS.LEARN,r._row,{'段階':'確認中'});});
  findRows(SHEETS.TASK,function(r){return String(r['送信状態'])==='テスト';})
    .forEach(function(r){updateRow(SHEETS.TASK,r._row,{'送信状態':'送信済'});});
  // 電池も入れ替えた状態にする（残りわずかなら、それは知らせるべき問題）
  PropertiesService.getScriptProperties().deleteProperty('SWITCHBOT_BATTERY');
})()`);
pushes.length = 0;
const quietResult = run('selfCheck()');
check('機器から届いていれば機器の警告は出さない、問題が無ければ何も送らない',
  pushes.length === 0 && String(quietResult).indexOf('要対応0件') === 0,
  quietResult + ' / ' + JSON.stringify(pushes).substring(0, 200));

// 5. 動いていないバッチに気づく
run(`appendRow(SHEETS.RUN_LOG,{日時:addDays_(todayStr_(),-5)+' 10:00',処理名:'morningBatch',結果:'完了',詳細:'テスト'})`);
clearCache();
pushes.length = 0;
run('selfCheck()');
check('何日も動いていないバッチに気づいて知らせる',
  JSON.stringify(pushes).indexOf('日動いていません') > 0, JSON.stringify(pushes).substring(0, 200));

// 6. 古い行は消さずに「_保管」シートへ移す
run(`(function(){
  var r=findRow(SHEETS.SETTING,{'キー':'archive_after_days'});updateRow(SHEETS.SETTING,r._row,{'値':'30'});
  clearSettingCache();
  appendRow(SHEETS.LOG_IMPORT,{log_id:'OLD1',発生日:addDays_(todayStr_(),-400),対象種別:'support',対象:'TEST01',
    項目名:'在否確認',値:'在宅',取込元:'ai-uribo',取込日時:nowStr_(),確度:'確定',推定回答:''});
})()`);
const beforeArchive = rows('LOG_IMPORT').length;
run('archiveOldRows()');
const afterArchive = rows('LOG_IMPORT').length;
check('古い行はS4から外れる', afterArchive < beforeArchive, beforeArchive + '→' + afterArchive);
check('外した行は消さずに保管シートへ移る',
  book.sheets.some(sh => sh.name === 'S4_実績ログ取込_保管')
    && run(`findRows('S4_実績ログ取込_保管')`).some(r => r.log_id === 'OLD1'),
  book.sheets.map(sh => sh.name).filter(n => n.indexOf('保管') > 0));
check('新しい行は残る', rows('LOG_IMPORT').some(r => r.対象 === 'TEST03'));
check('自動整理はバックアップの後に走る',
  String(run('dailyBackup()')).indexOf('のバックアップ完了') > 0);

console.log('\n=== T16 実行時間の上限への備え ===');
// GASは6分で強制終了され、その瞬間に何が終わって何が終わっていないのか分からなくなる。
// 手前で自分から切り上げ、残りは翌日の実行がそのまま拾う
run(`appendRow(SHEETS.GAP,{gap_id:'GAP-BUDGET-1',対象日:todayStr_(),check_id:'CHK001',対象:'STF001',
  状態:'検出',検出日時:nowStr_(),一次確認先staff_id:'STF001',完了日時:''})`);
run('startBatchClock_()');
run('BATCH_TIME_BUDGET_MS = 0');
check('時間切れと判定する', run('withinBatchBudget_()') === false);
pushes.length = 0;
run(`dispatchPendingGaps_(function(g){return String(g['gap_id'])==='GAP-BUDGET-1';},'【時間テスト】','budgetTest')`);
check('時間切れなら送らずに次回へ回す', pushes.length === 0, pushes.length);
check('回したことを警告として残す',
  rows('RUN_LOG').some(r => String(r.結果) === '警告' && String(r.詳細).indexOf('次回に回しました') > 0));
check('不足は消えないので翌日も残る',
  rows('GAP').some(g => g.gap_id === 'GAP-BUDGET-1' && String(g.状態) !== '完了'));

run('BATCH_TIME_BUDGET_MS = 240000');
run('startBatchClock_()');
check('余裕があれば止めない', run('withinBatchBudget_()') === true);
pushes.length = 0;
run(`dispatchPendingGaps_(function(g){return String(g['gap_id'])==='GAP-BUDGET-1';},'【時間テスト】','budgetTest')`);
check('余裕が戻れば同じ不足をちゃんと送る', pushes.length > 0, pushes.length);

// 自己点検が「間に合っていない」ことに気づく
clearCache();
pushes.length = 0;
run('selfCheck()');
check('自己点検が処理の遅れに気づいて知らせる',
  JSON.stringify(pushes).indexOf('時間内に終わらず') > 0, JSON.stringify(pushes).substring(0, 300));
check('実行にかかった秒数が実行ログに残る（遅くなってきたら分かる）',
  String(run('morningBatch()')).indexOf('秒') > 0);

console.log('\n=== T28 拠点をまたいだ誤配を防ぐ ===');
// 2拠点が動き出すと、清水の夜勤者に玉里の利用者の質問が届きうる。
// 見ていない利用者について答えられると、記録も担当者もずれる
run(`(function(){
  // 清水と玉里に1人ずつ利用者、夜勤者も1人ずつ用意する
  ['SITE_A','SITE_B'].forEach(function(code, i){
    var site = i === 0 ? '清水' : '玉里';
    var u = findRow(SHEETS.USER,{'user_code':code});
    if (u) updateRow(SHEETS.USER,u._row,{'拠点':site,'有効':true});
    else appendRow(SHEETS.USER,{user_code:code,拠点:site,自動ログ対応:false,服薬自動:false,
      在否自動:false,日中自動:false,有効:true});
  });
  ['STF801','STF802'].forEach(function(id, i){
    var site = i === 0 ? '清水' : '玉里';
    if (!staffById_(id)) {
      appendRow(SHEETS.STAFF,{staff_id:id,氏名:'夜勤'+site,line_user_id:'U_'+id,役割:'夜勤',
        拠点:site,エスカレーション先フラグ:false,有効:true,登録コード:''});
    }
    appendRow(SHEETS.SHIFT_PLAN,{日付:todayStr_(),staff_id:id,拠点:site,勤務区分:'夜勤',
      開始時刻:'',終了時刻:'',取込元:'test'});
  });
  // 両拠点に1件ずつ、夜に聞く不足を作る
  [['GAP-SITE-A','SITE_A'],['GAP-SITE-B','SITE_B']].forEach(function(p){
    if (!findRow(SHEETS.GAP,{'gap_id':p[0]})) {
      appendRow(SHEETS.GAP,{gap_id:p[0],対象日:addDays_(todayStr_(),-1),check_id:'CHK101',対象:p[1],
        状態:'検出',検出日時:nowStr_(),一次確認先staff_id:'',完了日時:''});
    }
  });
  var c=checkById_('CHK101');updateRow(SHEETS.CHECK,c._row,{'有効':true,'確認先役割':'夜勤'});
  checkById_._map=null;
})()`);
check('清水の夜勤者には清水の利用者だけを渡す',
  run(`forSiteOf_(pendingGaps_(function(){return true;}),'STF801')`)
    .every(g => String(g.対象) !== 'SITE_B'),
  run(`forSiteOf_(pendingGaps_(function(){return true;}),'STF801')`).map(g => g.対象));
check('玉里の夜勤者には玉里の利用者だけを渡す',
  run(`forSiteOf_(pendingGaps_(function(){return true;}),'STF802')`)
    .every(g => String(g.対象) !== 'SITE_A'));
check('それぞれ自分の拠点の分は受け取る',
  run(`forSiteOf_(pendingGaps_(function(){return true;}),'STF801')`).some(g => String(g.対象) === 'SITE_A')
    && run(`forSiteOf_(pendingGaps_(function(){return true;}),'STF802')`).some(g => String(g.対象) === 'SITE_B'));
check('拠点が分からない人には絞らない（届かないより多めに届く方がまし）',
  run(`forSiteOf_(pendingGaps_(function(){return true;}),'STF001')`).length
    >= run(`forSiteOf_(pendingGaps_(function(){return true;}),'STF801')`).length);
check('その日の拠点はシフト表から見る',
  run(`siteOfStaffToday_('STF801')`) === '清水' && run(`siteOfStaffToday_('STF802')`) === '玉里');

// 夜バッチを通しても、混ざらないこと
pushes.length = 0;
run('nightBatch(true)');
const toA = JSON.stringify(pushes.filter(p => p.to === 'U_STF801'));
const toB = JSON.stringify(pushes.filter(p => p.to === 'U_STF802'));
check('夜バッチでも、他拠点の利用者の質問は届かない',
  toA.indexOf('SITE_B') < 0 && toB.indexOf('SITE_A') < 0,
  (toA + ' || ' + toB).substring(0, 300));
// 後片付け
run(`(function(){
  ['SITE_A','SITE_B'].forEach(function(code){
    var u=findRow(SHEETS.USER,{'user_code':code}); if (u) updateRow(SHEETS.USER,u._row,{'有効':false});
  });
  ['STF801','STF802'].forEach(function(id){
    var s=staffById_(id); if (s) updateRow(SHEETS.STAFF,s._row,{'有効':false});
  });
})()`);

console.log('\n=== T27 給与ソフトのシフトをそのまま貼る ===');
// 給与計算ソフトの書き出しは形がまちまち。どれで貼られても読めるようにしてある
const csvShift = [
  '日付,氏名,勤務区分',
  '2026-11-01,服部俊喜,夜勤',
  '2026-11-02,服部俊喜,明け',
  '2026-11-02,藤原寛,日勤',
  '2026-11-03,服部俊喜,公休',
  '2026-11-04,山田太郎,夜勤'
].join('\n');
const csvRes = run(`importShiftText(${JSON.stringify(csvShift)})`);
check('見出し付きCSVを読める（列の並びを見て自分で合わせる）',
  csvRes.形式 === 'CSV' && csvRes.追加 === 3, csvRes);
check('拠点の列が無くても、その人のS1の拠点を使う',
  rows('SHIFT_PLAN').some(r => toStr(r.日付) === '2026-11-01' && r.staff_id === 'STF002' && r.拠点 === '清水'),
  rows('SHIFT_PLAN').filter(r => String(toStr(r.日付)).indexOf('2026-11') === 0));
check('休みの行は取り込まない',
  !rows('SHIFT_PLAN').some(r => toStr(r.日付) === '2026-11-03'));
check('スタッフ一覧に無い人は、行ごと理由を返す',
  csvRes.読めなかった行.some(l => l.indexOf('山田太郎') >= 0), csvRes.読めなかった行);
// 2交代の「明け」は朝で終わる勤務。その日の夜勤担当にすると、実際に泊まった人とずれる
check('「明け」はその晩の夜勤として扱わない',
  run(`isNightKind_('明け')`) === false && run(`isNightKind_('夜勤')`) === true
    && run(`isNightKind_('夜')`) === true);
check('「夜」だけの書き方でも夜勤と分かる（給与ソフトの記号に合わせる）',
  run(`(function(){ return fillNightStaffFromShift_('2026-11-01'); })()`) === 1);

// 月間シフト表（横に日付が並ぶ形）
const matrix = [
  '2026年11月',
  ['氏名', 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].join('\t'),
  ['服部俊喜', '夜', '明', '休', '日', '夜', '明', '休', '休', '夜', '明', '休'].join('\t'),
  ['藤原寛', '日', '日', '休', '夜', '明', '休', '日', '日', '休', '夜', '明'].join('\t')
].join('\n');
const matRes = run(`importShiftText(${JSON.stringify(matrix)})`);
check('月間シフト表（横に日付が並ぶ形）も読める',
  matRes.形式 === '月間シフト表' && matRes.追加 > 10, matRes);
check('休みの記号（休・×・空欄）は飛ばす',
  !rows('SHIFT_PLAN').some(r => toStr(r.日付) === '2026-11-12' && String(r.勤務区分) === '休'));
check('その日の夜勤が誰か、月間表からも分かる',
  String(run(`nightShiftReport_('2026-11-18')`)).indexOf('服部俊喜') > 0,
  run(`nightShiftReport_('2026-11-18')`).substring(0, 200));
check('同じ表を貼り直しても二重にならない',
  run(`importShiftText(${JSON.stringify(matrix)})`).追加 === 0);
// 手書きの形（日付 拠点 勤務区分 氏名）も今までどおり読める
check('手で書いた形も今までどおり読める',
  run(`importShiftText('2026-11-25 玉里 夜勤 藤原寛')`).追加 === 1);

console.log('\n=== T26 今日は誰が夜勤か ===');
// 夜の確認セットは夜勤の人に届く。誰が夜勤だと思われているかが見えないと、
// 「送ったのに現場に届いていない」が静かに起きる
run(`(function(){
  findRows(SHEETS.SHIFT_PLAN,function(r){return toDateStr_(r['日付'])===todayStr_();})
    .forEach(function(r){updateRow(SHEETS.SHIFT_PLAN,r._row,{'勤務区分':'（テストで消去）'});});
  var u=findRow(SHEETS.USER,{'user_code':'TEST01'});updateRow(SHEETS.USER,u._row,{'有効':true,'拠点':'清水'});
  findRows(SHEETS.STAFF,function(r){return String(r['役割']).indexOf('夜勤')>=0;})
    .forEach(function(r){updateRow(SHEETS.STAFF,r._row,{'有効':false});});
})()`);
const ns1 = run('nightShiftReport_()');
check('分からないときは「分かりません」と言う（黙って社員に送らない）',
  String(ns1).indexOf('分かりません') > 0 && String(ns1).indexOf('社員') > 0, String(ns1).substring(0, 300));
check('直し方を2つ示す（シフト表／役割の登録）',
  String(ns1).indexOf('シフト表を取り込む') > 0 && String(ns1).indexOf('役割を「夜勤」') > 0);

// シフト表が入っていれば、そこから答える
run(`importShiftText('${run('todayStr_()')} 清水 夜勤 服部俊喜')`);
const ns2 = run('nightShiftReport_()');
check('シフト表があれば、そこから誰かを答える',
  String(ns2).indexOf('清水：服部俊喜') > 0 && String(ns2).indexOf('シフト表より') > 0, String(ns2).substring(0, 300));

// LINEからも聞ける（この検証のために、無効化した夜勤スタッフを戻す）
run(`(function(){
  var s=findRow(SHEETS.STAFF,{'staff_id':'STF900'});
  if (s) updateRow(SHEETS.STAFF,s._row,{'有効':true});
})()`);
replies.length = 0;
post([{ type: 'message', webhookEventId: 'en1', source: { userId: 'U_NIGHT' }, message: { type: 'text', text: '夜勤' }, replyToken: 'rn1' }]);
check('LINEで「夜勤」と送れば誰でも確認できる',
  JSON.stringify(replies[0] || '').indexOf('の夜勤') > 0, replies[0]);

// LINE未登録の人がシフトに入っていたら、印を付けて知らせる
run(`(function(){
  var s=findRow(SHEETS.STAFF,{'staff_id':'STF002'});updateRow(SHEETS.STAFF,s._row,{'line_user_id':''});
})()`);
check('シフトの人がLINE未登録なら、そう分かるようにする',
  String(run('nightShiftReport_()')).indexOf('LINE未登録★') > 0, run('nightShiftReport_()').substring(0, 200));
run(`(function(){
  var s=findRow(SHEETS.STAFF,{'staff_id':'STF002'});updateRow(SHEETS.STAFF,s._row,{'line_user_id':'U_HATT'});
})()`);

console.log('\n=== T35 手作業をなくす（1クリック機能） ===');
// 本番セットアップを通してみて、人にしか押せない操作が多く残ることが分かった。
// とくに「設定値を一時的に書き換えて、試して、戻す」は戻し忘れが事故になる

// ① シフト希望のリハーサル：設定を触らずに、日付の条件だけ飛ばす
const dayNow = Number(run(`Utilities.formatDate(new Date(), TZ, 'd')`));
run(`(function(){
  var r=findRow(SHEETS.SETTING,{'キー':'shift_request_day'});updateRow(SHEETS.SETTING,r._row,{'値':'28'});
  var d=findRow(SHEETS.SETTING,{'キー':'shift_deadline_day'});updateRow(SHEETS.SETTING,d._row,{'値':'29'});
  clearSettingCache();
})()`);
check('普段は日付の条件どおり、対象外の日には出さない',
  run(`detectGaps(todayStr_(),['R01'])`).length === 0 || dayNow >= 28);
const rehearsed = run(`(function(){
  CacheService.getScriptCache().put(REHEARSAL_KEY,'1',300);
  var g = detectGaps(todayStr_(),['R01']);
  CacheService.getScriptCache().remove(REHEARSAL_KEY);
  return g;
})()`);
check('リハーサル中だけ、日付の条件を飛ばして質問を作る', rehearsed.length > 0, rehearsed.length);
check('リハーサルが終われば元に戻る（設定は触っていない）',
  run(`getSettingNum('shift_request_day',20)`) === 28
    && run(`detectGaps(todayStr_(),['R01'])`).length === 0 || dayNow >= 28);
run(`(function(){
  var r=findRow(SHEETS.SETTING,{'キー':'shift_request_day'});updateRow(SHEETS.SETTING,r._row,{'値':'20'});
  var d=findRow(SHEETS.SETTING,{'キー':'shift_deadline_day'});updateRow(SHEETS.SETTING,d._row,{'値':'25'});
  clearSettingCache();
})()`);

// ② 本番運用の開始／停止（S8を人が探して書き換えない）
run('setTestMode(true)');
check('テストモードON', String(run(`getSetting('test_mode','FALSE')`)) === 'TRUE');
const liveMsg = String(run('setTestMode(false)'));
check('本番運用に切り替えられる', String(run(`getSetting('test_mode','FALSE')`)) === 'FALSE');
check('切り替えた結果を言葉で返す', liveMsg.indexOf('実際にLINEへ届きます') > 0, liveMsg);

// ③ 利用者のまとめ登録（1人ずつ入力させない）
const usersBefore = rows('USER').length;
const bulk = String(run(`addUsersBulk(${JSON.stringify('清水\n試験太郎\n試験花子\n玉里\n試験一郎\n')})`));
check('拠点の見出しを引き継いで、まとめて登録できる',
  rows('USER').length === usersBefore + 3, rows('USER').length - usersBefore);
check('拠点が正しく分かれる',
  rows('USER').slice(-3).filter(u => String(u.拠点) === '清水').length === 2
    && rows('USER').slice(-3).filter(u => String(u.拠点) === '玉里').length === 1,
  rows('USER').slice(-3).map(u => u.拠点));
check('氏名はS9対応表にだけ入る（他のシートには記号だけ）',
  rows('NAME_MAP').some(n => String(n.氏名) === '試験太郎')
    && !rows('USER').some(u => JSON.stringify(u).indexOf('試験太郎') >= 0));
check('1行に「拠点 氏名」と書いても通る',
  String(run(`addUsersBulk(${JSON.stringify('玉里 試験次郎')})`)).indexOf('登録：1名') === 0);
check('結果に何名登録できたかを返す', bulk.indexOf('登録：3名') === 0, bulk.substring(0, 40));

// ④ SwitchBotの認証情報（スクリプトプロパティを手で触らせない）
delete props.SWITCHBOT_TOKEN; delete props.SWITCHBOT_SECRET;
check('片方だけでは受け付けない',
  String(run(`setSwitchbotSecrets('tok','')`)).indexOf('両方が必要') > 0);
run(`setSwitchbotSecrets('  tok123  ','  sec456  ')`);
check('前後の空白を落として保存する',
  props.SWITCHBOT_TOKEN === 'tok123' && props.SWITCHBOT_SECRET === 'sec456',
  [props.SWITCHBOT_TOKEN, props.SWITCHBOT_SECRET]);
check('値そのものはログに残さない',
  !rows('RUN_LOG').some(r => JSON.stringify(r).indexOf('tok123') >= 0));

// 後片付け
run(`deleteRowsWhere_(SHEETS.USER, function(r){ return String(r['user_code']).indexOf('ZZ') === 0; })`);
run(`(function(){
  ['試験太郎','試験花子','試験一郎','試験次郎'].forEach(function(n){
    deleteRowsWhere_(SHEETS.NAME_MAP, function(r){ return String(r['氏名'])===n; });
  });
})()`);

console.log('\n=== T34 Webhook秘密キーの作り直し ===');
// この鍵は画面に一度表示されるので、うっかり人に見せてしまうことがある。
// そのときに作り直せることと、貼り替え先が分かることが要る
props.WEBAPP_URL = 'https://script.google.com/macros/s/AAA/exec?k=oldkey123';
const oldKey = props.WEBHOOK_SECRET;
const rot = String(run('rotateWebhookSecret()'));
check('新しい鍵を作る', props.WEBHOOK_SECRET !== oldKey && /^[A-Za-z2-9]{24}$/.test(props.WEBHOOK_SECRET),
  props.WEBHOOK_SECRET);
const asReq = (k) => JSON.stringify({ parameter: { k }, postData: { contents: '{"events":[]}' } });
check('古い鍵では通らなくなる', run(`verifyRequest_(${asReq('oldkey123')})`) === false);
check('新しい鍵なら通る', run(`verifyRequest_(${asReq(props.WEBHOOK_SECRET)})`) === true);
check('保存してあるURLも新しい鍵に更新する（古い鍵が残らない）',
  props.WEBAPP_URL.indexOf('oldkey123') < 0 && props.WEBAPP_URL.indexOf(props.WEBHOOK_SECRET) > 0,
  props.WEBAPP_URL);
check('貼り替える場所を2か所とも案内する',
  rot.indexOf('LINE Developers') > 0 && rot.indexOf('secrets.yaml') > 0, rot.substring(0, 200));
check('貼り替えるまで受け付けが止まることを伝える', rot.indexOf('止まります') > 0);
// 後片付け：鍵を元に戻す（戻さないと以降のテストが全部「鍵が違う」で落ちる）
props.WEBHOOK_SECRET = oldKey;
delete props.WEBAPP_URL;
check('後片付け：鍵を元に戻した', props.WEBHOOK_SECRET === oldKey);

console.log('\n=== T33 拠点が2つになっても、材料が混ざらない ===');
// 清水にもハブを入れた瞬間に静かに壊れる箇所を、1拠点のうちに塞いでおく。
// 共用部のカメラは「誰の」かまでは分からないので、拠点あてで入ってくる
const mixDate = run('addDays_(todayStr_(),-2)');
run(`(function(){
  ['MIXA','MIXB'].forEach(function(code,i){
    var u=findRow(SHEETS.USER,{'user_code':code});
    var site = i===0 ? 'うりぼベース清水' : 'うりぼベース玉里';
    if (u) updateRow(SHEETS.USER,u._row,{'拠点':site,'有効':true});
    else appendRow(SHEETS.USER,{user_code:code,拠点:site,自動ログ対応:true,
      服薬自動:false,在否自動:false,日中自動:false,有効:true});
  });
})()`);
[['うりぼベース清水','清水の共用部で動きあり 01:10'],
 ['うりぼベース玉里','玉里の共用部で動きあり 03:20']].forEach(function (p) {
  postBody({ source: 'frigate', observations: [{ date: mixDate, target: p[0],
    item: '夜間の動き', value: p[1] }] });
});

const refFor = (code) => String(run(
  `referenceLogText_({'対象日':'${mixDate}','対象':'${code}'}, checkById_('CHK102'))`));
check('清水の質問には清水の動きだけを添える',
  refFor('MIXA').indexOf('清水の共用部') > 0 && refFor('MIXA').indexOf('玉里の共用部') < 0,
  refFor('MIXA'));
check('玉里の質問には玉里の動きだけを添える',
  refFor('MIXB').indexOf('玉里の共用部') > 0 && refFor('MIXB').indexOf('清水の共用部') < 0,
  refFor('MIXB'));

// 拠点名の書き方がずれたときは「誰にも届かない」より「多めに届く」（既存の方針に合わせる）
postBody({ source: 'frigate', observations: [{ date: mixDate, target: 'ALL',
  item: '夜間の動き', value: '拠点不明の動きあり 05:00' }] });
check('拠点あてが見つかる人には、全体あては混ぜない（確かな方を優先）',
  refFor('MIXA').indexOf('拠点不明') < 0, refFor('MIXA'));
run(`(function(){
  var u=findRow(SHEETS.USER,{'user_code':'MIXA'});
  updateRow(SHEETS.USER,u._row,{'拠点':'（表記ゆれ）'});
})()`);
check('拠点名がずれていても、全体あてが材料として残る（届かないよりまし）',
  refFor('MIXA').indexOf('拠点不明') > 0, refFor('MIXA'));

// 本人あてのログがあれば、それがいちばん強い
postBody({ source: 'door', observations: [{ date: mixDate, target: 'MIXB',
  item: '夜間の動き', value: '居室の開閉を検知 02:00' }] });
check('本人あてのログがあれば、それだけを使う（拠点あては補助）',
  refFor('MIXB').indexOf('居室の開閉') > 0 && refFor('MIXB').indexOf('玉里の共用部') < 0,
  refFor('MIXB'));

// 後片付け
run(`(function(){
  ['MIXA','MIXB'].forEach(function(code){
    var u=findRow(SHEETS.USER,{'user_code':code});
    if (u) updateRow(SHEETS.USER,u._row,{'有効':false});
  });
  deleteRowsWhere_(SHEETS.LOG_IMPORT, function(r){
    return toDateStr_(r['発生日'])==='${mixDate}' && String(r['項目名'])==='夜間の動き';
  });
})()`);
check('試験で入れた行を片付ける',
  rows('LOG_IMPORT').every(r => !(toStr(r.発生日) === mixDate && String(r.項目名) === '夜間の動き')));

console.log('\n=== T32 その材料が本当に効いているかを測る ===');
// センサーやAIハブは月々の費用がかかる。続けるかどうかを「便利そう」で決めないために、
// 材料を添えた質問と添えなかった質問で「わからない」率を比べる（現場の操作は増えない）
// 材料あり／材料なし（「ありませんでした」と書いて送った日）／そもそも材料を添えない質問、の3種類
const BODY = {
  ref: '（参考）夜間の動き：共用部で動きあり 02:40\n巡回はいかがでしたか',
  none: '（参考）2026-08-12 の「夜間の動き」の自動記録はありませんでした。\n巡回はいかがでしたか',
  other: 'シフト希望をお聞かせください'
};
const putTask = (kind, unknown, i) => run(`(function(){
  appendRow(SHEETS.TASK, {task_id:'ZZE${i}', gap_id:'', 送信先staff_id:'STF001',
    送信日時: todayStr_() + ' 10:00',
    回答: ${JSON.stringify(unknown ? 'わからない' : '済')},
    回答日時: todayStr_() + ' 10:05', 回答方法:'ボタン',
    送信本文: ${JSON.stringify(BODY[kind])},
    送信状態:'送信済', 再送回数:0, 追記待ち:false, セットid:'', 並び順:0, retry_key:'', 作成日時: nowStr_()});
})()`);

// まだ件数が少ないうちは「判断できません」と正直に言う
putTask('ref', false, 0); putTask('none', true, 1);
check('件数が少ないうちは判定しない（数字で誤解させない）',
  run('effectLines_()').join('\n').indexOf('まだ判断できません') > 0, run('effectLines_()'));

// 材料あり20件（わからない1件）／材料なし20件（わからない8件）
run(`deleteRowsWhere_(SHEETS.TASK, function(r){ return String(r['task_id']).indexOf('ZZE') === 0; })`);
for (let i = 0; i < 20; i++) putTask('ref', i < 1, 100 + i);
for (let i = 0; i < 20; i++) putTask('none', i < 8, 200 + i);
// そもそも材料を添えない種類の質問（シフト希望など）を混ぜても、比較を汚さないこと
for (let i = 0; i < 30; i++) putTask('other', i < 25, 500 + i);
const eff = run('effectLines_()').join('\n');
check('材料があった日と無かった日を並べて出す',
  eff.indexOf('材料があった日') > 0 && eff.indexOf('材料が無かった日') > 0, eff);
check('「その日は記録がありませんでした」を材料ありに数えない（数字が意味を失う）',
  eff.indexOf('材料があった日：20件') > 0 && eff.indexOf('材料が無かった日：20件') > 0, eff);
check('種類の違う質問（シフト希望など）を比較に混ぜない',
  eff.indexOf('50件') < 0 && eff.indexOf('30件') < 0, eff);
check('効いていれば「役に立っています」と言い切る',
  eff.indexOf('役に立っています') > 0, eff);
check('何ポイント差かを数字で出す', /\d+(\.\d)?ポイント/.test(eff), eff);

// 逆に差が無ければ「止めても影響が小さい」と言う（費用の判断ができるように）
run(`deleteRowsWhere_(SHEETS.TASK, function(r){ return String(r['task_id']).indexOf('ZZE') === 0; })`);
for (let i = 0; i < 20; i++) putTask('ref', i < 4, 300 + i);
for (let i = 0; i < 20; i++) putTask('none', i < 4, 400 + i);
const eff2 = run('effectLines_()').join('\n');
check('差が無ければ、止めてよいとはっきり言う',
  eff2.indexOf('差はほとんどありません') > 0 && eff2.indexOf('止めても影響が小さい') > 0, eff2);

// どの材料が何件に添えられたか
const bySrc = run('effectBySourceLines_()').join('\n');
check('どの材料を何件の質問に添えたかが分かる',
  bySrc.indexOf('夜間の動き') > 0, bySrc);

// 月に一度だけ週次に載せる（毎週載せると読まれなくなる）
check('効き目は月の最初の週次にだけ載せる',
  run(`isFirstDigestOfMonth_('2026-09-06')`) === true
    && run(`isFirstDigestOfMonth_('2026-09-20')`) === false);

// 後片付け
run(`deleteRowsWhere_(SHEETS.TASK, function(r){ return String(r['task_id']).indexOf('ZZE') === 0; })`);
check('試験で入れた行を片付ける',
  rows('TASK').every(r => String(r.task_id).indexOf('ZZE') !== 0));

console.log('\n=== T31 自動データが黙って止まったら気づく ===');
// いちばん怖い壊れ方はエラーではなく「沈黙」。SDが埋まる・電源が抜ける・Wi-Fiが変わる。
// どれも画面には何も出ず、記録だけが静かに薄くなる
const hoursAgo = (h) => run(`Utilities.formatDate(new Date(new Date().getTime() - ${h}*3600000), TZ, 'yyyy-MM-dd HH:mm')`);
const putSourceLogs = (src, stamps) => run(`(function(){
  ${JSON.stringify(stamps)}.forEach(function(t){
    appendRow(SHEETS.LOG_IMPORT, {log_id:'', 発生日:t.substring(0,10), 対象種別:'raw_test',
      対象:'ALL', 項目名:'ZZ_ALIVE', 値:'x', 取込元:${JSON.stringify(src)}, 取込日時:t});
  });
})()`);
// 配列は参照で渡せないので、中で作って返させる
const runAlive = () => run(`(function(){ var a=[]; checkSourcesAlive_(a); return a; })()`);

// ① 5件未満なら、まだ「普段の間隔」が分からないので騒がない
putSourceLogs('zz_new', [hoursAgo(300), hoursAgo(250)]);
check('データが少ないうちは沈黙を疑わない（設定直後に騒がない）',
  runAlive().every(m => String(m).indexOf('zz_new') < 0), runAlive());

// ② 1時間おきに来ていたものが丸1日止まったら気づく
putSourceLogs('zz_hourly', [30,29,28,27,26,25,24].map(h => hoursAgo(h)));
const silentMsgs = runAlive();
check('普段1時間おきのものが1日止まったら知らせる',
  silentMsgs.some(m => String(m).indexOf('zz_hourly') >= 0), silentMsgs);
check('何時間止まっているか・普段どれくらいかを書く',
  silentMsgs.some(m => /\d+時間止まって/.test(String(m)) && String(m).indexOf('普段は約') > 0), silentMsgs);

// ③ 普段どおり届いているものは鳴らさない
putSourceLogs('zz_ok', [6,5,4,3,2,1].map(h => hoursAgo(h)));
check('普段どおり届いているものでは鳴らさない',
  runAlive().every(m => String(m).indexOf('zz_ok') < 0), runAlive());

// ④ もともと間隔が長いもの（1日1回）は、半日空いた程度で鳴らさない
putSourceLogs('zz_daily', [24*6, 24*5, 24*4, 24*3, 24*2, 12].map(h => hoursAgo(h)));
check('もともと1日1回のものを、半日の間隔で誤報しない',
  runAlive().every(m => String(m).indexOf('zz_daily') < 0), runAlive());

// ⑤ AIハブは原因と確かめ方まで書く（現場が動けるように）
putSourceLogs('frigate', [30,29,28,27,26,25,24].map(h => hoursAgo(h)));
const hubMsg = runAlive().filter(m => String(m).indexOf('frigate') >= 0)[0] || '';
check('AIハブが止まったら、よくある原因を挙げる',
  String(hubMsg).indexOf('microSD') > 0 && String(hubMsg).indexOf('電源') > 0, hubMsg);
check('自分で確かめられるURLまで書く',
  String(hubMsg).indexOf('192.168.1.13:5000') > 0, hubMsg);

// ⑥ 人が手で貼るものは、届かなくても異常ではない
putSourceLogs('summary', [200,190,180,170,160,150].map(h => hoursAgo(h)));
check('手で貼り付けるもの（AIまとめ等）は沈黙を責めない',
  runAlive().every(m => String(m).indexOf('summary') < 0), runAlive());

// 後片付け（他のテストに影響させない）
run(`deleteRowsWhere_(SHEETS.LOG_IMPORT, function(r){ return String(r['項目名'])==='ZZ_ALIVE'; })`);
check('試験で入れた行を片付ける',
  rows('LOG_IMPORT').every(r => String(r.項目名) !== 'ZZ_ALIVE'));

console.log('\n=== T30 共用部カメラの動きが夜勤の質問に添えられる ===');
// 夜勤でいちばん辛いのは「思い出して書く」こと。
// Frigateが拾った時刻を質問に添えて、記憶ではなく事実から答えられるようにする
const camDate = run('addDays_(todayStr_(),-1)');
run(`(function(){
  var u=findRow(SHEETS.USER,{'user_code':'TEST01'});
  updateRow(SHEETS.USER,u._row,{'有効':true,'拠点':'清水'});
})()`);
// AIハブ（Home Assistant）から届く形そのままで投入する
[['00:15','front'],['02:40','living'],['04:30','living']].forEach(function (t, i) {
  postBody({
    source: 'frigate',
    observations: [{ date: camDate, target: 'ALL', item: '夜間の動き',
                     value: '共用部で動きあり ' + t[0] + '（' + t[1] + '）' }]
  });
});
const camLogs = rows('LOG_IMPORT').filter(r => String(r.取込元) === 'frigate');
check('AIハブからの観察がそのままの形で取り込まれる', camLogs.length === 3, camLogs.length);
check('画像ではなく言葉と時刻だけが入る',
  camLogs.every(r => /\d\d:\d\d/.test(String(r.値)) && String(r.値).indexOf('http') < 0));

// 自動充足：共用部の映像から利用者ごとの記録を勝手に作らないこと
run(`runAutoFill('${camDate}')`);
const madeUp = rows('FILL').filter(r => toStr(r.発生日) === camDate
  && String(r.情報源 || '').indexOf('frigate') >= 0 && String(r.対象) !== 'ALL');
check('共用部の映像から、利用者個人の記録を勝手に作らない', madeUp.length === 0,
  madeUp.map(r => r.対象 + '/' + r.項目名));

// 質問に添えられるか（ここが本命）
const patrolGap = { '対象日': camDate, '対象': 'TEST01' };
const refText = run(`referenceLogText_(${JSON.stringify(patrolGap)}, checkById_('CHK102'))`);
check('夜間巡回の質問に、その晩の動きが時刻つきで添えられる',
  String(refText).indexOf('00:15') > 0 && String(refText).indexOf('02:40') > 0
    && String(refText).indexOf('04:30') > 0, refText);
check('拠点共通（ALL）のログでも、利用者あての質問に添えられる',
  String(refText).indexOf('（参考）') === 0, refText);
check('CHK102に参照ログが設定されている',
  String(run(`checkById_('CHK102')['参照ログ']`)) === '夜間の動き');
// 6件以上あっても質問が長くなりすぎないこと
[1,2,3].forEach(function (i) {
  postBody({ source: 'frigate', observations: [{ date: camDate, target: 'ALL',
    item: '夜間の動き', value: '共用部で動きあり 0' + i + ':05（living）' }] });
});
const refMany = String(run(`referenceLogText_(${JSON.stringify(patrolGap)}, checkById_('CHK102'))`));
check('件数が多い晩は5件までにして「ほか◯件」とまとめる',
  refMany.indexOf('ほか1件') > 0 && refMany.split('／').length === 5, refMany);
check('自動記録が無い日は「ありませんでした」と正直に言う',
  String(run(`referenceLogText_({'対象日':'2001-01-01','対象':'TEST01'}, checkById_('CHK102'))`))
    .indexOf('ありませんでした') > 0);

console.log('\n=== T29 勤務開始の1時間前に送る ===');
// 21時固定だと、17時入りの人には遅すぎ（もう業務中）、22時入りの人には早すぎる。
// シフト表の開始時刻に合わせて、その人が動き出す前に届くようにする
check('時刻の書き方のゆれを読める（17:00／17時／1700／17）',
  run(`parseHour_('17:00')`) === 17 && run(`parseHour_('17時30分')`) === 17
    && run(`parseHour_('1700')`) === 17 && run(`parseHour_('17')`) === 17
    && run(`parseHour_('9:30')`) === 9,
  [run(`parseHour_('17:00')`), run(`parseHour_('17時30分')`), run(`parseHour_('1700')`), run(`parseHour_('17')`)]);
check('読めない値は「分からない」にする（勝手に0時にしない）',
  run(`parseHour_('')`) === -1 && run(`parseHour_('未定')`) === -1 && run(`parseHour_('25:00')`) === -1);

// シフト表に開始時刻を入れる
const setStart = (h) => run(`(function(){
  findRows(SHEETS.SHIFT_PLAN,function(r){
    return toDateStr_(r['日付'])===todayStr_() && String(r['staff_id'])==='STF002';
  }).forEach(function(r){updateRow(SHEETS.SHIFT_PLAN,r._row,{'勤務区分':'夜勤','開始時刻':${JSON.stringify(h)}});});
})()`);
const planFor = (id) => run(`nightSendPlan_(todayStr_())`).find(p => p.staffId === id);

setStart('17:00');
check('勤務開始17時なら16時に送る（1時間前）', (planFor('STF002') || {}).hour === 16, planFor('STF002'));
check('なぜその時刻なのかを言える', String((planFor('STF002') || {}).basis).indexOf('勤務開始17時の1時間前') >= 0,
  (planFor('STF002') || {}).basis);

setStart('');
check('開始時刻が無ければ従来どおり21時', (planFor('STF002') || {}).hour === 21, planFor('STF002'));
check('開始時刻が無いことを隠さない', String((planFor('STF002') || {}).basis).indexOf('未登録') >= 0);

setStart('23:00');
check('深夜入りの人でも、送信抑止に入る前（21時）に届ける', (planFor('STF002') || {}).hour === 21, planFor('STF002'));

setStart('7:00');
check('朝からの勤務が夜勤扱いで入っていても、早朝には送らない', (planFor('STF002') || {}).hour === 21, planFor('STF002'));

// 実際に送る／送らないの判断
setStart('17:00');
const nb = (h) => { sandbox.__fakeHour = h; const r = run('nightBatch()'); return String(r); };
check('送信時刻より前は何もしない', nb(14).indexOf('送信時刻前') === 0, nb(14));
check('何時に送るつもりかをログに残す', nb(14).indexOf('16時') > 0, nb(14));
check('送信時刻になったら動く', nb(16).indexOf('送信時刻前') < 0, nb(16));
check('深夜帯は動かない（送っても保留されるだけ）', nb(23).indexOf('深夜帯') >= 0, nb(23));
check('メニューからの手動実行は時刻を見ない',
  String(run('nightBatch(true)')).indexOf('深夜帯') < 0, run('nightBatch(true)'));
sandbox.__fakeHour = 10;   // 既定（昼）に戻す
check('明日の予定の検出は1日1回だけ',
  run(`needsPlanDetection_(todayStr_())`) === false
    && run(`needsPlanDetection_(addDays_(todayStr_(),1))`) === true);
check('今日の夜勤の画面に、送信時刻が出る',
  String(run('nightShiftReport_()')).indexOf('夜の確認セットの送信時刻') > 0,
  String(run('nightShiftReport_()')).substring(0, 400));
check('毎時のトリガーが登録されている（時刻が人によって違うため）',
  run('installTriggers()').indexOf('勤務開始') > 0 && sandbox.__triggers.indexOf('nightBatch') >= 0,
  run('installTriggers()'));

console.log('\n=== T25 SwitchBotから日誌が埋まるまで（通し） ===');
// 機器の通知が届いてから、既存アプリに渡す記録になるまでを1本で確かめる
run(`(function(){
  // 服薬ボックスの開閉センサーを、利用者TEST01に紐付けて有効にする
  var d = findRow(SHEETS.DEVICE,{'deviceId':'DEV2'});
  if (!d) {
    appendRow(SHEETS.DEVICE,{deviceId:'DEV2',deviceName:'清水 服薬ボックス',deviceType:'Contact Sensor',
      deviceMac:'C0DEB7260F48',拠点:'清水',対象user_code:'TEST01',用途種別:'服薬ボックス',有効:true,備考:''});
  } else {
    updateRow(SHEETS.DEVICE,d._row,{'対象user_code':'TEST01','用途種別':'服薬ボックス','有効':true,
      'deviceMac':'C0DEB7260F48','拠点':'清水'});
  }
  var u = findRow(SHEETS.USER,{'user_code':'TEST01'});
  updateRow(SHEETS.USER,u._row,{'有効':true,'拠点':'清水','服薬自動':true});
  var c = checkById_('CHK106'); updateRow(SHEETS.CHECK,c._row,{'有効':true}); checkById_._map=null;
})()`);

// ① SwitchBotから「箱が開いた」が届く
const medHook = { eventType: 'changeReport', eventVersion: '1', context: {
  deviceType: 'WoContact', deviceMac: 'C0DEB7260F48', openState: 'open', battery: 92 } };
const medRes = run(`doPost(${JSON.stringify({ parameter: { k: 'k123' }, postData: { contents: JSON.stringify(medHook) } })})`);
check('① 機器の通知を受け取る', String(medRes.text) === 'OK:1', medRes);
const medLog = rows('LOG_IMPORT').filter(l => String(l.取込元).indexOf('switchbot-webhook:DEV2') === 0).slice(-1)[0];
check('② 誰の・いつの出来事として記録される',
  medLog && medLog.対象 === 'TEST01' && String(medLog.対象種別) === 'raw_switchbot'
    && String(medLog.値).indexOf('開閉：open') === 0, medLog);
check('③ 時刻が残る（声かけの根拠になる）', /\d{1,2}:\d{2}/.test(String(medLog.値)), medLog && medLog.値);

// ④ 日誌側（支援記録）に落ちる
const medDate = toStr(medLog.発生日);
run(`runAutoFill('${medDate}')`);
check('④ 「服薬ボックス開放」が事実として日誌に入る',
  rows('LOG_IMPORT').some(l => toStr(l.発生日) === medDate && l.対象 === 'TEST01'
    && l.項目名 === '服薬ボックス開放' && String(l.確度) === '確定'),
  rows('LOG_IMPORT').filter(l => l.対象 === 'TEST01' && toStr(l.発生日) === medDate).map(l => l.項目名 + ':' + l.確度));
check('⑤ 「服薬確認」は推定として埋まる（断定しない）',
  rows('LOG_IMPORT').some(l => toStr(l.発生日) === medDate && l.対象 === 'TEST01'
    && l.項目名 === '服薬確認' && String(l.確度) === '推定'));
check('⑥ 既存アプリに渡す補完台帳に、出所つきで載る',
  rows('FILL').some(f => toStr(f.対象日) === medDate && f.対象 === 'TEST01' && f.項目名 === '服薬確認'
    && String(f.情報源).indexOf('switchbot_medication') > 0 && isTrueLike(f.要精査)),
  rows('FILL').filter(f => f.対象 === 'TEST01' && toStr(f.対象日) === medDate).map(f => f.項目名 + ':' + f.情報源));
check('⑦ それでも夜勤者には「声かけしたか」を聞く（機械には決められない）',
  run(`detectGaps('${medDate}',['R02'])`).some(g => g.check_id === 'CHK106' && g.対象 === 'TEST01'),
  run(`detectGaps('${medDate}',['R02'])`));
const medGapNow = run(`(function(){
  var gaps = detectGaps('${medDate}',['R02']).filter(function(g){return g.check_id==='CHK106';});
  registerGaps(gaps);
  var g = findRows(SHEETS.GAP,function(r){
    return r['check_id']==='CHK106' && toDateStr_(r['対象日'])==='${medDate}' && r['対象']==='TEST01';})[0];
  var msgs = buildQuestion_({task_id:'T-PREVIEW'}, g, checkById_('CHK106'), 0);
  return JSON.stringify(msgs);
})()`);
check('⑧ その質問に、箱が開いた時刻が添えられる（判断の材料になる）',
  String(medGapNow).indexOf('服薬ボックス開放') > 0 && /\d{1,2}:\d{2}/.test(String(medGapNow)),
  String(medGapNow).substring(0, 300));

// 未登録の機器・用途未設定の機器は取り込まない（誤って別の人の記録にしない）
const strayHook = { eventType: 'changeReport', context: { deviceMac: 'AAAAAAAAAAAA', openState: 'open' } };
check('⑨ 台帳に無い機器からの通知は記録しない',
  String(run(`doPost(${JSON.stringify({ parameter: { k: 'k123' }, postData: { contents: JSON.stringify(strayHook) } })})`).text) === 'OK:0');

// 深夜の出来事は「前の晩」の記録として扱う（日付で切ると夜勤の記録が抜けて見える）
const nightHook = { eventType: 'changeReport', context: {
  deviceType: 'WoContact', deviceMac: 'C0DEB7260F48', openState: 'open' } };
const nowHour = Number(run(`Utilities.formatDate(new Date(), TZ, 'H')`));
run(`doPost(${JSON.stringify({ parameter: { k: 'k123' }, postData: { contents: JSON.stringify(nightHook) } })})`);
const lastLog = rows('LOG_IMPORT').filter(l => String(l.取込元).indexOf('switchbot-webhook:DEV2') === 0).slice(-1)[0];
check('⑩ 深夜0〜5時の検知は前の晩の記録にする',
  nowHour < 5
    ? toStr(lastLog.発生日) === run('addDays_(todayStr_(),-1)')
    : toStr(lastLog.発生日) === run('todayStr_()'),
  '現在' + nowHour + '時 / 記録日 ' + toStr(lastLog.発生日));

console.log('\n=== T24 秘密情報の入力（打ち間違いを起こしようがなくする） ===');
delete props.LINE_CHANNEL_TOKEN;
delete props.WEBHOOK_SECRET;
const secRes = run(`setSecrets({token:'  dummy-token-123  '})`);
check('トークンを貼り付けるだけで正しいキー名に入る',
  props.LINE_CHANNEL_TOKEN === 'dummy-token-123', props.LINE_CHANNEL_TOKEN);
check('Webhookの秘密キーは自動で作る（人が考えなくてよい）',
  /^[A-Za-z2-9]{24}$/.test(String(props.WEBHOOK_SECRET || '')), props.WEBHOOK_SECRET);
check('作った秘密キーを呼び出し元に返す（?k= の案内に使う）',
  secRes.webhookSecret === props.WEBHOOK_SECRET);
const before24 = props.WEBHOOK_SECRET;
run(`setSecrets({channelSecret:'dummy-secret'})`);
check('空欄の項目は変更しない', props.WEBHOOK_SECRET === before24 && props.LINE_CHANNEL_TOKEN === 'dummy-token-123');
check('チャネルシークレットも入る', props.LINE_CHANNEL_SECRET === 'dummy-secret');
run(`setSecrets({webhookSecret:'自動'})`);
check('「自動」と指定すれば作り直せる', props.WEBHOOK_SECRET !== before24);
check('秘密の値そのものは実行ログに残さない',
  !rows('RUN_LOG').some(r => String(r.詳細).indexOf('dummy-token-123') >= 0
    || String(r.詳細).indexOf(String(props.WEBHOOK_SECRET)) >= 0),
  rows('RUN_LOG').filter(r => String(r.処理名) === 'setSecrets').map(r => r.詳細));
// あとのテストのために元に戻す
run(`(function(){ PropertiesService.getScriptProperties().setProperty('WEBHOOK_SECRET','k123'); })()`);

console.log('\n=== T23 通し試験（実機確認をシステム自身がやる） ===');
// 実機でしか分からないことを、1回の実行で確かめられるようにしたもの
run(`(function(){
  var r=findRow(SHEETS.SETTING,{'キー':'test_mode'});updateRow(SHEETS.SETTING,r._row,{'値':'FALSE'});
  clearSettingCache();
})()`);
pushes.length = 0;
const stReport = run('selfTest()');
check('全項目が通り、レポートが返る',
  String(stReport).indexOf('すべて通りました') > 0, String(stReport).substring(0, 600));
check('試験中はテストモードにする（現場にLINEを飛ばさない）',
  pushes.length === 0 && run(`getSetting('test_mode')`) === 'TRUE', pushes.length);
check('LINEのトークンが生きているかを、送信せずに確かめる',
  String(stReport).indexOf('LINEの接続：つながりました') > 0, String(stReport).substring(0, 400));
check('試験で作った行は後片付けされる',
  String(stReport).indexOf('後片付け：完了') > 0
    && !rows('GAP').some(g => String(g.gap_id).indexOf('ZZ_SELFTEST') >= 0)
    && !rows('USER').some(u => String(u.user_code).indexOf('ZZ_SELFTEST') >= 0),
  rows('GAP').filter(g => String(g.gap_id).indexOf('ZZ_SELFTEST') >= 0));
check('終わってもテストモードは戻さない（勝手に本番へ切り替えない）',
  String(stReport).indexOf('テストモードはONのままです') > 0);

// 直すべきことがあれば、直し方まで書いて返す
sandbox.__lineInfoCode = 401;
const stNg = run('selfTest()');
sandbox.__lineInfoCode = 200;
check('トークンが無効なら、そう言って直し方を示す',
  String(stNg).indexOf('トークンが無効です') > 0
    && String(stNg).indexOf('直していただきたいこと') > 0, String(stNg).substring(0, 500));
run(`(function(){
  var r=findRow(SHEETS.SETTING,{'キー':'test_mode'});updateRow(SHEETS.SETTING,r._row,{'値':'FALSE'});
  clearSettingCache();
})()`);

console.log('\n=== T22 実データ量での処理量（6分制限への備え） ===');
// 件数が増えたときに処理量が跳ね上がる（O(n^2)になる）と、いつか6分の制限に当たる。
// 利用者を倍にして、処理量がおおむね倍で収まるかを見る。
const seedScale = (users, days) => run(`(function(){
  // 既存の行は消さない（あとのテストが使うため）。SCALE利用者だけを増やして測る
  findRows(SHEETS.USER).forEach(function(u){
    var code = String(u['user_code']);
    if (code.indexOf('SCALE') !== 0) updateRow(SHEETS.USER,u._row,{'有効':false});
  });
  for (var i = 1; i <= ${users}; i++) {
    var code = 'SCALE' + i;
    var exists = findRow(SHEETS.USER,{'user_code':code});
    if (exists) {
      updateRow(SHEETS.USER,exists._row,{'有効':true});
    } else {
      appendRow(SHEETS.USER,{user_code:code,拠点:'清水',自動ログ対応:false,服薬自動:true,
        在否自動:true,日中自動:false,有効:true});
      for (var d = 1; d <= ${days}; d++) {
        appendRow(SHEETS.LOG_IMPORT,{log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),
          発生日:addDays_(todayStr_(), -d),対象種別:'raw_door',対象:code,項目名:'玄関',値:'開',
          取込元:'switchbot-webhook:dev'+i,取込日時:nowStr_()});
      }
    }
  }
  ['CHK101','CHK105','CHK106'].forEach(function(id){
    var c=checkById_(id);updateRow(SHEETS.CHECK,c._row,{'有効':true});});
  checkById_._map=null;
  return findRows(SHEETS.USER,function(u){return isTrue_(u['有効']);}).length;
})()`);

const measure = (users, dayOffset) => {
  seedScale(users, 30);
  // 測るのは利用者の数で増える部分（自動充足・不足検出・登録）。
  // 対象日を毎回変えて、前回の結果に引きずられないようにする
  SHEET_OPS.read = 0;
  SHEET_OPS.write = 0;
  const result = run(`(function(){
    var day = addDays_(todayStr_(), -${dayOffset});
    var auto = runAutoFill(day);
    var gaps = detectGaps(day, ['R02']);
    registerGaps(gaps);
    return { 充足: auto.filled, 検出: gaps.length };
  })()`);
  return { ops: SHEET_OPS.read + SHEET_OPS.write, 充足: result.充足, 検出: result.検出 };
};
const small = measure(3, 2);
const large = measure(6, 3);
console.log('   利用者3名: ' + small.ops + '操作（充足' + small.充足 + '件・検出' + small.検出 + '件）');
console.log('   利用者6名: ' + large.ops + '操作（充足' + large.充足 + '件・検出' + large.検出 + '件）');
check('利用者が倍になれば仕事も倍になっている（測定が成立している）',
  large.検出 >= small.検出 * 1.8 && large.充足 >= small.充足 * 1.8,
  JSON.stringify({ small: small, large: large }));
check('それでも処理量は倍程度に収まる（O(n^2)になっていない）',
  large.ops < small.ops * 3, small.ops + ' → ' + large.ops);
check('1日分の処理でシート操作が過大にならない', large.ops < 4000, large.ops);

// 台帳が育っても、古い行は保管へ移せる
run(`(function(){
  var r=findRow(SHEETS.SETTING,{'キー':'archive_after_days'});updateRow(SHEETS.SETTING,r._row,{'値':'10'});
  clearSettingCache();
})()`);
const beforeScaleArchive = rows('LOG_IMPORT').length;
run('archiveOldRows()');
check('育った台帳から古い行を保管へ移せる',
  rows('LOG_IMPORT').length < beforeScaleArchive,
  beforeScaleArchive + ' → ' + rows('LOG_IMPORT').length);
check('移した分は保管シートに残っている',
  run(`findRows('S4_実績ログ取込_保管')`).length > 0);

// 後片付け（あとのテストに影響させない）
run(`(function(){
  var r=findRow(SHEETS.SETTING,{'キー':'archive_after_days'});updateRow(SHEETS.SETTING,r._row,{'値':'180'});
  clearSettingCache();
  findRows(SHEETS.USER).forEach(function(u){
    var code = String(u['user_code']);
    updateRow(SHEETS.USER,u._row,{'有効': code.indexOf('SCALE') === 0 ? false : true});
  });
})()`);

console.log('\n=== T21 回答の訂正（押し間違いを本人が直せる） ===');
// 訂正できる回答がないときは、そう伝える
run(`(function(){
  findRows(SHEETS.TASK,function(r){return String(r['送信先staff_id'])==='STF900';})
    .forEach(function(t){updateRow(SHEETS.TASK,t._row,{'回答日時':''});});
})()`);
replies.length = 0;
post([{ type: 'message', webhookEventId: 'ec1', source: { userId: 'U_NIGHT' }, message: { type: 'text', text: '訂正' }, replyToken: 'rc1' }]);
check('直せる回答が無ければそう伝える',
  JSON.stringify(replies[0] || '').indexOf('直せる回答はありません') > 0, replies[0]);

// 答えた直後なら、本人が選び直せる
const fixGapId = run(`(function(){
  appendRow(SHEETS.GAP,{gap_id:'GAP-FIX-1',対象日:addDays_(todayStr_(),-1),check_id:'CHK101',対象:'TEST01',
    状態:'完了',検出日時:nowStr_(),一次確認先staff_id:'STF001',完了日時:nowStr_()});
  appendRow(SHEETS.TASK,{task_id:'TSK-FIX-1',gap_id:'GAP-FIX-1',送信先staff_id:'STF001',送信日時:nowStr_(),
    回答:'在宅',回答日時:nowStr_(),回答方法:'ボタン',送信本文:'',送信状態:'送信済',再送回数:0,
    追記待ち:false,セットid:'',並び順:1,retry_key:'',作成日時:nowStr_()});
  appendRow(SHEETS.FILL,{fill_id:nextSeqId_(SHEETS.FILL,'fill_id','FIL',6),対象日:addDays_(todayStr_(),-1),
    対象:'TEST01',項目名:'在否確認',値:'在宅',記入者staff_id:'STF001',取込済フラグ:true,作成日時:nowStr_(),
    gap_id:'GAP-FIX-1',情報源:'支援担当者の記録',要精査:false,精査結果:''});
  appendRow(SHEETS.LOG_IMPORT,{log_id:nextSeqId_(SHEETS.LOG_IMPORT,'log_id','LOG',6),
    発生日:addDays_(todayStr_(),-1),対象種別:'support',対象:'TEST01',項目名:'在否確認',値:'在宅',
    取込元:'ai-uribo',取込日時:nowStr_(),確度:'確定',推定回答:''});
  return 'GAP-FIX-1';
})()`);
replies.length = 0;
post([{ type: 'message', webhookEventId: 'ec2', source: { userId: 'U_FUJI' }, message: { type: 'text', text: '訂正' }, replyToken: 'rc2' }]);
check('直近に答えた項目が選べる',
  JSON.stringify(replies[0] || '').indexOf('fix|TSK-FIX-1') > 0, JSON.stringify(replies[0] || '').substring(0, 300));
replies.length = 0;
post([{ type: 'postback', webhookEventId: 'ec3', source: { userId: 'U_FUJI' }, postback: { data: 'fix|TSK-FIX-1' }, replyToken: 'rc3' }]);
check('いまの記録内容を示して選択肢を出し直す',
  JSON.stringify(replies[0] || '').indexOf('今は「在宅」で記録されています') > 0
    && JSON.stringify(replies[0] || '').indexOf('refix|TSK-FIX-1|外泊・帰省') > 0, replies[0]);

// 他人の回答は直せない
replies.length = 0;
post([{ type: 'postback', webhookEventId: 'ec4', source: { userId: 'U_NIGHT' }, postback: { data: 'fix|TSK-FIX-1' }, replyToken: 'rc4' }]);
check('他人の回答は直せない',
  JSON.stringify(replies[0] || '').indexOf('ご自身のものではない') > 0, replies[0]);

replies.length = 0;
post([{ type: 'postback', webhookEventId: 'ec5', source: { userId: 'U_FUJI' }, postback: { data: 'refix|TSK-FIX-1|外泊・帰省' }, replyToken: 'rc5' }]);
check('訂正できたことを本人に返す',
  JSON.stringify(replies[0] || '').indexOf('外泊・帰省」に直しました') > 0, replies[0]);
check('元の回答は履歴として残る（消さない）',
  rows('TASK').some(t => t.task_id === 'TSK-FIX-1' && String(t.回答方法).indexOf('訂正（前: 在宅）') === 0),
  rows('TASK').filter(t => t.task_id === 'TSK-FIX-1'));
check('補完台帳の元の記録に「訂正前」が付く',
  rows('FILL').some(f => f.gap_id === 'GAP-FIX-1' && f.精査結果 === '訂正前'));
check('訂正後の記録が新しい行として足される',
  rows('FILL').some(f => f.gap_id === 'GAP-FIX-1' && f.精査結果 === '訂正後'
    && String(f.値) === '外泊・帰省' && String(f.情報源).indexOf('訂正') > 0),
  rows('FILL').filter(f => f.gap_id === 'GAP-FIX-1'));
check('訂正後の行は未取込なので既存アプリに渡る',
  JSON.parse(run(`doGet(${JSON.stringify({ parameter: { k: 'k123', mode: 'fills' } })})`).text)
    .items.some(i => i.精査結果 === '訂正後'));
check('実績ログも新しい内容にそろう（1項目1行を保つ）',
  rows('LOG_IMPORT').filter(l => l.項目名 === '在否確認' && l.対象 === 'TEST01'
    && toStr(l.発生日) === run(`addDays_(todayStr_(),-1)`)).every(l => String(l.値) === '外泊・帰省'));
check('いつ誰が何をどう直したかが実行ログに残る',
  rows('RUN_LOG').some(r => String(r.結果) === '訂正' && String(r.詳細).indexOf('在宅') > 0));
replies.length = 0;
post([{ type: 'postback', webhookEventId: 'ec6', source: { userId: 'U_FUJI' }, postback: { data: 'refix|TSK-FIX-1|外泊・帰省' }, replyToken: 'rc6' }]);
check('同じ内容に直そうとしたら何もしない',
  JSON.stringify(replies[0] || '').indexOf('いまと同じ内容') > 0, replies[0]);

console.log('\n=== T20 拠点名の書き方のゆれ ===');
run(`(function(){
  var u=findRow(SHEETS.USER,{'user_code':'TEST01'});updateRow(SHEETS.USER,u._row,{'有効':true,'拠点':'清水'});
  appendRow(SHEETS.SHIFT_PLAN,{日付:todayStr_(),staff_id:'STF002',拠点:'うりぼベース清水',
    勤務区分:'夜勤',開始時刻:'',終了時刻:'',取込元:'test'});
})()`);
clearCache();
pushes.length = 0;
run('selfCheck()');
check('拠点名のゆれに気づいて知らせる',
  JSON.stringify(pushes).indexOf('利用者マスタに無い拠点名') > 0
    && JSON.stringify(pushes).indexOf('うりぼベース清水') > 0, JSON.stringify(pushes).substring(0, 300));
run(`(function(){
  findRows(SHEETS.SHIFT_PLAN,function(r){return String(r['拠点'])==='うりぼベース清水';})
    .forEach(function(r){updateRow(SHEETS.SHIFT_PLAN,r._row,{'拠点':'清水'});});
})()`);
clearCache();
pushes.length = 0;
run('selfCheck()');
check('そろえれば、その拠点名は指摘されなくなる',
  JSON.stringify(pushes).indexOf('うりぼベース清水') < 0, JSON.stringify(pushes).substring(0, 300));

console.log('\n=== T19 お返事が無い確認の聞き直し ===');
// 一度送ったきり返事が無い確認を放置すると、記録が空いたまま週次まで埋もれる
run(`(function(){
  appendRow(SHEETS.GAP,{gap_id:'GAP-REMIND-1',対象日:todayStr_(),check_id:'CHK001',対象:'STF002',
    状態:'検出',検出日時:nowStr_(),一次確認先staff_id:'STF002',完了日時:''});
})()`);
const remindGap = run(`findRows(SHEETS.GAP,function(r){return r['gap_id']==='GAP-REMIND-1';})`);
pushes.length = 0;
run(`dispatchPendingGaps_(function(g){return String(g['gap_id'])==='GAP-REMIND-1';},'【確認】','remindTest')`);
check('1回目は普通に届く', pushes.length === 1, pushes.length);
pushes.length = 0;
run(`dispatchPendingGaps_(function(g){return String(g['gap_id'])==='GAP-REMIND-1';},'【確認】','remindTest')`);
check('送った直後は二度聞きしない', pushes.length === 0, pushes.length);

// 時間が経ったら、もう一度だけお送りする
const ageTask = hours => run(`(function(){
  findRows(SHEETS.TASK,function(r){return r['gap_id']==='GAP-REMIND-1';}).forEach(function(t){
    updateRow(SHEETS.TASK,t._row,{'送信日時':toDateTimeStr_(new Date(new Date().getTime()-${hours}*3600000)),
      '作成日時':toDateTimeStr_(new Date(new Date().getTime()-${hours}*3600000))});
  });
})()`);
ageTask(24);
pushes.length = 0;
run(`dispatchPendingGaps_(function(g){return String(g['gap_id'])==='GAP-REMIND-1';},'【確認】','remindTest')`);
check('丸1日返事が無ければ、もう一度お送りする', pushes.length === 1, pushes.length);
check('催促に見えないよう一言添える',
  JSON.stringify(pushes).indexOf('前回お答えいただけなかった分') > 0, JSON.stringify(pushes).substring(0, 200));

// しつこくしない（上限を超えたら催促をやめ、週次で社員が引き取る）
ageTask(48);
pushes.length = 0;
run(`dispatchPendingGaps_(function(g){return String(g['gap_id'])==='GAP-REMIND-1';},'【確認】','remindTest')`);
check('上限までは聞き直す', pushes.length === 1, pushes.length);
ageTask(72);
pushes.length = 0;
run(`dispatchPendingGaps_(function(g){return String(g['gap_id'])==='GAP-REMIND-1';},'【確認】','remindTest')`);
check('上限を超えたら催促しない（週次で社員へ）', pushes.length === 0, pushes.length);
check('未完了なので週次の一覧には残る',
  rows('GAP').some(g => g.gap_id === 'GAP-REMIND-1' && String(g.状態) !== '完了'));

// 答えていただいた項目は、時間が経っても聞き直さない
run(`(function(){
  var g=findRow(SHEETS.GAP,{'gap_id':'GAP-REMIND-1'});updateRow(SHEETS.GAP,g._row,{'状態':'検出'});
  findRows(SHEETS.TASK,function(r){return r['gap_id']==='GAP-REMIND-1';}).forEach(function(t){
    updateRow(SHEETS.TASK,t._row,{'回答':'今答える','回答日時':nowStr_()});
  });
})()`);
pushes.length = 0;
run(`dispatchPendingGaps_(function(g){return String(g['gap_id'])==='GAP-REMIND-1';},'【確認】','remindTest')`);
check('答えていただいた項目は聞き直さない', pushes.length === 0, pushes.length);

console.log('\n=== T36 質問を出しすぎない ===');
// 利用者4名 × 支援記録6項目 = 初日から24件。正しくても、24回ボタンを押させる仕組みは使われない。
// 上限を超えた分は捨てずに残し、翌日また対象になる
run(`(function(){
  ['ZZL1','ZZL2','ZZL3'].forEach(function(c){
    if (!findRow(SHEETS.USER,{'user_code':c})) {
      appendRow(SHEETS.USER,{user_code:c, 拠点:'清水', 有効:true});
    }
  });
  deleteRowsWhere_(SHEETS.GAP, function(r){ return String(r['gap_id']).indexOf('ZZLIM') === 0; });
  var n = 0;
  ['ZZL1','ZZL2','ZZL3'].forEach(function(c){
    ['CHK101','CHK105','CHK106','CHK111','CHK112'].forEach(function(ck){
      n++;
      appendRow(SHEETS.GAP,{gap_id:'ZZLIM'+n, 対象日:todayStr_(), check_id:ck, 対象:c,
        状態:GAP_STATUS.DETECTED, 検出日時:nowStr_()});
    });
  });
})()`);
const limGaps = () => run(`findRows(SHEETS.GAP, function(r){ return String(r['gap_id']).indexOf('ZZLIM')===0; })`);
check('試験用の不足を15件用意した', limGaps().length === 15, limGaps().length);

const picked = run(`limitAsks_(findRows(SHEETS.GAP, function(r){ return String(r['gap_id']).indexOf('ZZLIM')===0; }))`);
check('1回にお送りするのは上限まで（既定8件）', picked.length === 8, picked.length);
check('優先度Aを先に聞く（あとから思い出せないものが後回しにならない）',
  picked.every(g => ['CHK101', 'CHK105', 'CHK106'].indexOf(String(g.check_id)) >= 0),
  picked.map(g => g.check_id));
check('同じ利用者の質問が固まらない（不在の日に全部わからないになるのを避ける）',
  new Set(picked.slice(0, 3).map(g => String(g.対象))).size === 3,
  picked.slice(0, 3).map(g => g.対象));
check('上限を下回るときはそのまま全部聞く',
  run(`limitAsks_([{gap_id:'a',check_id:'CHK101',対象:'ZZL1',対象日:todayStr_()}])`).length === 1);
// 上限を超えた分は「捨てた」のではなく「まわした」。S5の不足はそのまま残る
check('聞かなかった分の不足は消えない（翌日また対象になる）', limGaps().length === 15, limGaps().length);

run(`(function(){
  var r=findRow(SHEETS.SETTING,{'キー':'max_asks_per_set'});updateRow(SHEETS.SETTING,r._row,{'値':'0'});
  clearSettingCache();
})()`);
check('上限を0にすると絞らない（止めたい人の逃げ道）',
  run(`limitAsks_(findRows(SHEETS.GAP, function(r){ return String(r['gap_id']).indexOf('ZZLIM')===0; }))`).length === 15);
run(`(function(){
  var r=findRow(SHEETS.SETTING,{'キー':'max_asks_per_set'});updateRow(SHEETS.SETTING,r._row,{'値':'8'});
  clearSettingCache();
  deleteRowsWhere_(SHEETS.GAP, function(r){ return String(r['gap_id']).indexOf('ZZLIM') === 0; });
  deleteRowsWhere_(SHEETS.USER, function(r){ return String(r['user_code']).indexOf('ZZL') === 0; });
})()`);

console.log('\n=== T37 電池が切れたセンサーを信じない ===');
// 止まったセンサーは、エラーではなく「古い値」を返し続ける。
// その「動きなし」を材料にすると、夜勤の巡回を「していない」と読み違えたまま記録が歪む
check('電池0%は「尽きた」と見なす', run('isDeadBattery_(0)') === true);
check('電池5%も材料には使わない', run('isDeadBattery_(5)') === true);
check('電池20%はまだ使う（残りわずかなだけ）', run('isDeadBattery_(20)') === false);
check('電池の値を返さない機器を、勝手に電池切れ扱いしない',
  run('isDeadBattery_(undefined)') === false && run(`isDeadBattery_('')`) === false);

run(`(function(){
  if (!findRow(SHEETS.DEVICE,{'deviceId':'ZZDEAD'})) {
    appendRow(SHEETS.DEVICE,{deviceId:'ZZDEAD', deviceName:'試験_人感', deviceType:'Motion Sensor',
      拠点:'清水', 対象user_code:'', 用途種別:'人感', 有効:true});
  }
  if (!findRow(SHEETS.DEVICE,{'deviceId':'ZZLOW'})) {
    appendRow(SHEETS.DEVICE,{deviceId:'ZZLOW', deviceName:'試験_薬箱', deviceType:'Contact Sensor',
      拠点:'清水', 対象user_code:'', 用途種別:'服薬ボックス', 有効:true});
  }
  rememberBattery_({ZZDEAD:0, ZZLOW:20});
})()`);
const lowBatt = run('lowBatteryDevices_(20)');
check('電池が心もとない機器を拾える', lowBatt.length === 2, lowBatt.map(d => d.name + ':' + d.percent));
check('尽きた機器と、残りわずかな機器を区別する',
  lowBatt.filter(d => d.dead).length === 1 && String(lowBatt[0].name) === '試験_人感', lowBatt);
const battIssues = run(`(function(){ var a=[]; checkBattery_(a); return a; })()`);
check('朝の自己点検で、電池切れを社員に知らせる',
  battIssues.some(m => String(m).indexOf('試験_人感') >= 0 && String(m).indexOf('材料に使っていません') > 0),
  battIssues);
check('なぜ材料に使わないのかまで書いてある',
  battIssues.some(m => String(m).indexOf('読み違え') > 0), battIssues);

// 同じ値を毎時書き足さない（「いつ変わったか」が見えなくなるため）
run(`(function(){
  appendRow(SHEETS.LOG_IMPORT,{log_id:'ZZPOLL1', 発生日:todayStr_(), 対象種別:'raw_switchbot',
    対象:'ALL', 項目名:'服薬', 値:'状態:close', 取込元:'switchbot-poll:ZZLOW', 取込日時:nowStr_()});
})()`);
check('前と同じ値なら書き足さない', run(`lastPolledValue_('switchbot-poll:ZZLOW', todayStr_())`) === '状態:close');
check('前の値が無ければ空を返す（初回は必ず記録する）',
  run(`lastPolledValue_('switchbot-poll:ZZNONE', todayStr_())`) === '');

// 読めなかったときに黙って捨てない
check('状態に何が入っていたかを残せる',
  String(run(`statusKeys_({battery:0, version:'V1.2'})`)) === 'battery・version');
check('何も入っていなければ「なし」', String(run('statusKeys_({})')) === 'なし');

// 「開いた・動いた」の通知が一度も届かない状態に気づく
// （前のテストで入れた通知を外して、届いていない状態を作る）
run(`deleteRowsWhere_(SHEETS.LOG_IMPORT, function(r){
  return String(r['取込元']).indexOf('switchbot-webhook:') === 0;
})`);
const hookIssues = run(`(function(){ var a=[]; checkWebhookArriving_(a); return a; })()`);
check('薬箱の開閉通知が届いていないことに気づく',
  hookIssues.some(m => String(m).indexOf('届いていません') > 0), hookIssues);
check('届かないと何が困るのかを書いてある',
  hookIssues.some(m => String(m).indexOf('服薬の材料') > 0), hookIssues);
run(`(function(){
  appendRow(SHEETS.LOG_IMPORT,{log_id:'ZZHOOK1', 発生日:todayStr_(), 対象種別:'raw_switchbot',
    対象:'ALL', 項目名:'服薬', 値:'開閉：open', 取込元:'switchbot-webhook:ZZLOW', 取込日時:nowStr_()});
})()`);
check('届いていれば知らせない',
  run(`(function(){ var a=[]; checkWebhookArriving_(a); return a; })()`).length === 0);

// 後片付け
run(`(function(){
  deleteRowsWhere_(SHEETS.DEVICE, function(r){ return String(r['deviceId']).indexOf('ZZ') === 0; });
  deleteRowsWhere_(SHEETS.LOG_IMPORT, function(r){ return String(r['log_id']).indexOf('ZZ') === 0; });
})()`);

console.log('\n=== T38 支援記録の質問は少しずつ始める ===');
// 優先度Aは11項目。利用者4名なら初日から44件になる。
// 答えきれない質問が毎日積み上がると、仕組みそのものが使われなくなる
run(`(function(){
  findRows(SHEETS.CHECK, function(r){
    return ['support','plan'].indexOf(String(r['対象種別'])) >= 0;
  }).forEach(function(c){ updateRow(SHEETS.CHECK, c._row, {'有効': false}); });
  checkById_._map = null;
})()`);
const starterMsg = String(run('enablePhase2()'));
const onNow = () => run(`findRows(SHEETS.CHECK, function(r){
  return ['support','plan'].indexOf(String(r['対象種別'])) >= 0 && isTrue_(r['有効']);
})`).map(c => String(c.check_id));
check('まず5項目だけ始める', onNow().length === 5, onNow());
check('あとから思い出せないもの・実費請求の根拠になるものを選んでいる',
  ['CHK101', 'CHK105', 'CHK106', 'CHK204', 'CHK205'].every(id => onNow().indexOf(id) >= 0), onNow());
check('1日あたり何件になるかを先に伝える', starterMsg.indexOf('1日あたり最大') > 0, starterMsg.substring(0, 300));
check('まだ始めていない項目が残っていることを伝える',
  starterMsg.indexOf('質問を増やす') > 0, starterMsg.substring(0, 400));

const allMsg = String(run('enablePhase2(true)'));
check('「質問を増やす」で残りの優先度Aが入る', onNow().length > 5, onNow().length);
check('増やしたあとは、残りがあるとは言わない', allMsg.indexOf('質問を増やす') < 0, allMsg.substring(0, 300));
check('もう一度押しても二重にならない',
  String(run('enablePhase2(true)')).indexOf('すでに開始しています') > 0);
run('disablePhase2()');
check('多すぎたらいつでも静かにできる', onNow().length === 0, onNow());

console.log('\n=== T18 GAS貼り付け用の全部入りファイル ===');
// 1万行のコピーは静かに切れる。切れたまま動くのがいちばん厄介なので、
// 貼った本人がその場で気づけるかを確かめる
const bundler = require('../tools/bundle.js');
check('全部入りファイルが最新（src/を直したら作り直されている）',
  bundler.isBundleFresh(), 'node tools/bundle.js で作り直してください');
const bundleText = bundler.buildBundle();
let bundleOk = true;
let bundleErr = '';
try {
  const box = vm.createContext({});
  vm.runInContext(bundleText, box, { filename: 'AI_Uribo_全部入り.gs' });
  ['doPost', 'doGet', 'morningBatch', 'nightBatch', 'weeklyDigest', 'monthlyReport',
   'selfCheck', 'dailyBackup', 'flushQueue', 'installTriggers', 'quickStart',
   'addUser', 'enablePhase2', 'importShiftText', 'onOpen'].forEach(fn => {
    if (typeof box[fn] !== 'function') { bundleOk = false; bundleErr = fn + ' が定義されていません'; }
  });
} catch (e) {
  bundleOk = false;
  bundleErr = String(e);
}
check('貼り付けるだけで全機能が読み込める', bundleOk, bundleErr);
check('src/の全ファイルが漏れなく入っている',
  fs.readdirSync(SRC).filter(f => f.endsWith('.gs'))
    .every(f => bundleText.indexOf('// ' + f + '\n') > 0),
  fs.readdirSync(SRC).filter(f => f.endsWith('.gs') && bundleText.indexOf('// ' + f + '\n') < 0));

// --- 貼り付けが途中で切れたときに気づけるか ---
check('全部入りファイルに、収録した関数名の一覧が入っている',
  /var BUNDLE_FUNCTIONS = \[/.test(bundleText) && /var BUNDLE_FILE_COUNT = \d+;/.test(bundleText));
const pasteBox = { console, JSON, Math, String, Number, Object, Array, Date, RegExp, Error, isNaN, parseInt, parseFloat };
vm.createContext(pasteBox);
vm.runInContext(bundleText, pasteBox);
const pasteOk = vm.runInContext('verifyPaste()', pasteBox);
check('全文が貼れていれば「すべて入っています」と言う', pasteOk.ok === true, pasteOk.message);
check('何個の機能が入っているかを数字で示す', pasteOk.total > 200, pasteOk.total);

// 関数が1つ欠けても構文エラーにならない＝いちばん見逃しやすい壊れ方
const brokenText = bundleText.replace(/\nfunction nightBatch\(force\) \{[\s\S]*?\n\}\n/, '\n');
const brokenBox = { console, JSON, Math, String, Number, Object, Array, Date, RegExp, Error, isNaN, parseInt, parseFloat };
vm.createContext(brokenBox);
vm.runInContext(brokenText, brokenBox);
const brokenRes = vm.runInContext('verifyPaste()', brokenBox);
check('機能が1つでも欠けていれば、その場で気づける',
  brokenRes.ok === false && brokenRes.missing.indexOf('nightBatch') >= 0, brokenRes.message);
check('どう直せばよいかまで書いてある',
  String(brokenRes.message).indexOf('貼り直して') > 0, brokenRes.message);

run('installTriggers()');
check('トリガーを登録（SwitchBot設定時は8本）',
  sandbox.__triggers.length === 8 && sandbox.__triggers.indexOf('switchbotPoll') >= 0
    && sandbox.__triggers.indexOf('selfCheck') >= 0
    && sandbox.__triggers.indexOf('monthlyReport') >= 0, sandbox.__triggers);
// 「WEBHOOK_SECRET未設定なので拒否した」は、fail-closeの検証で意図的に出したエラー
const unexpectedErrors = rows('RUN_LOG').filter(r => r.結果 === 'エラー' &&
  String(r.詳細).indexOf('WEBHOOK_SECRET が未設定') < 0);
check('想定外のエラーがS10に無い', unexpectedErrors.length === 0,
  unexpectedErrors.map(r => r.処理名 + ': ' + r.詳細));

console.log('\n================ 結果: ' + (failures ? failures + '件 NG' : 'すべてOK') + ' ================\n');
process.exit(failures ? 1 : 0);
