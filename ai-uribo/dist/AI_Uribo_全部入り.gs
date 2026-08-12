/**
 * AI Uribo 全部入り（GAS貼り付け用）
 *
 * このファイルは tools/bundle.js が src/*.gs から自動生成しています。
 * **ここを直接編集しないでください。**直すのは src/ の各ファイルです。
 *
 * 使い方：GASエディタにスクリプトを1つ作り、このファイルの中身を全文貼り付けるだけ。
 * （appsscript.json だけは別途、プロジェクトの設定から差し替えてください）
 *
 * 収録: 20ファイル
 */

// ============================================================================
// config.gs
// ============================================================================

/**
 * AI Uribo 共通設定・定数定義
 *
 * 仕様書 02_データスキーマ.md / 08_Phase2チェック項目案.md v1.1 準拠。
 * シート名・ヘッダー・初期データはすべてここで一元管理する。
 * （個別の判定ルールはここに書かず、S3チェック項目マスタと detect.gs で管理する）
 */

/** タイムゾーン @type {string} */
var TZ = 'Asia/Tokyo';

/** シート名の定義 @type {Object.<string,string>} */
var SHEETS = {
  STAFF: 'S1_スタッフマスタ',
  USER: 'S2_利用者マスタ',
  CHECK: 'S3_チェック項目マスタ',
  LOG_IMPORT: 'S4_実績ログ取込',
  GAP: 'S5_不足検出結果',
  TASK: 'S6_確認タスク回答ログ',
  FILL: 'S7_補完台帳',
  SETTING: 'S8_設定',
  NAME_MAP: 'S9_対応表',
  RUN_LOG: 'S10_実行ログ',
  SHIFT_PLAN: 'S11_勤務予定',
  DEVICE: 'S12_機器マスタ',
  LEARN: 'S13_学習ログ'
};

/**
 * 全シートの定義（シート名・ヘッダー・備考）。
 * initSheets() がこの定義どおりにシートを生成する。
 * @type {Array.<{name:string, headers:Array.<string>, note:string}>}
 */
var SHEET_DEFS = [
  {
    name: SHEETS.STAFF,
    headers: ['staff_id', '氏名', 'line_user_id', '役割', '拠点', 'エスカレーション先フラグ', '有効', '登録コード'],
    note: 'スタッフマスタ。登録コードを本人に個別に伝え、LINEで送ってもらうことで紐付ける（なりすまし防止）'
  },
  {
    name: SHEETS.USER,
    headers: ['user_code', '拠点', '自動ログ対応', '服薬自動', '在否自動', '日中自動', '有効'],
    note: '利用者マスタ。氏名は置かない（S9対応表で管理）'
  },
  {
    name: SHEETS.CHECK,
    headers: ['check_id', '対象種別', '項目名', '判定ルールID', '確認先役割', '優先度', '質問文', '選択肢', '有効', '参照ログ', '検出キーワード'],
    note: '何を記録すべきかの定義。質問文・選択肢もここで管理しコードに埋め込まない。'
        + '参照ログ＝質問に添える補助情報のS4項目名（例：服薬ボックス開放）。'
        + '自動データを「支援の記録」の代わりにせず、支援を判断する材料として見せるための欄'
  },
  {
    name: SHEETS.LOG_IMPORT,
    headers: ['log_id', '発生日', '対象種別', '対象', '項目名', '値', '取込元', '取込日時', '確度', '推定回答'],
    note: '既存アプリ・自動ソースからのログ取込先。対象種別=plan は予定ログ。'
        + '確度＝確定（人の回答・事実のログ）／推定（データからの推測。人にも確認する）／'
        + '自動確定（推定だが精度が実績で確かめられたので確認を省いている）。'
        + '推定回答＝AIが「たぶんこの選択肢だろう」と読んだ答え。人の回答と突き合わせてS13学習ログに精度を貯める'
  },
  {
    name: SHEETS.GAP,
    headers: ['gap_id', '対象日', 'check_id', '対象', '状態', '検出日時', '一次確認先staff_id', '完了日時'],
    note: '不足検出結果。状態＝検出/確認中/回答済/エスカレーション中/完了'
  },
  {
    name: SHEETS.TASK,
    headers: ['task_id', 'gap_id', '送信先staff_id', '送信日時', '回答', '回答日時', '回答方法',
              '送信本文', '送信状態', '再送回数', '追記待ち', 'セットid', '並び順', 'retry_key', '作成日時'],
    note: '確認タスク・回答ログ兼LINE送信キュー。送信状態＝待機/キュー/送信済/失敗/中止。'
        + 'retry_keyはLINEの重複送信防止キー（同じ内容の再送では必ず同じ値を使う）'
  },
  {
    name: SHEETS.FILL,
    headers: ['fill_id', '対象日', '対象', '項目名', '値', '記入者staff_id', '取込済フラグ', '作成日時',
              'gap_id', '情報源', '要精査', '精査結果'],
    note: '補完台帳。既存アプリはここを読んで自分のDBに取り込む。gap_idは二重記録の防止に使う。'
        + '情報源＝本人回答/支援担当者の記録/支援担当者名＋管理者確認/自動ログ・自動推定。'
        + '要精査=TRUE は「データから推定して埋めたもの」。現場の人が見て直せるように印を付けてある。'
        + '精査結果＝空欄（まだ確かめていない）／一致（人の回答と同じだった）／訂正（違ったので人の回答で直した）'
  },
  {
    name: SHEETS.SETTING,
    headers: ['キー', '値', '説明'],
    note: '設定値。秘密情報は置かない（スクリプトプロパティを使用）'
  },
  {
    name: SHEETS.NAME_MAP,
    headers: ['コード', '氏名', '種別'],
    note: 'アクセス制限シート。LINE文面生成時のみ参照する'
  },
  {
    name: SHEETS.RUN_LOG,
    headers: ['日時', '処理名', '結果', '詳細'],
    note: '実行ログ。障害調査用'
  },
  {
    name: SHEETS.SHIFT_PLAN,
    headers: ['日付', 'staff_id', '拠点', '勤務区分', '開始時刻', '終了時刻', '取込元'],
    note: 'Stage2で使用。夜勤担当の特定と勤務開始1時間前送信に使う'
  },
  {
    name: SHEETS.DEVICE,
    headers: ['deviceId', 'deviceName', 'deviceType', 'deviceMac', '拠点', '対象user_code', '用途種別', '有効', '備考'],
    note: 'SwitchBot機器の台帳。switchbotSyncDevices()が機器を並べるので、'
        + '拠点・対象user_code・用途種別（服薬ボックス/玄関/居室ドア/人感/温湿度/施錠/家電/漏水）を'
        + '人が確認して有効=TRUEにする。deviceMacはアプリのデバイス情報から転記するとWebhookが紐付く'
  },
  {
    name: SHEETS.LEARN,
    headers: ['学習キー', '情報源', '項目名', '確認回数', '一致', '不一致', '正答率', '直近',
              '段階', '自動確定件数', '最終更新'],
    note: '学習ログ。「この自動ソースは、この項目について、どれくらい当たるか」の実績。'
        + 'AIが推定した答えと、人が実際に答えた内容を突き合わせて自動で貯まる。'
        + '段階＝確認中（毎回人にも聞く）／自動確定（実績十分なので聞かずに埋める）／要見直し（外れが増えたので必ず聞く）。'
        + '直近＝新しい順に○（当たり）×（外れ）。人が手で編集する必要はない'
  }
];

/**
 * S8設定の初期値。
 * 【08】v1.1に合わせ、朝10:00 / 夜21:00 / 日曜10:00週次ダイジェスト / 17:00エスカレーション廃止。
 * @type {Array.<Array.<string>>}
 */
var DEFAULT_SETTINGS = [
  ['morning_batch_hour', '10', '朝バッチの実行時刻（前日分の穴を確認）'],
  ['night_batch_hour', '21', '夜の確認セットの送信時刻（夜勤向け）'],
  ['weekly_digest_dow', '0', '週次ダイジェストの曜日（0=日曜）'],
  ['weekly_digest_hour', '10', '週次ダイジェストの送信時刻'],
  ['backup_hour', '3', 'バックアップの実行時刻'],
  ['shift_request_day', '20', 'シフト希望確認の送信開始日'],
  ['shift_deadline_day', '25', 'シフト希望の締切日'],
  ['quiet_start_hour', '22', '送信抑止（深夜帯）の開始時刻'],
  ['quiet_end_hour', '7', '送信抑止（深夜帯）の終了時刻'],
  ['stage', '1', '運用ステージ（1=まとめ回答/2=担当者ルーティング/3=完全自動）'],
  ['max_items_per_message', '3', '1通に載せる確認の最大件数'],
  ['backup_keep_days', '30', 'dailyバックアップの保持日数（月末分はmonthlyへ退避）'],
  ['backup_folder_name', 'AI_Uribo_Backup', 'バックアップ先フォルダ名'],
  ['line_retry_max', '3', 'LINE送信のリトライ回数'],
  ['digest_lookback_days', '7', '週次ダイジェストの集計対象日数'],
  ['stale_hours', '8', '確認中のまま何時間経過したら滞留とみなすか'],
  ['queue_expire_hours', '24', 'キュー・失敗分をこの時間を過ぎたら再送しない（LINEの重複防止キーの有効期間に合わせる）'],
  ['register_attempt_limit', '10', '登録コードの入力を1時間に何回まで許すか'],
  ['alert_keywords', '転倒,倒れ,うつ伏せ,座り込,出血,救急,発熱,嘔吐,痙攣,water leak',
   'AIまとめ等の文章にこの語が出たら、社員へすぐLINE通知する（カンマ区切り）'],
  ['test_mode', 'FALSE',
   'TRUEの間はLINEに実際には送らず、送信内容をS6に記録するだけ（設定作業中の誤送信防止）。運用開始時にFALSEへ'],
  ['switchbot_poll_hour', '9', 'SwitchBotの状態を取りに行く時刻（朝バッチの前）'],
  ['autofill_estimate', 'TRUE', 'データから推定できるものも積極的に埋めるか（FALSEにすると事実のログだけ埋める）'],
  ['learning_enabled', 'TRUE',
   'AIの推定と人の回答を突き合わせて精度を学習し、当たる項目は質問を省くか（FALSEにすると常に人に聞く）'],
  ['learn_min_samples', '8', '自動確定に切り替える前に、最低これだけ人の回答と突き合わせる'],
  ['learn_promote_rate', '0.9', 'この正答率以上なら「自動確定」に昇格（＝その質問をしなくなる）'],
  ['learn_demote_rate', '0.6', 'この正答率を下回ったら「要見直し」に降格（＝必ず人に聞く）'],
  ['learn_spotcheck_every', '20', '自動確定になった後も、この件数に1回は抜き打ちで人に確認する（精度の劣化に気づくため）'],
  ['selfcheck_hour', '8', '自己点検の実行時刻（朝バッチの前に、システム自身の状態を点検する）'],
  ['archive_enabled', 'TRUE', '古い行を「_保管」シートへ自動で移すか（台帳が重くなるのを防ぐ。消しはしない）'],
  ['archive_after_days', '180', '実績ログ・完了した不足・回答済みの確認を、何日過ぎたら保管へ移すか'],
  ['log_keep_days', '90', '実行ログを何日分手元に残すか'],
  ['sheet_warn_rows', '20000', 'この行数を超えたら自己点検で知らせる'],
  ['monthly_report_hour', '11', '月次まとめ（毎月1日・前月分）の実行時刻'],
  ['remind_after_hours', '20', 'お返事が無い確認を、何時間経ったらもう一度お送りするか'],
  ['remind_max', '2', '同じ確認をお送りし直す上限回数（これを超えたら催促せず、週次でまとめて社員へ）']
];

/** 学習の段階 @type {Object.<string,string>} */
var LEARN_STAGE = {
  LEARNING: '確認中',    // 推定で埋めるが、人にも確認する（突き合わせて実績を貯める段階）
  AUTO: '自動確定',      // 実績十分。推定で埋め、人には聞かない（抜き打ち確認は行う）
  REVIEW: '要見直し'     // 外れが増えた。推定で埋めるが必ず人に聞く
};

/** S4実績ログの確度 @type {Object.<string,string>} */
var CERTAINTY = {
  FIXED: '確定',        // 人の回答、または機械が直接観測した事実
  ESTIMATED: '推定',    // データからの推測。人にも確認する（＝不足として質問が出る）
  AUTO: '自動確定'      // 推定だが実績で確かめられているので確認を省く
};

/**
 * S1スタッフマスタの初期データ。
 * 岐部様は当面 有効=FALSE。兼崎様のフルネームは友だち追加時に確認して差し替える。
 * @type {Array.<Array.<string|boolean>>}
 */
var INITIAL_STAFF = [
  ['STF001', '藤原寛', '', '社員', '本部', true, true, ''],
  ['STF002', '服部俊喜', '', '社員', '清水', true, true, ''],
  ['STF003', '岐部紀美代', '', '社員', '本部', false, false, ''],
  ['STF004', '兼崎', '', '管理者', '本部', true, true, '']
];

/** 登録コードに使う文字（見間違えやすい 0/O/1/I/l を除く） @type {string} */
var REGISTRATION_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 登録コードの桁数 @type {number} */
var REGISTRATION_CODE_LENGTH = 8;

/**
 * S3チェック項目マスタの初期データ。
 * Phase1はR01（シフト希望）のみ有効。support/planはコードは動くがS3で無効化しておく（06 Step4）。
 * @type {Array.<Array.<string|boolean>>}
 */
var INITIAL_CHECKS = [
  // Phase1：シフト希望（R01）
  ['CHK001', 'shift', 'シフト希望回答', 'R01', '本人', 'A',
   '{月}分のシフト希望がまだ届いていません。締切は{締切日}です。今お答えいただけますか？',
   '今答える|後で（明日また聞いて）', true],

  // その日の夜勤担当者（1日1拠点につき1問。この回答が同じ日の全記録の「支援担当者」になる）
  ['CHK100', 'support', '夜勤担当者', 'R05', '社員', 'A',
   '{日付}の{対象}の夜勤担当者を教えてください。', '{夜勤スタッフ}', false],

  // Phase2：優先度A（監査対策・最優先）※Stage1で有効化する
  // ※質問文は「記録がありません」という詰問調を避け、事実を答えやすい聞き方にしてある。
  //   選択肢は「事実」と「わからない」を分け、推測で埋めさせない（運用・監査レビューの反映）。
  ['CHK101', 'support', '在否確認', 'R02', '夜勤', 'A',
   '{対象}さんは{日付}、ホームにいらっしゃいましたか？', '在宅|外泊・帰省|入院|わからない', false],
  ['CHK102', 'support', '夜間巡回・就寝確認', 'R02', '夜勤', 'A',
   '{対象}さんの{日付}夜（22時〜5時）の巡回・就寝確認について教えてください。',
   '複数回まわった|1回まわった|できなかった|わからない', false],
  ['CHK103', 'support', '支援内容', 'R02', '夜勤', 'A',
   '{対象}さんに{日付}行った支援があれば教えてください（声かけ・介助など）。',
   '支援あり（一言記入）|特記なし|わからない', false],
  ['CHK104', 'support', '利用者の状況', 'R02', '夜勤', 'A',
   '{対象}さんの{日付}のご様子はいかがでしたか？',
   '変わりなし|いつもと違う様子あり|わからない', false, '',
   '座り込,うつ伏せ,横になっ,倒れ,ふらつ,転倒,咳,発熱,嘔吐,不穏'],
  ['CHK105', 'support', '食事提供', 'R02', '夜勤', 'A',
   '{対象}さんへの{日付}の食事提供について教えてください（実費請求の根拠になります）。',
   '朝夕とも提供|朝のみ提供|夕のみ提供|提供なし', false, '',
   '食事,配膳,調理,炊飯,電子レンジ,食卓,食器,洗い物,冷蔵庫'],
  // センサーは「箱が開いた事実」を知らせるだけ。それを見て夜勤者が声かけをするのが実際の運用なので、
  // 開放ログは質問に添えるだけにして、記録そのものは人が答える（参照ログ列を使う）。
  ['CHK106', 'support', '服薬確認', 'R02', '夜勤', 'A',
   '{対象}さんの{日付}の服薬支援について教えてください。',
   '声かけ・確認をした|本人が自分で服薬（声かけ不要）|実施なし（一言記入）|わからない', false, '服薬ボックス開放',
   '服薬,薬を,内服'],
  ['CHK107', 'support', '緊急時・異常時対応', '-', '夜勤', 'A',
   '※検出対象外。「報告」コマンドで随時受け付ける', '', false],

  // Phase2：優先度B（Aが安定してから有効化）
  ['CHK111', 'support', '入浴', 'R02', '夜勤', 'B',
   '{対象}さんは{日付}、入浴されましたか？', '入浴した|清拭のみ|していない|わからない', false, '',
   '入浴,風呂,シャワー'],
  ['CHK112', 'support', '外出・帰宅時間', 'R02', '夜勤', 'B',
   '{対象}さんの{日付}の外出はありましたか？', '外出なし|外出あり（一言記入）|わからない', false, '',
   '外出,出かけ,帰宅,玄関を出'],
  ['CHK113', 'support', '日中活動', 'R02', '日勤', 'B',
   '{対象}さんは{日付}、日中活動に参加されましたか？', '参加した|休んだ（一言記入）|わからない', false],

  // 夜の確認セット：明日の予定（対象種別=plan）
  ['CHK201', 'plan', '予定_外出', 'R04', '本人', 'A', '{対象}さん、{日付}の外出の予定はありますか？', 'あり|なし|未定', false],
  ['CHK202', 'plan', '予定_通院', 'R04', '本人', 'A', '{対象}さん、{日付}の通院の予定はありますか？', 'あり|なし|未定', false],
  ['CHK203', 'plan', '予定_ラボ出勤', 'R04', '本人', 'A', '{対象}さん、{日付}のラボ出勤の予定はありますか？', 'あり|なし|未定', false],
  ['CHK204', 'plan', '予定_帰省', 'R04', '本人', 'A', '{対象}さん、{日付}の帰省・外泊の予定はありますか？', 'あり|なし|未定', false],
  ['CHK205', 'plan', '予定_食事', 'R04', '本人', 'A', '{対象}さん、{日付}の食事は必要ですか？', '朝夕とも必要|一部不要|不要', false]
];

/** スクリプトプロパティのキー名 @type {Object.<string,string>} */
var PROP = {
  TOKEN: 'LINE_CHANNEL_TOKEN',
  SECRET: 'LINE_CHANNEL_SECRET',
  WEBHOOK_KEY: 'WEBHOOK_SECRET',
  SPREADSHEET_ID: 'SPREADSHEET_ID'
};

/** 不足の状態 @type {Object.<string,string>} */
var GAP_STATUS = {
  DETECTED: '検出',
  ASKING: '確認中',
  ANSWERED: '回答済',
  ESCALATED: 'エスカレーション中',
  DONE: '完了'
};

/** 送信状態 @type {Object.<string,string>} */
var SEND_STATUS = {
  WAITING: '待機',   // 連続フローの順番待ち（まだ送っていない）
  QUEUED: 'キュー',  // 深夜帯のため保留（朝に送る）
  SENT: '送信済',
  TEST: 'テスト',   // test_mode中：実際には送らず内容だけ記録した
  FAILED: '失敗',
  CANCELED: '中止'   // 他の人が先に回答したので送らない
};

/**
 * 一言記述を追加で求める回答値。
 * これらを選んだ場合は、次に送られてくるテキストを回答に追記してから記録として成立させる。
 * @type {Array.<string>}
 */
var NEEDS_NOTE_ANSWERS = [
  'その他（名前を入力）',
  '未実施だった', 'できなかった', '実施なし（一言記入）', '支援あり（一言記入）', '記録あり（一言記入）',
  'いつもと違う様子あり', '対応あり', '外出あり（一言記入）', '外出あり', '休んだ（一言記入）', '休んだ',
  '一部不要', '入院', '外泊・帰省', '提供なし', '今答える'
];

/**
 * 追記を求めるときの案内文（回答値ごと）。指定が無ければ既定文を使う。
 * @type {Object.<string,string>}
 */
var NOTE_PROMPTS = {
  'その他（名前を入力）': 'ありがとうございます。その日の夜勤担当者のお名前を送ってください。',
  '今答える': 'ありがとうございます。希望をこのままメッセージで送ってください。\n（例：3日・10日休み希望、夜勤は週2まで）',
  'いつもと違う様子あり': 'ありがとうございます。どのようなご様子だったか、見たままを一言で教えてください。\n（例：37.5度の発熱、食事を残された）',
  '対応あり': 'ありがとうございます。どのような対応をされたか一言だけ教えてください。',
  '支援あり（一言記入）': 'ありがとうございます。行った支援を一言で教えてください。（例：入浴の声かけ、服薬の見守り）',
  '記録あり（一言記入）': 'ありがとうございます。内容を一言で教えてください。',
  '実施なし（一言記入）': 'ありがとうございます。実施できなかった理由を一言で教えてください。（例：本人が拒否、外出中）',
  'できなかった': 'ありがとうございます。できなかった理由を一言で教えてください。',
  '外出あり（一言記入）': 'ありがとうございます。外出先と帰宅時刻が分かれば一言で教えてください。',
  '休んだ（一言記入）': 'ありがとうございます。お休みの理由が分かれば一言で教えてください。',
  '提供なし': 'ありがとうございます。提供しなかった理由を一言で教えてください。（例：外泊、本人が不要と申し出）',
  '入院': 'ありがとうございます。差し支えなければ入院先・期間などを一言だけ教えてください。',
  '外泊・帰省': 'ありがとうございます。行き先・戻り予定が分かれば一言で教えてください。'
};

/** 追記を求めるときの既定の案内文 @type {string} */
var NOTE_PROMPT_DEFAULT = 'ありがとうございます。差し支えなければ状況を一言だけ教えてください（例：本人が拒否、外出中 など）。\n※特に無ければ「なし」と送ってください。';

/**
 * 不足解消とみなさず滞留させる回答値（04「わからない」の扱い）。
 * @type {Array.<string>}
 */
var UNKNOWN_ANSWERS = ['わからない', '未定'];

/**
 * コマンドとして扱う言葉。
 * 一言記述の追記待ちが残っている人がこれらを送っても、記録に混ぜずコマンドとして受け取る。
 * （「診断」「精度」などが台帳の一言欄に紛れ込むのを防ぐ）
 * @type {Array.<string>}
 */
var COMMAND_WORDS = ['状況', 'ヘルプ', 'まとめ', 'シフト', '精査', '精度', 'せいど', '診断', '報告', 'テスト実行'];

// ============================================================================
// db.gs
// ============================================================================

/**
 * シート読み書きの共通層（06 Step2）
 *
 * すべて列名（ヘッダー文字列）でアクセスする。列順が変わっても壊れないようにするため、
 * 他のファイルからシートの列番号を直接触らないこと。
 */

/**
 * 対象スプレッドシートを返す。
 * コンテナバインド（シートに紐づいたGASプロジェクト）ならそのシート、
 * スタンドアロンならスクリプトプロパティ SPREADSHEET_ID のシートを開く。
 * @return {Spreadsheet} スプレッドシート
 */
function book_() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  var id = PropertiesService.getScriptProperties().getProperty(PROP.SPREADSHEET_ID);
  if (!id) throw new Error('SPREADSHEET_ID が未設定です（スクリプトプロパティに設定してください）');
  return SpreadsheetApp.openById(id);
}

/**
 * シートオブジェクトを取得する。存在しない場合は例外。
 * @param {string} sheetName シート名
 * @return {Sheet} シート
 */
function sheet_(sheetName) {
  var sh = book_().getSheetByName(sheetName);
  if (!sh) throw new Error('シートがありません: ' + sheetName);
  return sh;
}

/**
 * 1回の実行中だけ有効なシート内容のキャッシュ。
 * 同じシートを何度も読み直すとGASの6分制限に当たりやすいため、
 * 読み込みは1実行につき1回にし、書き込み時にそのシートのキャッシュを捨てる。
 * @type {Object.<string,Object>}
 */
var TABLE_CACHE_ = {};

/**
 * 指定シート（省略時は全シート）のキャッシュを破棄する。
 * シートを直接 setValues などで書き換えたあとは必ず呼ぶこと。
 * @param {string} [sheetName] シート名
 * @return {void}
 */
function invalidateCache_(sheetName) {
  if (sheetName) delete TABLE_CACHE_[sheetName];
  else TABLE_CACHE_ = {};
}

/**
 * シート全体を読み、ヘッダーと行オブジェクト配列を返す（1実行内はキャッシュを使う）。
 * 各行オブジェクトには実シート行番号 _row を持たせる。
 * @param {string} sheetName シート名
 * @return {{headers:Array.<string>, rows:Array.<Object>}} 読み取り結果
 */
function readTable(sheetName) {
  if (TABLE_CACHE_[sheetName]) return TABLE_CACHE_[sheetName];
  var result = readTableFromSheet_(sheetName);
  TABLE_CACHE_[sheetName] = result;
  return result;
}

/**
 * シートを実際に読み込む（キャッシュを介さない）。
 * @param {string} sheetName シート名
 * @return {{headers:Array.<string>, rows:Array.<Object>}} 読み取り結果
 */
function readTableFromSheet_(sheetName) {
  var sh = sheet_(sheetName);
  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastCol === 0) return { headers: [], rows: [] };
  var values = sh.getRange(1, 1, Math.max(lastRow, 1), lastCol).getValues();
  var headers = values[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = { _row: i + 1 };
    var empty = true;
    for (var c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      obj[headers[c]] = values[i][c];
      if (values[i][c] !== '' && values[i][c] !== null) empty = false;
    }
    if (!empty) rows.push(obj);
  }
  return { headers: headers, rows: rows };
}

/**
 * 条件に合う行を返す。
 * @param {string} sheetName シート名
 * @param {Object|function(Object):boolean} [criteria] 列名→値の一致条件、または判定関数
 * @return {Array.<Object>} 条件に合う行オブジェクトの配列
 */
function findRows(sheetName, criteria) {
  var rows = readTable(sheetName).rows;
  if (!criteria) return rows;
  if (typeof criteria === 'function') return rows.filter(criteria);
  return rows.filter(function (r) {
    for (var k in criteria) {
      if (!criteria.hasOwnProperty(k)) continue;
      if (String(r[k]) !== String(criteria[k])) return false;
    }
    return true;
  });
}

/**
 * 条件に合う最初の1行を返す。
 * @param {string} sheetName シート名
 * @param {Object|function(Object):boolean} criteria 条件
 * @return {Object|null} 行オブジェクト（無ければnull）
 */
function findRow(sheetName, criteria) {
  var rows = findRows(sheetName, criteria);
  return rows.length ? rows[0] : null;
}

/**
 * 1行追加する。オブジェクトのキー（列名）を見てヘッダー順に並べ替えて書き込む。
 * @param {string} sheetName シート名
 * @param {Object} obj 列名→値
 * @return {number} 追加した行番号
 */
function appendRow(sheetName, obj) {
  var sh = sheet_(sheetName);
  var headers = readTable(sheetName).headers;
  var line = headers.map(function (h) {
    return (obj[h] === undefined || obj[h] === null) ? '' : obj[h];
  });
  sh.appendRow(line);
  var rowNumber = sh.getLastRow();

  // キャッシュにも同じ行を足しておく（読み直しを避けるため）
  var cached = TABLE_CACHE_[sheetName];
  if (cached) {
    var row = { _row: rowNumber };
    headers.forEach(function (h, i) { if (h) row[h] = line[i]; });
    cached.rows.push(row);
  }
  return rowNumber;
}

/**
 * 既存行を部分更新する。
 * @param {string} sheetName シート名
 * @param {number} rowNumber 実シート行番号（readTableの _row）
 * @param {Object} patch 列名→新しい値
 * @return {void}
 */
function updateRow(sheetName, rowNumber, patch) {
  var sh = sheet_(sheetName);
  var headers = readTable(sheetName).headers;
  var cached = TABLE_CACHE_[sheetName];
  var cachedRow = cached ? cached.rows.filter(function (r) { return r._row === rowNumber; })[0] : null;

  // 連続する列はまとめて1回で書く（セル単位の書き込みを減らす）
  var indexes = [];
  for (var k in patch) {
    if (!patch.hasOwnProperty(k)) continue;
    var idx = headers.indexOf(k);
    if (idx < 0) continue;
    indexes.push({ idx: idx, key: k });
    if (cachedRow) cachedRow[k] = patch[k];
  }
  if (!indexes.length) return;
  indexes.sort(function (a, b) { return a.idx - b.idx; });

  var min = indexes[0].idx;
  var max = indexes[indexes.length - 1].idx;
  var current = sh.getRange(rowNumber, min + 1, 1, max - min + 1).getValues()[0];
  indexes.forEach(function (e) { current[e.idx - min] = patch[e.key]; });
  sh.getRange(rowNumber, min + 1, 1, current.length).setValues([current]);
}

/**
 * その日時から今までに何時間経ったかを返す。
 * @param {string|Date} value 日時（空なら0を返す）
 * @return {number} 経過時間（時間）
 */
function hoursSince_(value) {
  var text = toDateTimeStr_(value);
  if (!text) return 0;
  var t = new Date(text.substring(0, 10) + 'T' + (text.substring(11) || '00:00') + ':00+09:00').getTime();
  if (!t) return 0;
  return (new Date().getTime() - t) / 3600000;
}

/**
 * ScriptLockを取って処理を実行する（再入可能）。
 * すでに同じ実行の中でロックを持っている場合は取り直さず、内側で解放もしない。
 * 全ての書き込み処理をこの関数で包むことで、「読んで無ければ追記」の競合を防ぐ。
 * @param {string} proc 処理名（ログ用）
 * @param {number} waitMs ロック取得を待つミリ秒
 * @param {function():*} fn 実行する処理
 * @param {function():*} [onBusy] ロックを取れなかったときの処理
 * @return {*} fnの戻り値（取れなかった場合はonBusyの戻り値、無ければnull）
 */
