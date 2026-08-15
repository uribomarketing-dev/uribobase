/**
 * SwitchBot 連携（Open API v1.1）
 *
 * 【役割】
 * センサーの現在値と変化イベントを取り込み、S4に生ログとして残す。
 * そこから先（記録への反映）は autofill.gs が担当する。
 *
 * 【2つの経路】
 *   ・ポーリング：switchbotPoll() が毎朝9:50に全機器の状態を取得（温湿度・施錠・電力など）
 *   ・Webhook   ：SwitchBotから変化した瞬間にPOSTが飛ぶ（開閉・人感・施錠など時刻が要るもの）
 *
 * 【使い始めるまで】
 *   1. スクリプトプロパティに SWITCHBOT_TOKEN / SWITCHBOT_SECRET を入れる
 *   2. switchbotSyncDevices() を実行 → S12_機器マスタに全機器が並ぶ
 *   3. S12で「拠点・対象user_code・用途種別」を埋める（ここが人の作業）
 *   4. switchbotSetupWebhook() を実行 → SwitchBot側にAI UriboのURLが登録される
 *
 * トークン・シークレットはスクリプトプロパティのみ。コード・シートには置かない。
 */

/** SwitchBot APIのベースURL @type {string} */
var SWITCHBOT_API = 'https://api.switch-bot.com/v1.1';

/**
 * 用途種別 → S4に書く生ログの種別・項目名。
 * S12_機器マスタの「用途種別」列にこのキーを書くと、その機器のデータが対応する形で入る。
 * @type {Object.<string,{種別:string, 項目名:string, 説明:string}>}
 */
var SWITCHBOT_ROLES = {
  '服薬ボックス': { 種別: 'raw_switchbot', 項目名: '服薬', 説明: '服薬ボックスに付けた開閉センサー' },
  '玄関': { 種別: 'raw_door', 項目名: '開閉', 説明: '玄関の開閉センサー（外出・帰宅）' },
  '居室ドア': { 種別: 'raw_door', 項目名: '開閉', 説明: '居室の開閉センサー（在否）' },
  '人感': { 種別: 'raw_motion', 項目名: '人感', 説明: '人感・Presenceセンサー' },
  '温湿度': { 種別: 'raw_meter', 項目名: '温湿度', 説明: '温湿度計・CO2計・Hub2' },
  '施錠': { 種別: 'raw_lock', 項目名: '施錠', 説明: 'スマートロック' },
  '家電': { 種別: 'raw_plug', 項目名: '家電', 説明: 'プラグミニ・リレースイッチ' },
  '漏水': { 種別: 'raw_leak', 項目名: '漏水', 説明: '漏水センサー' }
};

/**
 * SwitchBot APIの認証ヘッダーを作る（v1.1の署名方式）。
 * @return {Object.<string,string>} ヘッダー
 */
function switchbotHeaders_() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SWITCHBOT_TOKEN');
  var secret = props.getProperty('SWITCHBOT_SECRET');
  if (!token || !secret) {
    throw new Error('スクリプトプロパティ SWITCHBOT_TOKEN / SWITCHBOT_SECRET が未設定です');
  }
  var t = String(new Date().getTime());
  var nonce = Utilities.getUuid();
  var sign = Utilities.base64Encode(
    Utilities.computeHmacSha256Signature(token + t + nonce, secret)
  );
  return {
    'Authorization': token,
    'sign': sign,
    't': t,
    'nonce': nonce
  };
}

/**
 * SwitchBot APIを呼ぶ。
 * @param {string} path /devices などのパス
 * @param {string} [method] GET / POST
 * @param {Object} [payload] POST時の本文
 * @return {Object|null} body部分（失敗時はnull）
 */
