#!/bin/bash
#
# 別AIレビュー用に、全ソースと仕様の要約を1ファイル（review_bundle.md）にまとめる。
# 使い方： cd ai-uribo && bash tools/make_review_bundle.sh
#
set -eu
cd "$(dirname "$0")/.."
OUT="review_bundle.md"

{
  echo "# AI Uribo レビュー用バンドル"
  echo
  echo "生成日時: $(date '+%Y-%m-%d %H:%M')"
  echo
  echo "GAS＋Googleスプレッドシート＋LINE Messaging APIで動く、記録の抜けを自動検出して"
  echo "LINEで確認するシステムの全ソースです。以下の順に収録しています。"
  echo
  echo "1. 概要（README）"
  echo "2. 実装中に判断した内容（QUESTIONS）"
  echo "3. 全ソースコード（src/）"
  echo "4. 自動テストの内容（tests/harness.js）"
  echo
  echo "---"
  echo
  echo "## 1. 概要"
  echo
  cat README.md
  echo
  echo "---"
  echo
  echo "## 2. 実装中に判断した内容"
  echo
  cat QUESTIONS.md
  echo
  echo "---"
  echo
  echo "## 3. ソースコード"
  echo

  echo "### src/appsscript.json"
  echo '```json'
  cat src/appsscript.json
  echo '```'
  echo

  for f in config db log notify setup autofill detect ask batch webhook backup; do
    echo "### src/${f}.gs"
    echo '```javascript'
    cat "src/${f}.gs"
    echo '```'
    echo
  done

  echo "---"
  echo
  echo "## 4. 自動テスト（このコードで53項目を検証済み）"
  echo '```javascript'
  cat tests/harness.js
  echo '```'
} > "$OUT"

echo "生成しました: $(pwd)/$OUT ($(wc -l < "$OUT") 行)"