function withLock_(proc, waitMs, fn, onBusy) {
  if (withLock_._depth > 0) {
    withLock_._depth++;
    try { return fn(); } finally { withLock_._depth--; }
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs)) {
    logWarn(proc, 'ロックを取得できませんでした（他の処理が実行中）');
    return onBusy ? onBusy() : null;
  }
  withLock_._depth = 1;
  // ロック待ちの間に他の実行が書き換えている可能性があるため、必ず読み直す
  invalidateCache_();
  checkById_._map = null;
  clearSettingCache();
  try {
    return fn();
  } finally {
    withLock_._depth = 0;
    lock.releaseLock();
  }
}
withLock_._depth = 0;

/**
 * check_idからS3チェック項目を取得する（1実行内はキャッシュして読み込みを減らす）。
 * @param {string} checkId check_id
 * @return {Object|null} S3の行オブジェクト
 */
function checkById_(checkId) {
  var table = safely_('checkById_', function () { return readTable(SHEETS.CHECK); }, { rows: [] });
  // キャッシュが作り直された場合・行が増えた場合は索引を作り直す
  if (checkById_._src !== table || checkById_._len !== table.rows.length) {
    var m = {};
    table.rows.forEach(function (r) { m[String(r['check_id'])] = r; });
    checkById_._map = m;
    checkById_._src = table;
    checkById_._len = table.rows.length;
  }
  return checkById_._map[String(checkId)] || null;
}

/**
 * S8設定の値を取得する。見つからなければ既定値を返す。
 * @param {string} key 設定キー
 * @param {string|number} [fallback] 既定値
 * @return {string} 設定値（文字列）
 */
function getSetting(key, fallback) {
  var cache = getSetting._cache;
  if (!cache) {
    cache = {};
    try {
      findRows(SHEETS.SETTING).forEach(function (r) { cache[String(r['キー'])] = String(r['値']); });
    } catch (e) { /* 設定シート未生成時は既定値で動かす */ }
    getSetting._cache = cache;
  }
  if (cache[key] !== undefined && cache[key] !== '') return cache[key];
  return (fallback === undefined || fallback === null) ? '' : String(fallback);
}

/**
 * 設定キャッシュを破棄する（S8を書き換えた直後に呼ぶ）。
 * @return {void}
 */
function clearSettingCache() { getSetting._cache = null; }

/**
 * S8設定を数値として取得する。
 * @param {string} key 設定キー
 * @param {number} fallback 既定値
 * @return {number} 数値
 */
function getSettingNum(key, fallback) {
  var v = parseInt(getSetting(key, fallback), 10);
  return isNaN(v) ? fallback : v;
}

/**
 * TRUE/FALSE 判定（チェックボックス・文字列どちらでも受ける）。
 * @param {*} v 値
 * @return {boolean} 真偽
 */
function isTrue_(v) {
  if (v === true) return true;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'はい' || s === '1' || s === '○';
}

/**
 * 日付を YYYY-MM-DD 文字列にそろえる。
 * @param {Date|string} d 日付
 * @return {string} YYYY-MM-DD
 */
function toDateStr_(d) {
  if (!d && d !== 0) return '';
  if (Object.prototype.toString.call(d) === '[object Date]') {
    return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
  }
  var s = String(d).trim();
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) {
    return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  }
  return s;
}

/**
 * 日時を YYYY-MM-DD HH:mm 文字列にそろえる。
 * @param {Date|string} d 日時
 * @return {string} YYYY-MM-DD HH:mm
 */
function toDateTimeStr_(d) {
  if (!d && d !== 0) return '';
  if (Object.prototype.toString.call(d) === '[object Date]') {
    return Utilities.formatDate(d, TZ, 'yyyy-MM-dd HH:mm');
  }
  return String(d).trim();
}

/**
 * 現在日時（文字列）。
 * @return {string} YYYY-MM-DD HH:mm
 */
function nowStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }

/**
 * 今日の日付（文字列）。
 * @return {string} YYYY-MM-DD
 */
function todayStr_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

/**
 * 日付を加減算した日付文字列を返す。
 * @param {string|Date} base 基準日
 * @param {number} days 加算日数（マイナス可）
 * @return {string} YYYY-MM-DD
 */
function addDays_(base, days) {
  var d = (Object.prototype.toString.call(base) === '[object Date]') ? new Date(base.getTime())
        : new Date(toDateStr_(base) + 'T00:00:00+09:00');
  d.setDate(d.getDate() + days);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

/**
 * 連番IDを採番する（例：TSK0001）。
 * @param {string} sheetName シート名
 * @param {string} colName ID列名
 * @param {string} prefix 接頭辞
 * @param {number} digits 桁数
 * @return {string} 新しいID
 */
function nextSeqId_(sheetName, colName, prefix, digits) {
  var rows = findRows(sheetName);
  var max = 0;
  rows.forEach(function (r) {
    var m = String(r[colName]).match(new RegExp('^' + prefix + '(\\d+)$'));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  var n = String(max + 1);
  while (n.length < digits) n = '0' + n;
  return prefix + n;
}

/**
 * gap_id を採番する（GAP-YYYYMMDD-001 形式）。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {string} gap_id
 */
function nextGapId_(targetDate) {
  var key = 'GAP-' + toDateStr_(targetDate).replace(/-/g, '') + '-';
  var max = 0;
  findRows(SHEETS.GAP).forEach(function (r) {
    var m = String(r['gap_id']).match(new RegExp('^' + key + '(\\d+)$'));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  // 3桁でゼロ埋めするが、1000件を超えても桁を切らない（IDの重複を防ぐ）
  var n = String(max + 1);
  while (n.length < 3) n = '0' + n;
  return key + n;
}

/**
 * 登録コードを生成する（見間違えにくい文字だけを使う）。
 * @return {string} 登録コード
 */
function makeRegistrationCode_() {
  var s = '';
  for (var i = 0; i < REGISTRATION_CODE_LENGTH; i++) {
    s += REGISTRATION_CODE_CHARS.charAt(Math.floor(Math.random() * REGISTRATION_CODE_CHARS.length));
  }
  return s;
}

// ============================================================================
// log.gs
// ============================================================================

/**
 * 実行ログ（S10）記録層（06 Step2）
 *
 * 品質基準：エラーで停止せず、必ずS10に記録して処理を継続する。
 * そのためログ記録自体が失敗しても例外を投げない。
 */

/**
 * 実行ログを1行記録する。
 * @param {string} proc 処理名（例：morningBatch）
 * @param {string} result 結果（開始/正常/警告/エラー）
 * @param {*} [detail] 詳細（文字列化して保存。長い場合は先頭2000文字）
 * @return {void}
 */
function writeLog(proc, result, detail) {
  try {
    var text = (detail === undefined || detail === null) ? ''
      : (typeof detail === 'string' ? detail : JSON.stringify(detail));
    if (text.length > 2000) text = text.substring(0, 2000) + '…(以下略)';
    appendRow(SHEETS.RUN_LOG, {
      '日時': nowStr_(),
      '処理名': proc,
      '結果': result,
      '詳細': text
    });
  } catch (e) {
    Logger.log('[S10書込失敗] ' + proc + ' / ' + result + ' / ' + e);
  }
}

/**
 * 処理開始ログ。
 * @param {string} proc 処理名
 * @param {*} [detail] 詳細
 * @return {void}
 */
function logStart(proc, detail) { writeLog(proc, '開始', detail); }

/**
 * 正常終了ログ。
 * @param {string} proc 処理名
 * @param {*} [detail] 詳細
 * @return {void}
 */
function logInfo(proc, detail) { writeLog(proc, '正常', detail); }

/**
 * 警告ログ（処理は継続する）。
 * @param {string} proc 処理名
 * @param {*} [detail] 詳細
 * @return {void}
 */
function logWarn(proc, detail) { writeLog(proc, '警告', detail); }

/**
 * エラーログ。
 * @param {string} proc 処理名
 * @param {Error|string} err エラー
 * @param {*} [extra] 補足情報
 * @return {void}
 */
function logError(proc, err, extra) {
  var msg = (err && err.stack) ? (err.message + ' / ' + err.stack) : String(err);
  if (extra !== undefined) msg += ' / ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
  writeLog(proc, 'エラー', msg);
}

/**
 * 例外を投げない実行ラッパー。1件の失敗で全体を止めないために使う。
 * @param {string} proc 処理名
 * @param {function():*} fn 実行する処理
 * @param {*} [fallback] 例外時の戻り値
 * @return {*} fnの戻り値、または fallback
 */
function safely_(proc, fn, fallback) {
  try {
    return fn();
  } catch (e) {
    logError(proc, e);
    return fallback;
  }
}

// ============================================================================
// notify.gs
// ============================================================================

/**
 * LINE送信の共通層（06 Step2 / 03_LINE会話仕様.md）
 *
 * ・push送信はリトライ3回（既定。S8 line_retry_max で変更可）
 * ・深夜帯（S8 quiet_start_hour〜quiet_end_hour）はS6にキュー保存し、朝のバッチで送る
 * ・チャネルアクセストークンはスクリプトプロパティからのみ読む（コード・シートに置かない）
 */

/** LINE APIのエンドポイント @type {Object.<string,string>} */
var LINE_API = {
  PUSH: 'https://api.line.me/v2/bot/message/push',
  REPLY: 'https://api.line.me/v2/bot/message/reply',
  PROFILE: 'https://api.line.me/v2/bot/profile/'
};

/**
 * チャネルアクセストークンを取得する。
 * @return {string} トークン
 */
function lineToken_() {
  var t = PropertiesService.getScriptProperties().getProperty(PROP.TOKEN);
  if (!t) throw new Error('スクリプトプロパティ ' + PROP.TOKEN + ' が未設定です');
  return t;
}

/**
 * LINE APIを1回呼ぶ（リトライなし）。
 * @param {string} url エンドポイント
 * @param {Object} payload 送信JSON
 * @param {string} [retryKey] 冪等性キー（同じキーの再送は重複送信されない）
 * @return {{code:number, body:string}} HTTPステータスと本文
 */
function lineFetch_(url, payload, retryKey) {
  var headers = { 'Authorization': 'Bearer ' + lineToken_() };
  if (retryKey) headers['X-Line-Retry-Key'] = retryKey;
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return { code: res.getResponseCode(), body: res.getContentText() };
}

/**
 * push送信（リトライ付き）。
 * @param {string} lineUserId 送信先のLINEユーザーID
 * @param {Array.<Object>} messages LINEメッセージオブジェクト配列（最大5件）
 * @param {string} [retryKey] 冪等性キー（UUID形式）
 * @return {{ok:boolean, code:number, body:string, tries:number}} 送信結果
 */
function pushRaw_(lineUserId, messages, retryKey) {
  var max = getSettingNum('line_retry_max', 3);
  var key = retryKey || Utilities.getUuid();
  var last = { ok: false, code: 0, body: '', tries: 0 };
  for (var i = 1; i <= max; i++) {
    last.tries = i;
    try {
      var r = lineFetch_(LINE_API.PUSH, { to: lineUserId, messages: messages }, key);
      last.code = r.code;
      last.body = r.body;
      if (r.code === 200) { last.ok = true; return last; }
      // 409 は「同じリトライキーの送信を既に受理済み」の意味。成功として扱う（重複送信の防止）
      if (r.code === 409) {
        last.ok = true;
        logInfo('pushRaw_', '409（送信済み）として扱う: ' + lineUserId);
        return last;
      }
      // 4xx（トークン不正・宛先不正など）はリトライしても直らないので即終了
      if (r.code >= 400 && r.code < 500 && r.code !== 429) return last;
    } catch (e) {
      last.body = String(e);
    }
    if (i < max) Utilities.sleep(Math.pow(2, i - 1) * 1000);
  }
  return last;
}

/**
 * 返信（replyToken使用。webhook応答用・リトライ不可）。
 * @param {string} replyToken 返信トークン
 * @param {Array.<Object>} messages メッセージ配列
 * @return {boolean} 成功したか
 */
function replyRaw_(replyToken, messages) {
  try {
    var r = lineFetch_(LINE_API.REPLY, { replyToken: replyToken, messages: messages });
    if (r.code !== 200) logWarn('replyRaw_', 'code=' + r.code + ' ' + r.body);
    return r.code === 200;
  } catch (e) {
    logError('replyRaw_', e);
    return false;
  }
}

/**
 * 深夜帯（送信抑止時間帯）かどうか。
 * @param {Date} [now] 判定する日時（省略時は現在）
 * @return {boolean} 深夜帯ならtrue
 */
function isQuietHours_(now) {
  var h = parseInt(Utilities.formatDate(now || new Date(), TZ, 'H'), 10);
  var start = getSettingNum('quiet_start_hour', 22);
  var end = getSettingNum('quiet_end_hour', 7);
  return (start > end) ? (h >= start || h < end) : (h >= start && h < end);
}

/**
 * staff_idからスタッフ行を取得する。
 * @param {string} staffId スタッフID
 * @return {Object|null} S1の行オブジェクト
 */
function staffById_(staffId) {
  return findRow(SHEETS.STAFF, { 'staff_id': staffId });
}

/**
 * line_user_idからスタッフ行を取得する。
 * @param {string} lineUserId LINEユーザーID
 * @return {Object|null} S1の行オブジェクト
 */
function staffByLineId_(lineUserId) {
  if (!lineUserId) return null;
  return findRow(SHEETS.STAFF, { 'line_user_id': lineUserId });
}

/**
 * エスカレーション先（社員）のスタッフ行一覧を返す。
 * @return {Array.<Object>} S1の行オブジェクト配列
 */
function escalationStaff_() {
  return findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && isTrue_(r['エスカレーション先フラグ']);
  });
}

/**
 * スタッフへメッセージを送る。深夜帯はS6にキュー保存し、朝のバッチで送信する。
 * @param {string} staffId 送信先staff_id
 * @param {Array.<Object>} messages メッセージ配列
 * @param {{taskRowNumber:number, force:boolean, label:string}} [opts]
 *        taskRowNumber: 既存のS6行を更新する場合の行番号 /
 *        force: 深夜帯でも即送信する / label: ログ用の名称
 * @return {{ok:boolean, queued:boolean, detail:string}} 送信結果
 */
function sendToStaff(staffId, messages, opts) {
  opts = opts || {};
  var label = opts.label || 'sendToStaff';
  var staff = staffById_(staffId);
  if (!staff) {
    logWarn(label, 'staff_idがS1にありません: ' + staffId);
    return { ok: false, queued: false, detail: 'staff_not_found' };
  }
  var lineId = String(staff['line_user_id'] || '').trim();
  if (!lineId) {
    logWarn(label, staff['氏名'] + ' のline_user_idが未登録のため送信できません（友だち追加待ち）');
    return { ok: false, queued: false, detail: 'no_line_user_id' };
  }

  var body = JSON.stringify(messages);

  // テストモード中は実際には送らない（設定作業中に現場へ誤送信しないため）
  if (isTrue_(getSetting('test_mode', 'FALSE'))) {
    if (opts.taskRowNumber) {
      updateRow(SHEETS.TASK, opts.taskRowNumber, {
        '送信本文': body, '送信状態': SEND_STATUS.TEST, '送信日時': nowStr_()
      });
    } else {
      appendRow(SHEETS.TASK, {
        'task_id': nextSeqId_(SHEETS.TASK, 'task_id', 'TSK', 5),
        '送信先staff_id': staffId,
        '送信本文': body,
        '送信状態': SEND_STATUS.TEST,
        '送信日時': nowStr_(),
        '作成日時': nowStr_()
      });
    }
    logInfo(label, '【テストモード】送信せず記録のみ: ' + staff['氏名']);
    return { ok: true, queued: false, detail: 'test_mode' };
  }

  // 同じ内容の再送では必ず同じキーを使う（LINE側が重複を弾けるようにするため）
  var retryKey = opts.retryKey || '';
  if (!retryKey && opts.taskRowNumber) {
    var taskRow = findRow(SHEETS.TASK, function (r) { return r._row === opts.taskRowNumber; });
    retryKey = taskRow ? String(taskRow['retry_key'] || '') : '';
  }
  if (!retryKey) retryKey = Utilities.getUuid();

  // 深夜帯はキューに積む
  if (!opts.force && isQuietHours_()) {
    if (opts.taskRowNumber) {
      updateRow(SHEETS.TASK, opts.taskRowNumber, {
        '送信状態': SEND_STATUS.QUEUED, '送信本文': body, 'retry_key': retryKey
      });
    } else {
      appendRow(SHEETS.TASK, {
        'task_id': nextSeqId_(SHEETS.TASK, 'task_id', 'TSK', 5),
        '送信先staff_id': staffId,
        '送信本文': body,
        '送信状態': SEND_STATUS.QUEUED,
        '再送回数': 0,
        'retry_key': retryKey,
        '作成日時': nowStr_()
      });
    }
    logInfo(label, '深夜帯のためキュー保存: ' + staff['氏名']);
    return { ok: true, queued: true, detail: 'queued' };
  }

  var res = pushRaw_(lineId, messages, retryKey);
  if (opts.taskRowNumber) {
    updateRow(SHEETS.TASK, opts.taskRowNumber, {
      '送信本文': body,
      '送信状態': res.ok ? SEND_STATUS.SENT : SEND_STATUS.FAILED,
      '送信日時': res.ok ? nowStr_() : '',
      '再送回数': res.tries,
      'retry_key': retryKey
    });
  }
  if (res.ok) {
    logInfo(label, '送信成功: ' + staff['氏名']);
  } else {
    logError(label, '送信失敗: ' + staff['氏名'] + ' code=' + res.code + ' ' + res.body);
  }
  return { ok: res.ok, queued: false, detail: res.body };
}

/**
 * エスカレーション先の社員全員へ同じメッセージを送る。
 * @param {Array.<Object>} messages メッセージ配列
 * @param {string} label ログ用の名称
 * @return {number} 送信できた人数
 */
function sendToEscalationStaff(messages, label) {
  var n = 0;
  escalationStaff_().forEach(function (s) {
    var r = safely_(label, function () {
      return sendToStaff(s['staff_id'], messages, { label: label });
    }, { ok: false });
    if (r && r.ok) n++;
  });
  return n;
}

/**
 * キュー（深夜帯保留分・送信失敗分）をまとめて送信する。
 * 朝のバッチと、深夜帯明けの時刻トリガーから呼ばれる。
 * @return {number} 送信できた件数
 */
function flushQueue() {
  var proc = 'flushQueue';
  return withLock_(proc, 60000, function () {
    logStart(proc);
    if (isQuietHours_()) {
      logInfo(proc, '深夜帯のため送信しない');
      return 0;
    }
    var maxRetry = getSettingNum('line_retry_max', 3);
    var expireMs = getSettingNum('queue_expire_hours', 24) * 3600 * 1000;
    var now = new Date().getTime();

    var targets = findRows(SHEETS.TASK, function (r) {
      var st = String(r['送信状態']);
      if (st === SEND_STATUS.QUEUED) return true;
      return st === SEND_STATUS.FAILED && Number(r['再送回数'] || 0) < maxRetry * 2;
    });
    var sent = 0, expired = 0;

    targets.forEach(function (t) {
      safely_(proc, function () {
        var body = String(t['送信本文'] || '');
        if (!body) {
          updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED });
          return;
        }
        // 作られてから期限（既定24時間）を過ぎたものは再送しない。
        // LINEの重複防止キーの有効期間を超えると、二重送信になる恐れがあるため。
        var created = toDateTimeStr_(t['作成日時'] || t['送信日時']);
        if (created) {
          var age = now - new Date(created.replace(' ', 'T') + ':00+09:00').getTime();
          if (!isNaN(age) && age > expireMs) {
            updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED });
            logWarn(proc, '期限切れのため送信を取りやめ: ' + t['task_id']);
            expired++;
            return;
          }
        }
        // 対応する不足がすでに完了していれば送らない
        if (t['gap_id']) {
          var gap = findRow(SHEETS.GAP, { 'gap_id': t['gap_id'] });
          if (gap && String(gap['状態']) === GAP_STATUS.DONE) {
            updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED });
            return;
          }
        }
        var prevTries = Number(t['再送回数'] || 0);
        var r = sendToStaff(t['送信先staff_id'], JSON.parse(body), {
          taskRowNumber: t._row, label: proc, force: false
        });
        if (r.ok && !r.queued) {
          sent++;
        } else if (!r.ok) {
          // 再送回数は累積させる（無限リトライを防ぐため）
          updateRow(SHEETS.TASK, t._row, { '再送回数': prevTries + 1 });
        }
      });
    });
    logInfo(proc, '送信 ' + sent + '件 / 対象 ' + targets.length + '件 / 期限切れ ' + expired + '件');
    return sent;
  }, function () { return 0; });
}

// ---------------------------------------------------------------------------
// メッセージ組み立て
// ---------------------------------------------------------------------------

/**
 * テキストメッセージを作る。
 * @param {string} text 本文
 * @return {Object} LINEメッセージオブジェクト
 */
function msgText_(text) {
  return { type: 'text', text: truncate_(text, 4900) };
}

/**
 * ボタン付きテンプレートメッセージを作る（選択肢は最大4件）。
 * @param {string} title タイトル（40文字以内）
 * @param {string} text 本文（60文字以内）
 * @param {Array.<{label:string, data:string}>} actions 選択肢
 * @return {Object} LINEメッセージオブジェクト
 */
function msgButtons_(title, text, actions) {
  var acts = actions.slice(0, 4).map(function (a) {
    return { type: 'postback', label: truncate_(a.label, 20), data: a.data, displayText: truncate_(a.label, 20) };
  });
  return {
    type: 'template',
    altText: truncate_(title + ' ' + text, 400),
    template: {
      type: 'buttons',
      title: truncate_(title, 40),
      text: truncate_(text, 60),
      actions: acts
    }
  };
}

/**
 * クイックリプライ付きテキストメッセージを作る。
 * @param {string} text 本文
 * @param {Array.<{label:string, data:string}>} items 選択肢（最大13件）
 * @return {Object} LINEメッセージオブジェクト
 */
function msgQuickReply_(text, items) {
  return {
    type: 'text',
    text: truncate_(text, 4900),
    quickReply: {
      items: items.slice(0, 13).map(function (i) {
        return {
          type: 'action',
          action: { type: 'postback', label: truncate_(i.label, 20), data: i.data, displayText: truncate_(i.label, 20) }
        };
      })
    }
  };
}

/**
 * 文字列を指定長に切り詰める。
 * @param {string} s 文字列
 * @param {number} n 最大長
 * @return {string} 切り詰めた文字列
 */
function truncate_(s, n) {
  s = String(s === null || s === undefined ? '' : s);
  return s.length <= n ? s : s.substring(0, n - 1) + '…';
}

// ============================================================================
// setup.gs
// ============================================================================

/**
 * 台帳初期化スクリプト（06 Step1）
 *
 * initSheets() を1回だけ実行すれば、02_データスキーマ.md のS1〜S12が
 * ヘッダー付きで生成され、S1スタッフ4名・S3チェック項目・S8設定値が投入される。
 * 既存シートは上書きせずスキップし、実行ログ（S10）に記録する。
 */

/**
 * 台帳の全シートを生成し、初期データを投入する。
 * 何度実行しても既存データは壊さない（冪等）。
 * @return {string} 実行結果のサマリ
 */
function initSheets() {
  var proc = 'initSheets';
  var book = book_();
  var created = [];
  var skipped = [];

  // S10だけは先に作る（以降の処理でログを書くため）
  ensureSheet_(book, SHEET_DEFS.filter(function (d) { return d.name === SHEETS.RUN_LOG; })[0], created, skipped);
  logStart(proc);

  SHEET_DEFS.forEach(function (def) {
    if (def.name === SHEETS.RUN_LOG) return;
    safely_(proc, function () { ensureSheet_(book, def, created, skipped); });
  });

  var seeded = [];
  safely_(proc, function () { if (seedStaff_()) seeded.push('S1スタッフ4名'); });
  safely_(proc, function () { if (seedChecks_()) seeded.push('S3チェック項目' + INITIAL_CHECKS.length + '件'); });
  safely_(proc, function () { if (seedSettings_()) seeded.push('S8設定' + DEFAULT_SETTINGS.length + '件'); });
  safely_(proc, function () { removeDefaultSheet_(book); });
  clearSettingCache();

  var summary = '作成: ' + (created.join(', ') || 'なし')
    + ' / 既存のためスキップ: ' + (skipped.join(', ') || 'なし')
    + ' / 初期データ投入: ' + (seeded.join(', ') || 'なし（既にデータあり）');
  logInfo(proc, summary);
  return summary;
}

/**
 * シートが無ければ作り、ヘッダーを整える。
 * @param {Spreadsheet} book スプレッドシート
 * @param {{name:string, headers:Array.<string>, note:string}} def シート定義
 * @param {Array.<string>} created 作成したシート名の配列（追記される）
 * @param {Array.<string>} skipped スキップしたシート名の配列（追記される）
 * @return {Sheet} シート
 */
function ensureSheet_(book, def, created, skipped) {
  var sh = book.getSheetByName(def.name);
  if (sh) {
    var added = addMissingHeaders_(sh, def);
    skipped.push(def.name + (added.length ? '（列を追加: ' + added.join('・') + '）' : ''));
    return sh;
  }
  sh = book.insertSheet(def.name);
  sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers])
    .setFontWeight('bold').setBackground('#EFEFEF');
  sh.setFrozenRows(1);
  sh.getRange(1, 1).setNote(def.note);
  if (sh.getMaxColumns() > def.headers.length) {
    sh.deleteColumns(def.headers.length + 1, sh.getMaxColumns() - def.headers.length);
  }
  created.push(def.name);
  invalidateCache_(def.name);
  return sh;
}

/**
 * すでにあるシートに、定義には有るのに実物に無い列を末尾へ足す。
 *
 * バージョンアップで列が増えたとき、藤原様が台帳を作り直さなくて済むようにするための処理。
 * 既存の列は並べ替えも改名もしない（既存データを壊さないため、足すだけ）。
 * @param {Sheet} sh シート
 * @param {{name:string, headers:Array.<string>, note:string}} def シート定義
 * @return {Array.<string>} 追加した列名
 */
function addMissingHeaders_(sh, def) {
  var width = Math.max(sh.getLastColumn(), 1);
  var current = sh.getRange(1, 1, 1, width).getValues()[0].map(function (v) { return String(v).trim(); });
  var missing = def.headers.filter(function (h) { return current.indexOf(h) < 0; });
  if (!missing.length) return [];

  var start = current.length + 1;
  if (sh.getMaxColumns() < current.length + missing.length) {
    sh.insertColumnsAfter(sh.getMaxColumns(), current.length + missing.length - sh.getMaxColumns());
  }
  sh.getRange(1, start, 1, missing.length).setValues([missing])
    .setFontWeight('bold').setBackground('#EFEFEF');
  sh.getRange(1, 1).setNote(def.note);
  invalidateCache_(def.name);
  logInfo('addMissingHeaders_', def.name + ' に列を追加: ' + missing.join('・'));
  return missing;
}

/**
 * 新規スプレッドシートに残っている既定シート「シート1」を削除する。
 * @param {Spreadsheet} book スプレッドシート
 * @return {void}
 */
function removeDefaultSheet_(book) {
  ['シート1', 'Sheet1'].forEach(function (name) {
    var sh = book.getSheetByName(name);
    if (sh && book.getSheets().length > 1 && sh.getLastRow() === 0) book.deleteSheet(sh);
  });
}

/**
 * S1スタッフマスタに初期4名を投入する（既にデータがあれば何もしない）。
 * @return {boolean} 投入したらtrue
 */
function seedStaff_() {
  if (findRows(SHEETS.STAFF).length > 0) return false;
  var sh = sheet_(SHEETS.STAFF);
  var values = INITIAL_STAFF.map(function (row) {
    var copy = row.slice();
    copy[7] = makeRegistrationCode_();   // 登録コードを自動発行
    return copy;
  });
  sh.getRange(2, 1, values.length, values[0].length).setValues(values);
  sh.getRange(2, 4).setNote('兼崎様のフルネームは友だち追加時に確認して氏名列を更新すること');
  sh.getRange(1, 8).setNote('本人にだけ個別に伝えるコード。LINEでこのコードを送ってもらうと紐付く。'
    + '紐付いたら自動で消える。再発行はメニュー「AI Uribo」→「登録コードを発行」から');
  invalidateCache_(SHEETS.STAFF);
  return true;
}

/**
 * 登録コードを（再）発行する。メニューから実行し、表示されたコードを本人にだけ伝える。
 * すでにLINEと紐付いているスタッフに発行すると、紐付けを解除して付け直しになる。
 * @param {string} [staffId] staff_id（省略時はダイアログで入力）
 * @return {string} 発行結果のメッセージ
 */
function issueRegistrationCode(staffId) {
  var proc = 'issueRegistrationCode';
  return withLock_(proc, 20000, function () {
    var staff = staffId ? staffById_(staffId) : null;
    if (!staff) {
      var msg = 'staff_idが見つかりません: ' + staffId;
      logWarn(proc, msg);
      return msg;
    }
    var code = makeRegistrationCode_();
    updateRow(SHEETS.STAFF, staff._row, { '登録コード': code, 'line_user_id': '' });
    logInfo(proc, staff['氏名'] + ' の登録コードを再発行（コード自体はログに残さない）');
    return staff['氏名'] + ' さんの登録コード：' + code
      + '\n※本人にだけ伝えてください。LINEでこのコードを送ると登録されます。';
  });
}