function switchbotFetch_(path, method, payload) {
  var proc = 'switchbotFetch_';
  return safely_(proc, function () {
    var options = {
      method: method || 'get',
      headers: switchbotHeaders_(),
      contentType: 'application/json; charset=utf8',
      muteHttpExceptions: true
    };
    if (payload) options.payload = JSON.stringify(payload);
    var res = UrlFetchApp.fetch(SWITCHBOT_API + path, options);
    var json = JSON.parse(res.getContentText());
    if (Number(json.statusCode) !== 100) {
      logWarn(proc, path + ' が失敗: ' + res.getContentText().substring(0, 200));
      return null;
    }
    return json.body;
  }, null);
}

/**
 * 機器一覧を取得してS12_機器マスタに反映する。
 * 既にある行の「拠点・対象user_code・用途種別」は上書きしない（人が埋めた設定を守る）。
 * @return {string} 実行サマリ
 */
function switchbotSyncDevices() {
  var proc = 'switchbotSyncDevices';
  return withLock_(proc, 60000, function () {
    logStart(proc);
    var body = switchbotFetch_('/devices');
    if (!body) return '取得に失敗しました（トークン・通信をご確認ください）';

    var known = {};
    findRows(SHEETS.DEVICE).forEach(function (r) { known[String(r['deviceId'])] = r; });

    var added = 0;
    (body.deviceList || []).forEach(function (d) {
      if (known[String(d.deviceId)]) return;
      appendRow(SHEETS.DEVICE, {
        'deviceId': String(d.deviceId),
        'deviceName': String(d.deviceName || ''),
        'deviceType': String(d.deviceType || ''),
        'deviceMac': '',
        '拠点': '',
        '対象user_code': '',
        '用途種別': guessRole_(String(d.deviceType || ''), String(d.deviceName || '')),
        '有効': false,          // 人が用途を確認してからONにする
        '備考': ''
      });
      added++;
    });

    // 赤外線リモコン等も一覧に出るが、記録には使わないので追加しない
    var summary = '機器 ' + (body.deviceList || []).length + '件を確認 / 新規追加 ' + added + '件。'
      + 'S12_機器マスタで拠点・対象user_code・用途種別を確認し、有効=TRUEにしてください';
    logInfo(proc, summary);
    return summary;
  }, function () { return '他の処理が実行中のためスキップ'; });
}

/**
 * 機器の種類と名前から用途種別を推測する（あくまで初期値。人が直す前提）。
 * @param {string} deviceType 機器種別
 * @param {string} deviceName 機器名
 * @return {string} 用途種別
 */
function guessRole_(deviceType, deviceName) {
  var n = deviceName;
  if (/服薬|薬/.test(n)) return '服薬ボックス';
  if (/玄関|entrance/i.test(n)) return '玄関';
  if (deviceType === 'Contact Sensor') return '居室ドア';
  if (deviceType === 'Motion Sensor' || deviceType === 'Presence Sensor') return '人感';
  if (/Meter|Hub 2|Hub 3/i.test(deviceType)) return '温湿度';
  if (/Lock/i.test(deviceType)) return '施錠';
  if (/Plug|Relay/i.test(deviceType)) return '家電';
  if (/Leak/i.test(deviceType)) return '漏水';
  return '';
}

/**
 * 有効な機器の現在値を取得してS4に生ログを書く（毎朝9:50・朝バッチの前）。
 * @return {string} 実行サマリ
 */
