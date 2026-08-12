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
  return withLock_(proc, 120000, function () {
    logStart(proc);
    var devices = findRows(SHEETS.DEVICE, function (r) {
      return isTrue_(r['有効']) && String(r['用途種別'] || '').trim();
    });
    if (!devices.length) {
      logInfo(proc, '有効な機器がありません（S12_機器マスタをご確認ください）');
      return '対象機器なし';
    }

    var date = todayStr_();
    var written = 0;
    devices.forEach(function (d) {
      safely_(proc + ':' + d['deviceName'], function () {
        var st = switchbotFetch_('/devices/' + encodeURIComponent(String(d['deviceId'])) + '/status');
        if (!st) return;
        var role = SWITCHBOT_ROLES[String(d['用途種別'])];
        if (!role) return;
        var value = describeStatus_(String(d['用途種別']), st);
        if (!value) return;
        appendRow(SHEETS.LOG_IMPORT, {
          'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
          '発生日': date,
          '対象種別': role.種別,
          '対象': String(d['対象user_code'] || d['拠点'] || 'ALL'),
          '項目名': role.項目名,
          '値': value,
          '取込元': 'switchbot-poll:' + String(d['deviceId']),
          '取込日時': nowStr_()
        });
        written++;
        // 電池切れの予兆は先に知らせる（現場が困る前に）
        if (st.battery !== undefined && Number(st.battery) <= 20) {
          logWarn(proc, String(d['deviceName']) + ' の電池残量が ' + st.battery + '%');
        }
      });
    });
    var summary = '機器 ' + devices.length + '件を取得 / 記録 ' + written + '件';
    logInfo(proc, summary);
    return summary;
  }, function () { return '他の処理が実行中のためスキップ'; });
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
  var res = switchbotFetch_('/webhook/queryWebhook', 'post', { action: 'queryUrl' });
  var text = res ? JSON.stringify(res) : '取得できませんでした';
  logInfo('switchbotQueryWebhook', text);
  return text;
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

  return withLock_(proc, 30000, function () {
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

    appendRow(SHEETS.LOG_IMPORT, {
      'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
      '発生日': todayStr_(),
      '対象種別': role.種別,
      '対象': String(dev['対象user_code'] || dev['拠点'] || 'ALL'),
      '項目名': itemName,
      '値': describeWebhook_(ctx) + '（' + Utilities.formatDate(new Date(), TZ, 'HH:mm') + '）',
      '取込元': 'switchbot-webhook:' + String(dev['deviceId']),
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