/**
 * メニューから登録コードを発行する。
 * @return {void}
 */
function menuIssueCode_() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('登録コードの発行', 'staff_id を入力してください（例：STF001）', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  ui.alert('登録コード', issueRegistrationCode(String(res.getResponseText()).trim()), ui.ButtonSet.OK);
}

/**
 * S3チェック項目マスタに初期項目を投入する（既にデータがあれば何もしない）。
 * @return {boolean} 投入したらtrue
 */
function seedChecks_() {
  if (findRows(SHEETS.CHECK).length > 0) return false;
  var sh = sheet_(SHEETS.CHECK);
  var width = readTable(SHEETS.CHECK).headers.length;
  // 行ごとに列数が違っても崩れないよう、ヘッダーの列数にそろえる
  var values = INITIAL_CHECKS.map(function (row) {
    var copy = row.slice();
    while (copy.length < width) copy.push('');
    return copy.slice(0, width);
  });
  sh.getRange(2, 1, values.length, width).setValues(values);
  invalidateCache_(SHEETS.CHECK);
  return true;
}

/**
 * S8設定に初期値を投入する（既にデータがあれば不足キーのみ追加）。
 * @return {boolean} 投入したらtrue
 */
function seedSettings_() {
  var existing = {};
  findRows(SHEETS.SETTING).forEach(function (r) { existing[String(r['キー'])] = true; });
  var add = DEFAULT_SETTINGS.filter(function (s) { return !existing[s[0]]; });
  if (!add.length) return false;
  var sh = sheet_(SHEETS.SETTING);
  sh.getRange(sh.getLastRow() + 1, 1, add.length, 3).setValues(add);
  invalidateCache_(SHEETS.SETTING);
  clearSettingCache();
  return true;
}

/**
 * はじめの設定をまとめて実行する（デプロイ直後にこれ1つ実行すればよい）。
 * 台帳を作り、テストモードをONにし、足りない設定を一覧で返す。
 * @return {string} 次にやることの案内
 */
function quickStart() {
  var proc = 'quickStart';
  var lines = ['=== AI Uribo はじめの設定 ==='];
  lines.push(safely_(proc, function () { return initSheets(); }, '台帳の作成に失敗しました'));

  // 設定作業中に現場へ誤送信しないよう、最初はテストモードで始める
  safely_(proc, function () {
    var row = findRow(SHEETS.SETTING, { 'キー': 'test_mode' });
    if (row) updateRow(SHEETS.SETTING, row._row, { '値': 'TRUE' });
    clearSettingCache();
    lines.push('テストモードをONにしました（LINEには実際には送りません）');
  });

  lines.push('');
  lines.push(safely_(proc, function () { return checkSetup(); }, ''));
  lines.push('');
  lines.push('【次にやること】');
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP.TOKEN)) lines.push('1. スクリプトプロパティに LINE_CHANNEL_TOKEN を入れる');
  if (!props.getProperty(PROP.WEBHOOK_KEY)) lines.push('2. スクリプトプロパティに WEBHOOK_SECRET を入れる（未設定だとWebhookは全拒否）');
  lines.push('3. ウェブアプリとしてデプロイし、URLの末尾に ?k=＜WEBHOOK_SECRET＞ を付けてLINEに登録');
  lines.push('4. S1の登録コードを本人に伝え、LINEで送ってもらう');
  lines.push('5. installTriggers() を実行');
  lines.push('6. メニュー「利用者を登録する」で利用者を登録し、'
    + '「支援記録の質問を開始する（Phase2）」を実行');
  lines.push('7. テストが済んだら S8設定の test_mode を FALSE にする（これで本番運用開始）');
  var text = lines.join('\n');
  logInfo(proc, '実行しました');
  return text;
}

/**
 * セットアップ状態を点検して結果を返す（人間の確認用）。
 * メニュー「AI Uribo」→「セットアップ点検」から実行できる。
 * @return {string} 点検結果
 */
function checkSetup() {
  var out = [];
  var props = PropertiesService.getScriptProperties();
  SHEET_DEFS.forEach(function (d) {
    out.push((book_().getSheetByName(d.name) ? '○ ' : '× ') + d.name);
  });
  out.push((props.getProperty(PROP.TOKEN) ? '○ ' : '× ') + 'スクリプトプロパティ ' + PROP.TOKEN);
  out.push((props.getProperty(PROP.SECRET) ? '○ ' : '× ') + 'スクリプトプロパティ ' + PROP.SECRET);
  if (props.getProperty(PROP.WEBHOOK_KEY)) {
    out.push('○ スクリプトプロパティ ' + PROP.WEBHOOK_KEY);
  } else {
    out.push('× スクリプトプロパティ ' + PROP.WEBHOOK_KEY
      + ' 【未設定のためWebhookは全リクエストを拒否します。運用開始前に必ず設定してください】');
  }
  out.push((props.getProperty('SWITCHBOT_TOKEN') ? '○ ' : '－ ') + 'スクリプトプロパティ SWITCHBOT_TOKEN（任意）');
  var devices = safely_('checkSetup', function () {
    return findRows(SHEETS.DEVICE, function (r) { return isTrue_(r['有効']); }).length;
  }, 0);
  out.push('SwitchBot機器（有効） ' + devices + '件');
  if (isTrue_(getSetting('test_mode', 'FALSE'))) {
    out.push('★テストモード：ON（LINEには実際に送りません。運用開始時はS8のtest_modeをFALSEに）');
  } else {
    out.push('テストモード：OFF（実際にLINEへ送信します）');
  }
  var staff = findRows(SHEETS.STAFF, function (r) { return isTrue_(r['有効']); });
  var linked = staff.filter(function (r) { return String(r['line_user_id'] || '').trim(); });
  out.push('有効スタッフ ' + staff.length + '名 / LINE紐付け済み ' + linked.length + '名');
  var users = safely_('checkSetup', function () {
    return findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); }).length;
  }, 0);
  var supportOn = safely_('checkSetup', function () {
    return findRows(SHEETS.CHECK, function (r) {
      return String(r['対象種別']) === 'support' && isTrue_(r['有効']);
    }).length;
  }, 0);
  out.push('有効な利用者 ' + users + '名'
    + (users ? '' : '【メニュー「利用者を登録する」から登録してください】'));
  out.push('支援記録の質問 ' + (supportOn ? supportOn + '項目が有効' : '未開始【メニュー「支援記録の質問を開始する（Phase2）」】'));
  var triggers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  ['morningBatch', 'nightBatch', 'weeklyDigest', 'dailyBackup', 'flushQueue'].forEach(function (f) {
    out.push((triggers.indexOf(f) >= 0 ? '○ ' : '× ') + 'トリガー ' + f);
  });
  var text = out.join('\n');
  logInfo('checkSetup', text);
  return text;
}

/**
 * スプレッドシートを開いたときにメニューを追加する。
 * @return {void}
 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('AI Uribo')
    .addItem('はじめの設定（quickStart）', 'menuQuickStart_')
    .addItem('台帳を初期化する（initSheets）', 'initSheets')
    .addItem('セットアップ点検', 'menuCheckSetup_')
    .addItem('登録コードを発行', 'menuIssueCode_')
    .addSeparator()
    .addItem('利用者を登録する', 'menuAddUser_')
    .addItem('登録済みの利用者を見る', 'menuListUsers_')
    .addItem('支援記録の質問を開始する（Phase2）', 'menuEnablePhase2_')
    .addItem('シフト表を取り込む', 'menuImportShift_')
    .addSeparator()
    .addItem('診断情報をコピー', 'menuDiagnostics_')
    .addSeparator()
    .addItem('朝バッチを今すぐ実行', 'morningBatch')
    .addItem('夜の確認セットを今すぐ実行', 'nightBatch')
    .addItem('週次ダイジェストを今すぐ実行', 'weeklyDigest')
    .addItem('月次まとめを作る（監査用）', 'menuMonthlyReport_')
    .addItem('バックアップを今すぐ実行', 'dailyBackup')
    .addItem('自己点検を今すぐ実行', 'selfCheck')
    .addItem('古い行を保管シートへ移す', 'archiveOldRows')
    .addSeparator()
    .addItem('SwitchBot機器を読み込む', 'switchbotSyncDevices')
    .addItem('SwitchBotの状態を今すぐ取得', 'switchbotPoll')
    .addItem('SwitchBotのWebhookを登録', 'switchbotSetupWebhook')
    .addSeparator()
    .addItem('トリガーを設定する（installTriggers）', 'installTriggers')
    .addToUi();
}

/**
 * メニューからはじめの設定を実行する。
 * @return {void}
 */
function menuQuickStart_() {
  SpreadsheetApp.getUi().alert('AI Uribo はじめの設定', quickStart(), SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * メニューからセットアップ点検を実行し、結果をダイアログ表示する。
 * @return {void}
 */
function menuCheckSetup_() {
  SpreadsheetApp.getUi().alert('AI Uribo セットアップ点検', checkSetup(), SpreadsheetApp.getUi().ButtonSet.OK);
}

// ============================================================================
// users.gs
// ============================================================================

/**
 * 利用者の登録と、支援記録（Phase2）の有効化
 *
 * 【氏名の置き場所】
 * 台帳の本体（S2〜S7）に利用者の氏名は置かない。置くのは記号（user_code）だけ。
 * 氏名はS9_対応表にだけ持ち、LINEの文面を作るときにその場で差し替える。
 * こうしておくと、台帳を人に見せたりCSVで渡したりしても、そこに氏名は出てこない。
 *
 * 【使い方】
 *   メニュー「AI Uribo」→「利用者を登録する」で1人ずつ登録する（拠点と氏名だけ）。
 *   自動データを使う利用者は、S2の「服薬自動／在否自動／日中自動」をTRUEにする。
 *   全員の登録が済んだら「支援記録の質問を開始する（Phase2）」を実行する。
 *
 * 診断名・病名・障害区分などの医療情報は、この台帳では一切扱わない。
 */

/**
 * 利用者を1人登録する（すでにあれば拠点・氏名を更新する）。
 * @param {string} site 拠点（例：清水／玉里）
 * @param {string} name 氏名（S9_対応表にだけ入る）
 * @param {string} [userCode] user_code（省略すると自動採番）
 * @return {string} 実行結果のメッセージ
 */
function addUser(site, name, userCode) {
  var proc = 'addUser';
  return withLock_(proc, 20000, function () {
    var siteText = String(site || '').trim();
    var nameText = String(name || '').trim();
    if (!siteText) return '拠点を入力してください（例：清水／玉里）';
    if (!nameText) return '氏名を入力してください（氏名はS9_対応表にだけ入り、他のシートには出ません）';

    var code = String(userCode || '').trim() || nextUserCode_();
    var existing = findRow(SHEETS.USER, { 'user_code': code });
    if (existing) {
      updateRow(SHEETS.USER, existing._row, { '拠点': siteText, '有効': true });
    } else {
      appendRow(SHEETS.USER, {
        'user_code': code,
        '拠点': siteText,
        // 自動データを使うかは利用者ごとに人が決める（機器が付いている方だけTRUEにする）
        '自動ログ対応': false,
        '服薬自動': false,
        '在否自動': false,
        '日中自動': false,
        '有効': true
      });
    }
    setDisplayName_(code, nameText);
    logInfo(proc, code + ' を登録しました（拠点: ' + siteText + '／氏名はS9のみ）');
    return code + ' を登録しました（拠点：' + siteText + '）。\n'
      + '自動データを使う場合は、S2_利用者マスタの「服薬自動／在否自動／日中自動」をTRUEにしてください。';
  });
}

/**
 * 利用者を登録から外す（行は消さず、有効=FALSEにする）。
 * 過去の記録との対応が取れなくなるため、行そのものは残す。
 * @param {string} userCode user_code
 * @return {string} 実行結果のメッセージ
 */
function retireUser(userCode) {
  var proc = 'retireUser';
  return withLock_(proc, 20000, function () {
    var row = findRow(SHEETS.USER, { 'user_code': String(userCode).trim() });
    if (!row) return 'user_codeが見つかりません: ' + userCode;
    updateRow(SHEETS.USER, row._row, { '有効': false });
    logInfo(proc, userCode + ' を有効=FALSEにしました（過去の記録は残ります）');
    return userCode + ' を対象外にしました。過去の記録はそのまま残ります。';
  });
}

/**
 * 次のuser_codeを採番する。
 * @return {string} user_code
 */
function nextUserCode_() {
  return nextSeqId_(SHEETS.USER, 'user_code', 'U', 3);
}

/**
 * S9_対応表に氏名を登録する（同じコードがあれば上書き）。
 * @param {string} code user_code
 * @param {string} name 氏名
 * @return {void}
 */
function setDisplayName_(code, name) {
  var row = findRow(SHEETS.NAME_MAP, { 'コード': code });
  if (row) {
    updateRow(SHEETS.NAME_MAP, row._row, { '氏名': name, '種別': '利用者' });
  } else {
    appendRow(SHEETS.NAME_MAP, { 'コード': code, '氏名': name, '種別': '利用者' });
  }
  displayName_._src = null;   // 氏名の対応表を読み直させる
}

/**
 * 登録済みの利用者を一覧にする（この文はメニューの中だけで表示する）。
 * @return {string} 一覧
 */
function listUsers() {
  var rows = findRows(SHEETS.USER);
  if (!rows.length) return 'まだ登録がありません。メニュー「利用者を登録する」から追加してください。';
  var lines = ['【利用者】' + rows.length + '名'];
  rows.forEach(function (r) {
    var autos = ['服薬自動', '在否自動', '日中自動'].filter(function (k) { return isTrue_(r[k]); });
    lines.push((isTrue_(r['有効']) ? '○ ' : '－ ') + r['user_code'] + '　' + displayName_(String(r['user_code']))
      + '（' + (r['拠点'] || '拠点未設定') + '）'
      + (autos.length ? '　自動：' + autos.join('・') : '　自動：なし'));
  });
  return lines.join('\n');
}

/**
 * 支援記録の質問（Phase2の優先度A）を開始する。
 *
 * 利用者が1人も登録されていないうちに開始すると、質問が作られないまま
 * 「動いていない」ように見えてしまうため、登録を確認してから有効化する。
 * @return {string} 実行結果のメッセージ
 */
function enablePhase2() {
  var proc = 'enablePhase2';
  return withLock_(proc, 20000, function () {
    var users = findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); });
    if (!users.length) {
      return '利用者がまだ登録されていません。先にメニュー「利用者を登録する」から登録してください。';
    }

    var enabled = [];
    findRows(SHEETS.CHECK, function (r) {
      return String(r['優先度']) === 'A'
        && String(r['判定ルールID']) !== '-'
        && ['support', 'plan'].indexOf(String(r['対象種別'])) >= 0
        && !isTrue_(r['有効']);
    }).forEach(function (c) {
      updateRow(SHEETS.CHECK, c._row, { '有効': true });
      enabled.push(String(c['check_id']) + ' ' + String(c['項目名']));
    });
    checkById_._map = null;

    var summary = enabled.length
      ? '支援記録の質問を開始しました（' + enabled.length + '項目）：\n・' + enabled.join('\n・')
      : '支援記録の質問はすでに開始しています。';
    logInfo(proc, summary.replace(/\n/g, ' / '));
    return summary + '\n\n利用者' + users.length + '名が対象です。'
      + '翌朝10:00の確認から質問が届きます（すぐ試すならメニュー「朝バッチを今すぐ実行」）。';
  });
}

/**
 * 支援記録の質問をいったん止める（優先度A・Bともに無効化する）。
 * 質問が多すぎたときに、すぐ静かにできる逃げ道として用意しておく。
 * @return {string} 実行結果のメッセージ
 */
function disablePhase2() {
  var proc = 'disablePhase2';
  return withLock_(proc, 20000, function () {
    var off = 0;
    findRows(SHEETS.CHECK, function (r) {
      return ['support', 'plan'].indexOf(String(r['対象種別'])) >= 0 && isTrue_(r['有効']);
    }).forEach(function (c) {
      updateRow(SHEETS.CHECK, c._row, { '有効': false });
      off++;
    });
    checkById_._map = null;
    logInfo(proc, '支援記録の質問を' + off + '項目とめました');
    return '支援記録の質問を' + off + '項目とめました（シフト希望の確認は続きます）。';
  });
}

/**
 * メニューから利用者を登録する。
 * @return {void}
 */
function menuAddUser_() {
  var ui = SpreadsheetApp.getUi();
  var site = ui.prompt('利用者の登録（1/2）', '拠点を入力してください（例：清水／玉里）', ui.ButtonSet.OK_CANCEL);
  if (site.getSelectedButton() !== ui.Button.OK) return;
  var name = ui.prompt('利用者の登録（2/2）',
    '氏名を入力してください。\n※氏名はS9_対応表にだけ保存され、他のシートには記号だけが残ります。',
    ui.ButtonSet.OK_CANCEL);
  if (name.getSelectedButton() !== ui.Button.OK) return;
  ui.alert('利用者の登録', addUser(String(site.getResponseText()), String(name.getResponseText())),
    ui.ButtonSet.OK);
}

/**
 * メニューから利用者一覧を表示する。
 * @return {void}
 */
function menuListUsers_() {
  SpreadsheetApp.getUi().alert('登録済みの利用者', listUsers(), SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * メニューから支援記録の質問を開始する。
 * @return {void}
 */
function menuEnablePhase2_() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.alert('支援記録の質問を開始しますか？',
    listUsers() + '\n\nこの方々について、毎日の支援記録の確認（在否・食事・服薬など）が始まります。',
    ui.ButtonSet.OK_CANCEL);
  if (res !== ui.Button.OK) return;
  ui.alert('支援記録の質問', enablePhase2(), ui.ButtonSet.OK);
}

// ============================================================================
// learn.gs
// ============================================================================

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

// ============================================================================
// shift.gs
// ============================================================================

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
 * 1行に「日付　拠点　勤務区分　氏名」を空白区切りで書く。順番は変えない。
 *
 *   2026-08
 *   8/1  清水  夜勤  服部俊喜
 *   8/2  玉里  夜勤  兼崎
 *   8/3  清水  日勤  藤原寛
 *
 * ・先頭に「2026-08」の行があれば、以降の「8/1」をその年の日付として読む
 * ・日付は「8/1」「08/01」「2026-08-01」「1日」のいずれでもよい
 * ・氏名はS1_スタッフマスタに登録されている氏名（一部でも可）
 * ・読めなかった行は捨てずに理由を返すので、直してもう一度貼り付ければよい
 */

/**
 * シフト表の文章を取り込む。
 * @param {string} text 貼り付けられた文章
 * @return {{追加:number, 更新:number, 読めなかった行:Array.<string>, 対象月:string}} 取り込み結果
 */
function importShiftText(text) {
  var proc = 'importShiftText';
  return withLock_(proc, 60000, function () {
    var result = { 追加: 0, 更新: 0, 読めなかった行: [], 対象月: '' };
    var lines = String(text || '').split(/\r?\n/);
    var month = todayStr_().substring(0, 7);

    // 氏名 → staff_id の索引（部分一致も引けるように配列で持つ）
    var staff = findRows(SHEETS.STAFF, function (r) { return isTrue_(r['有効']); });

    lines.forEach(function (raw) {
      var line = String(raw).replace(/[　]/g, ' ').trim();
      if (!line) return;

      // 「2026-08」「2026/8」だけの行は、以降の日付の年月として扱う
      var head = line.match(/^(20\d{2})[-\/年](\d{1,2})月?$/);
      if (head) {
        month = head[1] + '-' + padTwo_(head[2]);
        result.対象月 = month;
        return;
      }

      var cols = line.split(/[\s,、]+/).filter(function (c) { return c; });
      if (cols.length < 4) { result.読めなかった行.push(line + ' … 4つに分かれていません'); return; }

      var date = parseShiftDate_(cols[0], month);
      if (!date) { result.読めなかった行.push(line + ' … 日付が読めません'); return; }

      var site = cols[1];
      var kind = cols[2];
      var name = cols.slice(3).join(' ');
      var member = matchStaffByName_(staff, name);
      if (!member) {
        result.読めなかった行.push(line + ' … 「' + name + '」がスタッフ一覧にありません');
        return;
      }

      var exists = findRow(SHEETS.SHIFT_PLAN, function (r) {
        return toDateStr_(r['日付']) === date
          && String(r['staff_id']) === String(member['staff_id'])
          && String(r['拠点']) === site;
      });
      if (exists) {
        updateRow(SHEETS.SHIFT_PLAN, exists._row, { '勤務区分': kind, '取込元': 'paste' });
        result.更新++;
      } else {
        appendRow(SHEETS.SHIFT_PLAN, {
          '日付': date,
          'staff_id': String(member['staff_id']),
          '拠点': site,
          '勤務区分': kind,
          '開始時刻': '',
          '終了時刻': '',
          '取込元': 'paste'
        });
        result.追加++;
      }
    });

    if (!result.対象月) result.対象月 = month;
    logInfo(proc, '追加' + result.追加 + '件 / 更新' + result.更新 + '件 / 読めなかった行'
      + result.読めなかった行.length + '件（対象月 ' + result.対象月 + '）');
    return result;
  }, function () {
    return { 追加: 0, 更新: 0, 読めなかった行: ['他の処理が実行中でした。もう一度お試しください'], 対象月: '' };
  });
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
    return toDateStr_(r['日付']) === date && String(r['勤務区分']).indexOf('夜勤') >= 0;
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

// ============================================================================
// autofill.gs
// ============================================================================

/**
 * 自動充足（【08】v1.1 第4章／運用方針の確定：2026-08-12）
 *
 * 【このシステムの位置づけ】
 * AI Uriboは「記録を正しく作る装置」ではなく、**記録者と利用者の実態を素早くつかむための補助**である。
 * だから帳簿の隙間は、手元にあるあらゆるデータを使って**積極的に埋めにいく**。
 * 埋めたものが推定であれば「要精査」の印を付け、現場の人がそれを見て、
 * さまざまな可能性を理解したうえで支援し、必要なら記録を直す。記録は記録、支援は支援。
 *
 * したがって：
 *   ・確実な事実（センサーの検知そのもの）→ そのまま記録する
 *   ・そこから推測できること（服薬した可能性・在宅していた可能性 等）→ 推定として埋める（要精査=TRUE）
 *   ・推定を止めたいときは S8設定 autofill_estimate を FALSE にすれば事実だけになる
 *
 * 【精度が上がる仕組み】
 * 推定で埋めても、それだけでは当たっているか分からない。そこで当面は推定で埋めたうえで
 * 人にも同じことを聞き、回答と突き合わせて情報源ごとの精度を貯める（learn.gs）。
 * 十分に当たると分かった組み合わせは質問をやめ、外れが増えたら聞き直しに戻す。
 * 結果として、使うほど質問が減り、精度は保たれる。
 *
 * 実接続（ファイル形式・置き場所）はStage2で確定。現時点では
 * 「S4に生ログが入っていれば正規化して充足する」器として実装してある。
 * 生ログの入れ方は docs/自動ソース取込フォーマット.md を参照。
 */

/**
 * 自動充足ソースの定義。
 * map() が返す各項目：
 *   項目名   … S3チェック項目マスタの項目名（これに一致すると、その質問は人に聞かなくなる）
 *   値       … 記録する値（何を根拠にしたか分かる書き方にする）
 *   推定     … true なら「データからの推定」。要精査=TRUEで記録し、現場が精査できるようにする
 *   推定回答 … AIが「たぶんこの選択肢だろう」と読んだ答え（S3の選択肢と同じ文字列）。
 *              これが入っている推定だけが、人の回答と突き合わされて学習の対象になる。
 *              センサーからは選択肢を決めようがないもの（服薬の声かけ等）には持たせない＝ずっと人に聞く
 *   全利用者 … true なら有効な利用者全員に展開する（献立など全体に効く情報）
 * @type {Array.<Object>}
 */
var AUTOFILL_SOURCES = [
  {
    id: 'switchbot_medication',
    生ログ種別: 'raw_switchbot',
    必要フラグ: '服薬自動',
    説明: 'SwitchBot服薬ログ → 開放の事実＋服薬確認（推定）',
    map: function (raw) {
      var v = String(raw['値'] || '').trim();
      var detail = v ? ('開放を検知 ' + v) : '開放を検知';
      return [
        // 事実：箱が開いた
        { 項目名: '服薬ボックス開放', 値: detail + '（SwitchBot自動記録）' },
        // 推定：開いている以上、服薬された可能性が高い。夜勤の声かけもこのログが起点になっている
        { 項目名: '服薬確認', 値: '服薬したとみられる（' + detail + '／SwitchBot自動記録・要精査）', 推定: true }
      ];
    }
  },
  {
    id: 'door_sensor',
    生ログ種別: 'raw_door',
    必要フラグ: '在否自動',
    説明: '開閉センサーログ → 在否確認・夜間の動き・夜間巡回（推定）',
    map: function (raw) {
      var out = [{ 項目名: '在否確認', 値: '在室とみられる（開閉センサー自動記録）',
                   推定: true, 推定回答: '在宅' }];
      if (String(raw['項目名']).indexOf('夜間') >= 0) {
        var v = String(raw['値'] || '').trim();
        out.push({ 項目名: '夜間の動き', 値: '夜間の開閉を検知' + (v ? ' ' + v : '') + '（開閉センサー自動記録）' });
        out.push({ 項目名: '夜間巡回・就寝確認', 値: '居室で動きあり（開閉センサー自動記録・要精査）', 推定: true });
      }
      return out;
    }
  },
  {
    id: 'motion_sensor',
    生ログ種別: 'raw_motion',
    必要フラグ: '在否自動',
    説明: '人感・Presenceセンサー → 在否確認・夜間巡回（推定）',
    map: function (raw) {
      var night = String(raw['項目名']).indexOf('夜間') >= 0;
      var out = [{ 項目名: '在否確認', 値: '在室とみられる（人感センサー自動記録）',
                   推定: true, 推定回答: '在宅' }];
      if (night) {
        out.push({ 項目名: '夜間の動き', 値: String(raw['値'] || '夜間に動きを検知') + '（人感センサー自動記録）' });
        out.push({ 項目名: '夜間巡回・就寝確認', 値: '居室で動きあり（人感センサー自動記録・要精査）', 推定: true });
      }
      return out;
    }
  },
  {
    id: 'lock_sensor',
    生ログ種別: 'raw_lock',
    必要フラグ: '',
    説明: 'スマートロック → 戸締まり確認（推定）',
    map: function (raw) {
      var v = String(raw['値'] || '');
      if (v.indexOf('施錠されている') < 0) return [];
      return [{ 項目名: '戸締まり確認', 値: v + '（スマートロック自動記録・要精査）', 推定: true }];
    }
  },
  {
    id: 'meter_sensor',
    生ログ種別: 'raw_meter',
    必要フラグ: '',
    説明: '温湿度計・Hub2 → 居室環境（実測値なので推定ではない）',
    map: function (raw) {
      var v = String(raw['値'] || '');
      if (!v) return [];
      return [{ 項目名: '居室環境', 値: v + '（自動記録）', 全利用者: String(raw['対象'] || 'ALL') === 'ALL' }];
    }
  },
  {
    id: 'labo_attendance',
    生ログ種別: 'raw_labo',
    必要フラグ: '日中自動',
    説明: 'うりぼラボ出勤情報 → 在否確認・日中活動',
    map: function (raw) {
      return [
        { 項目名: '在否確認', 値: '在宅（ラボ出勤記録より）', 推定: true, 推定回答: '在宅' },
        { 項目名: '日中活動', 値: 'ラボ出勤（出勤記録より）', 推定: true, 推定回答: '参加した' }
      ];
    }
  },
  {
    id: 'inoya_nisshi',
    生ログ種別: 'raw_inoya',
    必要フラグ: '',   // 拠点全体の情報なので利用者フラグの制約を受けない
    説明: '猪ノ屋業務日誌 → 天気・献立を転記し、献立があれば食事提供も推定',
    map: function (raw) {
      var name = String(raw['項目名']);
      var value = String(raw['値']);
      var out = [{ 項目名: name, 値: value }];
      if (name === '献立' && value) {
        out.push({
          項目名: '食事提供',
          値: '提供あり（献立記録：' + truncate_(value, 40) + '／要精査）',
          推定: true, 推定回答: '朝夕とも提供', 全利用者: true
        });
      }
      return out;
    }
  },
  {
    id: 'openclaw_vision',
    生ログ種別: 'raw_openclaw',
    必要フラグ: '',
    説明: 'AIハブ（OpenClaw）の映像解析メモ → 該当項目を推定で埋める',
    map: function (raw) {
      // AIハブのVLMが映像から読み取った内容が、すでにAI Uriboの項目名で届く前提。
      // 映像そのものは受け取らない（台帳に入るのは言葉だけ）。
      var name = String(raw['項目名'] || '').trim();
      if (!name) return [];
      return [{
        項目名: name,
        値: String(raw['値']) + '（AIハブ映像解析・要精査）',
        推定: true,
        全利用者: String(raw['対象'] || 'ALL') === 'ALL'
      }];
    }
  },
  {
    id: 'summary_scan',
    生ログ種別: 'raw_summary',
    必要フラグ: '',
    説明: 'AIまとめ等の文章をS3の検出キーワードで走査し、該当項目を推定で埋める',
    map: function (raw) {
      var text = String(raw['値'] || '');
      if (!text) return [];
      var out = [];
      findRows(SHEETS.CHECK, function (c) { return String(c['検出キーワード'] || '').trim(); })
        .forEach(function (c) {
          var words = String(c['検出キーワード']).split(',').map(function (w) { return w.trim(); })
            .filter(function (w) { return w; });
          var hit = words.filter(function (w) { return text.indexOf(w) >= 0; });
          if (!hit.length) return;
          out.push({
            項目名: String(c['項目名']),
            値: excerptAround_(text, hit[0]) + '（AIまとめより／該当語：' + hit.join('・') + '）',
            推定: true,
            全利用者: String(raw['対象'] || 'ALL') === 'ALL'
          });
        });
      return out;
    }
  },
  {
    id: 'plan_carryover',
    生ログ種別: 'plan',           // 前夜に本人へ確認した「明日の予定」
    必要フラグ: '',
    説明: '前夜に聞いた予定 → 実績の推定（予定どおりなら聞き直さない）',
    map: function (raw) {
      var name = String(raw['項目名']);
      var value = String(raw['値']).split('／')[0].trim();
      var pairs = {
        '予定_帰省': { 'あり': { 項目名: '在否確認', 値: '外泊・帰省（前夜の予定より）', 推定回答: '外泊・帰省' } },
        '予定_外出': {
          'あり': { 項目名: '外出・帰宅時間', 値: '外出あり（前夜の予定より）', 推定回答: '外出あり（一言記入）' },
          'なし': { 項目名: '外出・帰宅時間', 値: '外出なし（前夜の予定より）', 推定回答: '外出なし' }
        },
        '予定_ラボ出勤': { 'あり': { 項目名: '日中活動', 値: 'ラボ出勤（前夜の予定より）', 推定回答: '参加した' } },
        '予定_食事': {
          '朝夕とも必要': { 項目名: '食事提供', 値: '朝夕とも提供（前夜の予定より）', 推定回答: '朝夕とも提供' },
          '不要': { 項目名: '食事提供', 値: '提供なし（前夜の予定より）', 推定回答: '提供なし' }
        }
      };
      var hit = pairs[name] && pairs[name][value];
      if (!hit) return [];
      return [{ 項目名: hit.項目名, 値: hit.値 + '（要精査）', 推定: true, 推定回答: hit.推定回答 }];
    }
  }
];

/**
 * 自動充足を実行する。detectGaps の直前に必ず呼ぶこと。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {{filled:number, estimated:number, autoConfirmed:number, bySource:Object.<string,number>, skipped:number}} 充足結果
 */
function runAutoFill(targetDate) {
  var proc = 'runAutoFill';
  // 「無ければ書く」の判定と追記の間に他の実行が割り込まないよう直列化する（再入可能）
  return withLock_(proc, 120000, function () { return runAutoFillBody_(proc, targetDate); },
    function () { return { filled: 0, estimated: 0, autoConfirmed: 0, bySource: {}, skipped: 0 }; });
}

/**
 * 自動充足の本体（ロック取得済みの状態で呼ばれる）。
 * @param {string} proc ログ用の処理名
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {{filled:number, estimated:number, autoConfirmed:number, bySource:Object.<string,number>, skipped:number}} 充足結果
 */
function runAutoFillBody_(proc, targetDate) {
  var date = toDateStr_(targetDate);
  logStart(proc, date);

  var useEstimate = isTrue_(getSetting('autofill_estimate', 'TRUE'));
  var users = {};
  var activeCodes = [];
  findRows(SHEETS.USER).forEach(function (u) {
    users[String(u['user_code'])] = u;
    if (isTrue_(u['有効'])) activeCodes.push(String(u['user_code']));
  });

  // シフト表に夜勤の予定があれば、その日の夜勤担当者を先に記録しておく
  // （決まっていることを毎日聞かないため。記録には担当者名が残る）
  safely_(proc, function () { fillNightStaffFromShift_(date); });

  var logs = findRows(SHEETS.LOG_IMPORT, function (r) { return toDateStr_(r['発生日']) === date; });

  // すでにある支援記録ログ（対象＋項目名）を索引化して二重書き込みを防ぐ
  var have = {};
  logs.forEach(function (r) {
    if (String(r['対象種別']) === 'support') have[r['対象'] + '\t' + r['項目名']] = true;
  });

  var result = { filled: 0, estimated: 0, autoConfirmed: 0, bySource: {}, skipped: 0 };

  AUTOFILL_SOURCES.forEach(function (src) {
    result.bySource[src.id] = 0;
    safely_(proc + ':' + src.id, function () {
      logs.filter(function (r) { return String(r['対象種別']) === src.生ログ種別; })
        .forEach(function (raw) {
          var rawTarget = String(raw['対象'] || 'ALL');

          src.map(raw).forEach(function (fill) {
            if (!fill.項目名) return;
            if (fill.推定 && !useEstimate) { result.skipped++; return; }

            // 全体情報（献立など）は有効な利用者全員に展開する
            var targets = fill.全利用者 ? activeCodes : [rawTarget];
            targets.forEach(function (target) {
              var user = users[target];

              // 利用者マスタで自動対応フラグがOFFなら自動充足しない（人に聞く）
              if (src.必要フラグ) {
                if (!user || !isTrue_(user[src.必要フラグ]) || !isTrue_(user['有効'])) {
                  result.skipped++;
                  return;
                }
              } else if (user && !isTrue_(user['有効'])) {
                result.skipped++;
                return;
              }

              var key = target + '\t' + fill.項目名;
              if (have[key]) { result.skipped++; return; }
              have[key] = true;
              var certainty = certaintyOf_(src.id, fill);
              writeAutoFill_(date, target, fill, src.id, certainty);
              result.filled++;
              if (fill.推定) result.estimated++;
              if (certainty === CERTAINTY.AUTO) result.autoConfirmed++;
              result.bySource[src.id]++;
            });
          });
        });
    });
  });

  logInfo(proc, '自動充足 ' + result.filled + '件（うち推定 ' + result.estimated + '件'
    + '／学習済みで質問を省いたもの ' + result.autoConfirmed + '件・'
    + JSON.stringify(result.bySource) + '） / スキップ ' + result.skipped + '件');
  return result;
}

/**
 * この1件を「人にも確認するか、もう確認しないか」を学習の実績から決める。
 *
 * ・事実のログ（推定ではない）           → 確定。もともと質問しない
 * ・推定回答を持たない推定               → 推定。ずっと人に聞く（機械には決めようがないもの）
 * ・学習が「自動確定」まで育った推定     → 自動確定。人に聞かない（ただし抜き打ちの回だけは聞く）
 * ・それ以外の推定（学習中・要見直し）   → 推定。埋めたうえで人にも聞き、当たり外れを貯める
 * @param {string} sourceId 自動ソースのid
 * @param {{項目名:string, 推定:boolean, 推定回答:string}} fill 充足内容
 * @return {string} CERTAINTY のいずれか
 */
function certaintyOf_(sourceId, fill) {
  if (!fill.推定) return CERTAINTY.FIXED;
  if (!fill.推定回答) return CERTAINTY.ESTIMATED;
  if (learnStage_(sourceId, fill.項目名) !== LEARN_STAGE.AUTO) return CERTAINTY.ESTIMATED;
  return learnSpotCheckDue_(sourceId, fill.項目名) ? CERTAINTY.ESTIMATED : CERTAINTY.AUTO;
}

/**
 * 自動充足の1件をS4（記録）とS7（既存アプリへの還元）に書く。
 * @param {string} date 対象日
 * @param {string} target 対象（user_code など）
 * @param {{項目名:string, 値:string, 推定:boolean, 推定回答:string}} fill 充足内容
 * @param {string} sourceId 自動ソースのid
 * @param {string} certainty 確度（CERTAINTY）
 * @return {void}
 */
function writeAutoFill_(date, target, fill, sourceId, certainty) {
  var level = certainty || (fill.推定 ? CERTAINTY.ESTIMATED : CERTAINTY.FIXED);
  appendRow(SHEETS.LOG_IMPORT, {
    'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
    '発生日': date,
    '対象種別': 'support',
    '対象': target,
    '項目名': fill.項目名,
    '値': fill.値,
    '取込元': sourceId,
    '取込日時': nowStr_(),
    '確度': level,
    '推定回答': fill.推定回答 || ''
  });
  appendRow(SHEETS.FILL, {
    'fill_id': nextSeqId_(SHEETS.FILL, 'fill_id', 'FIL', 6),
    '対象日': date,
    '対象': target,
    '項目名': fill.項目名,
    '値': fill.値,
    '記入者staff_id': 'AUTO:' + sourceId,
    '取込済フラグ': false,
    '作成日時': nowStr_(),
    '情報源': (fill.推定 ? '自動推定（' : '自動ログ（') + sourceId
      + (level === CERTAINTY.AUTO ? '・学習済み' : '') + '）',
    '要精査': fill.推定 ? true : false,
    '精査結果': ''
  });
}

/**
 * 文章から、該当語の周辺だけを切り出す（記録に残すのは要点だけにするため）。
 * @param {string} text 全文
 * @param {string} word 該当語
 * @param {number} [span] 前後に取る文字数
 * @return {string} 抜粋
 */
function excerptAround_(text, word, span) {
  var n = span || 30;
  var i = text.indexOf(word);
  if (i < 0) return truncate_(text, n * 2);
  var from = Math.max(0, i - n);
  var to = Math.min(text.length, i + word.length + n);
  return (from > 0 ? '…' : '') + text.substring(from, to) + (to < text.length ? '…' : '');
}

/**
 * その日の文章ログ（AIまとめ等）に注意すべき語が無いか調べ、あれば社員へすぐ知らせる。
 * 「転倒」「うつ伏せ」などは、記録として埋めるだけでなく人が気づく必要があるため。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @return {number} 通知した件数
 */
function scanAlerts_(targetDate) {
  var proc = 'scanAlerts_';
  var words = String(getSetting('alert_keywords', '')).split(',')
    .map(function (w) { return w.trim(); }).filter(function (w) { return w; });
  if (!words.length) return 0;

  var date = toDateStr_(targetDate);
  var texts = findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date
      && (String(r['対象種別']).indexOf('raw_summary') === 0 || String(r['対象種別']).indexOf('raw_openclaw') === 0);
  });

  var sent = 0;
  texts.forEach(function (r) {
    safely_(proc, function () {
      var text = String(r['値'] || '');
      var hit = words.filter(function (w) { return text.indexOf(w) >= 0; });
      if (!hit.length) return;

      // 同じ日・同じ語で二度知らせない
      var cache = CacheService.getScriptCache();
      var key = 'alert_' + date + '_' + hit.join('_') + '_' + String(r['対象']);
      if (cache.get(key)) return;
      cache.put(key, '1', 86400);

      // AIの読み取りは誤りが多い。断定せずに知らせ、事実かどうかを人に判定してもらう
      var msg = '【AIが気にした記述】' + date + '　' + displayName_(String(r['対象'])) + '\n'
        + '「' + hit.join('・') + '」という語が見つかりました。\n\n'
        + excerptAround_(text, hit[0], 60) + '\n\n'
        + '※これはカメラのAIが書いた文章です。**誤りが多く含まれます。**\n'
        + '　事実かどうかだけ、下のボタンで教えてください。';
      var key2 = date + '|' + hit[0] + '|' + String(r['対象']);
      var buttons = msgButtons_('AIの読み取り確認', '実際にあったことですか？', [
        { label: '事実だった', data: 'alert|ok|' + key2 },
        { label: 'これは違う（誤検知）', data: 'alert|ng|' + key2 },
        { label: '判断できない', data: 'alert|unknown|' + key2 }
      ]);
      sent += sendToEscalationStaff([msgText_(msg), buttons], proc);
      logWarn(proc, date + ' に注意語を検出: ' + hit.join('・'));
    });
  });
  return sent;
}