function switchbotPoll() {
  var proc = 'switchbotPoll';
  logStart(proc);
  var devices = findRows(SHEETS.DEVICE, function (r) {
    return isTrue_(r['有効']) && String(r['用途種別'] || '').trim();
  });
  if (!devices.length) {
    logInfo(proc, '有効な機器がありません（S12_機器マスタをご確認ください）');
    return '対象機器なし';
  }

  // 機器への問い合わせは鍵を持たずに済ませる。
  // ここで鍵を握ったまま6台ぶん通信すると、その間に届いた薬箱の開閉が
  // 「他の処理が実行中」で捨てられる（実際に8/14・8/15に取りこぼしていた）。
  var fetched = devices.map(function (d) {
    return {
      dev: d,
      st: safely_(proc + ':' + d['deviceName'], function () {
        return switchbotFetch_('/devices/' + encodeURIComponent(String(d['deviceId'])) + '/status');
      }, null)
    };
  });

  return withLock_(proc, 60000, function () {
    var date = todayStr_();
    var written = 0;
    var skippedDead = [];
    var unreadable = [];
    var battery = {};

    fetched.forEach(function (f) {
      var d = f.dev;
      var st = f.st;
      safely_(proc + ':' + d['deviceName'], function () {
        if (!st) { unreadable.push(String(d['deviceName']) + '（応答なし）'); return; }
        var role = SWITCHBOT_ROLES[String(d['用途種別'])];
        if (!role) return;

        if (st.battery !== undefined) battery[String(d['deviceId'])] = Number(st.battery);

        // 電池が尽きた機器は「値」を持っていても信用しない。
        // 止まったセンサーが返す「動きなし」は、動きが無かった証拠ではなく、
        // ただ測れていないだけ。これを材料にすると、夜勤の巡回を
        // 「していない」と読み違えたまま静かに記録が歪む。
        if (isDeadBattery_(st.battery)) {
          skippedDead.push(String(d['deviceName']) + '（電池' + st.battery + '%）');
          return;
        }

        var value = describeStatus_(String(d['用途種別']), st);
        if (!value) {
          // 黙って捨てない。何が返ってきたのかを残さないと、原因にたどり着けない
          unreadable.push(String(d['deviceName']) + '（読めた項目：' + statusKeys_(st) + '）');
          return;
        }

        // 前と同じ値なら書かない。毎時「状態:close」を積むと台帳が埋まるだけで、
        // 「いつ変わったか」が見えなくなる（見たいのは変化のほう）
        var srcId = 'switchbot-poll:' + String(d['deviceId']);
        if (value === lastPolledValue_(srcId, date)) return;

        appendRow(SHEETS.LOG_IMPORT, {
          'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
          '発生日': date,
          '対象種別': role.種別,
          '対象': String(d['対象user_code'] || d['拠点'] || 'ALL'),
          '項目名': role.項目名,
          '値': value,
          '取込元': srcId,
          '取込日時': nowStr_()
        });
        written++;
      });
    });

    rememberBattery_(battery);
    if (skippedDead.length) {
      logWarn(proc, '電池切れのため材料に使いませんでした：' + skippedDead.join('、'));
    }
    if (unreadable.length) {
      logWarn(proc, '状態を記録できませんでした：' + unreadable.join('、'));
    }
    var summary = '機器 ' + devices.length + '件を確認 / 記録 ' + written + '件（変化があった分だけ）'
      + (skippedDead.length ? ' / 電池切れで除外 ' + skippedDead.length + '件' : '')
      + (unreadable.length ? ' / 読めず ' + unreadable.length + '件' : '');
    logInfo(proc, summary);
    return summary;
  }, function () { return '他の処理が実行中のためスキップ'; });
}

/** 電池がこの割合以下なら、その機器の値は材料に使わない @type {number} */
var DEAD_BATTERY_PERCENT = 5;

/**
 * 電池が尽きているか。
 * @param {*} battery 電池残量（%）
 * @return {boolean} 尽きていればtrue
 */
function isDeadBattery_(battery) {
  if (battery === undefined || battery === null || battery === '') return false;
  var n = Number(battery);
  return !isNaN(n) && n <= DEAD_BATTERY_PERCENT;
}

/**
 * 状態に何が入っていたかを短く並べる（原因調査用。値そのものは載せない）。
 * @param {Object} st statusのbody
 * @return {string} 項目名を並べた文字列
 */
function statusKeys_(st) {
  var keys = [];
  for (var k in st) { if (Object.prototype.hasOwnProperty.call(st, k)) keys.push(k); }
  return keys.length ? keys.join('・') : 'なし';
}

