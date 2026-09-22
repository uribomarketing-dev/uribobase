#!/bin/bash
#
# 貼る前・渡す前に、これ1本で全部確かめる。
#   cd ai-uribo && bash tools/check_all.sh
#
# 中身：
#   1. 本体（GASのコード）の自動テスト
#   2. AIハブ側の設定（Home AssistantのYAML／Jinja2）の検査
#   3. 貼り付け用ファイルが最新か
#
set -u
cd "$(dirname "$0")/.."
NG=0

echo "──────────────────────────────────────────"
echo " 1. 本体の自動テスト"
echo "──────────────────────────────────────────"
if (cd tests && node harness.js | tail -25); then :; else NG=1; fi
(cd tests && node harness.js | grep -q 'すべてOK') || NG=1

echo
echo "──────────────────────────────────────────"
echo " 2. AIハブ側の設定の検査"
echo "──────────────────────────────────────────"
if python3 tools/check_hub_templates.py; then :; else NG=1; fi

echo
echo "──────────────────────────────────────────"
echo " 3. 貼り付け用ファイル"
echo "──────────────────────────────────────────"
node tools/bundle.js
echo

if [ "$NG" -ne 0 ]; then
  echo "======== NG があります。直してから貼ってください ========"
  exit 1
fi
echo "======== すべてOK。貼って大丈夫です ========"