/**
 * 指定期間の自動充足件数を数える（週次ダイジェストの自動充足率算出用）。
 * @param {string} fromDate 開始日 YYYY-MM-DD
 * @param {string} toDate 終了日 YYYY-MM-DD
 * @return {number} 自動ソース由来のS4ログ件数
 */
function countAutoFilled_(fromDate, toDate) {
  var ids = AUTOFILL_SOURCES.map(function (s) { return s.id; });
  return findRows(SHEETS.LOG_IMPORT, function (r) {
    var d = toDateStr_(r['発生日']);
    return d >= toDateStr_(fromDate) && d <= toDateStr_(toDate) && ids.indexOf(String(r['取込元'])) >= 0;
  }).length;
}

/**
 * 指定期間の「要精査」（推定で埋めた）件数を数える。
 * @param {string} fromDate 開始日 YYYY-MM-DD
 * @param {string} toDate 終了日 YYYY-MM-DD
 * @return {number} 要精査の件数
 */
function countNeedsReview_(fromDate, toDate) {
  return findRows(SHEETS.FILL, function (r) {
    var d = toDateStr_(r['対象日']);
    return d >= toDateStr_(fromDate) && d <= toDateStr_(toDate) && isTrue_(r['要精査']);
  }).length;
}

// ============================================================================
// consistency.gs
// ============================================================================

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

// ============================================================================
// detect.gs
// ============================================================================

/**
 * 不足検出（04_不足判定ルール仕様.md / 06 Step4）
 *
 * 判定ロジックは detectGaps() に完全分離してある。
 * Phase4でAI化する場合は、この関数の中身をAnthropic API呼び出しに差し替えるだけでよい。
 *   detectGaps(targetDate) → [{check_id, 対象, 対象日, 理由}]
 *
 * 個別ルールはS3チェック項目マスタの「判定ルールID」で切り替える。
 * S3で 有効=FALSE の項目は一切検出しない（Phase1はR01のみ有効）。
 */

/**
 * 指定日の不足を検出する（AI化の差し替えポイント）。
 * ※呼び出し前に必ず runAutoFill(targetDate) を実行すること。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @param {Array.<string>} [ruleFilter] 実行するルールIDの限定（省略時は R01/R02）
 * @return {Array.<{check_id:string, 対象:string, 対象日:string, 理由:string}>} 不足の配列
 */
function detectGaps(targetDate, ruleFilter) {
  var proc = 'detectGaps';
  var date = toDateStr_(targetDate);
  var rules = ruleFilter || ['R01', 'R02'];
  var gaps = [];

  var checks = findRows(SHEETS.CHECK, function (r) { return isTrue_(r['有効']); });
  checks.forEach(function (c) {
    var rule = String(c['判定ルールID']);
    if (rules.indexOf(rule) < 0) return;
    safely_(proc + ':' + c['check_id'], function () {
      switch (rule) {
        case 'R01': gaps = gaps.concat(ruleR01_(date, c)); break;
        case 'R02': gaps = gaps.concat(ruleR02_(date, c)); break;
        case 'R04': gaps = gaps.concat(ruleR04_(date, c)); break;
        case 'R05': gaps = gaps.concat(ruleR05_(date, c)); break;
        default: logWarn(proc, '未対応の判定ルールID: ' + rule + '（' + c['check_id'] + '）');
      }
    });
  });

  logInfo(proc, date + ' の不足 ' + gaps.length + '件（ルール: ' + rules.join(',') + '）');
  return gaps;
}

/**
 * R01：シフト希望未回答（Phase1のテスト題材）。
 * 毎月 shift_request_day 〜 shift_deadline_day の間だけ発火し、翌月分の希望が
 * S4に無い有効スタッフを不足として検出する。
 * @param {string} targetDate 対象日（判定は実行日で行う）
 * @param {Object} check S3の行
 * @return {Array.<Object>} 不足の配列
 */
function ruleR01_(targetDate, check) {
  var today = new Date();
  var day = parseInt(Utilities.formatDate(today, TZ, 'd'), 10);
  var from = getSettingNum('shift_request_day', 20);
  var to = getSettingNum('shift_deadline_day', 25);
  if (day < from || day > to) return [];

  var targetMonth = nextMonthStr_(today);          // 例：2026-09
  var monthKey = targetMonth + '-01';              // 不足の対象日（重複検出防止のキー）

  var answered = {};
  findRows(SHEETS.LOG_IMPORT, function (r) {
    return String(r['対象種別']) === 'shift' && String(r['項目名']) === String(check['項目名']);
  }).forEach(function (r) {
    if (String(r['値']).indexOf(targetMonth) >= 0) answered[String(r['対象'])] = true;
  });

  var gaps = [];
  findRows(SHEETS.STAFF, function (r) { return isTrue_(r['有効']); }).forEach(function (s) {
    if (answered[String(s['staff_id'])]) return;
    gaps.push({
      check_id: String(check['check_id']),
      対象: String(s['staff_id']),
      対象日: monthKey,
      理由: targetMonth + '分のシフト希望が未提出（締切' + to + '日）'
    });
  });
  return gaps;
}

/**
 * R02：日次記録の欠落（Phase2・清水）。
 * S2の有効な利用者 × 当該チェック項目について、S4に前日分のログが無いものを検出する。
 * 自動充足済みのものは runAutoFill() でS4に書かれているため、ここでは自然に除外される。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @param {Object} check S3の行
 * @return {Array.<Object>} 不足の配列
 */
function ruleR02_(targetDate, check) {
  var date = toDateStr_(targetDate);
  var logs = findRows(SHEETS.LOG_IMPORT, function (r) { return toDateStr_(r['発生日']) === date; });

  var have = {};
  var absent = {};
  logs.forEach(function (r) {
    var target = String(r['対象']);
    var name = String(r['項目名']);
    if (String(r['対象種別']) === 'support') {
      // 確度=推定 の行は「埋めてはあるが、まだ人に確かめていない」もの。
      // 記録としては残したまま、質問は出す（learn.gs が実績を貯め、当たるようになったら
      // 確度=自動確定 に変わって、この行も「聞かなくてよい」側に入る）。
      if (String(r['確度']) !== CERTAINTY.ESTIMATED) have[target + '\t' + name] = true;
      // 在否確認が外泊・入院・帰省なら、その日はその利用者の全項目を判定除外
      if (name === '在否確認' && /外泊|入院|帰省|不在/.test(String(r['値']))) absent[target] = true;
      if (name === '不在') absent[target] = true;
    }
    // 予定ログで帰省・外泊が入っていればその日は判定除外
    if (String(r['対象種別']) === 'plan' && name === '予定_帰省' && String(r['値']) === 'あり') absent[target] = true;
  });

  var gaps = [];
  findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); }).forEach(function (u) {
    var code = String(u['user_code']);
    if (absent[code]) return;
    if (have[code + '\t' + String(check['項目名'])]) return;
    gaps.push({
      check_id: String(check['check_id']),
      対象: code,
      対象日: date,
      理由: date + 'の「' + check['項目名'] + '」の記録なし'
    });
  });
  return gaps;
}

/**
 * R04：明日の予定の未確認（夜の確認セット用）。
 * S4に 対象種別=plan の予定ログが無い利用者を検出する。
 * @param {string} targetDate 予定を確認したい日（＝明日）YYYY-MM-DD
 * @param {Object} check S3の行
 * @return {Array.<Object>} 不足の配列
 */
function ruleR04_(targetDate, check) {
  var date = toDateStr_(targetDate);
  var have = {};
  findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date && String(r['対象種別']) === 'plan';
  }).forEach(function (r) { have[String(r['対象']) + '\t' + String(r['項目名'])] = true; });

  var gaps = [];
  findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); }).forEach(function (u) {
    var code = String(u['user_code']);
    if (have[code + '\t' + String(check['項目名'])]) return;
    gaps.push({
      check_id: String(check['check_id']),
      対象: code,
      対象日: date,
      理由: date + 'の「' + check['項目名'] + '」が未確認'
    });
  });
  return gaps;
}

/**
 * R05：その日の夜勤担当者が未記録。
 * 利用者ごとではなく「拠点ごとに1日1問」だけ聞く。この回答が、同じ日・同じ拠点の
 * 全記録の「支援担当者」になり、監査で問われる「誰が支援したか」を満たす。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @param {Object} check S3の行
 * @return {Array.<Object>} 不足の配列
 */
function ruleR05_(targetDate, check) {
  var date = toDateStr_(targetDate);
  var have = {};
  findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date && String(r['項目名']) === String(check['項目名']);
  }).forEach(function (r) { have[String(r['対象'])] = true; });

  // 有効な利用者がいる拠点だけを対象にする（誰もいない拠点には聞かない）
  var sites = {};
  findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); })
    .forEach(function (u) { if (u['拠点']) sites[String(u['拠点'])] = true; });

  var gaps = [];
  Object.keys(sites).forEach(function (site) {
    if (have[site]) return;
    gaps.push({
      check_id: String(check['check_id']),
      対象: site,
      対象日: date,
      理由: date + 'の' + site + 'の夜勤担当者が未記録'
    });
  });
  return gaps;
}

/**
 * 指定日・指定拠点の夜勤担当者名を返す（記録されていなければ空文字）。
 * @param {string} targetDate 対象日 YYYY-MM-DD
 * @param {string} site 拠点
 * @return {string} 夜勤担当者名
 */
function nightStaffNameOf_(targetDate, site) {
  var row = findRow(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === toDateStr_(targetDate)
      && String(r['項目名']) === '夜勤担当者'
      && String(r['対象']) === String(site);
  });
  if (!row) return '';
  // 「その他（名前を入力）／山田太郎」のように追記されている場合は後半を採る
  var parts = String(row['値']).split('／');
  return parts.length > 1 ? parts[parts.length - 1].trim() : String(row['値']).trim();
}

/**
 * 検出した不足をS5に登録する。
 * 同一（対象日 × check_id × 対象）が既に存在する場合は登録しない（二重検出防止）。
 * @param {Array.<Object>} gaps detectGapsの戻り値
 * @return {Array.<Object>} 新規登録したS5行オブジェクト（gap_id・check・対象日などを含む）
 */
function registerGaps(gaps) {
  var proc = 'registerGaps';
  // 重複確認と追記の間に他の実行が割り込まないよう直列化する（再入可能）
  return withLock_(proc, 120000, function () { return registerGapsBody_(proc, gaps); }, function () { return []; });
}

/**
 * 不足登録の本体（ロック取得済みの状態で呼ばれる）。
 * @param {string} proc ログ用の処理名
 * @param {Array.<Object>} gaps detectGapsの戻り値
 * @return {Array.<Object>} 新規登録した不足の配列
 */
function registerGapsBody_(proc, gaps) {
  var existing = {};
  findRows(SHEETS.GAP).forEach(function (r) {
    existing[toDateStr_(r['対象日']) + '\t' + r['check_id'] + '\t' + r['対象']] = true;
  });

  var created = [];
  gaps.forEach(function (g) {
    safely_(proc, function () {
      var key = toDateStr_(g.対象日) + '\t' + g.check_id + '\t' + g.対象;
      if (existing[key]) return;
      existing[key] = true;

      var check = checkById_(g.check_id);
      var assignees = resolveAssignees_(check, g.対象日, g.対象);
      var gapId = nextGapId_(todayStr_());
      appendRow(SHEETS.GAP, {
        'gap_id': gapId,
        '対象日': toDateStr_(g.対象日),
        'check_id': g.check_id,
        '対象': g.対象,
        '状態': GAP_STATUS.DETECTED,
        '検出日時': nowStr_(),
        '一次確認先staff_id': assignees.join(','),
        '完了日時': ''
      });
      created.push({
        gap_id: gapId,
        対象日: toDateStr_(g.対象日),
        check_id: g.check_id,
        対象: g.対象,
        理由: g.理由,
        assignees: assignees,
        check: check
      });
    });
  });

  logInfo(proc, '新規登録 ' + created.length + '件 / 検出 ' + gaps.length + '件');
  return created;
}

/**
 * 一次確認先のstaff_idを決める。
 * ・シフト希望（確認先役割=本人・対象がstaff_id）→ 本人
 * ・Stage1 → 藤原様・服部様（エスカレーション先フラグ=TRUE）にまとめて確認
 * ・Stage2以降 → S11勤務予定から該当役割の担当者を特定（居なければエスカレーション先へ）
 * @param {Object} check S3の行
 * @param {string} targetDate 対象日
 * @param {string} target 対象（user_code または staff_id）
 * @return {Array.<string>} staff_idの配列
 */
function resolveAssignees_(check, targetDate, target) {
  var fallback = escalationStaff_().map(function (s) { return String(s['staff_id']); });
  if (!check) return fallback;

  // 本人（＝スタッフ自身）に聞く項目
  if (String(check['対象種別']) === 'shift' && String(check['確認先役割']) === '本人') {
    var self = staffById_(target);
    if (self && isTrue_(self['有効'])) return [String(self['staff_id'])];
    return fallback;
  }

  var stage = getSettingNum('stage', 1);
  if (stage <= 1) return fallback;

  // Stage2以降：勤務予定から確認先役割の担当者を探す
  var role = String(check['確認先役割']);
  var onDuty = findRows(SHEETS.SHIFT_PLAN, function (r) {
    return toDateStr_(r['日付']) === toDateStr_(targetDate) && String(r['勤務区分']).indexOf(role) >= 0;
  }).map(function (r) { return String(r['staff_id']); });

  var valid = onDuty.filter(function (id) {
    var s = staffById_(id);
    return s && isTrue_(s['有効']) && String(s['line_user_id'] || '').trim();
  });
  return valid.length ? valid : fallback;
}

/**
 * 翌月を YYYY-MM 形式で返す。
 * @param {Date} base 基準日
 * @return {string} YYYY-MM
 */
function nextMonthStr_(base) {
  var d = new Date(base.getTime());
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  return Utilities.formatDate(d, TZ, 'yyyy-MM');
}

/**
 * 滞留している不足（確認中のまま stale_hours 時間以上経過）を返す（R03の判定部）。
 * 【08】v1.1で17:00エスカレーションは廃止したため、週次ダイジェストから使う。
 * @return {Array.<Object>} S5の行オブジェクト配列
 */
function findStaleGaps_() {
  var limit = getSettingNum('stale_hours', 8) * 3600 * 1000;
  var now = new Date().getTime();
  return findRows(SHEETS.GAP, function (r) {
    if (String(r['状態']) !== GAP_STATUS.ASKING) return false;
    var t = toDateTimeStr_(r['検出日時']);
    if (!t) return false;
    var d = new Date(t.replace(' ', 'T') + ':00+09:00');
    return !isNaN(d.getTime()) && (now - d.getTime()) >= limit;
  });
}

// ============================================================================
// ask.gs
// ============================================================================

/**
 * 確認セットの組み立てと回答処理（03_LINE会話仕様.md F2・F3 /【08】まとめ回答形式）
 *
 * 1通に質問を詰め込まず、「項目ごとにボタンをタップ → 次の質問が届く」連続フローにする。
 * 1セット＝S6の複数行（同じセットid、並び順で順番管理）。
 * 誰か1人が回答した不足は、他の人の待機タスクを自動で中止する。
 */

/**
 * 確認セットを作成し、最初の質問を送る。
 * @param {string} staffId 送信先staff_id
 * @param {Array.<Object>} gaps S5の行オブジェクト（gap_id・対象日・check_id・対象を含む）
 * @param {string} title セットの見出し（例：【昨日(8/11)の記録確認】）
 * @return {{setId:string, count:number, sent:boolean}} 作成結果
 */
function createAndSendSet(staffId, gaps, title) {
  var proc = 'createAndSendSet';
  if (!gaps || !gaps.length) return { setId: '', count: 0, sent: false };

  var setId = nextSeqId_(SHEETS.TASK, 'セットid', 'SET', 5);
  gaps.forEach(function (g, i) {
    appendRow(SHEETS.TASK, {
      'task_id': nextSeqId_(SHEETS.TASK, 'task_id', 'TSK', 5),
      'gap_id': g.gap_id,
      '送信先staff_id': staffId,
      '送信状態': SEND_STATUS.WAITING,
      '再送回数': 0,
      '追記待ち': false,
      'セットid': setId,
      '並び順': i + 1
    });
  });

  var intro = msgText_(title + '\n全' + gaps.length + '件です。ボタンで順番にお答えください。');
  var result = sendNextInSet_(setId, null, [intro]);
  logInfo(proc, staffId + ' へ ' + gaps.length + '件の確認セット（' + setId + '）を作成 / 送信=' + result);
  return { setId: setId, count: gaps.length, sent: (result === SEND_RESULT.SENT) };
}

/**
 * sendNextInSet_ の戻り値。
 * SENT=次の質問を送った / NONE=残りが無い / FAILED=送信に失敗した（replyTokenは使用済みの可能性）
 * @type {Object.<string,string>}
 */
var SEND_RESULT = { SENT: 'sent', NONE: 'none', FAILED: 'failed' };

/**
 * セット内の次の未送信タスクを1件送る。
 * @param {string} setId セットid
 * @param {string} [replyToken] 返信トークン（webhookからの応答時に指定）
 * @param {Array.<Object>} [prefixMessages] 質問の前に付けるメッセージ（お礼など）
 * @return {string} SEND_RESULT のいずれか
 */
function sendNextInSet_(setId, replyToken, prefixMessages) {
  var proc = 'sendNextInSet_';
  var tasks = findRows(SHEETS.TASK, function (r) {
    return String(r['セットid']) === String(setId) && String(r['送信状態']) === SEND_STATUS.WAITING;
  }).sort(function (a, b) { return Number(a['並び順']) - Number(b['並び順']); });

  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var gap = findRow(SHEETS.GAP, { 'gap_id': t['gap_id'] });
    if (!gap) { updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED }); continue; }
    if (String(gap['状態']) === GAP_STATUS.DONE) {
      updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED });
      continue;
    }
    var check = checkById_(gap['check_id']);
    if (!check) { updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED }); continue; }

    var remain = tasks.length - i - 1;
    var messages = (prefixMessages || []).concat(buildQuestion_(t, gap, check, remain));

    if (replyToken) {
      var ok = replyRaw_(replyToken, messages);
      updateRow(SHEETS.TASK, t._row, {
        '送信本文': JSON.stringify(messages),
        // 返信に失敗した分は「失敗」にしておくと flushQueue がpushで送り直す
        '送信状態': ok ? SEND_STATUS.SENT : SEND_STATUS.FAILED,
        '送信日時': ok ? nowStr_() : '',
        '作成日時': t['作成日時'] || nowStr_()
      });
      if (ok) updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.ASKING });
      return ok ? SEND_RESULT.SENT : SEND_RESULT.FAILED;
    }

    var res = sendToStaff(t['送信先staff_id'], messages, { taskRowNumber: t._row, label: proc });
    if (res.ok && !res.queued) updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.ASKING });
    return res.ok ? SEND_RESULT.SENT : SEND_RESULT.FAILED;
  }

  // 残りが無い場合は何も送らない（呼び出し側が完了メッセージを返す）
  return SEND_RESULT.NONE;
}

