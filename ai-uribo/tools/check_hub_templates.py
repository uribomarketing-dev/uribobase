#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AIハブ側の設定（hub/homeassistant/ai_uribo.yaml）を、貼る前に検査する。

なぜ要るか：
  この設定だけは自動テストの外にあり、しかも **間違っていてもエラーが出ない**。
  カメラ名の読み替えが空白1つで外れて記録にMACアドレスが出る、
  深夜の検知が翌日に付く、条件が常にfalseで一度も動かない——
  どれも現場からは気づけないまま、記録だけが静かにおかしくなる。

  そこでYAMLの構文と、Jinja2テンプレートの実際の出力を、
  Frigateの本物のイベント（2026-08-13に玉里で取得したもの）で検証する。

使い方：
  cd ai-uribo && python3 tools/check_hub_templates.py
"""
import sys, os, re, datetime, zoneinfo

HERE = os.path.dirname(os.path.abspath(__file__))
YAML_PATH = os.path.join(HERE, '..', 'hub', 'homeassistant', 'ai_uribo.yaml')
TZ = zoneinfo.ZoneInfo('Asia/Tokyo')

try:
    import yaml, jinja2
except ImportError:
    print('※ pyyaml と jinja2 が要ります： pip install pyyaml jinja2')
    sys.exit(2)


class HALoader(yaml.SafeLoader):
    """Home Assistant独自のタグを読み飛ばす"""


HALoader.add_constructor('!secret', lambda l, n: '＜secrets.yamlの値＞')
HALoader.add_constructor('!include_dir_named', lambda l, n: 'INCLUDE')

fails = []


def check(name, ok, detail=''):
    print(('  OK   ' if ok else '  NG   ') + name + ('' if ok else ' → ' + str(detail)))
    if not ok:
        fails.append(name)


def ha_env():
    """HAのテンプレート環境を最小限まねる"""
    env = jinja2.Environment()
    env.filters['int'] = lambda v, d=0: int(float(v))

    def timestamp_custom(ts, fmt, local=True):
        return datetime.datetime.fromtimestamp(float(ts), TZ).strftime(fmt)

    env.filters['timestamp_custom'] = timestamp_custom
    return env


# 2026-08-13に玉里の実機から取得したイベント（人の検出・18:06:14 JST）
REAL_EVENT = [{
    'id': '1786611974.091048-xj0255',
    'camera': 'B0E9FE038DFB',
    'label': 'person',
    'start_time': 1786611974.091048,
}]

print('=== AIハブ設定の検査 ===')

raw = open(YAML_PATH, encoding='utf-8').read()
try:
    conf = yaml.load(raw, Loader=HALoader)
    check('YAMLとして読める', True)
except Exception as e:
    check('YAMLとして読める', False, e)
    sys.exit(1)

# --- 構成 -------------------------------------------------------------------
check('必要な項目がそろっている',
      all(k in conf for k in ('sensor', 'template', 'rest_command', 'timer', 'automation')),
      sorted(conf.keys()))
check('記録の保存期間を絞ってある（SDが埋まって黙って止まるのを防ぐ）',
      conf.get('recorder', {}).get('purge_keep_days', 99) <= 7,
      conf.get('recorder'))
check('画像を送る設定になっていない（送るのは言葉と時刻だけ）',
      'snapshot' not in raw and 'clip' not in raw.replace('has_clip', ''))
check('送り先URLを設定ファイルに直書きしていない',
      'script.google.com/macros/s/AKfyc' not in raw)

env = ha_env()

# --- センサーの状態 ---------------------------------------------------------
state = env.from_string(conf['sensor'][0]['value_template']).render(value_json=REAL_EVENT)
check('検出があるとき「時刻|カメラ名」を返す', state == '1786611974|B0E9FE038DFB', repr(state))
check('前後に余白が付かない（付くとカメラ名の読み替えが外れる）',
      state == state.strip(), repr(state))
empty = env.from_string(conf['sensor'][0]['value_template']).render(value_json=[])
check('検出が無いときは none', empty.strip() == 'none', repr(empty))

# --- カメラ名の読み替え -----------------------------------------------------
label_tpl = conf['template'][0]['sensor'][0]['state']
render_label = lambda st: env.from_string(
    label_tpl.replace("states('sensor.ai_uribo_frigate_last_person')", 'state')
).render(state=st).strip()
check('MACアドレスを人が読める名前に直す', render_label(state) == '玉里キッチン', render_label(state))
check('余白が混ざっても読み替えが外れない',
      render_label('\n  1786611974|B0E9FE038DFB  \n') == '玉里キッチン')
check('知らないカメラでも落ちない（そのまま出す）',
      render_label('1786611974|UNKNOWNCAM') == 'UNKNOWNCAM')
check('状態が none のときは「不明」', render_label('none') == '不明', render_label('none'))

# --- 自動化の条件と本文 -----------------------------------------------------
autos = {a['id']: a for a in conf['automation']}
check('自動化が3本ある（夜間・日中・食事の時間帯）', len(autos) == 3, list(autos))


def render_all(text, st):
    return env.from_string(
        text.replace('trigger.to_state.state', 'state')
    ).render(state=st).strip()


# 夜間：深夜0時の検知は「前の晩」の日付になること（夜勤は日付をまたぐ）
night = autos['ai_uribo_night_motion']
date_tpl = night['actions'][-1]['data']['date']
midnight = '1786633200|B0E9FE038DFB'   # 2026-08-14 00:00 JST
res = render_all(date_tpl.replace('ts', "((state | trim).split('|')[0] | float)"), midnight)
check('深夜0時の検知は「前の晩（8/13）」として記録する', res == '2026-08-13', res)
evening = render_all(date_tpl.replace('ts', "((state | trim).split('|')[0] | float)"),
                     '1786698000|B0E9FE038DFB')   # 2026-08-14 18:00 JST
check('夕方の検知はその日の日付のまま', evening == '2026-08-14', evening)

# 夜間・日中・食事の時間帯の切り分け
def hour_ok(auto, st):
    for c in auto['conditions']:
        t = c.get('value_template', '')
        if 'timestamp_custom' in t:
            return render_all(t, st) == 'True'
    return None


cases = [
    ('02:00', '1786640400|B0E9FE038DFB'),   # 2026-08-14 02:00
    ('12:00', '1786676400|B0E9FE038DFB'),   # 12:00
    ('18:00', '1786698000|B0E9FE038DFB'),   # 18:00
    ('23:00', '1786716000|B0E9FE038DFB'),   # 23:00
]
for label, st in cases:
    h = datetime.datetime.fromtimestamp(float(st.split('|')[0]), TZ).strftime('%H:%M')
    assert h == label, (h, label)

check('深夜2時は夜間の自動化だけが動く',
      hour_ok(autos['ai_uribo_night_motion'], cases[0][1]) is True
      and hour_ok(autos['ai_uribo_daytime_presence'], cases[0][1]) is False
      and hour_ok(autos['ai_uribo_meal_window_presence'], cases[0][1]) is False)
check('23時も夜間の自動化が動く', hour_ok(autos['ai_uribo_night_motion'], cases[3][1]) is True)
check('夕食どき（18時）は食事の自動化が動く',
      hour_ok(autos['ai_uribo_meal_window_presence'], cases[2][1]) is True
      and hour_ok(autos['ai_uribo_night_motion'], cases[2][1]) is False)
check('昼12時は食事の時間帯に入る',
      hour_ok(autos['ai_uribo_meal_window_presence'], cases[1][1]) is True)

# 送る本文にカメラ名と時刻が入るか
val = night['actions'][-1]['data']['value']
body = env.from_string(val).render(ts=1786611974.0, cam='玉里キッチン').strip()
check('記録の本文に時刻とカメラ名が入る', '18:06' in body and '玉里キッチン' in body, body)
check('記録の本文に個人を特定する情報を入れていない',
      'person' not in body and 'http' not in body, body)

# 連投の抑制
check('夜は連投を抑える（30分以上）',
      conf['timer']['ai_uribo_night_cooldown']['duration'] >= '00:30:00',
      conf['timer']['ai_uribo_night_cooldown'])
for a in conf['automation']:
    names = [str(x) for x in a['actions']]
    check('「' + a['id'] + '」は送信前にタイマーを開始している',
          'timer.start' in str(a['actions'][0]))

print()
if fails:
    print('======== NG ' + str(len(fails)) + '件 ========')
    sys.exit(1)
print('======== すべてOK ========')