/**
 * その取込元で最後に記録した値を返す（同じ値の書き足しを避けるため）。
 * @param {string} srcId 取込元（switchbot-poll:deviceId）
 * @param {string} date 対象日 YYYY-MM-DD
 * @return {string} 最後に記録した値（無ければ空文字）
 */
function lastPolledValue_(srcId, date) {
  var rows = findRows(SHEETS.LOG_IMPORT, function (r) {
    return String(r['取込元']) === srcId
      && (toDateStr_(r['発生日']) === date || toDateStr_(r['発生日']) === addDays_(date, -1));
  });
  if (!rows.length) return '';
  var last = rows[rows.length - 1];
  return String(last['値'] || '');
}

/**
 * 電池残量を覚えておく（自己点検が朝にまとめて知らせるため）。
 * 毎時LINEで知らせると通知だらけになるので、ここでは記録するだけにする。
 * @param {Object.<string,number>} battery deviceId→残量%
 * @return {void}
 */
function rememberBattery_(battery) {
  safely_('rememberBattery_', function () {
    if (!battery) return;
    var props = PropertiesService.getScriptProperties();
    var prev = {};
    safely_('rememberBattery_', function () {
      prev = JSON.parse(props.getProperty('SWITCHBOT_BATTERY') || '{}');
    });
    for (var id in battery) {
      if (Object.prototype.hasOwnProperty.call(battery, id)) prev[id] = battery[id];
    }
    props.setProperty('SWITCHBOT_BATTERY', JSON.stringify(prev));
  });
}

/**
 * 電池が心もとない機器の一覧を返す（自己点検から呼ぶ）。
 * @param {number} [threshold] この割合以下を対象にする（既定20）
 * @return {Array.<{name:string, percent:number, dead:boolean}>} 機器の配列
 */
function lowBatteryDevices_(threshold) {
  var limit = threshold === undefined ? 20 : threshold;
  var map = safely_('lowBatteryDevices_', function () {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty('SWITCHBOT_BATTERY') || '{}');
  }, {}) || {};

  var out = [];
  findRows(SHEETS.DEVICE, function (r) { return isTrue_(r['有効']); }).forEach(function (d) {
    var id = String(d['deviceId']);
    if (map[id] === undefined) return;
    var pct = Number(map[id]);
    if (isNaN(pct) || pct > limit) return;
    out.push({ name: String(d['deviceName']), percent: pct, dead: isDeadBattery_(pct) });
  });
  out.sort(function (a, b) { return a.percent - b.percent; });
  return out;
}

/**
 * 取得した状態を、人が読める1行にまとめる。
 * @param {string} role 用途種別
 * @param {Object} st statusのbody
 * @return {string} 記録する値
 */
function describeStatus_(role, st) {
  switch (role) {
    case '温湿度':
      var parts = [];
      if (st.temperature !== undefined) parts.push('室温' + st.temperature + '℃');
      if (st.humidity !== undefined) parts.push('湿度' + st.humidity + '%');
      if (st.CO2 !== undefined) parts.push('CO2 ' + st.CO2 + 'ppm');
      if (st.lightLevel !== undefined) parts.push('明るさ' + st.lightLevel);
      return parts.join('・');
    case '施錠':
      return (st.lockState === 'LOCKED' ? '施錠されている' : st.lockState === 'JAMMED' ? '異常（引っかかり）' : '解錠されている')
        + (st.doorState ? '／ドア:' + st.doorState : '');
    case '家電':
      return (st.power ? '電源' + st.power : '')
        + (st.weight !== undefined ? ' 消費電力' + st.weight + 'W' : '')
        + (st.electricityOfDay !== undefined ? ' 本日の通電' + st.electricityOfDay + '分' : '');
    case '漏水':
      return Number(st.status) === 1 ? '漏水を検知' : '異常なし';
    case '玄関':
    case '居室ドア':
    case '服薬ボックス':
      return (st.openState ? '状態:' + st.openState : '') + (st.moveDetected ? '／動きあり' : '');
    case '人感':
      return (st.moveDetected || st.Detected) ? '動きを検知' : '動きなし';
    default:
      return '';
  }
}