/**
 * 1件分の質問メッセージを作る。質問文・選択肢はS3チェック項目マスタの内容を使う。
 * S3の「参照ログ」に項目名が入っていれば、その自動ログを判断材料として質問の前に添える。
 * （自動データを支援の記録の代わりにせず、人が判断するための材料として見せるための仕組み）
 * @param {Object} task S6の行
 * @param {Object} gap S5の行
 * @param {Object} check S3の行
 * @param {number} remain このセットの残り件数
 * @return {Array.<Object>} LINEメッセージオブジェクトの配列
 */
function buildQuestion_(task, gap, check, remain) {
  var text = fillPlaceholders_(String(check['質問文']), gap);
  var choices = expandChoices_(String(check['選択肢'] || ''));
  if (!choices.length) choices = ['済', 'できていない', 'わからない'];

  var actions = choices.map(function (c) {
    return { label: c, data: 'ans|' + task['task_id'] + '|' + c };
  });
  var title = String(check['項目名']);
  if (remain > 0) title += '（残り' + remain + '件）';

  var messages = [];
  var context = referenceLogText_(gap, check);
  if (context) messages.push(msgText_(context));
  messages.push(msgButtons_(title, text, actions));
  return messages;
}

/**
 * 参照ログ（判断材料になる自動データ）の文面を作る。
 * @param {Object} gap S5の行
 * @param {Object} check S3の行
 * @return {string} 添える文面（無ければ空文字）
 */
function referenceLogText_(gap, check) {
  var name = String(check['参照ログ'] || '').trim();
  if (!name) return '';
  var row = safely_('referenceLogText_', function () {
    return findRow(SHEETS.LOG_IMPORT, function (r) {
      return toDateStr_(r['発生日']) === toDateStr_(gap['対象日'])
        && String(r['項目名']) === name
        && String(r['対象']) === String(gap['対象']);
    });
  }, null);
  if (!row) {
    return '（参考）' + toDateStr_(gap['対象日']) + ' の「' + name + '」の自動記録はありませんでした。';
  }
  return '（参考）' + name + '：' + String(row['値']);
}

/**
 * 選択肢を展開する。
 * `{夜勤スタッフ}` と書いておくと、S1の有効な夜勤スタッフの氏名（最大3名）＋「その他（名前を入力）」になる。
 * 名前をコードに埋め込まず、スタッフの入れ替わりに自動で追従させるための仕組み。
 * @param {string} raw S3の選択肢欄の値
 * @return {Array.<string>} 選択肢の配列
 */
function expandChoices_(raw) {
  if (String(raw).indexOf('{夜勤スタッフ}') < 0) {
    return String(raw).split('|').filter(function (s) { return s.trim(); });
  }
  var names = findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && String(r['役割']).indexOf('夜勤') >= 0;
  }).map(function (r) { return String(r['氏名']); }).slice(0, 3);
  return names.concat(['その他（名前を入力）']);
}

/**
 * 質問文のプレースホルダを埋める。
 * {対象}=利用者名またはスタッフ名 / {日付}=対象日 / {月}=対象月 / {締切日}=シフト締切日
 * @param {string} template 質問文テンプレート
 * @param {Object} gap S5の行
 * @return {string} 置換後の文字列
 */
function fillPlaceholders_(template, gap) {
  var date = toDateStr_(gap['対象日']);
  var md = date ? (Number(date.substring(5, 7)) + '/' + Number(date.substring(8, 10))) : '';
  var month = date ? (Number(date.substring(5, 7)) + '月') : '';
  return String(template)
    .replace(/\{対象\}/g, displayName_(String(gap['対象'])))
    .replace(/\{日付\}/g, md)
    .replace(/\{月\}/g, month)
    .replace(/\{締切日\}/g, String(getSettingNum('shift_deadline_day', 25)));
}

/**
 * コード（user_code / staff_id）を表示名に変換する。
 * S9対応表 → S1スタッフマスタの順で探し、見つからなければコードのまま返す。
 * @param {string} code コード
 * @return {string} 表示名
 */
function displayName_(code) {
  var staffTable = safely_('displayName_', function () { return readTable(SHEETS.STAFF); }, { rows: [] });
  if (displayName_._src !== staffTable || displayName_._len !== staffTable.rows.length) {
    var m = {};
    staffTable.rows.forEach(function (r) {
      if (r['氏名']) m[String(r['staff_id'])] = String(r['氏名']);
    });
    safely_('displayName_', function () {
      findRows(SHEETS.NAME_MAP).forEach(function (r) {
        if (r['氏名']) m[String(r['コード'])] = String(r['氏名']);
      });
    });
    displayName_._map = m;
    displayName_._src = staffTable;
    displayName_._len = staffTable.rows.length;
  }
  return displayName_._map[String(code)] || String(code);
}

/**
 * ボタン回答（postback: ans|task_id|値）を処理する。
 * @param {Object} staff 回答したスタッフのS1行
 * @param {string} taskId task_id
 * @param {string} answer 回答値
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function handleAnswer_(staff, taskId, answer, replyToken) {
  var proc = 'handleAnswer_';
  var task = findRow(SHEETS.TASK, { 'task_id': taskId });
  if (!task) {
    replyRaw_(replyToken, [msgText_('この確認は見つかりませんでした。お手数ですが「状況」と送って確認してください。')]);
    return;
  }
  if (String(task['回答'] || '').trim()) {
    replyRaw_(replyToken, [msgText_('この項目はすでに回答済みです。ありがとうございます。')]);
    return;
  }
  // 自分あての確認かどうかを必ず確認する（他人あてのタスクには回答させない）
  if (String(task['送信先staff_id']) !== String(staff['staff_id'])) {
    logWarn(proc, '回答権限のない操作: ' + staff['staff_id'] + ' → ' + taskId);
    replyRaw_(replyToken, [msgText_('この確認にはお答えいただけません。')]);
    return;
  }

  var gap = findRow(SHEETS.GAP, { 'gap_id': task['gap_id'] });
  var check = gap ? checkById_(gap['check_id']) : null;

  // すでに送信済みの質問に他の人が先に答えていた場合（同じ不足を2名に送っているため起こりうる）
  if (gap && String(gap['状態']) === GAP_STATUS.DONE) {
    updateRow(SHEETS.TASK, task._row, {
      '回答': answer + '（他の方が先に回答済み）',
      '回答日時': nowStr_(),
      '回答方法': 'ボタン'
    });
    var done = msgText_('この項目は他の方が回答済みでした。ありがとうございます。');
    if (sendNextInSet_(task['セットid'], replyToken, [done]) === SEND_RESULT.NONE) {
      replyRaw_(replyToken, [done]);
    }
    logInfo(proc, taskId + ' は他の人が回答済みのため二重記録しない');
    return;
  }

  updateRow(SHEETS.TASK, task._row, {
    '回答': answer,
    '回答日時': nowStr_(),
    '回答方法': 'ボタン'
  });

  var needNote = NEEDS_NOTE_ANSWERS.indexOf(answer) >= 0;
  var unknown = UNKNOWN_ANSWERS.indexOf(answer) >= 0;
  var later = (answer.indexOf('後で') === 0);

  if (gap) {
    if (later) {
      // 「後で」は不足のまま残し、翌日また確認する
      updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.DETECTED });
    } else if (unknown) {
      // 「わからない」は不足解消とみなさず滞留させる（04共通ルール）
      updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.ESCALATED });
    } else if (needNote) {
      // 一言待ち。追記を受け取った時点で記録として成立させる（handleNote_）
      updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.ANSWERED });
    } else {
      updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.ANSWERED });
      recordFill_(gap, check, answer, staff);
      updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.DONE, '完了日時': nowStr_() });
      cancelSiblingTasks_(gap['gap_id'], task['task_id']);
    }
  }
  logInfo(proc, staff['氏名'] + ' が ' + taskId + ' に「' + answer + '」と回答');

  if (needNote || unknown) {
    updateRow(SHEETS.TASK, task._row, { '追記待ち': true });
    replyRaw_(replyToken, [msgText_(NOTE_PROMPTS[answer] || NOTE_PROMPT_DEFAULT)]);
    return;
  }

  finishTurn_(task, replyToken);
}

/**
 * 回答受付後の締めくくり。次の質問があれば送り、無ければ完了メッセージを返す。
 * 送信に失敗した場合は同じreplyTokenを二度使わない（1回限りのため）。失敗分はflushQueueがpushで送る。
 * @param {Object} task S6の行
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function finishTurn_(task, replyToken) {
  var thanks = msgText_('ありがとうございます。記録に反映しました。');
  var result = sendNextInSet_(task['セットid'], replyToken, [thanks]);
  if (result === SEND_RESULT.NONE) {
    replyRaw_(replyToken, [msgText_('ありがとうございます。記録に反映しました。\nこれで全部完了です。おつかれさまでした。')]);
  } else if (result === SEND_RESULT.FAILED) {
    logWarn('finishTurn_', '返信に失敗したため、次の質問はpush送信に切り替えます（' + task['セットid'] + '）');
  }
}

/**
 * 自由記述（追記）を処理する。追記待ちのタスクがあれば回答に追記する。
 * @param {Object} staff スタッフのS1行
 * @param {string} text 受信テキスト
 * @param {string} replyToken 返信トークン
 * @return {boolean} 追記として処理したらtrue
 */
function handleNote_(staff, text, replyToken) {
  // コマンドは一言記述として取り込まない。
  // 追記を求めたまま返事が無い状態は珍しくなく、そこへ「診断」等が来たときに
  // それを台帳の一言欄に書いてしまうと、記録が読めないものになるため。
  if (COMMAND_WORDS.indexOf(String(text).trim()) >= 0) return false;

  var pending = findRows(SHEETS.TASK, function (r) {
    return String(r['送信先staff_id']) === String(staff['staff_id']) && isTrue_(r['追記待ち']);
  }).sort(function (a, b) {
    return toDateTimeStr_(b['回答日時']).localeCompare(toDateTimeStr_(a['回答日時']));
  });
  if (!pending.length) return false;

  var task = pending[0];
  var base = String(task['回答'] || '');
  var note = (String(text).trim() === 'なし') ? '' : String(text).trim();
  var combined = base + (note ? '／' + note : '');
  updateRow(SHEETS.TASK, task._row, {
    '回答': combined,
    '回答方法': '自由記述',
    '追記待ち': false
  });

  var gap = findRow(SHEETS.GAP, { 'gap_id': task['gap_id'] });
  var check = gap ? checkById_(gap['check_id']) : null;
  if (gap && UNKNOWN_ANSWERS.indexOf(base) < 0 && String(gap['状態']) !== GAP_STATUS.DONE) {
    // 「わからない」以外は、状況が書かれた時点で記録として成立させる
    recordFill_(gap, check, combined, staff);
    updateRow(SHEETS.GAP, gap._row, { '状態': GAP_STATUS.DONE, '完了日時': nowStr_() });
    cancelSiblingTasks_(gap['gap_id'], task['task_id']);
  }

  finishTurn_(task, replyToken);
  return true;
}

/**
 * 回答内容をS7補完台帳とS4実績ログに記録する。
 * @param {Object} gap S5の行
 * @param {Object} check S3の行
 * @param {string} value 回答値
 * @param {Object} staff 回答したスタッフのS1行
 * @return {void}
 */
function recordFill_(gap, check, value, staff) {
  var itemName = check ? String(check['項目名']) : String(gap['check_id']);
  var kind = check ? String(check['対象種別']) : 'support';
  var date = toDateStr_(gap['対象日']);
  var gapId = String(gap['gap_id']);

  // 同じ不足に対する記録が既にあれば書かない（二重記録の防止）
  if (findRow(SHEETS.FILL, { 'gap_id': gapId })) {
    logWarn('recordFill_', '既に記録済みのためスキップ: ' + gapId);
    return;
  }

  // AIが先に推定で埋めていた場合は、人の回答と突き合わせて精度の実績を貯める（learn.gs）。
  // 当たる組み合わせはやがて質問されなくなり、外れが増えれば聞き直しに戻る。
  var learned = learnFromAnswer_(date, String(gap['対象']), itemName, value);

  // シフト希望は対象月（YYYY-MM）を値に含める。R01がこの値を見て「回答済み」と判定するため。
  if (kind === 'shift') value = date.substring(0, 7) + ' ' + value;

  appendRow(SHEETS.FILL, {
    'fill_id': nextSeqId_(SHEETS.FILL, 'fill_id', 'FIL', 6),
    '対象日': date,
    '対象': String(gap['対象']),
    '項目名': itemName,
    '値': value,
    '記入者staff_id': String(staff['staff_id']),
    '取込済フラグ': false,
    '作成日時': nowStr_(),
    'gap_id': gapId,
    '情報源': fillSourceOf_(gap, staff),
    '要精査': false,
    '精査結果': ''
  });

  // 推定で先に埋めていた行があれば、そこを人の回答で上書きする（同じ項目が2行に増えないように）
  if (!supersedeEstimate_(date, String(gap['対象']), itemName, value)) {
    appendRow(SHEETS.LOG_IMPORT, {
      'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
      '発生日': date,
      '対象種別': kind,
      '対象': String(gap['対象']),
      '項目名': itemName,
      '値': value,
      '取込元': 'ai-uribo',
      '取込日時': nowStr_(),
      '確度': CERTAINTY.FIXED,
      '推定回答': ''
    });
  }

  if (learned.突合) {
    logInfo('recordFill_', '推定と回答の突き合わせ: ' + itemName + '（' + learned.情報源 + '）→ '
      + (learned.一致 ? '一致' : '不一致'));
  }
}

/**
 * その日・その利用者・その項目に推定の記録が既にあれば、人の回答で上書きする。
 *
 * 推定は「まだ確かめていない仮の記録」なので、人が答えた時点で役目を終える。
 * 行を増やさず上書きすることで、既存アプリが取り込む記録は常に1項目1行になる。
 * @param {string} date 対象日
 * @param {string} target 対象
 * @param {string} itemName 項目名
 * @param {string} value 人の回答
 * @return {boolean} 上書きしたらtrue
 */
function supersedeEstimate_(date, target, itemName, value) {
  var rows = findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) === date
      && String(r['対象']) === String(target)
      && String(r['項目名']) === String(itemName)
      && String(r['対象種別']) === 'support'
      && String(r['確度']) === CERTAINTY.ESTIMATED;
  });
  if (!rows.length) return false;

  updateRow(SHEETS.LOG_IMPORT, rows[0]._row, {
    '値': value,
    '取込元': 'ai-uribo',
    '取込日時': nowStr_(),
    '確度': CERTAINTY.FIXED
  });
  return true;
}

/**
 * その記録が「誰の情報か」を判定する。
 * 監査では「いつ・誰が・誰に・何をしたか」が問われるため、支援した人と確認した人を分けて残す。
 *
 * ・本人回答             … スタッフ本人のこと（シフト希望など）
 * ・支援担当者の記録     … 支援した本人（夜勤・世話人）がその場で答えた
 * ・支援担当者名＋管理者確認 … 社員・管理者が拠点を回り、紙台帳や口頭で担当者を確認して入力した
 *                            （代理入力ではなく、担当者名と確認者名の両方を残す形）
 * ・自動ログ             … 機械の記録（autofill.gs 側で付与）
 * @param {Object} gap S5の行
 * @param {Object} staff 回答したスタッフのS1行
 * @return {string} 情報源
 */
function fillSourceOf_(gap, staff) {
  if (String(gap['対象']) === String(staff['staff_id'])) return '本人回答';

  var role = String(staff['役割']);
  if (role !== '社員' && role !== '管理者') {
    return '支援担当者の記録（' + String(staff['氏名']) + '）';
  }

  // 社員・管理者が入力した場合は、その日の夜勤担当者名とセットで残す
  var site = siteOfTarget_(String(gap['対象']));
  var name = site ? safely_('fillSourceOf_', function () {
    return nightStaffNameOf_(gap['対象日'], site);
  }, '') : '';
  if (name) return '支援担当者：' + name + '／管理者確認：' + String(staff['氏名']);
  return '管理者確認：' + String(staff['氏名']) + '（担当者名は未記録）';
}

/**
 * 対象（user_code または拠点名）の拠点を返す。
 * @param {string} target 対象
 * @return {string} 拠点名（分からなければ空文字）
 */
function siteOfTarget_(target) {
  var user = safely_('siteOfTarget_', function () {
    return findRow(SHEETS.USER, { 'user_code': target });
  }, null);
  if (user && user['拠点']) return String(user['拠点']);
  // 夜勤担当者の質問そのものは対象が拠点名
  var isSite = safely_('siteOfTarget_', function () {
    return findRows(SHEETS.USER).some(function (u) { return String(u['拠点']) === String(target); });
  }, false);
  return isSite ? String(target) : '';
}

/**
 * 同じ不足に対する他の人の待機タスクを中止する（重複質問の防止）。
 * @param {string} gapId gap_id
 * @param {string} exceptTaskId 除外するtask_id
 * @return {void}
 */
function cancelSiblingTasks_(gapId, exceptTaskId) {
  findRows(SHEETS.TASK, function (r) {
    return String(r['gap_id']) === String(gapId)
      && String(r['task_id']) !== String(exceptTaskId)
      && (String(r['送信状態']) === SEND_STATUS.WAITING || String(r['送信状態']) === SEND_STATUS.QUEUED);
  }).forEach(function (t) {
    updateRow(SHEETS.TASK, t._row, { '送信状態': SEND_STATUS.CANCELED });
  });
}

// ============================================================================
// batch.gs
// ============================================================================

/**
 * 定時バッチ（06 Step4 を【08】v1.1に読み替えた確定仕様）
 *
 *   morningBatch()  毎朝10:00  自動充足 → 不足検出 → まとめ確認LINE（Stage1は藤原様・服部様の2名）
 *   nightBatch()    毎晩21:00  夜勤向け「夜の確認セット」（昨日の穴＋明日の予定を本人に確認）
 *   weeklyDigest()  日曜10:00  週次ダイジェスト（未完了・わからない残件＋精度指標）
 *   flushQueue()    毎朝7:00   深夜帯に保留した送信を流す（notify.gsに実装）
 *
 * ※17:00エスカレーションは【08】で廃止。R03の滞留判定は週次ダイジェストで使う。
 *
 * 全てのバッチは withLock_ で直列化する。日曜10:00は朝バッチと週次ダイジェストが重なるため、
 * 待ち時間を長め（既定5分）にとって、片方が終わるのを待ってから動くようにしている。
 */

/** バッチがロックを待つ時間（ミリ秒） @type {number} */
var BATCH_LOCK_WAIT_MS = 300000;

/**
 * 1回のバッチで使ってよい時間（ミリ秒）。
 * GASの実行は6分で強制終了され、その瞬間に何が終わって何が終わっていないのか分からなくなる。
 * 手前で自分から切り上げ、残りは次の実行に回す（毎日動くので、翌日には必ず追いつく）。
 * @type {number}
 */
var BATCH_TIME_BUDGET_MS = 240000;

/** いまのバッチが始まった時刻（ミリ秒） @type {number} */
var BATCH_STARTED_AT_ = 0;

/**
 * バッチの時計を開始する。
 * @return {void}
 */
function startBatchClock_() {
  BATCH_STARTED_AT_ = new Date().getTime();
}

/**
 * まだ時間に余裕があるか。
 * @return {boolean} 余裕があればtrue
 */
function withinBatchBudget_() {
  if (!BATCH_STARTED_AT_) return true;
  return (new Date().getTime() - BATCH_STARTED_AT_) < BATCH_TIME_BUDGET_MS;
}

/**
 * バッチ開始からの経過秒数。
 * @return {number} 秒
 */
function batchElapsedSec_() {
  return BATCH_STARTED_AT_ ? Math.round((new Date().getTime() - BATCH_STARTED_AT_) / 1000) : 0;
}

/**
 * 朝バッチ。前日分を自動充足したうえで不足を検出し、確認LINEを送る。
 * @return {string} 実行サマリ
 */
function morningBatch() {
  var proc = 'morningBatch';
  return withLock_(proc, BATCH_LOCK_WAIT_MS, function () {
    try {
      logStart(proc);
      startBatchClock_();
      var targetDate = addDays_(todayStr_(), -1);

      safely_(proc, function () { flushQueue(); });
      var auto = safely_(proc, function () { return runAutoFill(targetDate); }, { filled: 0 });
      // 埋めた直後に噛み合わない記録を洗う。ここで聞き直しに戻した項目は、この後の検出で質問になる
      var bad = safely_(proc, function () { return checkConsistency(targetDate); },
        { 再確認: 0, 要判断: 0, 一覧: [] });
      safely_(proc, function () { scanAlerts_(targetDate); });
      var gaps = safely_(proc, function () { return detectGaps(targetDate, ['R01', 'R02', 'R05']); }, []);
      safely_(proc, function () { registerGaps(gaps); });

      var md = formatMd_(targetDate);
      var sentTotal = dispatchPendingGaps_(
        // 予定（対象種別=plan）は夜の確認セットで扱うので朝は送らない
        function (gap, check) { return !check || String(check['対象種別']) !== 'plan'; },
        '【' + md + 'までの確認】',
        proc
      );

      var summary = '自動充足' + auto.filled + '件 / 食い違い' + bad.一覧.length + '件'
        + ' / 新規検出' + gaps.length + '件 / 送信' + sentTotal + '件'
        + ' / ' + batchElapsedSec_() + '秒';
      logInfo(proc, summary);
      return summary;
    } catch (e) {
      logError(proc, e);
      return 'エラー: ' + e;
    }
  }, function () { return '他の処理が実行中のためスキップ'; });
}

/**
 * 夜バッチ（夜の確認セット）。
 * 昨日の穴のうち本人に聞けば分かるものと、明日の予定をまとめて夜勤担当に送る。
 * @return {string} 実行サマリ
 */
function nightBatch() {
  var proc = 'nightBatch';
  return withLock_(proc, BATCH_LOCK_WAIT_MS, function () {
   try {
    logStart(proc);
    startBatchClock_();
    var tomorrow = addDays_(todayStr_(), 1);

    // 明日の予定（R04）を検出して登録
    var planGaps = safely_(proc, function () { return detectGaps(tomorrow, ['R04']); }, []);
    safely_(proc, function () { registerGaps(planGaps); });

    var recipients = nightShiftStaff_();
    if (!recipients.length) {
      logWarn(proc, '夜勤担当が特定できないため送信しない');
      return '夜勤担当なし';
    }

    // 送る対象：明日の予定と、支援記録のうち利用者本人・夜勤に聞けば分かる項目
    // （シフト希望はスタッフ本人に朝送るものなので、夜の確認セットには入れない）
    var pending = pendingGaps_(function (gap, check) {
      if (!check) return false;
      var kind = String(check['対象種別']);
      if (kind === 'plan') return true;
      if (kind !== 'support') return false;
      var role = String(check['確認先役割']);
      return role === '本人' || role === '夜勤';
    });
    if (!pending.length) {
      logInfo(proc, '確認事項なし');
      return '確認事項なし';
    }

    var sent = 0;
    recipients.forEach(function (staffId) {
      safely_(proc, function () {
        var list = excludeAlreadyAsked_(pending, staffId);
        if (!list.length) return;
        var r = createAndSendSet(staffId, list, '【夜の確認セット】利用者さんに聞きながらお答えください');
        if (r.sent) sent += r.count;
      });
    });

    var summary = '予定検出' + planGaps.length + '件 / 確認' + pending.length + '件 / 送信' + sent + '件';
    logInfo(proc, summary);
    return summary;
   } catch (e) {
    logError(proc, e);
    return 'エラー: ' + e;
   }
  }, function () { return '他の処理が実行中のためスキップ'; });
}

/**
 * 週次ダイジェスト（日曜10:00）。
 * 未完了・「わからない」の残件と、精度指標（質問件数・わからない率・自動充足率）を社員へ送る。
 * @return {string} 実行サマリ
 */
function weeklyDigest() {
  var proc = 'weeklyDigest';
  return withLock_(proc, BATCH_LOCK_WAIT_MS, function () {
   try {
    logStart(proc);
    startBatchClock_();
    var days = getSettingNum('digest_lookback_days', 7);
    var to = todayStr_();
    var from = addDays_(to, -days);

    // 集計期間は「検出日時」で切る（シフト希望のように対象日が未来の不足も拾うため）
    var gapsInRange = findRows(SHEETS.GAP, function (r) {
      var d = toDateTimeStr_(r['検出日時']).substring(0, 10);
      return d >= from && d <= to;
    });
    var done = gapsInRange.filter(function (r) { return String(r['状態']) === GAP_STATUS.DONE; });
    var open = gapsInRange.filter(function (r) { return String(r['状態']) !== GAP_STATUS.DONE; });
    var stale = safely_(proc, function () { return findStaleGaps_(); }, []);

    var answers = findRows(SHEETS.TASK, function (r) {
      var d = toDateTimeStr_(r['回答日時']);
      return d && d.substring(0, 10) >= from && d.substring(0, 10) <= to;
    });
    var unknowns = answers.filter(function (r) {
      return UNKNOWN_ANSWERS.indexOf(String(r['回答']).split('／')[0]) >= 0;
    });
    var autoFilled = safely_(proc, function () { return countAutoFilled_(from, to); }, 0);
    var needsReview = safely_(proc, function () { return countNeedsReview_(from, to); }, 0);

    // AIの読み取り通知の精度（誤検知がどれだけ多いか）
    var feedback = findRows(SHEETS.RUN_LOG, function (r) {
      var d = toDateTimeStr_(r['日時']).substring(0, 10);
      return String(r['処理名']) === 'alertFeedback' && d >= from && d <= to;
    });
    var wrong = feedback.filter(function (r) { return String(r['詳細']).indexOf('誤検知') >= 0; }).length;

    var askCount = findRows(SHEETS.TASK, function (r) {
      var d = toDateTimeStr_(r['送信日時']);
      return d && d.substring(0, 10) >= from && d.substring(0, 10) <= to;
    }).length;
    var autoRate = (autoFilled + gapsInRange.length) > 0
      ? Math.round(autoFilled * 100 / (autoFilled + gapsInRange.length)) : 0;
    var unknownRate = answers.length ? Math.round(unknowns.length * 100 / answers.length) : 0;

    var lines = [];
    lines.push('【週次ダイジェスト】' + from + '〜' + to);
    lines.push('検出' + gapsInRange.length + '件 / 完了' + done.length + '件 / 未完了' + open.length + '件');
    lines.push('質問した件数：' + askCount + '件（うち「わからない」' + unknowns.length + '件・' + unknownRate + '%）');
    lines.push('自動で埋まった件数：' + autoFilled + '件（自動充足率 ' + autoRate + '%）');
    if (needsReview) {
      lines.push('うち推定で埋めた「要精査」：' + needsReview + '件'
        + '（LINEで「精査」と送るか、S7補完台帳の要精査列をご確認ください）');
    }
    if (feedback.length) {
      lines.push('AIの読み取り通知：' + feedback.length + '件（うち誤検知 ' + wrong + '件・'
        + Math.round(wrong * 100 / feedback.length) + '%）');
    }
    if (stale.length) lines.push('※8時間以上返事待ちの項目：' + stale.length + '件');
    var conflicts = findRows(SHEETS.RUN_LOG, function (r) {
      var d = toDateTimeStr_(r['日時']).substring(0, 10);
      return String(r['結果']) === '食い違い' && d >= from && d <= to;
    }).length;
    if (conflicts) lines.push('記録の食い違い：' + conflicts + '件（聞き直しか、社員への確認を出しています）');

    // 学習の進み具合（＝どれだけ質問が減ったか）を毎週示す
    var saved = safely_(proc, function () { return countAutoConfirmed_(from, to); }, 0);
    if (saved) lines.push('学習済みのため聞かずに済んだ件数：' + saved + '件');
    lines.push('');
    safely_(proc, function () { learnSummaryLines_().forEach(function (l) { lines.push(l); }); });
    lines.push('');
    if (open.length) {
      lines.push('▼未完了の一覧（最大15件）');
      open.slice(0, 15).forEach(function (g) {
        var c = checkById_(g['check_id']);
        lines.push('・' + toDateStr_(g['対象日']) + ' ' + displayName_(String(g['対象']))
          + ' 「' + (c ? c['項目名'] : g['check_id']) + '」（' + g['状態'] + '）');
      });
      lines.push('');
      lines.push('この後、回答できる項目をボタンでお送りします。');
    } else {
      lines.push('未完了はありません。今週もありがとうございました。');
    }

    var n = sendToEscalationStaff([msgText_(lines.join('\n'))], proc);

    // 未完了分は社員がその場で回答できるよう、確認セットにして送る（最大10件）
    var answerable = pendingGaps_(function () { return true; }).slice(0, 10);
    escalationStaff_().forEach(function (s) {
      safely_(proc, function () {
        var list = excludeAlreadyAsked_(answerable, String(s['staff_id']));
        if (list.length) createAndSendSet(String(s['staff_id']), list, '【今週の未完了分】');
      });
    });

    writeLog(proc, '週次集計',
      JSON.stringify({ from: from, to: to, 検出: gapsInRange.length, 完了: done.length,
        未完了: open.length, 質問: askCount, わからない: unknowns.length,
        わからない率: unknownRate, 自動充足: autoFilled, 自動充足率: autoRate, 要精査: needsReview,
        学習で省いた質問: saved }));
    logInfo(proc, '送信 ' + n + '名');
    return '未完了' + open.length + '件 / 送信' + n + '名';
   } catch (e) {
    logError(proc, e);
    return 'エラー: ' + e;
   }
  }, function () { return '他の処理が実行中のためスキップ'; });
}

