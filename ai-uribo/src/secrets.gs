/**
 * 秘密情報の入力（スクリプトプロパティを画面から設定する）
 *
 * 【なぜ要るか】
 * LINEのトークンなどは「プロジェクトの設定 → スクリプトプロパティ」に、
 * キー名を一字一句正しく手入力する必要がある。ここは配置作業でいちばん間違えやすく、
 * 打ち間違えても「動かない」としか分からない（キー名が違うだけで全拒否になる）。
 *
 * メニューから貼り付けるだけにして、キー名の打ち間違いを起こしようがなくする。
 * Webhook用の秘密キーは、そもそも人が考えなくてよいので自動で作る。
 *
 * 【秘密情報の扱い】
 * 値はスクリプトプロパティにだけ保存する。台帳にもログにも書かない。
 * このファイルの中でも、ログに出すのは「設定した／しなかった」だけにしてある。
 */

/** 自動生成する秘密キーの長さ @type {number} */
var GENERATED_SECRET_LENGTH = 24;

/**
 * 推測されにくい文字列を作る（Webhook用の秘密キーなど）。
 * @return {string} 秘密キー
 */
function makeSecret_() {
  var chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var s = '';
  for (var i = 0; i < GENERATED_SECRET_LENGTH; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

/**
 * 秘密情報をまとめて設定する。
 *
 * @param {Object} values {token:..., channelSecret:..., webhookSecret:..., apiSecret:...}
 *                        空欄のものは変更しない。webhookSecret に '自動' を渡すと自動生成する
 * @return {{設定:Array.<string>, 変更なし:Array.<string>, webhookSecret:string}} 結果
 */
function setSecrets(values) {
  var proc = 'setSecrets';
  var props = PropertiesService.getScriptProperties();
  var v = values || {};
  var done = [];
  var skipped = [];

  var put = function (key, value) {
    var text = String(value || '').trim();
    if (!text) { skipped.push(key); return; }
    props.setProperty(key, text);
    done.push(key);
  };

  put(PROP.TOKEN, v.token);
  put(PROP.SECRET, v.channelSecret);

  // Webhookの秘密キーは人が考える必要がないので、無ければ作る
  var webhook = String(v.webhookSecret || '').trim();
  if (webhook === '自動' || (!webhook && !props.getProperty(PROP.WEBHOOK_KEY))) {
    webhook = makeSecret_();
  }
  put(PROP.WEBHOOK_KEY, webhook);
  put('API_SECRET', v.apiSecret);

  // 値そのものは絶対に残さない（何を設定したかだけ）
  logInfo(proc, '設定: ' + (done.join('・') || 'なし') + ' / 変更なし: ' + (skipped.join('・') || 'なし'));
  return { 設定: done, 変更なし: skipped, webhookSecret: String(props.getProperty(PROP.WEBHOOK_KEY) || '') };
}

/**
 * Webhookの秘密キーを作り直す。
 *
 * この鍵は、ウェブアプリURLの末尾に付けて「LINE以外からの投稿を弾く」ためのもの。
 * 画面に一度表示されるので、うっかり人に見せてしまうことがある。
 * その場合は作り直せば、古い鍵での投稿は通らなくなる。
 *
 * ⚠ 作り直したら、**LINE DevelopersのWebhook URLと、AIハブのsecrets.yamlを
 *   新しい鍵に貼り替えるまで、外からの受け付けは止まる**（受け取らない方が安全なため）。
 * @return {string} 新しい鍵と、貼り替え先の案内
 */
function rotateWebhookSecret() {
  var proc = 'rotateWebhookSecret';
  var props = PropertiesService.getScriptProperties();
  var key = makeSecret_();
  props.setProperty(PROP.WEBHOOK_KEY, key);
  logInfo(proc, 'Webhook秘密キーを作り直しました（値はログに残しません）');

  // 保存してあるURLは古い鍵付き（…/exec?k=旧キー）なので、?以降を落としてから付け直す
  var saved = String(props.getProperty('WEBAPP_URL') || '');
  var base = saved ? saved.split('?')[0] : '＜ウェブアプリのURL＞';
  if (saved) props.setProperty('WEBAPP_URL', base + '?k=' + key);
  var url = base;
  return '新しいWebhook用の秘密キー：\n' + key + '\n\n'
    + '次の2か所を、新しいURLに貼り替えてください。貼り替えるまで受け付けは止まります。\n\n'
    + '① LINE Developers → Messaging API設定 → Webhook URL\n'
    + '　 ' + url + '?k=' + key + '\n\n'
    + '② AIハブ /config/secrets.yaml の ai_uribo_url\n'
    + '　 （同じURLに書き替えて、開発者ツール→YAMLの再読み込み）';
}

/**
 * メニューからWebhookの秘密キーを作り直す。
 * @return {void}
 */
function menuRotateWebhookSecret_() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.alert('Webhook秘密キーの作り直し',
    '鍵を新しくします。\n\n'
    + '貼り替えが済むまで、LINEからの操作とAIハブからの取り込みは止まります'
    + '（不正な投稿を受け取らないための動きです）。\n\n実行しますか？',
    ui.ButtonSet.OK_CANCEL);
  if (res !== ui.Button.OK) return;
  ui.alert('新しい秘密キー', rotateWebhookSecret(), ui.ButtonSet.OK);
}

/**
 * メニューから秘密情報を入力する。
 * @return {void}
 */
function menuSetSecrets_() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  var t = ui.prompt('秘密情報の設定（1/2）',
    'LINEのチャネルアクセストークン（長期）を貼り付けてください。\n'
    + 'LINE Developers → Messaging API設定 → チャネルアクセストークン\n\n'
    + '※空欄のままOKを押すと、いまの設定を変えません'
    + (props.getProperty(PROP.TOKEN) ? '（現在：設定済み）' : '（現在：未設定）'),
    ui.ButtonSet.OK_CANCEL);
  if (t.getSelectedButton() !== ui.Button.OK) return;

  var s = ui.prompt('秘密情報の設定（2/2）',
    'チャネルシークレットを貼り付けてください（任意）。\n'
    + 'LINE Developers → チャネル基本設定 → チャネルシークレット\n\n'
    + '※分からなければ空欄のままOKで構いません',
    ui.ButtonSet.OK_CANCEL);
  if (s.getSelectedButton() !== ui.Button.OK) return;

  var r = setSecrets({
    token: String(t.getResponseText()),
    channelSecret: String(s.getResponseText())
  });

  var url = props.getProperty('WEBAPP_URL') || '＜ウェブアプリのURL＞';
  ui.alert('秘密情報を設定しました',
    '設定：' + (r.設定.join('・') || 'なし') + '\n'
    + '変更なし：' + (r.変更なし.join('・') || 'なし') + '\n\n'
    + '【Webhook用の秘密キーは自動で作りました】\n'
    + r.webhookSecret + '\n\n'
    + 'LINE DevelopersのWebhook URLには、ウェブアプリのURLの末尾に\n'
    + '?k=' + r.webhookSecret + '\n'
    + 'を付けたものを貼ってください。\n'
    + '例）' + url + '?k=' + r.webhookSecret + '\n\n'
    + '※この画面を閉じるともう一度は表示されません。'
    + '必要ならこのままコピーしておいてください（あとで確認する場合は'
    + 'プロジェクトの設定→スクリプトプロパティ→WEBHOOK_SECRET）。',
    ui.ButtonSet.OK);
}

/**
 * ウェブアプリのURLを控える（SwitchBotのWebhook自動登録と、上の案内文に使う）。
 * @return {void}
 */
function menuSetWebappUrl_() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('ウェブアプリURLの登録',
    'デプロイで表示されたURL（/exec で終わるもの）を貼り付けてください。\n'
    + '?k= は付けても付けなくても構いません。',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;

  var url = String(res.getResponseText()).trim().split('?')[0];
  if (url.indexOf('/exec') < 0) {
    ui.alert('URLの形が違うようです', '/exec で終わるURLを貼り付けてください。', ui.ButtonSet.OK);
    return;
  }
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(PROP.WEBHOOK_KEY) || '';
  props.setProperty('WEBAPP_URL', url + (key ? '?k=' + key : ''));
  logInfo('menuSetWebappUrl_', 'ウェブアプリURLを登録しました（URL自体はログに残しません）');
  ui.alert('登録しました',
    'LINE DevelopersのWebhook URLには、次をそのまま貼ってください。\n\n'
    + url + (key ? '?k=' + key : '') + '\n\n'
    + '（SwitchBotのWebhook自動登録にも、このURLを使います）',
    ui.ButtonSet.OK);
}