/**
 * SwitchBot側にAI UriboのWebhook URLを登録する。
 * これを実行すると、開閉・人感・施錠などの変化がその場でAI Uriboに届くようになる。
 * @return {string} 実行結果
 */
function switchbotSetupWebhook() {
  var proc = 'switchbotSetupWebhook';
  var url = webhookUrl_();
  if (!url) return 'スクリプトプロパティ WEBAPP_URL（?k=付きのURL）を先に設定してください';

  var res = switchbotFetch_('/webhook/setupWebhook', 'post', {
    action: 'setupWebhook',
    url: url,
    deviceList: 'ALL'
  });
  var msg = res ? 'Webhookを登録しました' : '登録に失敗しました（URL・トークンをご確認ください）';
  logInfo(proc, msg);
  return msg;
}

/**
 * 登録済みのWebhook設定を確認する。
 * @return {string} 現在の設定
 */
function switchbotQueryWebhook() {
  var proc = 'switchbotQueryWebhook';
  var res = switchbotFetch_('/webhook/queryWebhook', 'post', { action: 'queryUrl' });
  if (!res) {
    logWarn(proc, '登録先を取得できませんでした（トークン・通信をご確認ください）');
    return '登録先を取得できませんでした（トークン・通信をご確認ください）';
  }

  var urls = (res.urls || []).map(String);
  var mine = webhookUrl_();
  var match = mine && urls.some(function (u) { return u === mine; });

  // 秘密キー（?k=）は台帳にも画面にも出さない。合っているかどうかだけを言う
  var text = urls.length
    ? '登録あり ' + urls.length + '件 / このAI Uriboと' + (match ? '一致しています' : '一致していません')
    : 'まだ登録されていません';
  logInfo(proc, text);

  return text + '\n\n'
    + (match
      ? '登録は正しく入っています。それでも通知が届かないときは、SwitchBot側から見て\n'
        + 'このURLに届いていない（GASが転送で応答するため）可能性があります。\n'
        + 'その場合は薬箱の開閉を材料にできないので、服薬は質問でお答えいただく形になります。'
      : 'メニュー「SwitchBotのWebhookを登録」を押すと登録し直せます。');
}

/**
 * メニューからWebhookの登録先を確認する。
 * @return {void}
 */
function menuQueryWebhook_() {
  SpreadsheetApp.getUi().alert('SwitchBotのWebhook', switchbotQueryWebhook(),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * このウェブアプリのURL（?k=付き）を返す。
 * @return {string} URL（未設定なら空文字）
 */
function webhookUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || '').trim();
}

/**
 * SwitchBotのWebhookイベントをS4に取り込む（webhook.gs の doPost から呼ばれる）。
 * @param {Object} body リクエスト本文（eventType / context を含む）
 * @return {number} 取り込んだ件数
 */