// ---------------------------------------------------------------------------
// 共通ヘルパー
// ---------------------------------------------------------------------------

/**
 * 未完了（検出・確認中・エスカレーション中）の不足を返す。
 * @param {function(Object, Object):boolean} [filter] (gap, check) を受け取る絞り込み関数
 * @return {Array.<Object>} S5の行オブジェクト配列
 */
function pendingGaps_(filter) {
  return findRows(SHEETS.GAP, function (r) {
    var st = String(r['状態']);
    return st === GAP_STATUS.DETECTED || st === GAP_STATUS.ASKING || st === GAP_STATUS.ESCALATED;
  }).filter(function (g) {
    if (!filter) return true;
    var check = checkById_(g['check_id']);
    return filter(g, check);
  });
}

/**
 * そのスタッフに送る不足を絞り込む。
 *
 * 同じ日に同じことを二度聞かないのが基本。ただし、
 * **一度送ったきり返事が無い確認を放置すると、記録が空いたまま週次まで埋もれる**。
 * そこで一定時間が過ぎたものはもう一度だけお送りする（回数の上限つき。しつこくしない）。
 * 上限に達したものは催促をやめ、週次ダイジェストで社員がまとめて引き取る。
 *
 * @param {Array.<Object>} gaps S5の行オブジェクト配列
 * @param {string} staffId staff_id
 * @return {Array.<Object>} 送る不足だけの配列
 */
function excludeAlreadyAsked_(gaps, staffId) {
  var remindAfter = getSettingNum('remind_after_hours', 20);
  var remindMax = getSettingNum('remind_max', 2);

  var answered = {};
  var times = {};   // gap_id → その人に送った回数
  var latest = {};  // gap_id → 最後に送った（または作った）日時

  findRows(SHEETS.TASK, function (r) {
    var st = String(r['送信状態']);
    return String(r['送信先staff_id']) === String(staffId)
      && (st === SEND_STATUS.WAITING || st === SEND_STATUS.QUEUED || st === SEND_STATUS.SENT);
  }).forEach(function (t) {
    var id = String(t['gap_id']);
    // 「後で（明日また聞いて）」と答えた項目は、翌日また聞くので数に入れない
    if (String(t['回答'] || '').indexOf('後で') === 0) return;
    if (String(t['回答'] || '').trim()) { answered[id] = true; return; }

    times[id] = (times[id] || 0) + 1;
    var when = toDateTimeStr_(t['送信日時']) || toDateTimeStr_(t['作成日時']);
    if (!latest[id] || when > latest[id]) latest[id] = when;
  });

  return gaps.filter(function (g) {
    var id = String(g['gap_id']);
    if (answered[id]) return false;              // もう答えていただいている
    if (!times[id]) return true;                 // まだ送っていない
    if (times[id] > remindMax) return false;     // これ以上は催促しない（週次で社員へ）
    return hoursSince_(latest[id]) >= remindAfter;
  });
}

/**
 * その一覧に「一度送ったが返事が無いもの」が含まれるか。
 * 見出しに一言添えて、催促されたと感じさせないための判定。
 * @param {Array.<Object>} gaps 送る不足
 * @param {string} staffId staff_id
 * @return {boolean} 含まれていればtrue
 */
function includesReask_(gaps, staffId) {
  var sent = {};
  findRows(SHEETS.TASK, function (r) {
    return String(r['送信先staff_id']) === String(staffId)
      && String(r['送信状態']) === SEND_STATUS.SENT;
  }).forEach(function (t) { sent[String(t['gap_id'])] = true; });
  return gaps.some(function (g) { return sent[String(g['gap_id'])]; });
}

/**
 * 未完了の不足を一次確認先ごとにまとめて送る。
 * @param {function(Object):boolean} gapFilter 対象にする不足の絞り込み
 * @param {string} title セットの見出し
 * @param {string} proc ログ用の処理名
 * @return {number} 送信した件数
 */
function dispatchPendingGaps_(gapFilter, title, proc) {
  var pending = pendingGaps_().filter(gapFilter);
  if (!pending.length) {
    logInfo(proc, '送る不足なし');
    return 0;
  }
  var byStaff = {};
  pending.forEach(function (g) {
    String(g['一次確認先staff_id'] || '').split(',').forEach(function (id) {
      id = id.trim();
      if (!id) return;
      if (!byStaff[id]) byStaff[id] = [];
      byStaff[id].push(g);
    });
  });

  var sent = 0;
  var skipped = 0;
  Object.keys(byStaff).forEach(function (staffId) {
    // 時間切れで強制終了されると、送ったのか送っていないのか分からない状態が残る。
    // 手前で自分から止めれば、残りは翌日の実行がそのまま拾う（不足は消えないため）
    if (!withinBatchBudget_()) { skipped++; return; }
    safely_(proc, function () {
      var list = excludeAlreadyAsked_(byStaff[staffId], staffId);
      if (!list.length) return;
      var head = includesReask_(list, staffId)
        ? title + '\n※前回お答えいただけなかった分も入っています'
        : title;
      var r = createAndSendSet(staffId, list, head);
      if (r.sent) sent += r.count;
    });
  });
  if (skipped) {
    logWarn(proc, '実行時間が長くなったため' + skipped + '名分の送信を次回に回しました'
      + '（経過' + batchElapsedSec_() + '秒）');
  }
  return sent;
}

/**
 * 今夜の夜勤担当のstaff_id一覧を返す。
 * S11勤務予定 → S1の役割=夜勤 → エスカレーション先社員 の順にフォールバックする。
 * @return {Array.<string>} staff_idの配列
 */
function nightShiftStaff_() {
  var today = todayStr_();
  var fromPlan = safely_('nightShiftStaff_', function () {
    return findRows(SHEETS.SHIFT_PLAN, function (r) {
      return toDateStr_(r['日付']) === today && String(r['勤務区分']).indexOf('夜勤') >= 0;
    }).map(function (r) { return String(r['staff_id']); });
  }, []);

  var valid = fromPlan.filter(function (id) {
    var s = staffById_(id);
    return s && isTrue_(s['有効']) && String(s['line_user_id'] || '').trim();
  });
  if (valid.length) return valid;

  var byRole = findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && String(r['役割']).indexOf('夜勤') >= 0 && String(r['line_user_id'] || '').trim();
  }).map(function (r) { return String(r['staff_id']); });
  if (byRole.length) return byRole;

  return escalationStaff_().map(function (s) { return String(s['staff_id']); });
}

/**
 * YYYY-MM-DD を M/D 表記にする。
 * @param {string} dateStr 日付
 * @return {string} M/D
 */
function formatMd_(dateStr) {
  var d = toDateStr_(dateStr);
  if (d.length < 10) return d;
  return Number(d.substring(5, 7)) + '/' + Number(d.substring(8, 10));
}

// ---------------------------------------------------------------------------
// トリガー設定
// ---------------------------------------------------------------------------

/**
 * 時間主導トリガーを設定する（既存の同名トリガーは削除してから作り直す）。
 * S8設定の時刻を変えたあとに実行し直すこと。
 * @return {string} 設定内容のサマリ
 */
function installTriggers() {
  var proc = 'installTriggers';
  var handlers = ['morningBatch', 'nightBatch', 'weeklyDigest', 'dailyBackup', 'flushQueue',
                  'switchbotPoll', 'selfCheck', 'monthlyReport'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });

  var morning = getSettingNum('morning_batch_hour', 10);
  var night = getSettingNum('night_batch_hour', 21);
  var digestHour = getSettingNum('weekly_digest_hour', 10);
  var backup = getSettingNum('backup_hour', 3);
  var quietEnd = getSettingNum('quiet_end_hour', 7);

  ScriptApp.newTrigger('morningBatch').timeBased().atHour(morning).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('nightBatch').timeBased().atHour(night).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('dailyBackup').timeBased().atHour(backup).everyDays(1).inTimezone(TZ).create();
  ScriptApp.newTrigger('flushQueue').timeBased().atHour(quietEnd).everyDays(1).inTimezone(TZ).create();
  // 自己点検は朝バッチより前。ここでトリガーの欠けや連携の停止に自分で気づく
  ScriptApp.newTrigger('selfCheck').timeBased()
    .atHour(getSettingNum('selfcheck_hour', 8)).everyDays(1).inTimezone(TZ).create();
  // SwitchBotの状態取得は朝バッチの前に走らせる（取得した値をその日の充足に使うため）
  if (PropertiesService.getScriptProperties().getProperty('SWITCHBOT_TOKEN')) {
    ScriptApp.newTrigger('switchbotPoll').timeBased()
      .atHour(getSettingNum('switchbot_poll_hour', 9)).everyDays(1).inTimezone(TZ).create();
  }
  // 月次まとめは月初に前月分をまとめる（実地指導・監査の備え）
  ScriptApp.newTrigger('monthlyReport').timeBased()
    .onMonthDay(1).atHour(getSettingNum('monthly_report_hour', 11)).inTimezone(TZ).create();
  ScriptApp.newTrigger('weeklyDigest').timeBased()
    .onWeekDay(dayOfWeek_(getSettingNum('weekly_digest_dow', 0)))
    .atHour(digestHour).inTimezone(TZ).create();

  var summary = '自己点検' + getSettingNum('selfcheck_hour', 8) + '時 / 朝' + morning + '時 / 夜' + night
    + '時 / 週次(日)' + digestHour + '時 / 月次(1日)' + getSettingNum('monthly_report_hour', 11) + '時'
    + ' / バックアップ' + backup + '時 / キュー送信' + quietEnd + '時';
  logInfo(proc, summary);
  return summary;
}

/**
 * 数値（0=日）をScriptApp.WeekDayに変換する。
 * @param {number} n 曜日番号（0=日〜6=土）
 * @return {WeekDay} 曜日
 */
function dayOfWeek_(n) {
  var list = [ScriptApp.WeekDay.SUNDAY, ScriptApp.WeekDay.MONDAY, ScriptApp.WeekDay.TUESDAY,
               ScriptApp.WeekDay.WEDNESDAY, ScriptApp.WeekDay.THURSDAY, ScriptApp.WeekDay.FRIDAY,
               ScriptApp.WeekDay.SATURDAY];
  return list[(n % 7 + 7) % 7];
}

// ============================================================================
// webhook.gs
// ============================================================================

/**
 * LINE Webhook（06 Step3 / 03_LINE会話仕様.md F1・F3・F5）
 *
 * doPost(e) が LINE からのイベントを受け取り、
 *   follow    → 名前確認クイックリプライ（F1）
 *   postback  → 回答受付（F3）・名前紐付け
 *   message   → 追記の受付、手動コマンド（F5：状況/テスト実行/ヘルプ/報告）
 * を処理する。
 *
 * 【検証方式についての注意（重要）】
 * Google Apps Script のウェブアプリは HTTP リクエストヘッダーを取得できないため、
 * X-Line-Signature ヘッダーによる署名検証を GAS 単体で行うことは技術的にできない。
 * そのため本実装では次の三段構えで正当性を担保する：
 *   (1) Webhook URL に秘密のクエリキーを付与し（?k=＜WEBHOOK_SECRET＞）、一致しないリクエストは破棄する。
 *       WEBHOOK_SECRET が未設定のときは「全部拒否」する（設定漏れが認証無効化にならないようにするため）
 *   (2) 署名検証関数 validateSignature_() は実装済みで、署名を渡せる経路（将来リバースプロキシを
 *       挟む場合など）ではそのまま利用できる。クエリ sig で署名が渡された場合は検証する
 *   (3) スタッフの紐付けは「管理者が個別に伝えた登録コード」を送ってもらう方式。
 *       友だち追加しただけの第三者が、名前を選ぶだけでスタッフになりすますことはできない
 * さらに、S1で有効=TRUEかつ紐付け済みのユーザー以外は操作を受け付けない。
 * この制約と対策は docs/デプロイ手順.md にも記載してある。
 */

/**
 * LINEからのWebhookを受け取る。
 * @param {Object} e リクエストイベント
 * @return {TextOutput} 応答（LINEは本文を見ないので固定文字列）
 */
function doPost(e) {
  var proc = 'doPost';
  try {
    if (!verifyRequest_(e)) {
      logWarn(proc, '不正なリクエストを破棄しました');
      return ContentService.createTextOutput('NG');
    }
    var body = JSON.parse(e.postData.contents);

    // SwitchBotのWebhook（機器の変化通知）
    if (!body.events && body.eventType && body.context) {
      var m = safely_(proc, function () { return ingestSwitchbotWebhook_(body); }, 0);
      return ContentService.createTextOutput('OK:' + m);
    }

    // 既存アプリからの「取り込み済み」通知
    if (!body.events && String(body.action || '') === 'markImported') {
      var marked = safely_(proc, function () { return markImported_(body); }, -1);
      // 書き込めなかったときは ok:false を返し、既存アプリにやり直してもらう
      // （0件成功と同じ返事にすると、渡せていない記録を渡した扱いにしてしまう）
      var payload = marked < 0
        ? { ok: false, error: 'busy', marked: 0 }
        : { ok: true, marked: marked };
      return ContentService.createTextOutput(JSON.stringify(payload))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // LINE以外からの投入も同じ入口で受ける（送信元を本文の形で見分ける）
    if (!body.events && (body.observations || body.source)) {
      var n = ingestObservations_(body);
      return ContentService.createTextOutput('OK:' + n);
    }

    var events = body.events || [];
    events.forEach(function (ev) {
      safely_(proc, function () { handleEvent_(ev); });
    });
  } catch (err) {
    logError(proc, err, e && e.postData ? String(e.postData.contents).substring(0, 500) : '');
  }
  return ContentService.createTextOutput('OK');
}

/**
 * 外部からの観察データ（AIハブ／OpenClaw・他のアプリ）をS4に取り込む。
 *
 * 期待する本文（映像・画像は受け取らない。言葉だけ）：
 *   {
 *     "source": "openclaw",
 *     "observations": [
 *       { "date": "2026-08-11", "target": "SMZ01", "item": "食事提供", "value": "夕食を配膳（キッチンカメラ 18:05）" }
 *     ]
 *   }
 * target を "ALL" にすると、その拠点の有効な利用者全員に展開される。
 * 取り込んだ内容は翌朝の自動充足で「推定（要精査）」として記録に反映される。
 * @param {Object} body リクエスト本文
 * @return {number} 取り込んだ件数
 */
function ingestObservations_(body) {
  var proc = 'ingestObservations_';
  var source = String(body.source || 'external').substring(0, 40);
  var list = body.observations || [];
  if (!list.length && body.item) list = [body];   // 1件だけの簡易形式も受ける

  return withLock_(proc, 60000, function () {
    var n = 0;
    list.forEach(function (o) {
      safely_(proc, function () {
        var item = String(o.item || o['項目名'] || '').trim();
        var value = String(o.value || o['値'] || '').trim();
        if (!item || !value) return;
        appendRow(SHEETS.LOG_IMPORT, {
          'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
          '発生日': toDateStr_(o.date || o['発生日'] || todayStr_()),
          '対象種別': 'raw_' + (source === 'openclaw' ? 'openclaw' : source),
          '対象': String(o.target || o['対象'] || 'ALL'),
          '項目名': item,
          '値': truncate_(value, 300),
          '取込元': source,
          '取込日時': nowStr_()
        });
        n++;
      });
    });
    logInfo(proc, source + ' から ' + n + '件を取り込みました');
    return n;
  }, function () {
    logWarn(proc, 'ロックが取れなかったため取り込みを見送りました（送信側で再送してください）');
    return 0;
  });
}

/**
 * 動作確認用のGET応答（Webhook URLをブラウザで開いたときの表示）。
 * @param {Object} e リクエストイベント
 * @return {TextOutput} 応答
 */
function doGet(e) {
  // 既存アプリからの読み取り要求（?mode=... 付き）はAPIとして扱う
  if (e && e.parameter && e.parameter.mode) return handleApiGet_(e);
  return ContentService.createTextOutput('AI Uribo is running. ' + nowStr_());
}

/**
 * リクエストの正当性を確認する。
 * @param {Object} e リクエストイベント
 * @return {boolean} 正当ならtrue
 */
function verifyRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) return false;
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(PROP.WEBHOOK_KEY);
  // 未設定なら受け付けない（設定漏れがそのまま認証無効化にならないようにする）
  if (!key) {
    logError('verifyRequest_', 'WEBHOOK_SECRET が未設定のためリクエストを拒否しました。'
      + 'スクリプトプロパティに設定してください');
    return false;
  }
  if (!e.parameter || String(e.parameter.k) !== String(key)) return false;
  // 署名が渡せる経路の場合は署名も検証する
  if (e.parameter && e.parameter.sig) {
    if (!validateSignature_(e.postData.contents, e.parameter.sig)) return false;
  }
  return true;
}

/**
 * LINEの署名（X-Line-Signature）を検証する。
 * ※GASウェブアプリはヘッダーを取得できないため通常は呼ばれない。将来の経路変更に備えた実装。
 * @param {string} bodyText リクエストボディ
 * @param {string} signature 署名（Base64）
 * @return {boolean} 一致すればtrue
 */
function validateSignature_(bodyText, signature) {
  var secret = PropertiesService.getScriptProperties().getProperty(PROP.SECRET);
  if (!secret) {
    logWarn('validateSignature_', 'LINE_CHANNEL_SECRET が未設定です');
    return false;
  }
  var mac = Utilities.computeHmacSha256Signature(bodyText, secret);
  var expected = Utilities.base64Encode(mac);
  return expected === String(signature);
}

/**
 * 1イベントを処理する。
 * @param {Object} ev LINEイベント
 * @return {void}
 */
function handleEvent_(ev) {
  var cache = CacheService.getScriptCache();
  var key = ev.webhookEventId ? ('ev_' + ev.webhookEventId) : '';

  // 処理済み・処理中のイベントは無視する（LINEは同じイベントを再送することがある）
  if (key) {
    var state = cache.get(key);
    if (state) {
      logInfo('handleEvent_', '重複イベントを無視（' + state + '）: ' + ev.webhookEventId);
      return;
    }
    cache.put(key, 'processing', 21600); // 6時間
  }

  var userId = (ev.source && ev.source.userId) ? ev.source.userId : '';
  try {
    switch (ev.type) {
      case 'follow': onFollow_(userId, ev.replyToken); break;
      case 'unfollow': logInfo('unfollow', userId); break;
      case 'postback': onPostback_(userId, ev.postback.data, ev.replyToken); break;
      case 'message':
        if (ev.message && ev.message.type === 'text') onText_(userId, String(ev.message.text).trim(), ev.replyToken);
        else if (ev.replyToken) replyRaw_(ev.replyToken, [msgText_('ボタンでお答えください。困ったら「ヘルプ」と送ってください。')]);
        break;
      default: logInfo('handleEvent_', '未対応イベント: ' + ev.type);
    }
    if (key) cache.put(key, 'done', 21600);
  } catch (err) {
    // 途中で落ちた場合は印を消し、LINEの再送で処理し直せるようにする（回答の取りこぼし防止）
    if (key) cache.remove(key);
    throw err;
  }
}

/**
 * 友だち追加時の処理（F1）。
 * @param {string} userId LINEユーザーID
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function onFollow_(userId, replyToken) {
  var proc = 'onFollow_';
  var known = staffByLineId_(userId);
  if (known) {
    var msg = isTrue_(known['有効'])
      ? known['氏名'] + 'さん、おかえりなさい。AI Uriboです。\n困ったら「ヘルプ」と送ってください。'
      : 'AI Uriboです。現在このアカウントは利用停止中です。管理者にご連絡ください。';
    replyRaw_(replyToken, [msgText_(msg)]);
    return;
  }
  // スタッフ名の一覧は出さない（第三者が名前を選ぶだけで登録できてしまうため）。
  // 管理者が本人にだけ伝えた登録コードを送ってもらう方式にする。
  replyRaw_(replyToken, [msgText_(
    'AI Uriboです。Uriboの記録の抜けを見つけて、皆さんに確認する係です。\n\n'
    + 'ご利用には登録が必要です。管理者からお伝えした「登録コード」（英数字8文字）をそのまま送ってください。\n'
    + 'お持ちでない場合は管理者にご連絡ください。')]);
  logInfo(proc, '未登録ユーザーが友だち追加: ' + userId);
}

/**
 * 登録コードによるスタッフ紐付けを試みる。
 * @param {string} userId LINEユーザーID
 * @param {string} text 受信テキスト（登録コードの候補）
 * @param {string} replyToken 返信トークン
 * @return {boolean} 登録処理として扱ったらtrue
 */
function tryRegisterByCode_(userId, text, replyToken) {
  var proc = 'tryRegisterByCode_';
  var code = String(text).trim().toUpperCase().replace(/[\s-]/g, '');
  if (!new RegExp('^[' + REGISTRATION_CODE_CHARS + ']{' + REGISTRATION_CODE_LENGTH + '}$').test(code)) {
    return false;   // 登録コードの形をしていないので、通常のメッセージとして扱う
  }

  // 総当たりを防ぐため、1時間あたりの試行回数を制限する
  var cache = CacheService.getScriptCache();
  var attemptKey = 'reg_' + userId;
  var attempts = Number(cache.get(attemptKey) || 0) + 1;
  cache.put(attemptKey, String(attempts), 3600);
  if (attempts > getSettingNum('register_attempt_limit', 10)) {
    logWarn(proc, '登録コードの試行回数超過: ' + userId);
    replyRaw_(replyToken, [msgText_('登録の試行回数が上限に達しました。しばらく待ってから、管理者にご連絡ください。')]);
    return true;
  }

  return withLock_(proc, 20000, function () {
    var staff = findRow(SHEETS.STAFF, function (r) {
      return String(r['登録コード'] || '').trim().toUpperCase() === code;
    });
    if (!staff) {
      logWarn(proc, '登録コード不一致: ' + userId);
      replyRaw_(replyToken, [msgText_('登録コードが確認できませんでした。管理者にご確認ください。')]);
      return true;
    }
    if (!isTrue_(staff['有効'])) {
      logWarn(proc, '無効なスタッフの登録コードが使われました: ' + staff['staff_id']);
      replyRaw_(replyToken, [msgText_('このコードは現在ご利用いただけません。管理者にご連絡ください。')]);
      return true;
    }
    if (String(staff['line_user_id'] || '').trim()) {
      // 既存の紐付けは絶対に自動で上書きしない（乗っ取り防止）
      logWarn(proc, staff['staff_id'] + ' は既に別のLINEと紐付いています');
      replyRaw_(replyToken, [msgText_('このスタッフ情報は登録済みです。付け替えが必要な場合は管理者にご連絡ください。')]);
      return true;
    }

    // 紐付けたらコードは使い捨てにする（同じコードで2人目が登録できないように）
    updateRow(SHEETS.STAFF, staff._row, { 'line_user_id': userId, '登録コード': '' });
    replyRaw_(replyToken, [msgText_(staff['氏名'] + 'さんですね。登録しました。\n'
      + 'これから記録の確認をお送りします。困ったら「ヘルプ」と送ってください。')]);
    logInfo(proc, staff['氏名'] + ' を登録しました');
    return true;
  }, function () {
    replyRaw_(replyToken, [msgText_('ただいま混み合っています。少し待ってからもう一度お送りください。')]);
    return true;
  });
}

/**
 * postback（ボタンタップ）の処理。
 * @param {string} userId LINEユーザーID
 * @param {string} data postbackデータ
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function onPostback_(userId, data, replyToken) {
  var proc = 'onPostback_';
  var parts = String(data).split('|');
  withLock_(proc, 20000, function () {
    try {
      var staff = activeStaffByLineId_(userId, replyToken);
      if (!staff) return;
      if (parts[0] === 'ans') {
        handleAnswer_(staff, parts[1], parts.slice(2).join('|'), replyToken);
        return;
      }
      if (parts[0] === 'alert') {
        handleAlertFeedback_(staff, parts[1], parts.slice(2).join('|'), replyToken);
        return;
      }
      logWarn(proc, '未対応のpostback: ' + data);
      replyRaw_(replyToken, [msgText_('うまく受け取れませんでした。もう一度ボタンを押してみてください。')]);
    } catch (e) {
      logError(proc, e, data);
      replyRaw_(replyToken, [msgText_('申し訳ありません、処理中に問題が起きました。担当者に記録しました。')]);
    }
  }, function () {
    // ロックを取れないまま処理を続けると二重記録の原因になるため、必ず中断して案内する
    replyRaw_(replyToken, [msgText_('ただいま処理が混み合っています。少し待ってからもう一度お試しください。')]);
  });
}

/**
 * AIの読み取り通知に対する判定（事実／誤検知／判断できない）を記録する。
 * カメラのAIが書く文章は誤りが多いため、人の判定を貯めて精度を測り、
 * 検出キーワードの調整に使う。
 * @param {Object} staff 判定したスタッフのS1行
 * @param {string} judge ok / ng / unknown
 * @param {string} key 対象日|該当語|対象
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function handleAlertFeedback_(staff, judge, key, replyToken) {
  var label = { ok: '事実だった', ng: '誤検知', unknown: '判断できない' }[judge] || judge;
  writeLog('alertFeedback', 'AI判定', JSON.stringify({
    判定: label, キー: key, 判定者: String(staff['staff_id'])
  }));
  var msg = (judge === 'ng')
    ? 'ありがとうございます。誤検知として記録しました。\n同じような誤りが続く場合は、S8設定の alert_keywords から語を外せます。'
    : 'ありがとうございます。記録しました。';
  replyRaw_(replyToken, [msgText_(msg)]);
}

/**
 * 紐付け済みかつ有効なスタッフを取得する。該当しない場合は案内を返してnullを返す。
 * @param {string} userId LINEユーザーID
 * @param {string} replyToken 返信トークン
 * @return {Object|null} S1の行オブジェクト
 */
function activeStaffByLineId_(userId, replyToken) {
  var staff = staffByLineId_(userId);
  if (!staff) {
    replyRaw_(replyToken, [msgText_('恐れ入りますが、登録がお済みでないようです。'
      + '管理者からお伝えした登録コードを送ってください。')]);
    return null;
  }
  if (!isTrue_(staff['有効'])) {
    logWarn('activeStaffByLineId_', '無効なスタッフからの操作: ' + staff['staff_id']);
    replyRaw_(replyToken, [msgText_('現在このアカウントは利用停止中です。管理者にご連絡ください。')]);
    return null;
  }
  return staff;
}

/**
 * テキストメッセージの処理（追記の受付・手動コマンド）。
 * @param {string} userId LINEユーザーID
 * @param {string} text 本文
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function onText_(userId, text, replyToken) {
  var proc = 'onText_';

  // 未登録ユーザーからのメッセージは、登録コードとしてのみ受け付ける
  if (!staffByLineId_(userId)) {
    if (tryRegisterByCode_(userId, text, replyToken)) return;
    replyRaw_(replyToken, [msgText_('AI Uriboです。ご利用には登録が必要です。'
      + '管理者からお伝えした登録コード（英数字8文字）を送ってください。')]);
    return;
  }

  withLock_(proc, 20000, function () {
    var staff = activeStaffByLineId_(userId, replyToken);
    if (!staff) return;
    onTextBody_(staff, userId, text, replyToken, proc);
  }, function () {
    replyRaw_(replyToken, [msgText_('ただいま処理が混み合っています。少し待ってからもう一度お試しください。')]);
  });
}

/**
 * テキストメッセージ本体の処理（ロック取得済みの状態で呼ばれる）。
 * @param {Object} staff スタッフのS1行
 * @param {string} userId LINEユーザーID
 * @param {string} text 本文
 * @param {string} replyToken 返信トークン
 * @param {string} proc ログ用の処理名
 * @return {void}
 */
