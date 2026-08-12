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
  setFrozenRows() { return this; }
  appendRow(values) {
    const r = this.getLastRow() + 1;
    this._ensure(r, values.length);
    for (let c = 0; c < values.length; c++) this.data[r - 1][c] = values[c];
    return this;
  }
  getRange(row, col, numRows = 1, numCols = 1) { return new MockRange(this, row, col, numRows, numCols); }
}
class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
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
    this.sheet._ensure(this.row - 1 + values.length, this.col - 1 + values[0].length);
    values.forEach((row, r) => row.forEach((v, c) => { this.sheet.data[this.row - 1 + r][this.col - 1 + c] = v; }));
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
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
      setProperty: (k, v) => { props[k] = v; }
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
    getProjectTriggers: () => [],
    deleteTrigger: () => { },
    newTrigger: (fn) => {
      const b = {
        timeBased: () => b, atHour: () => b, everyDays: () => b, onWeekDay: () => b,
        inTimezone: () => b, create: () => { sandbox.__triggers.push(fn); }
      };
      return b;
    },
    WeekDay: { SUNDAY: 'SUN', MONDAY: 'MON', TUESDAY: 'TUE', WEDNESDAY: 'WED', THURSDAY: 'THU', FRIDAY: 'FRI', SATURDAY: 'SAT' }
  },
  UrlFetchApp: {
    fetch: (url, opts) => {
      const payload = JSON.parse(opts.payload);
      if (url.indexOf('/push') >= 0) pushes.push(payload); else replies.push(payload);
      return { getResponseCode: () => 200, getContentText: () => '{}' };
    }
  },
  ContentService: { createTextOutput: t => ({ text: t }) },
  DriveApp: {
    getRootFolder: () => mockFolder('root'),
    getFileById: () => ({ makeCopy: () => ({}) })
  },
  Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
  __triggers: [],
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
    createFile: blob => (files[blob.name] = { name: blob.name, setTrashed: () => { } }),
    moveTo: () => { }, setTrashed: () => { }
  };
  return f;
}
function iter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; }

vm.createContext(sandbox);
['config', 'db', 'log', 'notify', 'setup', 'autofill', 'detect', 'ask', 'batch', 'webhook', 'backup', 'diagnose', 'switchbot'].forEach(f => {
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
const isTrueLike = v => v === true || String(v).toLowerCase() === 'true';

console.log('\n=== T1 台帳生成 ===');
run('initSheets()');
check('12シート生成', book.sheets.length === 12, book.sheets.map(s => s.name));
check('S1に4名', rows('STAFF').length === 4);
check('S3のCHK001が有効', run(`String(checkById_('CHK001')['有効'])`) === 'true');
check('S3のCHK101は無効', run(`String(checkById_('CHK101')['有効'])`) === 'false');
check('S8にmorning_batch_hour=10', run(`getSetting('morning_batch_hour')`) === '10');
run('initSheets()');
check('再実行しても増えない（冪等）', rows('STAFF').length === 4 && book.sheets.length === 12);

console.log('\n=== T2 登録コードによる本人確認と紐付け ===');
props.LINE_CHANNEL_TOKEN = 'dummy-token';
const post = (events, key = 'k123') => run(`doPost(${JSON.stringify({ parameter: { k: '__KEY__' }, postData: { contents: JSON.stringify({ events }) } })})`.replace('__KEY__', key));

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
check('推定で埋まった服薬確認はもう質問されない', !d2.some(g => g.check_id === 'CHK106'), d2);
check('データが無い在否確認は質問として残る', d2.some(g => g.check_id === 'CHK101'), d2);
pushes.length = 0;
console.log('  morningBatch（支援記録あり） → ' + run('morningBatch()'));
check('Stage1は藤原・服部の2名にまとめて送信', pushes.length === 2 && pushes.map(p => p.to).sort().join() === 'U_FUJI,U_HATT', pushes.map(p => p.to));
check('在否確認の不足がS5に登録', rows('GAP').some(g => g.check_id === 'CHK101' && g.対象 === 'TEST01'));
// 服薬確認は推定で埋まって質問が消えるため、同じ利用者・同じ日の別の不足を使って
// 「参照ログが質問に添えられるか」だけを確認する
const medGap = rows('GAP').find(g => g.対象 === 'TEST01');
const medMsgs = run(`buildQuestion_({task_id:'TSKX'}, findRow(SHEETS.GAP,{'gap_id':'${medGap.gap_id}'}), checkById_('CHK106'), 0)`);
check('服薬確認の質問に開放ログが判断材料として添えられる',
  JSON.stringify(medMsgs).indexOf('服薬ボックス開放：開放を検知') > 0, medMsgs);
check('参照ログが無い項目には余計な情報を付けない',
  run(`buildQuestion_({task_id:'TSKX'}, findRow(SHEETS.GAP,{'gap_id':'${medGap.gap_id}'}), checkById_('CHK101'), 0)`).length === 1);
pushes.length = 0;
console.log('  nightBatch → ' + run('nightBatch()'));
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
  rows('LOG_IMPORT').filter(l => String(l.取込元) === 'switchbot-poll').map(l => l.値));
check('電池残量が少ない機器を警告する',
  rows('RUN_LOG').some(r => String(r.結果) === '警告' && String(r.詳細).indexOf('電池残量') > 0));

// SwitchBotのWebhook（服薬ボックスが開いた）
const sbHook = { eventType: 'changeReport', eventVersion: '1', context: {
  deviceType: 'WoContact', deviceMac: 'C0DEB7260F48', openState: 'open', detectionState: 'DETECTED', battery: 100 } };
const hookRes = run(`doPost(${JSON.stringify({ parameter: { k: 'k123' }, postData: { contents: JSON.stringify(sbHook) } })})`);
check('SwitchBotのWebhookを受け取る', String(hookRes.text) === 'OK:1', hookRes);
check('機器マスタのMACで利用者に紐付く',
  rows('LOG_IMPORT').some(l => String(l.取込元) === 'switchbot-webhook' && String(l.対象種別) === 'raw_switchbot'));
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

run('installTriggers()');
check('トリガーを登録（SwitchBot設定時は6本）',
  sandbox.__triggers.length === 6 && sandbox.__triggers.indexOf('switchbotPoll') >= 0, sandbox.__triggers);
// 「WEBHOOK_SECRET未設定なので拒否した」は、fail-closeの検証で意図的に出したエラー
const unexpectedErrors = rows('RUN_LOG').filter(r => r.結果 === 'エラー' &&
  String(r.詳細).indexOf('WEBHOOK_SECRET が未設定') < 0);
check('想定外のエラーがS10に無い', unexpectedErrors.length === 0,
  unexpectedErrors.map(r => r.処理名 + ': ' + r.詳細));

console.log('\n================ 結果: ' + (failures ? failures + '件 NG' : 'すべてOK') + ' ================\n');
process.exit(failures ? 1 : 0);
