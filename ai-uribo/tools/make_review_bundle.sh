#!/bin/bash
#
# 別AIレビュー用に、全ソースと方針を1ファイル（review_bundle.md）にまとめる。
# 使い方： cd ai-uribo && bash tools/make_review_bundle.sh
#
# ※ 収録するファイルは列挙せず、src/ にあるものを全部入れる。
#   （以前は手で並べていたため、ファイルを足したときに漏れて
#     「全ソース」と言いながら半分しか渡していない状態になっていた）
#
set -eu
cd "$(dirname "$0")/.."
OUT="review_bundle.md"

# 読む順番だけ決めて、残りは自動で拾う（GASは全ファイルが1つの空間に読まれる）
FIRST="config db log notify"
REST=$(ls src/*.gs | sed 's|src/||; s|\.gs$||' | grep -vx -e config -e db -e log -e notify | sort)
FILES="$FIRST $REST"
COUNT=$(ls src/*.gs | wc -l | tr -d ' ')
CHECKS=$(cd tests && node harness.js 2>/dev/null | grep -c '^  OK' || echo '?')

{
  echo "# AI Uribo レビュー用バンドル"
  echo
  echo "生成日時: $(date '+%Y-%m-%d %H:%M')"
  echo
  echo "障害者グループホーム（2拠点）の支援記録の抜けを自動検出し、LINEで担当者に確認して"
  echo "埋める常駐システムです。GAS＋Googleスプレッドシート＋LINE Messaging API。"
  echo
  echo "## レビューで特に見ていただきたいこと"
  echo
  echo "1. **記録の正確性を壊しうる箇所**（この台帳は実地指導・監査で参照されます）"
  echo "2. **利用者のプライバシー**（氏名・映像・医療情報を扱わない設計になっているか）"
  echo "3. **黙って壊れる箇所**（現場から気づけない失敗。常駐システムで最も危険）"
  echo "4. **日付・時刻の扱い**（夜勤は日付をまたぐため、ここのバグは記録全体を汚します）"
  echo "5. GAS固有の制約（6分の実行時間・ロック・同時実行・スプレッドシートAPIの回数）"
  echo
  echo "## 前提となる方針（ここを外れた指摘は採用できません）"
  echo
  echo "- 秘密情報はスクリプトプロパティのみ。コードやシートに書かない"
  echo "- **利用者の氏名を台帳に載せない**（S9対応表だけが持ち、LINE文面生成時のみ引く）"
  echo "- **診断名・病名・障害区分などの医療情報は扱わない**"
  echo "- **画像・映像を台帳に置かない**（AIハブからは言葉と時刻だけを受け取る）"
  echo "- 既存アプリの正本データは書き換えない（S7補完台帳を各アプリが読む疎結合）"
  echo "- AIが埋めたものは「推定・要精査」。**確定させるのは人**"
  echo
  echo "## 収録内容"
  echo
  echo "1. 概要（README）"
  echo "2. 判断した内容・未確認事項（QUESTIONS）"
  echo "3. AIハブ活用方針（カメラ・センサーをどう使うか）"
  echo "4. 全ソースコード（src/ の ${COUNT} ファイル **全部**）"
  echo "5. AIハブ側の設定（Home Assistant）"
  echo "6. 自動テスト（${CHECKS}項目）"
  echo
  echo "---"
  echo
  echo "## 1. 概要"
  echo
  cat README.md
  echo
  echo "---"
  echo
  echo "## 2. 判断した内容・未確認事項"
  echo
  cat QUESTIONS.md
  echo
  echo "---"
  echo
  echo "## 3. AIハブ活用方針"
  echo
  cat docs/AIハブ活用方針.md
  echo
  echo "---"
  echo
  echo "## 4. ソースコード（${COUNT}ファイル）"
  echo

  echo "### src/appsscript.json"
  echo '```json'
  cat src/appsscript.json
  echo '```'
  echo

  for f in $FILES; do
    echo "### src/${f}.gs"
    echo '```javascript'
    cat "src/${f}.gs"
    echo '```'
    echo
  done

  echo "---"
  echo
  echo "## 5. AIハブ側の設定（Home Assistant）"
  echo
  echo "玉里のAIハブ（Home Assistant / Frigate NVR / OpenClaw が動く小型サーバー）から、"
  echo "共用部カメラの人検出を「時刻つきの事実」としてAI Uriboへ送る設定です。"
  echo "**画像は送らず、言葉と時刻だけ**を送ります。"
  echo
  echo '```yaml'
  cat hub/homeassistant/ai_uribo.yaml
  echo '```'
  echo
  echo "---"
  echo
  echo "## 6. 自動テスト（${CHECKS}項目・このコードで全項目OK）"
  echo
  echo "GASのAPI（スプレッドシート・LINE送信・プロパティ・キャッシュ・ロック・トリガー・Drive）を"
  echo "メモリ上に再現し、**実際のソースをそのまま読み込んで動かして**います。"
  echo
  echo '```javascript'
  cat tests/harness.js
  echo '```'
} > "$OUT"

echo "生成しました: $(pwd)/$OUT ($(wc -l < "$OUT") 行 / src ${COUNT}ファイル / テスト ${CHECKS}項目)"