function onTextBody_(staff, userId, text, replyToken, proc) {
  try {
    // 「報告」コマンドの本文待ち
    var cache = CacheService.getScriptCache();
    if (cache.get('report_' + userId)) {
      cache.remove('report_' + userId);
      saveReport_(staff, text, replyToken);
      return;
    }
    // 「まとめ」コマンドの本文待ち（SwitchBotのAIまとめを貼り付けてもらう）
    if (cache.get('summary_' + userId)) {
      cache.remove('summary_' + userId);
      saveSummary_(staff, text, replyToken);
      return;
    }
    // 「シフト」コマンドの本文待ち
    if (cache.get('shift_' + userId)) {
      cache.remove('shift_' + userId);
      saveShift_(staff, text, replyToken);
      return;
    }
    // 回答への一言追記
    if (handleNote_(staff, text, replyToken)) return;

    switch (text) {
      case '状況': replyRaw_(replyToken, [msgText_(buildStatusText_(staff))]); return;
      case 'ヘルプ': replyRaw_(replyToken, [msgText_(HELP_TEXT_)]); return;
      case 'まとめ':
        if (!isOfficeStaff_(staff)) {
          replyRaw_(replyToken, [msgText_('このコマンドは社員のみ実行できます。')]);
          return;
        }
        cache.put('summary_' + userId, '1', 900);
        replyRaw_(replyToken, [msgText_('SwitchBotの「AIまとめ」の本文を、そのまま貼り付けて送ってください。\n'
          + '先頭に日付（例：8/11）を書くとその日の記録になります。書かなければ昨日として扱います。')]);
        return;
      case 'シフト':
        if (!isOfficeStaff_(staff)) {
          replyRaw_(replyToken, [msgText_('このコマンドは社員のみ実行できます。')]);
          return;
        }
        cache.put('shift_' + userId, '1', 900);
        replyRaw_(replyToken, [msgText_('シフト表を貼り付けて送ってください。\n'
          + '1行に「日付 拠点 勤務区分 氏名」を空白区切りで。\n'
          + '例）8/1 清水 夜勤 服部俊喜\n'
          + '先頭に「2026-08」と書くと、その年月として読みます。')]);
        return;
      case '精査':
        if (!isOfficeStaff_(staff)) {
          replyRaw_(replyToken, [msgText_('このコマンドは社員のみ実行できます。')]);
          return;
        }
        replyRaw_(replyToken, [msgText_(buildReviewText_())]);
        return;
      case '精度':
      case 'せいど':
        if (!isOfficeStaff_(staff)) {
          replyRaw_(replyToken, [msgText_('このコマンドは社員のみ実行できます。')]);
          return;
        }
        replyRaw_(replyToken, [msgText_(learnSummaryLines_().join('\n'))]);
        return;
      case '診断':
        if (!isOfficeStaff_(staff)) {
          replyRaw_(replyToken, [msgText_('このコマンドは社員のみ実行できます。')]);
          return;
        }
        replyRaw_(replyToken, [msgText_(exportDiagnostics(true))]);
        return;
      case '報告':
        cache.put('report_' + userId, '1', 600);
        replyRaw_(replyToken, [msgText_('報告の内容を送ってください（日時・何があったか・どう対応したか）。\n社員にもそのまま共有します。')]);
        return;
      case 'テスト実行':
        if (!isOfficeStaff_(staff)) {
          replyRaw_(replyToken, [msgText_('このコマンドは社員のみ実行できます。')]);
          return;
        }
        replyRaw_(replyToken, [msgText_('朝バッチを実行します。少しお待ちください。')]);
        var r = morningBatch();
        sendToStaff(staff['staff_id'], [msgText_('朝バッチの結果：' + r)], { label: proc, force: true });
        return;
      default:
        replyRaw_(replyToken, [msgText_('ボタンでお答えください。困ったら「ヘルプ」と送ってください。')]);
        logInfo(proc, staff['氏名'] + ' から想定外のテキスト: ' + truncate_(text, 100));
    }
  } catch (e) {
    logError(proc, e, text);
    replyRaw_(replyToken, [msgText_('申し訳ありません、処理中に問題が起きました。担当者に記録しました。')]);
  }
}

/**
 * 社員・管理者かどうか（管理コマンドを実行できる役割か）。
 * @param {Object} staff S1の行
 * @return {boolean} 社員・管理者ならtrue
 */
function isOfficeStaff_(staff) {
  var role = String(staff['役割']);
  return role === '社員' || role === '管理者';
}

/** ヘルプ本文 @type {string} */
var HELP_TEXT_ = 'AI Uriboの使い方\n'
  + '・届いた質問はボタンを押すだけでOKです\n'
  + '・「未実施だった」「わからない」を選んだときだけ、一言だけ理由を送ってください（不要なら「なし」）\n'
  + '・「状況」…今の未完了件数を確認できます\n'
  + '・「報告」…事故・体調急変などをその場で報告できます\n'
  + '・「ヘルプ」…このメッセージ\n'
  + '・「診断」…（社員のみ）不具合調査用の情報を返します\n'
  + '・「精査」…（社員のみ）データから推定して埋めた記録の一覧を返します\n'
  + '・「精度」…（社員のみ）自動データがどれくらい当たっているかを返します\n'
  + '・「まとめ」…（社員のみ）SwitchBotのAIまとめを貼り付けると記録に取り込みます\n'
  + '・「シフト」…（社員のみ）シフト表を貼り付けると、夜勤担当者を毎日聞かなくなります\n'
  + '答えられないときは無理をせず「わからない」で大丈夫です。社員が引き取ります。';

/**
 * 「状況」コマンドの本文を作る。
 * 社員・管理者は全体を、それ以外の役割は自分に割り当てられた分だけを見られる。
 * @param {Object} staff 問い合わせたスタッフのS1行
 * @return {string} 本文
 */
function buildStatusText_(staff) {
  var role = String(staff['役割']);
  var seesAll = (role === '社員' || role === '管理者');
  var pending = pendingGaps_();
  if (!seesAll) {
    var myId = String(staff['staff_id']);
    pending = pending.filter(function (g) {
      return String(g['一次確認先staff_id'] || '').split(',').some(function (id) {
        return id.trim() === myId;
      });
    });
  }
  var lines = ['【現在の状況】' + nowStr_()];
  lines.push((seesAll ? '未完了：' : 'あなたの未完了：') + pending.length + '件');
  pending.slice(0, 10).forEach(function (g) {
    var c = checkById_(g['check_id']);
    lines.push('・' + toDateStr_(g['対象日']) + ' ' + displayName_(String(g['対象']))
      + ' 「' + (c ? c['項目名'] : g['check_id']) + '」（' + g['状態'] + '）');
  });
  if (pending.length > 10) lines.push('…ほか' + (pending.length - 10) + '件');
  if (!pending.length) lines.push('すべて記録済みです。ありがとうございます。');
  return lines.join('\n');
}

/**
 * 貼り付けられた「AIまとめ」を取り込み、その場で自動充足まで走らせる。
 * 映像は受け取らず、文章だけをS4に残す。
 * @param {Object} staff 貼り付けたスタッフのS1行
 * @param {string} text 本文（先頭に日付があれば対象日として使う）
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function saveSummary_(staff, text, replyToken) {
  var proc = 'saveSummary_';
  var body = String(text).trim();
  var date = addDays_(todayStr_(), -1);

  // 先頭の日付（2026/08/11・2026-08-11・8/11 のいずれか）を対象日として読む
  var m = body.match(/^\s*(20\d{2})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) {
    date = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    body = body.substring(m[0].length).trim();
  } else {
    var m2 = body.match(/^\s*(\d{1,2})[\/\-.](\d{1,2})/);
    if (m2) {
      date = todayStr_().substring(0, 4) + '-' + ('0' + m2[1]).slice(-2) + '-' + ('0' + m2[2]).slice(-2);
      body = body.substring(m2[0].length).trim();
    }
  }
  if (!body) {
    replyRaw_(replyToken, [msgText_('本文が読み取れませんでした。もう一度「まとめ」から始めてください。')]);
    return;
  }

  appendRow(SHEETS.LOG_IMPORT, {
    'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
    '発生日': date,
    '対象種別': 'raw_summary',
    '対象': String(staff['拠点'] === '本部' ? 'ALL' : (staff['拠点'] || 'ALL')),
    '項目名': 'AIまとめ',
    '値': truncate_(body, 1000),
    '取込元': 'switchbot-ai',
    '取込日時': nowStr_()
  });

  var auto = safely_(proc, function () { return runAutoFill(date); }, { filled: 0, estimated: 0 });
  var alerts = safely_(proc, function () { return scanAlerts_(date); }, 0);

  var lines = ['取り込みました（' + date + '分）。'];
  lines.push('この文章から ' + auto.filled + '件を記録に反映しました（うち推定 ' + auto.estimated + '件）。');
  if (alerts) lines.push('※気になる記述があったため、社員に別途お知らせしました。');
  lines.push('内容は「精査」と送ると確認できます。');
  replyRaw_(replyToken, [msgText_(lines.join('\n'))]);
  logInfo(proc, staff['氏名'] + ' がAIまとめを取り込み（' + date + '・' + auto.filled + '件反映）');
}

/**
 * 貼り付けられたシフト表を取り込む。
 * @param {Object} staff 送信したスタッフのS1行
 * @param {string} text 貼り付け本文
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function saveShift_(staff, text, replyToken) {
  var proc = 'saveShift_';
  var r = importShiftText(text);
  replyRaw_(replyToken, [msgText_(shiftResultText_(r))]);
  logInfo(proc, staff['氏名'] + ' がシフト表を取り込み（追加' + r.追加 + '件・更新' + r.更新
    + '件・読めなかった行' + r.読めなかった行.length + '件）');
}

/**
 * 「精査」コマンドの本文を作る。
 * 推定で埋めた記録（要精査=TRUE）を新しい順に並べ、現場が中身を見て直せるようにする。
 * @return {string} 本文
 */
function buildReviewText_() {
  var rows = findRows(SHEETS.FILL, function (r) {
    return isTrue_(r['要精査']) && !String(r['精査結果'] || '').trim();
  })
    .sort(function (a, b) {
      return toDateTimeStr_(b['作成日時']).localeCompare(toDateTimeStr_(a['作成日時']));
    });
  if (!rows.length) return 'まだ確かめていない推定の記録はありません。';

  var lines = ['【推定で埋めた記録（未確認）】' + rows.length + '件'];
  rows.slice(0, 10).forEach(function (r) {
    lines.push('・' + toDateStr_(r['対象日']) + ' ' + displayName_(String(r['対象']))
      + ' 「' + r['項目名'] + '」\n　→ ' + truncate_(String(r['値']), 60));
  });
  if (rows.length > 10) lines.push('…ほか' + (rows.length - 10) + '件');
  lines.push('');
  lines.push('内容が違っていれば、台帳のS7補完台帳で値を直し、要精査列をFALSEにしてください。');
  lines.push('※同じ項目の質問に答えていただくと、この一覧からは自動で消え、AIの精度の実績になります。');
  return lines.join('\n');
}

/**
 * 「報告」コマンドの内容を保存し、社員へ共有する（A7 緊急時・異常時対応）。
 * @param {Object} staff 報告者のS1行
 * @param {string} text 報告本文
 * @param {string} replyToken 返信トークン
 * @return {void}
 */
function saveReport_(staff, text, replyToken) {
  appendRow(SHEETS.LOG_IMPORT, {
    'log_id': nextSeqId_(SHEETS.LOG_IMPORT, 'log_id', 'LOG', 6),
    '発生日': todayStr_(),
    '対象種別': 'report',
    '対象': String(staff['staff_id']),
    '項目名': '緊急時・異常時対応',
    '値': text,
    '取込元': 'line-report',
    '取込日時': nowStr_()
  });
  appendRow(SHEETS.FILL, {
    'fill_id': nextSeqId_(SHEETS.FILL, 'fill_id', 'FIL', 6),
    '対象日': todayStr_(),
    '対象': String(staff['staff_id']),
    '項目名': '緊急時・異常時対応',
    '値': text,
    '記入者staff_id': String(staff['staff_id']),
    '取込済フラグ': false,
    '作成日時': nowStr_()
  });
  replyRaw_(replyToken, [msgText_('報告を受け取りました。社員に共有します。ありがとうございます。')]);
  sendToEscalationStaff([msgText_('【報告】' + staff['氏名'] + 'さんより（' + nowStr_() + '）\n' + text)], 'saveReport_');
  logInfo('saveReport_', staff['氏名'] + ' からの報告を記録');
}

// ============================================================================
// api.gs
// ============================================================================

/**
 * 既存アプリ向けの受け渡し口（読み取りAPI）
 *
 * 【何のためにあるか】
 * AI Uriboが埋めた記録は、最後は既存アプリのDBに戻らないと意味がない。
 * 人がスプレッドシートを開いてコピーする運用にすると、そこだけ手作業が残り、
 * しかも「まだ取り込んでいない分」が分からなくなる。
 * そこで、既存アプリが自分で取りに来られる口を用意する。
 *
 *   1. GET  ?k=＜秘密キー＞&mode=fills          … まだ渡していない補完台帳を受け取る
 *   2. POST {"action":"markImported","fill_ids":[...]} … 取り込んだものに済みを付ける
 *
 * 2まで済ませて初めて「渡した」とみなす。取り込みに失敗したら済みを付けなければ、
 * 次の呼び出しでまた同じものが返るので、取りこぼしが起きない。
 *
 * 【個人情報の扱い】
 * 記録には利用者の氏名を含めない（user_codeだけ）。氏名が要るときは mode=users を
 * 1回だけ呼んで対応表を作ること。どちらも秘密キーが無ければ何も返さない。
 * 診断名・病名などの医療情報はそもそも台帳に無いので、当然ここからも出ない。
 */

/**
 * オブジェクトをJSONとして返す。
 * @param {Object} obj 応答オブジェクト
 * @return {TextOutput} 応答
 */
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 1回の呼び出しで返す最大件数 @type {number} */
var API_MAX_ROWS = 500;

/**
 * 読み取りAPI（GET）の入口。
 * @param {Object} e リクエストイベント
 * @return {TextOutput} 応答
 */
function handleApiGet_(e) {
  var proc = 'api';
  var mode = String((e && e.parameter && e.parameter.mode) || '').trim();

  if (!verifyApiKey_(e)) {
    logWarn(proc, '秘密キーが違うためAPIの要求を拒否しました（mode=' + mode + '）');
    return jsonOut_({ ok: false, error: 'unauthorized' });
  }

  switch (mode) {
    case 'fills': return jsonOut_(apiFills_(e));
    case 'users': return jsonOut_(apiUsers_());
    case 'ping': return jsonOut_(apiPing_());
    default:
      return jsonOut_({ ok: false, error: 'unknown mode',
        modes: ['fills', 'users', 'ping'] });
  }
}

/**
 * APIの秘密キーを確認する。
 * API_SECRET が設定されていればそれを使い、無ければWebhookと同じ鍵を使う。
 * どちらも未設定なら受け付けない（設定漏れがそのまま認証無効化にならないようにする）。
 * @param {Object} e リクエストイベント
 * @return {boolean} 正当ならtrue
 */
function verifyApiKey_(e) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('API_SECRET') || props.getProperty(PROP.WEBHOOK_KEY);
  if (!key) {
    logError('verifyApiKey_', 'API_SECRET も WEBHOOK_SECRET も未設定のため要求を拒否しました');
    return false;
  }
  return !!(e && e.parameter && String(e.parameter.k) === String(key));
}

/**
 * まだ既存アプリに渡していない補完台帳を返す。
 *
 * 既定では「要精査」の行も含めて渡す（隙間を残さないため）。
 * 確かめ済みのものだけが欲しい場合は reviewed=1 を付ける。
 * @param {Object} e リクエストイベント
 * @return {Object} 応答オブジェクト
 */
function apiFills_(e) {
  var p = (e && e.parameter) || {};
  var from = String(p.from || '').trim();
  var to = String(p.to || '').trim();
  var onlyReviewed = String(p.reviewed || '') === '1';
  var limit = Math.min(Number(p.limit || API_MAX_ROWS) || API_MAX_ROWS, API_MAX_ROWS);

  var rows = findRows(SHEETS.FILL, function (r) {
    if (isTrue_(r['取込済フラグ'])) return false;
    var d = toDateStr_(r['対象日']);
    if (from && d < from) return false;
    if (to && d > to) return false;
    if (onlyReviewed && isTrue_(r['要精査'])) return false;
    return true;
  });

  var items = rows.slice(0, limit).map(function (r) {
    return {
      fill_id: String(r['fill_id']),
      対象日: toDateStr_(r['対象日']),
      対象: String(r['対象']),
      項目名: String(r['項目名']),
      値: String(r['値']),
      情報源: String(r['情報源'] || ''),
      要精査: isTrue_(r['要精査']),
      精査結果: String(r['精査結果'] || ''),
      記入者staff_id: String(r['記入者staff_id'] || ''),
      作成日時: toDateTimeStr_(r['作成日時'])
    };
  });

  logInfo('api', 'fills を ' + items.length + '件返しました（未取込 全' + rows.length + '件）');
  return {
    ok: true, count: items.length, remaining: Math.max(0, rows.length - items.length),
    items: items,
    note: '取り込めたものは POST {"action":"markImported","fill_ids":[...]} で済みを付けてください'
  };
}

/**
 * user_code と氏名の対応表を返す（既存アプリ側のひも付け用）。
 * @return {Object} 応答オブジェクト
 */
function apiUsers_() {
  var items = findRows(SHEETS.USER).map(function (u) {
    var code = String(u['user_code']);
    return { user_code: code, 氏名: displayName_(code), 拠点: String(u['拠点'] || ''),
             有効: isTrue_(u['有効']) };
  });
  logInfo('api', 'users を ' + items.length + '件返しました');
  return { ok: true, count: items.length, items: items };
}

/**
 * 生きているかどうかと、いまの残件を返す（既存アプリ側の監視用）。
 * @return {Object} 応答オブジェクト
 */
function apiPing_() {
  return {
    ok: true,
    時刻: nowStr_(),
    未取込の補完: findRows(SHEETS.FILL, function (r) { return !isTrue_(r['取込済フラグ']); }).length,
    未完了の不足: findRows(SHEETS.GAP, function (r) { return String(r['状態']) !== GAP_STATUS.DONE; }).length,
    テストモード: isTrue_(getSetting('test_mode', 'FALSE'))
  };
}

/**
 * 取り込みが済んだ補完台帳に済みを付ける（POST）。
 * 他の処理と重なって書き込めなかったときは -1 を返す。
 * 0（対象なし）と混同すると、既存アプリが「済んだ」と誤解して同じ記録を二度と受け取れなくなる。
 * @param {Object} body リクエストボディ
 * @return {number} 済みを付けた件数。書き込めなかったときは -1
 */
function markImported_(body) {
  var proc = 'markImported';
  var ids = body.fill_ids || [];
  if (!ids.length) return 0;

  return withLock_(proc, 60000, function () {
    var want = {};
    ids.forEach(function (id) { want[String(id)] = true; });
    var n = 0;
    findRows(SHEETS.FILL, function (r) {
      return want[String(r['fill_id'])] && !isTrue_(r['取込済フラグ']);
    }).forEach(function (r) {
      updateRow(SHEETS.FILL, r._row, { '取込済フラグ': true });
      n++;
    });
    logInfo(proc, ids.length + '件の指定のうち ' + n + '件に取込済みを付けました');
    return n;
  }, function () {
    logWarn(proc, '他の処理が実行中のため取込済みを付けられませんでした（呼び出し側でやり直してください）');
    return -1;
  });
}

// ============================================================================
// monthly.gs
// ============================================================================

/**
 * 月次まとめ（実地指導・監査に備えるための一覧）
 *
 * 【なぜ要るか】
 * 監査で問われるのは「その日、その人に、何をしたか」が残っているかどうか。
 * 日々の運用では、どの項目がどれだけ埋まっているのかが見えないまま月が過ぎる。
 * 月が変わったところで、拠点ごと・利用者ごと・項目ごとに
 * 「対象だった日数のうち、何日ぶん記録が残っているか」を一覧にする。
 *
 * 【見方】
 *   対象日数 … その利用者について記録が要る日数（外泊・入院の日は除く）
 *   記録あり … 実際に記録が残っている日数
 *   うち推定 … データからの推定で埋めたまま、まだ人が確かめていない日数
 *   充足率   … 記録あり ÷ 対象日数
 *
 * 充足率が低い項目が、そのまま「監査で突かれるところ」であり、
 * 「現場が実態をつかめていないところ」でもある。数字を見て手当てするのは人。
 */

/**
 * 月次まとめを作る。
 * @param {string} [yyyymm] 対象月 YYYY-MM（省略時は前月）
 * @return {string} 実行サマリ
 */
function monthlyReport(yyyymm) {
  var proc = 'monthlyReport';
  return withLock_(proc, BATCH_LOCK_WAIT_MS, function () {
    try {
      logStart(proc);
      var month = String(yyyymm || '').trim() || previousMonth_();
      var days = monthDays_(month);
      var rows = buildMonthlyRows_(month, days);
      writeMonthlySheet_(month, rows);
      var n = sendMonthlySummary_(proc, month, days.length, rows);

      var summary = month + ' の月次まとめ：' + rows.length + '行 / 送信' + n + '名';
      logInfo(proc, summary);
      writeLog(proc, '月次集計', JSON.stringify({ 対象月: month, 日数: days.length, 行数: rows.length }));
      return summary;
    } catch (e) {
      logError(proc, e);
      return 'エラー: ' + e;
    }
  }, function () { return '他の処理が実行中のためスキップ'; });
}

/**
 * 前月（YYYY-MM）を返す。
 * @return {string} YYYY-MM
 */
function previousMonth_() {
  var today = todayStr_();
  var firstOfThisMonth = today.substring(0, 8) + '01';
  return addDays_(firstOfThisMonth, -1).substring(0, 7);
}

/**
 * その月の日付（YYYY-MM-DD）を並べる。未来の日は含めない。
 * @param {string} month YYYY-MM
 * @return {Array.<string>} 日付の配列
 */
function monthDays_(month) {
  var days = [];
  var today = todayStr_();
  var d = month + '-01';
  while (d.substring(0, 7) === month) {
    if (d <= today) days.push(d);
    d = addDays_(d, 1);
  }
  return days;
}

/**
 * 月次まとめの明細を作る。
 * @param {string} month YYYY-MM
 * @param {Array.<string>} days 対象日の配列
 * @return {Array.<Object>} 明細
 */
function buildMonthlyRows_(month, days) {
  var users = findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); });
  var checks = findRows(SHEETS.CHECK, function (r) {
    return String(r['対象種別']) === 'support' && isTrue_(r['有効']) && String(r['判定ルールID']) !== '-';
  });
  if (!users.length || !checks.length) return [];

  // その月の支援記録を 対象＋日付＋項目名 で引けるようにする
  var recorded = {};
  var absent = {};
  findRows(SHEETS.LOG_IMPORT, function (r) {
    return String(r['対象種別']) === 'support' && toDateStr_(r['発生日']).substring(0, 7) === month;
  }).forEach(function (r) {
    var day = toDateStr_(r['発生日']);
    var key = r['対象'] + '\t' + day + '\t' + r['項目名'];
    recorded[key] = String(r['確度']) === CERTAINTY.ESTIMATED ? '推定' : '記録';
    // 外泊・入院の日は、その利用者のその日を対象から外す（検出の考え方と合わせる）
    if (String(r['項目名']) === '在否確認' && /外泊|入院|帰省|不在/.test(String(r['値']))) {
      absent[r['対象'] + '\t' + day] = true;
    }
  });

  var out = [];
  users.forEach(function (u) {
    var code = String(u['user_code']);
    var targetDays = days.filter(function (d) { return !absent[code + '\t' + d]; });

    checks.forEach(function (c) {
      var item = String(c['項目名']);
      var have = 0;
      var estimated = 0;
      var missing = [];
      targetDays.forEach(function (d) {
        var state = recorded[code + '\t' + d + '\t' + item];
        if (!state) { missing.push(d.substring(8)); return; }
        have++;
        if (state === '推定') estimated++;
      });
      out.push({
        拠点: String(u['拠点'] || ''),
        user_code: code,
        項目: item,
        対象日数: targetDays.length,
        記録あり: have,
        うち推定: estimated,
        充足率: targetDays.length ? Math.round(have * 100 / targetDays.length) : 100,
        未記録日: missing.slice(0, 15).join('・') + (missing.length > 15 ? '…' : '')
      });
    });
  });
  return out;
}

/**
 * 月次まとめをシートに書く（同じ月を作り直したら上書きする）。
 * @param {string} month YYYY-MM
 * @param {Array.<Object>} rows 明細
 * @return {void}
 */
function writeMonthlySheet_(month, rows) {
  var name = '月次_' + month;
  var book = book_();
  var headers = ['拠点', 'user_code', '項目', '対象日数', '記録あり', 'うち推定', '充足率(%)', '未記録日'];
  var sh = book.getSheetByName(name);
  if (!sh) {
    sh = book.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#EFEFEF');
    sh.setFrozenRows(1);
    sh.getRange(1, 1).setNote('月次まとめ。対象日数は外泊・入院の日を除いた日数。'
      + '「うち推定」はデータから推定で埋めたまま、まだ人が確かめていない日数。'
      + '氏名は載せない（S9_対応表で照合すること）');
  } else if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).clearContent();
  }
  if (!rows.length) return;

  var values = rows.map(function (r) {
    return [r.拠点, r.user_code, r.項目, r.対象日数, r.記録あり, r.うち推定, r.充足率, r.未記録日];
  });
  sh.getRange(2, 1, values.length, headers.length).setValues(values);
  invalidateCache_(name);
}

/**
 * 月次まとめの要点を社員へ送る。
 * 数字を全部送っても読めないので、拠点ごとの充足率と、弱い項目だけを出す。
 * @param {string} proc ログ用の処理名
 * @param {string} month YYYY-MM
 * @param {number} dayCount 対象日数
 * @param {Array.<Object>} rows 明細
 * @return {number} 送信人数
 */
function sendMonthlySummary_(proc, month, dayCount, rows) {
  var lines = ['【月次まとめ】' + month + '（' + dayCount + '日分）'];

  if (!rows.length) {
    lines.push('');
    lines.push('対象の記録がありません（利用者の登録か、支援記録の開始をご確認ください）。');
    return sendToEscalationStaff([msgText_(lines.join('\n'))], proc);
  }

  // 拠点ごとの充足率
  var bySite = {};
  rows.forEach(function (r) {
    if (!bySite[r.拠点]) bySite[r.拠点] = { 対象: 0, 記録: 0, 推定: 0 };
    bySite[r.拠点].対象 += r.対象日数;
    bySite[r.拠点].記録 += r.記録あり;
    bySite[r.拠点].推定 += r.うち推定;
  });
  lines.push('');
  Object.keys(bySite).forEach(function (site) {
    var s = bySite[site];
    lines.push('■' + (site || '拠点未設定') + '　充足率 '
      + (s.対象 ? Math.round(s.記録 * 100 / s.対象) : 100) + '%'
      + '（記録 ' + s.記録 + '/' + s.対象 + '・うち未確認の推定 ' + s.推定 + '）');
  });

  // 弱いところから5つ
  var weak = rows.filter(function (r) { return r.充足率 < 100; })
    .sort(function (a, b) { return a.充足率 - b.充足率; });
  lines.push('');
  if (!weak.length) {
    lines.push('すべての項目が埋まっています。');
  } else {
    lines.push('▼記録が足りていない項目（弱い順に5件）');
    weak.slice(0, 5).forEach(function (r) {
      lines.push('・' + displayName_(r.user_code) + '「' + r.項目 + '」 '
        + r.記録あり + '/' + r.対象日数 + '日（' + r.充足率 + '%）');
      if (r.未記録日) lines.push('　未記録：' + r.未記録日 + '日');
    });
    if (weak.length > 5) lines.push('…ほか' + (weak.length - 5) + '項目');
  }
  lines.push('');
  lines.push('詳しくは台帳の「月次_' + month + '」シートをご覧ください。');
  return sendToEscalationStaff([msgText_(lines.join('\n'))], proc);
}

/**
 * メニューから先月の月次まとめを作る。
 * @return {void}
 */
function menuMonthlyReport_() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('月次まとめ', '対象月を YYYY-MM で入力してください（空欄なら先月）',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  ui.alert('月次まとめ', monthlyReport(String(res.getResponseText()).trim()), ui.ButtonSet.OK);
}

// ============================================================================
// selfcheck.gs
// ============================================================================

/**
 * 自己点検と自動整理（手がかからないための仕組み）
 *
 * 【考え方】
 * 常駐システムがいちばん危ないのは「止まっているのに誰も気づかない」こと。
 * トリガーが消えた、Webhookが切れた、センサーの電池が切れた、台帳が重くなった——
 * どれも現場では気づけないまま、記録だけが静かに欠けていく。
 *
 * そこで毎朝、システム自身が自分の状態を点検する。
 *   ・直せるもの（消えたトリガー等）は自分で直す
 *   ・人の手が要るものだけ、1通にまとめて社員へ知らせる
 *   ・何も問題が無ければ何も送らない（毎日「異常なし」が届くと、やがて誰も読まなくなるため）
 *
 * 台帳の肥大化も放っておくと処理時間の上限に当たるので、
 * バックアップ済みの古い行を「_保管」シートへ自動で移す（消さない）。
 */

/**
 * 自己点検を実行する。問題があれば社員へ1通だけ送る。
 * @return {string} 実行サマリ
 */
function selfCheck() {
  var proc = 'selfCheck';
  return withLock_(proc, 60000, function () { return selfCheckBody_(proc); },
    function () { return '他の処理が実行中のためスキップ'; });
}

/**
 * 自己点検の本体（ロック取得済みの状態で呼ばれる）。
 * @param {string} proc ログ用の処理名
 * @return {string} 実行サマリ
 */
function selfCheckBody_(proc) {
  logStart(proc);
  var issues = [];   // 人の手が要ること
  var fixed = [];    // 自分で直したこと

  safely_(proc, function () { checkTriggers_(issues, fixed); });
  safely_(proc, function () { checkBatchesRan_(issues); });
  safely_(proc, function () { checkSecrets_(issues); });
  safely_(proc, function () { checkStaffLinked_(issues); });
  safely_(proc, function () { checkStuckQueue_(issues); });
  safely_(proc, function () { checkTestMode_(issues); });
  safely_(proc, function () { checkDevices_(issues); });
  safely_(proc, function () { checkLearning_(issues); });
  safely_(proc, function () { checkSheetSize_(issues); });
  safely_(proc, function () { checkSlowBatch_(issues); });
  safely_(proc, function () { checkSiteNames_(issues); });

  var summary = '要対応' + issues.length + '件 / 自動修復' + fixed.length + '件';
  if (fixed.length) logInfo(proc, '自動修復: ' + fixed.join(' / '));

  if (!issues.length) {
    logInfo(proc, summary + '（通知なし）');
    return summary;
  }

  // 同じ内容を毎日送らない（同じ知らせが続くと読まれなくなるため、内容が変わった日だけ送る）
  var body = issues.join('\n');
  var cache = CacheService.getScriptCache();
  var digest = String(body.length) + ':' + body.substring(0, 80);
  if (cache.get('selfcheck_last') === digest) {
    logInfo(proc, summary + '（前回と同じ内容のため送信省略）');
    return summary + '（通知省略）';
  }
  cache.put('selfcheck_last', digest, 21600);

  var lines = ['【AI Uribo 自己点検】' + nowStr_()];
  lines.push('次の点をご確認ください。');
  lines.push('');
  issues.forEach(function (t) { lines.push('・' + t); });
  if (fixed.length) {
    lines.push('');
    lines.push('（自動で直したもの：' + fixed.join('、') + '）');
  }
  var n = sendToEscalationStaff([msgText_(lines.join('\n'))], proc);
  logInfo(proc, summary + ' / 送信' + n + '名');
  return summary;
}