function ingestSwitchbotWebhook_(body) {
  var proc = 'ingestSwitchbotWebhook_';
  var ctx = body.context || {};
  var mac = String(ctx.deviceMac || '');
  if (!mac) return 0;

  return withLock_(proc, 60000, function () {
    // deviceMac から機器を探す（S12でMACを埋めていない場合は deviceId でも照合）
    var dev = findRow(SHEETS.DEVICE, function (r) {
      var m = String(r['deviceMac'] || '').replace(/:/g, '').toUpperCase();
      return m && m === mac.replace(/:/g, '').toUpperCase();
    }) || findRow(SHEETS.DEVICE, function (r) {
      return String(r['deviceId'] || '').replace(/:/g, '').toUpperCase() === mac.replace(/:/g, '').toUpperCase();
    });

    if (!dev) {
      logWarn(proc, '未登録の機器からの通知: ' + mac + '（S12_機器マスタにMACを登録してください）');
      return 0;
    }
    if (!isTrue_(dev['有効'])) return 0;

    var role = SWITCHBOT_ROLES[String(dev['用途種別'])];
    if (!role) return 0;

    // 夜間の検知は項目名を分けておく（夜間巡回・就寝確認の材料にするため）
    var hour = parseInt(Utilities.formatDate(new Date(), TZ, 'H'), 10);
    var isNight = (hour >= 22 || hour < 5);
    var itemName = role.項目名;
    if ((role.種別 === 'raw_door' || role.種別 === 'raw_motion') && isNight) itemName = '夜間' + itemName;

    // 深夜0〜5時の出来事は「前の晩」の記録として扱う。
    // 日付で切ってしまうと、夜勤者が入っていた晩の出来事が翌日の記録に付き、
    // 「その晩どうだったか」を見たときに抜けて見える（夜勤の記録がいちばん問われるところ）
    var eventDate = (hour < 5) ? addDays_(todayStr_(), -1) : todayStr_();

    var srcId = 'switchbot-webhook:' + String(dev['deviceId']);
    var value = describeWebhook_(ctx) + '（' + Utilities.formatDate(new Date(), TZ, 'HH:mm')
      + (hour < 5 ? '・翌' + Utilities.formatDate(new Date(), TZ, 'M/d') + '未明' : '') + '）';

    // 同じ通知が二重に入るのを防ぐ。
    // GASはPOSTに転送で応答するため、SwitchBot側が「届かなかった」と見て
    // もう一度送ってくることがある（実際に「開閉：open（10:55）」が2行入っていた）。
    // 同じ機器・同じ分・同じ内容なら、それは同じ出来事とみなす。
    if (sameWebhookExists_(srcId, eventDate, value)) {
      logInfo(proc, String(dev['deviceName']) + ' の通知は同じものが既にあるため記録しません');
      return 0;
    }

    appendRow(SHEETS.LOG_IMPORT, {
      'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
      '発生日': eventDate,
      '対象種別': role.種別,
      '対象': String(dev['対象user_code'] || dev['拠点'] || 'ALL'),
      '項目名': itemName,
      '値': value,
      '取込元': srcId,
      '取込日時': nowStr_()
    });
    logInfo(proc, String(dev['deviceName']) + ' の通知を記録');

    // 漏水は待てないので即通知
    if (String(dev['用途種別']) === '漏水' && Number(ctx.detectionState) === 1) {
      sendToEscalationStaff([msgText_('【漏水を検知】' + String(dev['deviceName'])
        + '（' + String(dev['拠点']) + '）\n至急ご確認ください。')], proc);
    }
    return 1;
  }, function () { return 0; });
}

/**
 * 同じ通知が既にS4に入っているか。
 * @param {string} srcId 取込元（switchbot-webhook:deviceId）
 * @param {string} date 発生日 YYYY-MM-DD
 * @param {string} value 値
 * @return {boolean} 既にあればtrue
 */
function sameWebhookExists_(srcId, date, value) {
  return findRows(SHEETS.LOG_IMPORT, function (r) {
    return String(r['取込元']) === srcId
      && toDateStr_(r['発生日']) === date
      && String(r['値']) === value;
  }).length > 0;
}

/**
 * Webhookの中身を人が読める1行にする。
 * @param {Object} ctx context部分
 * @return {string} 説明文
 */
function describeWebhook_(ctx) {
  if (ctx.openState) return '開閉：' + ctx.openState;
  if (ctx.detectionState !== undefined) {
    return String(ctx.detectionState) === 'DETECTED' ? '検知あり'
      : Number(ctx.detectionState) === 1 ? '漏水を検知'
      : '検知なし';
  }
  if (ctx.lockState) return '施錠状態：' + ctx.lockState;
  if (ctx.powerState) return '電源：' + ctx.powerState;
  if (ctx.temperature !== undefined) return '室温' + ctx.temperature + '℃／湿度' + ctx.humidity + '%';
  if (ctx.press) return '呼び出しボタンが押された';
  return JSON.stringify(ctx).substring(0, 120);
}