/**
 * トリガーが揃っているかを見て、足りなければ自分で入れ直す。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @param {Array.<string>} fixed 自動修復した内容の配列（追記される）
 * @return {void}
 */
function checkTriggers_(issues, fixed) {
  var required = ['morningBatch', 'nightBatch', 'weeklyDigest', 'dailyBackup', 'flushQueue', 'selfCheck'];
  var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
  var missing = required.filter(function (f) { return handlers.indexOf(f) < 0; });
  if (!missing.length) return;

  // トリガーは消えていても現場からは見えない。気づいた時点で自分で入れ直す
  installTriggers();
  fixed.push('トリガーの再設定（' + missing.join('・') + '）');
}

/**
 * 各バッチがちゃんと動いているかを、実行ログの最終記録から見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkBatchesRan_(issues) {
  var logs = findRows(SHEETS.RUN_LOG);
  var limits = { morningBatch: 2, nightBatch: 2, dailyBackup: 2, weeklyDigest: 9 };
  var labels = { morningBatch: '朝の確認', nightBatch: '夜の確認セット',
                 dailyBackup: 'バックアップ', weeklyDigest: '週次ダイジェスト' };

  Object.keys(limits).forEach(function (name) {
    var last = '';
    logs.forEach(function (r) {
      if (String(r['処理名']) === name && String(r['結果']) !== '開始') last = toDateTimeStr_(r['日時']);
    });
    if (!last) return;   // 一度も動いていない＝まだ運用前。ここでは騒がない
    var days = daysBetween_(last.substring(0, 10), todayStr_());
    if (days > limits[name]) {
      issues.push(labels[name] + 'が' + days + '日動いていません（最後：' + last + '）。'
        + 'スプレッドシートのメニュー「AI Uribo」→「トリガーを設定」をもう一度実行してください');
    }
  });
}

/**
 * 秘密情報が設定されているかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkSecrets_(issues) {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(PROP.TOKEN)) issues.push('LINEのアクセストークンが未設定です（送信できません）');
  if (!props.getProperty(PROP.WEBHOOK_KEY)) issues.push('Webhook秘密キーが未設定です（LINEからの操作をすべて拒否します）');
}

/**
 * 有効なスタッフでLINE紐付けが済んでいない人がいないかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkStaffLinked_(issues) {
  var waiting = findRows(SHEETS.STAFF, function (r) {
    return isTrue_(r['有効']) && !String(r['line_user_id'] || '').trim();
  });
  if (waiting.length) {
    issues.push('LINEの登録が済んでいない方が' + waiting.length + '名います（'
      + waiting.map(function (r) { return String(r['staff_id']); }).join('・')
      + '）。登録コードをお渡しください');
  }
}

/**
 * 送れないまま溜まっている送信がないかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkStuckQueue_(issues) {
  var expire = getSettingNum('queue_expire_hours', 24);
  var stuck = findRows(SHEETS.TASK, function (r) {
    var st = String(r['送信状態']);
    if (st !== SEND_STATUS.QUEUED && st !== SEND_STATUS.FAILED) return false;
    var created = toDateTimeStr_(r['作成日時']).substring(0, 10);
    return created && daysBetween_(created, todayStr_()) * 24 > expire;
  });
  if (stuck.length) {
    issues.push('送れないまま残っている確認が' + stuck.length + '件あります'
      + '（LINEのトークンか、相手の友だち登録をご確認ください）');
  }
}

/**
 * テストモードが入ったままになっていないかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkTestMode_(issues) {
  if (!isTrue_(getSetting('test_mode', 'FALSE'))) return;
  // 運用が始まっているのにテストモードのままだと、誰にも届かないまま記録だけが溜まる
  var sent = findRows(SHEETS.TASK, function (r) { return String(r['送信状態']) === SEND_STATUS.TEST; });
  if (sent.length >= 20) {
    issues.push('テストモードがONのままです（' + sent.length + '件がLINEに届いていません）。'
      + 'S8設定の test_mode を FALSE にすると実際に送られます');
  }
}

/**
 * 機器から情報が届かなくなっていないかを見る（電池切れ・置き場所の変更など）。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkDevices_(issues) {
  var devices = findRows(SHEETS.DEVICE, function (r) { return isTrue_(r['有効']); });
  if (!devices.length) return;

  // 自動データの取込元は「switchbot-poll:<deviceId>」の形で入っているので、機器ごとに追える。
  // 部分一致だと別の機器のIDに含まれてしまうことがあるため、IDそのもので突き合わせる
  var since = addDays_(todayStr_(), -3);
  var heard = {};
  findRows(SHEETS.LOG_IMPORT, function (r) {
    return toDateStr_(r['発生日']) >= since && String(r['対象種別']).indexOf('raw_') === 0;
  }).forEach(function (r) {
    var parts = String(r['取込元']).split(':');
    if (parts.length > 1) heard[parts[parts.length - 1]] = true;
  });

  var silent = devices.filter(function (d) {
    return !heard[String(d['deviceId'])];
  });
  // 全機器が黙っているときは、機器側ではなく連携そのものが止まっている可能性が高い
  if (silent.length && silent.length === devices.length) {
    issues.push('SwitchBotから3日間なにも届いていません（連携かWebhookの設定をご確認ください）');
  } else if (silent.length) {
    issues.push('3日間なにも届いていない機器があります：'
      + silent.slice(0, 5).map(function (d) { return String(d['deviceName']); }).join('・')
      + '（電池切れ・置き場所の変更かもしれません）');
  }
}

/**
 * 自動データの精度が落ちた組み合わせがないかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkLearning_(issues) {
  var review = findRows(SHEETS.LEARN, function (r) { return String(r['段階']) === LEARN_STAGE.REVIEW; });
  if (!review.length) return;
  issues.push('自動データが当たらなくなった項目があります：'
    + review.map(function (r) { return String(r['項目名']) + '（' + String(r['情報源']) + '）'; }).join('・')
    + '。機器の位置ずれ・故障や、運用の変更が考えられます（当面は人に確認しています）');
}

/**
 * 台帳が重くなっていないかを見る。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkSheetSize_(issues) {
  var limit = getSettingNum('sheet_warn_rows', 20000);
  var big = [];
  [SHEETS.LOG_IMPORT, SHEETS.TASK, SHEETS.FILL, SHEETS.GAP, SHEETS.RUN_LOG].forEach(function (name) {
    var sh = book_().getSheetByName(name);
    if (sh && sh.getLastRow() > limit) big.push(name + '（' + sh.getLastRow() + '行）');
  });
  if (big.length) {
    issues.push('台帳が大きくなっています：' + big.join('・')
      + '。自動整理が効いているかご確認ください（S8設定 archive_enabled）');
  }
}

/**
 * 拠点名の書き方がそろっているかを見る。
 *
 * 「清水」と「うりぼベース清水」のように書き方がぶれると、
 * シフト表の夜勤がどの拠点のものか分からなくなり、機器も利用者に結びつかない。
 * 表記ゆれは画面上は些細に見えて、記録が静かに欠ける原因になる。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkSiteNames_(issues) {
  var known = {};
  findRows(SHEETS.USER, function (r) { return isTrue_(r['有効']); })
    .forEach(function (u) { if (u['拠点']) known[String(u['拠点']).trim()] = true; });
  if (!Object.keys(known).length) return;   // 利用者未登録。ここでは騒がない

  var odd = {};
  var since = addDays_(todayStr_(), -7);
  findRows(SHEETS.SHIFT_PLAN, function (r) { return toDateStr_(r['日付']) >= since; })
    .forEach(function (r) {
      var site = String(r['拠点'] || '').trim();
      if (site && !known[site]) odd[site] = 'シフト表';
    });
  findRows(SHEETS.DEVICE, function (r) { return isTrue_(r['有効']); })
    .forEach(function (r) {
      var site = String(r['拠点'] || '').trim();
      if (site && !known[site]) odd[site] = '機器マスタ';
    });

  var names = Object.keys(odd);
  if (!names.length) return;
  issues.push('拠点名の書き方がそろっていません：'
    + names.map(function (n) { return '「' + n + '」（' + odd[n] + '）'; }).join('・')
    + '。S2_利用者マスタの拠点（' + Object.keys(known).join('・') + '）と同じ書き方に直してください');
}

/**
 * バッチが時間切れ寸前になっていないかを見る。
 * 件数が増えると、いつか6分の上限に当たる。当たる前に気づけるようにしておく。
 * @param {Array.<string>} issues 要対応の配列（追記される）
 * @return {void}
 */
function checkSlowBatch_(issues) {
  var since = addDays_(todayStr_(), -3);
  var slow = findRows(SHEETS.RUN_LOG, function (r) {
    return String(r['結果']) === '警告'
      && String(r['詳細']).indexOf('実行時間が長くなったため') >= 0
      && toDateTimeStr_(r['日時']).substring(0, 10) >= since;
  });
  if (!slow.length) return;
  issues.push('処理が時間内に終わらず、送信を次回に回した日があります（直近3日で' + slow.length + '回）。'
    + '件数が増えています。S8設定の max_items_per_message を減らすか、'
    + '対象の項目を絞ることをご検討ください');
}

/**
 * 2つの日付の差（日数）を返す。
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 * @return {number} 日数
 */
function daysBetween_(from, to) {
  var a = new Date(String(from) + 'T00:00:00+09:00').getTime();
  var b = new Date(String(to) + 'T00:00:00+09:00').getTime();
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------------
// 自動整理（古い行を「_保管」シートへ移す）
// ---------------------------------------------------------------------------

/**
 * 自動整理の対象。
 * まだ使っている行（未完了の不足・返事待ちの確認・既存アプリが未取込の補完）は動かさない。
 * @type {Array.<Object>}
 */
var ARCHIVE_RULES = [
  {
    sheet: SHEETS.LOG_IMPORT, 日付列: '発生日', 設定: 'archive_after_days',
    説明: '実績ログ（取込済みの過去分）',
    条件: function () { return true; }
  },
  {
    sheet: SHEETS.GAP, 日付列: '対象日', 設定: 'archive_after_days',
    説明: '完了した不足検出',
    条件: function (r) { return String(r['状態']) === GAP_STATUS.DONE; }
  },
  {
    sheet: SHEETS.TASK, 日付列: '作成日時', 設定: 'archive_after_days',
    説明: '送信・回答が済んだ確認タスク',
    条件: function (r) {
      return !isTrue_(r['追記待ち'])
        && [SEND_STATUS.SENT, SEND_STATUS.CANCELED, SEND_STATUS.TEST, SEND_STATUS.FAILED]
          .indexOf(String(r['送信状態'])) >= 0;
    }
  },
  {
    sheet: SHEETS.FILL, 日付列: '対象日', 設定: 'archive_after_days',
    説明: '既存アプリが取り込み済みの補完台帳',
    条件: function (r) { return isTrue_(r['取込済フラグ']); }
  },
  {
    sheet: SHEETS.RUN_LOG, 日付列: '日時', 設定: 'log_keep_days',
    説明: '実行ログ',
    条件: function () { return true; }
  }
];

/**
 * 古い行を「_保管」シートへ移す。
 *
 * バックアップの直後に呼ぶこと（保管シートへ移す前のCSVが必ず1本残るようにするため）。
 * 消さずに同じ台帳の中へ移すだけなので、後から見返せる。
 * @return {string} 実行サマリ
 */
function archiveOldRows() {
  var proc = 'archiveOldRows';
  if (!isTrue_(getSetting('archive_enabled', 'TRUE'))) return '自動整理はOFF';

  var moved = [];
  ARCHIVE_RULES.forEach(function (rule) {
    safely_(proc, function () {
      var days = getSettingNum(rule.設定, 180);
      var n = archiveSheet_(rule, days);
      if (n) moved.push(rule.sheet + ' ' + n + '行');
    });
  });

  var summary = moved.length ? '保管へ移動: ' + moved.join(' / ') : '移動なし';
  logInfo(proc, summary);
  return summary;
}

/**
 * 1シート分の自動整理を行う。
 * @param {Object} rule ARCHIVE_RULESの1件
 * @param {number} keepDays 何日分を手元に残すか
 * @return {number} 移動した行数
 */
function archiveSheet_(rule, keepDays) {
  var table = readTable(rule.sheet);
  if (!table.rows.length) return 0;

  var cutoff = addDays_(todayStr_(), -keepDays);
  var older = [];
  var keep = [];
  table.rows.forEach(function (r) {
    var d = String(toDateTimeStr_(r[rule.日付列]) || toDateStr_(r[rule.日付列]) || '').substring(0, 10);
    if (d && d < cutoff && rule.条件(r)) older.push(r); else keep.push(r);
  });
  if (!older.length) return 0;

  var toValues = function (list) {
    return list.map(function (r) {
      return table.headers.map(function (h) {
        return (r[h] === undefined || r[h] === null) ? '' : r[h];
      });
    });
  };

  // 1. 保管シートへ追記
  var store = ensureArchiveSheet_(rule.sheet, table.headers);
  var values = toValues(older);
  store.getRange(store.getLastRow() + 1, 1, values.length, table.headers.length).setValues(values);

  // 2. 元シートを「ヘッダー＋残す行」で書き直す（1行ずつ消すより速く、途中で止まりにくい）
  var sh = sheet_(rule.sheet);
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, table.headers.length).clearContent();
  if (keep.length) {
    sh.getRange(2, 1, keep.length, table.headers.length).setValues(toValues(keep));
  }
  invalidateCache_(rule.sheet);
  logInfo('archiveSheet_', rule.sheet + ' の' + cutoff + 'より前 ' + older.length + '行を保管へ移動（'
    + rule.説明 + '）');
  return older.length;
}

/**
 * 保管シートを用意する（無ければヘッダー付きで作る）。
 * @param {string} sheetName 元のシート名
 * @param {Array.<string>} headers ヘッダー
 * @return {Sheet} 保管シート
 */
function ensureArchiveSheet_(sheetName, headers) {
  var name = sheetName + '_保管';
  var book = book_();
  var sh = book.getSheetByName(name);
  if (sh) return sh;
  sh = book.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#EFEFEF');
  sh.setFrozenRows(1);
  sh.getRange(1, 1).setNote('古くなった行の保管先。' + sheetName + 'から自動で移される（消してはいない）。'
    + '移す前のCSVはDriveのバックアップに残っている');
  return sh;
}

// ============================================================================
// switchbot.gs
// ============================================================================

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

// ============================================================================
// backup.gs
// ============================================================================

/**
 * 自動バックアップ 第1層（05_バックアップ運用仕様.md / 06 Step5）
 *
 * 毎日3:00に実行し、
 *   1. 全シートをCSV（UTF-8 BOM付き）で AI_Uribo_Backup/daily/YYYY-MM-DD/ に保存
 *   2. スプレッドシート自体の複製を AI_Uribo_Backup/snapshot/ に1部（前日分は上書き）
 *   3. dailyは直近30日分を保持。月末日分は monthly/ へ移して永久保存
 *   4. 結果をS10に記録し、失敗時はエスカレーション先社員にLINE通知
 *
 * 本体バッチと独立して動くよう、他ファイルの関数への依存は最小限にしてある。
 */

/**
 * 日次バックアップを実行する。
 * @return {string} 実行サマリ
 */
function dailyBackup() {
  var proc = 'dailyBackup';
  // 書き込みの途中でCSVを吐くと中途半端な状態が残るため、他の処理と直列化する
  return withLock_(proc, 120000, function () { return dailyBackupBody_(proc); },
    function () { return '他の処理が実行中のためスキップ'; });
}

/**
 * 日次バックアップの本体（ロック取得済みの状態で呼ばれる）。
 * @param {string} proc ログ用の処理名
 * @return {string} 実行サマリ
 */
function dailyBackupBody_(proc) {
  logStart(proc);
  var today = todayStr_();
  try {
    var root = getOrCreateFolder_(DriveApp.getRootFolder(), getSetting('backup_folder_name', 'AI_Uribo_Backup'));
    var dailyRoot = getOrCreateFolder_(root, 'daily');
    var snapRoot = getOrCreateFolder_(root, 'snapshot');
    var monthlyRoot = getOrCreateFolder_(root, 'monthly');

    // 1. CSVエクスポート
    var dayFolder = getOrCreateFolder_(dailyRoot, today);
    var book = book_();
    var count = 0;
    book.getSheets().forEach(function (sh) {
      try {
        var csv = sheetToCsv_(sh);
        var name = sh.getName() + '.csv';
        // 同名ファイルがあれば消してから作る（再実行時の重複防止）
        var existing = dayFolder.getFilesByName(name);
        while (existing.hasNext()) existing.next().setTrashed(true);
        // 先頭にBOM（\uFEFF）を付けてExcelでの文字化けを防ぐ
        dayFolder.createFile(Utilities.newBlob('', 'text/csv', name)
          .setDataFromString('\uFEFF' + csv, 'UTF-8'));
        count++;
      } catch (e) {
        logError(proc, e, 'シート: ' + sh.getName());
      }
    });

    // 2. スプレッドシートの複製（1部だけ保持）
    safely_(proc, function () {
      var snapName = 'AI_Uribo_台帳_snapshot';
      var old = snapRoot.getFilesByName(snapName);
      while (old.hasNext()) old.next().setTrashed(true);
      DriveApp.getFileById(book.getId()).makeCopy(snapName, snapRoot);
    });

    // 3. 保持ルールの適用
    var rotated = safely_(proc, function () { return rotateBackups_(dailyRoot, monthlyRoot); }, { moved: 0, trashed: 0 });

    // 4. 復旧手順書を同梱
    safely_(proc, function () { ensureRestoreGuide_(root); });

    // 5. 古い行を保管シートへ移す（この日のCSVを取り終えた後にだけ行う）
    var archived = safely_(proc, function () { return archiveOldRows(); }, '自動整理なし');

    var summary = today + ' のバックアップ完了：CSV ' + count + '件 / monthly移動 ' + rotated.moved
      + '件 / 削除 ' + rotated.trashed + '件 / ' + archived;
    logInfo(proc, summary);
    return summary;
  } catch (e) {
    logError(proc, e);
    safely_(proc, function () {
      sendToEscalationStaff([msgText_('【AI Uribo】バックアップに失敗しました（' + nowStr_() + '）\n'
        + String(e).substring(0, 300) + '\nS10実行ログをご確認ください。')], proc);
    });
    return 'エラー: ' + e;
  }
}

/**
 * 指定フォルダ配下の子フォルダを取得（無ければ作成）する。
 * @param {Folder} parent 親フォルダ
 * @param {string} name フォルダ名
 * @return {Folder} フォルダ
 */
function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/**
 * シートをCSV文字列に変換する。
 * @param {Sheet} sheet シート
 * @return {string} CSV
 */
function sheetToCsv_(sheet) {
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow === 0 || lastCol === 0) return '';
  var values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  return values.map(function (row) {
    return row.map(function (v) {
      var s = String(v === null || v === undefined ? '' : v);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\r\n');
}

/**
 * 保持ルールを適用する。
 * 保持日数を過ぎたdailyフォルダのうち、月末日分は monthly/ へ移動し、それ以外はゴミ箱へ。
 * @param {Folder} dailyRoot dailyフォルダ
 * @param {Folder} monthlyRoot monthlyフォルダ
 * @return {{moved:number, trashed:number}} 処理件数
 */
function rotateBackups_(dailyRoot, monthlyRoot) {
  var keep = getSettingNum('backup_keep_days', 30);
  var limit = addDays_(todayStr_(), -keep);
  var moved = 0, trashed = 0;
  var it = dailyRoot.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    var name = f.getName();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    if (name >= limit) continue;
    if (isMonthEnd_(name)) {
      f.moveTo(monthlyRoot);
      moved++;
    } else {
      f.setTrashed(true);
      trashed++;
    }
  }
  return { moved: moved, trashed: trashed };
}

/**
 * その日付が月末日かどうか判定する。
 * @param {string} dateStr YYYY-MM-DD
 * @return {boolean} 月末ならtrue
 */
function isMonthEnd_(dateStr) {
  var d = new Date(dateStr + 'T00:00:00+09:00');
  var next = new Date(d.getTime());
  next.setDate(next.getDate() + 1);
  return next.getDate() === 1;
}

/**
 * バックアップフォルダに復旧手順書を置く（無ければ作成する）。
 * @param {Folder} root バックアップのルートフォルダ
 * @return {void}
 */
function ensureRestoreGuide_(root) {
  var name = '復旧手順.txt';
  if (root.getFilesByName(name).hasNext()) return;
  var text = [
    'AI Uribo バックアップ 復旧手順',
    '',
    '■ 軽微な誤記（数セルを戻したい）',
    '  スプレッドシート「AI_Uribo_台帳」を開き、ファイル → 版履歴 → 版履歴を表示 から復元する。',
    '',
    '■ シートが壊れた（1シートだけ戻したい）',
    '  snapshot/AI_Uribo_台帳_snapshot を開き、該当シートを右クリック →「他のスプレッドシートにコピー」で',
    '  本番の台帳にコピーし、壊れたシートを削除して名前を元に戻す。',
    '',
    '■ Googleアカウント事故（台帳ごと失った）',
    '  1. 新規スプレッドシートを作成し「AI_Uribo_台帳」と命名',
    '  2. NAS または monthly/daily の最新フォルダから各CSVをインポート',
    '     （ファイル → インポート → アップロード → 「新しいシートを挿入する」）',
    '  3. シート名をCSVのファイル名（S1_スタッフマスタ 等）に合わせる',
    '  4. GASプロジェクトを新台帳に紐付け直し、スクリプトプロパティを再設定、installTriggers() を実行',
    '',
    '■ 第2バックアップ（清水NAS）',
    '  \\\\192.168.1.20\\ウリボ単体\\AI_Uribo_Backup\\ に週次でミラーされている。',
    '',
    '※CSVはUTF-8（BOM付き）。Excelでそのまま開いても文字化けしない。'
  ].join('\n');
  root.createFile(Utilities.newBlob('', 'text/plain', name).setDataFromString(text, 'UTF-8'));
}

// ============================================================================
// diagnose.gs
// ============================================================================

/**
 * 診断情報の出力
 *
 * 不具合が起きたとき、藤原様が「これをコピーしてAIに渡すだけ」で原因調査ができるように、
 * 必要な情報（設定状況・直近のエラー・件数・最終実行結果）を1つのテキストにまとめる。
 *
 * 使い方は3通り：
 *   ・LINEで「診断」と送る（社員・管理者のみ。要点のみ返す）
 *   ・スプレッドシートのメニュー「AI Uribo」→「診断情報をコピー」（全文をダイアログ表示）
 *   ・GASエディタで exportDiagnostics() を実行（実行ログにも残る）
 *
 * 個人情報は含めない（LINEユーザーIDは先頭4文字のみ、氏名・回答本文は出さない）。
 */

/**
 * 診断情報を作る。
 * @param {boolean} [brief] trueならLINE向けの短縮版
 * @return {string} 診断テキスト
 */
function exportDiagnostics(brief) {
  var lines = [];
  lines.push('===== AI Uribo 診断情報 =====');
  lines.push('生成日時: ' + nowStr_());

  // 1. セットアップ状況
  safely_('exportDiagnostics', function () {
    lines.push('');
    lines.push('【設定】');
    var props = PropertiesService.getScriptProperties();
    lines.push('LINEトークン: ' + (props.getProperty(PROP.TOKEN) ? '設定済' : '未設定'));
    lines.push('チャネルシークレット: ' + (props.getProperty(PROP.SECRET) ? '設定済' : '未設定'));
    lines.push('Webhook秘密キー: ' + (props.getProperty(PROP.WEBHOOK_KEY) ? '設定済' : '未設定★Webhookは全拒否になります'));
    var missing = SHEET_DEFS.filter(function (d) { return !book_().getSheetByName(d.name); })
      .map(function (d) { return d.name; });
    lines.push('シート: ' + (missing.length ? '不足あり → ' + missing.join(', ')
      : SHEET_DEFS.length + 'シートすべてあり'));
    var handlers = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
    var required = ['morningBatch', 'nightBatch', 'weeklyDigest', 'dailyBackup', 'flushQueue', 'selfCheck'];
    required.forEach(function (f) {
      if (handlers.indexOf(f) < 0) lines.push('トリガー未設定★: ' + f);
    });
    if (required.every(function (f) { return handlers.indexOf(f) >= 0; })) {
      lines.push('トリガー: ' + required.length + '本すべて設定済');
    }
    lines.push('テストモード: ' + (isTrue_(getSetting('test_mode', 'FALSE'))
      ? 'ON（LINEに実際には送っていません）' : 'OFF（実際に送信します）'));
    lines.push('運用ステージ: ' + getSetting('stage', '1')
      + ' / 朝' + getSetting('morning_batch_hour', '10') + '時'
      + ' 夜' + getSetting('night_batch_hour', '21') + '時');
  });

  // 2. スタッフの登録状況（氏名・IDは出さない）
  safely_('exportDiagnostics', function () {
    lines.push('');
    lines.push('【スタッフ】');
    var staff = findRows(SHEETS.STAFF);
    var active = staff.filter(function (r) { return isTrue_(r['有効']); });
    var linked = active.filter(function (r) { return String(r['line_user_id'] || '').trim(); });
    lines.push('登録' + staff.length + '名 / 有効' + active.length + '名 / LINE紐付け済み' + linked.length + '名');
    var waiting = active.filter(function (r) { return !String(r['line_user_id'] || '').trim(); })
      .map(function (r) { return String(r['staff_id']); });
    if (waiting.length) lines.push('未紐付け: ' + waiting.join(', ') + '（登録コードの配布待ち）');
  });

  // 3. 件数の状況
  safely_('exportDiagnostics', function () {
    lines.push('');
    lines.push('【件数】');
    var gaps = findRows(SHEETS.GAP);
    var byState = {};
    gaps.forEach(function (g) { byState[g['状態']] = (byState[g['状態']] || 0) + 1; });
    lines.push('不足(S5) 全' + gaps.length + '件: ' + (JSON.stringify(byState) || '{}'));
    var tasks = findRows(SHEETS.TASK);
    var bySend = {};
    tasks.forEach(function (t) { bySend[t['送信状態']] = (bySend[t['送信状態']] || 0) + 1; });
    lines.push('確認タスク(S6) 全' + tasks.length + '件: ' + JSON.stringify(bySend));
    lines.push('実績ログ(S4): ' + findRows(SHEETS.LOG_IMPORT).length + '件 / '
      + '補完台帳(S7): ' + findRows(SHEETS.FILL).length + '件');
  });

  // 3b. 学習の進み具合（質問がどれだけ減っているか）
  safely_('exportDiagnostics', function () {
    lines.push('');
    lines.push('【学習】');
    lines.push('学習: ' + (isTrue_(getSetting('learning_enabled', 'TRUE')) ? 'ON' : 'OFF'));
    learnSummaryLines_().forEach(function (l) { lines.push(l); });
  });

  // 4. 最後の実行結果
  safely_('exportDiagnostics', function () {
    lines.push('');
    lines.push('【各バッチの最終実行】');
    var logs = findRows(SHEETS.RUN_LOG);
    ['selfCheck', 'morningBatch', 'nightBatch', 'weeklyDigest', 'dailyBackup', 'flushQueue'].forEach(function (name) {
      var last = null;
      logs.forEach(function (r) { if (String(r['処理名']) === name && String(r['結果']) !== '開始') last = r; });
      lines.push(name + ': ' + (last ? toDateTimeStr_(last['日時']) + ' ' + last['結果'] + ' / '
        + truncate_(String(last['詳細']), 120) : '実行記録なし'));
    });
  });

  // 5. 直近のエラー・警告
  safely_('exportDiagnostics', function () {
    lines.push('');
    lines.push('【直近のエラー・警告】');
    var limit = brief ? 5 : 20;
    var bad = findRows(SHEETS.RUN_LOG, function (r) {
      return String(r['結果']) === 'エラー' || String(r['結果']) === '警告';
    });
    if (!bad.length) {
      lines.push('なし');
    } else {
      bad.slice(-limit).forEach(function (r) {
        lines.push('・' + toDateTimeStr_(r['日時']) + ' [' + r['結果'] + '] ' + r['処理名']
          + ' : ' + truncate_(String(r['詳細']), brief ? 100 : 300));
      });
      if (bad.length > limit) lines.push('（ほか' + (bad.length - limit) + '件。全文はスプレッドシートのS10をご覧ください）');
    }
  });

  lines.push('');
  lines.push('===== ここまで =====');
  var text = lines.join('\n');
  if (!brief) logInfo('exportDiagnostics', '診断情報を出力しました（' + text.length + '文字）');
  return text;
}

/**
 * メニューから診断情報を表示する（全文をコピーできる）。
 * @return {void}
 */
function menuDiagnostics_() {
  SpreadsheetApp.getUi().alert('AI Uribo 診断情報（全文をコピーしてAIに渡してください）',
    exportDiagnostics(false), SpreadsheetApp.getUi().ButtonSet.OK);
}
