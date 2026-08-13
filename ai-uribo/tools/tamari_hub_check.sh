#!/bin/sh
# ---------------------------------------------------------------------------
# 玉里AIハブ 現地調査スクリプト（読み取りだけ。設定は一切変えません）
#
# 使い方：Macを玉里のWi-Fiにつないで、ターミナルに次の1行を貼るだけ。
#   sh tamari_hub_check.sh
#
# Home Assistantの中身まで見たいときは、先にトークンを作って（下記A）から
#   HA_TOKEN='作ったトークン' sh tamari_hub_check.sh
#
#   A) http://192.168.1.13:8123 → 左下の自分の名前 → 一番下「長期アクセストークン」
#      →「トークンを作成」→ 名前は AI_Uribo
#
# ※トークンは結果ファイルには書き出しません（人に見せられる内容だけ残します）。
# ※結果はデスクトップにテキストで出ます。そのまま送ってください。
# ---------------------------------------------------------------------------

HUB=${HUB:-192.168.1.13}
OUT="$HOME/Desktop/tamari-hub-$(date +%Y%m%d-%H%M).txt"

say() { echo "$@" >> "$OUT"; }
dump_file() { head -c "${2:-600}" "$1" 2>/dev/null | tr -d '\000' >> "$OUT"; echo "" >> "$OUT"; }
dump_stdin() { head -c "${1:-600}" 2>/dev/null | tr -d '\000' >> "$OUT"; echo "" >> "$OUT"; }

: > "$OUT"
say "==== 玉里AIハブ 現地調査 $(date '+%Y-%m-%d %H:%M') ===="
say "調査元Mac: $(hostname)"
say "ハブIP: $HUB"
say ""

say "---- 0. ネットワーク ----"
say "Macのアドレス: $(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '取得できず')"
say "ルーター: $(netstat -rn 2>/dev/null | awk '/^default/{print $2; exit}')"
say "（清水NAS 192.168.1.20 と同じ帯なら、将来Tailscaleでつなぐときに衝突します）"
say ""

say "---- 1. ハブに届くか ----"
if ping -c 2 -W 2000 "$HUB" >/dev/null 2>&1; then
  say "ping: 届く"
else
  say "ping: 届かない（Wi-Fiが玉里のものか、ハブの電源をご確認ください）"
fi

for p in 8123 18789 11435 5000 8971 1984 22; do
  if nc -z -w 2 "$HUB" "$p" >/dev/null 2>&1; then
    say "ポート $p: 開いている"
  else
    say "ポート $p: 閉じている／応答なし"
  fi
done
say ""

say "---- 2. Home Assistant (8123) ----"
curl -s -m 8 -o /tmp/ha_root.txt -w "トップページ応答: %{http_code}\n" "http://$HUB:8123/" >> "$OUT" 2>&1
say "manifest:"
curl -s -m 8 "http://$HUB:8123/manifest.json" | dump_stdin 300

if [ -n "$HA_TOKEN" ]; then
  say ""
  say "バージョン等（/api/config）:"
  curl -s -m 10 -H "Authorization: Bearer $HA_TOKEN" "http://$HUB:8123/api/config" | dump_stdin 1200
  say ""
  say "つながっている機器・センサーの一覧（entity_id）:"
  curl -s -m 20 -H "Authorization: Bearer $HA_TOKEN" "http://$HUB:8123/api/states" \
    | grep -o '"entity_id": *"[^"]*"' | sed 's/"entity_id": *//; s/"//g' | sort >> "$OUT"
  say ""
  say "上のうちカメラ・人感・開閉だけ抜き出し:"
  curl -s -m 20 -H "Authorization: Bearer $HA_TOKEN" "http://$HUB:8123/api/states" \
    | grep -o '"entity_id": *"[^"]*"' | sed 's/"entity_id": *//; s/"//g' \
    | grep -E '^(camera|binary_sensor|person|device_tracker)\.' | sort >> "$OUT"
  say ""
  say "rest_command（外部へPOSTする仕組み）が使えるか:"
  curl -s -m 10 -H "Authorization: Bearer $HA_TOKEN" "http://$HUB:8123/api/services" \
    | grep -o '"domain": *"rest_command"' | head -1 >> "$OUT"
else
  say "(HA_TOKEN が指定されていないため、中身は見ていません)"
fi
say ""

say "---- 3. OpenClaw (18789 / 11435) ----"
for p in 18789 11435; do
  say "[$p] 応答:"
  curl -s -m 8 -D - -o /tmp/oc_body.txt "http://$HUB:$p/" 2>/dev/null | head -20 >> "$OUT"
  say "[$p] 本文の先頭:"
  dump_file /tmp/oc_body.txt 400
  for path in api/version version health api/health api/status; do
    code=$(curl -s -m 5 -o /tmp/oc_p.txt -w '%{http_code}' "http://$HUB:$p/$path" 2>/dev/null)
    if [ "$code" = "200" ]; then
      say "  /$path → 200"
      dump_file /tmp/oc_p.txt 300
    fi
  done
done
say ""

say "---- 4. Frigate (5000 / 8971) ----"
for p in 5000 8971; do
  code=$(curl -s -m 8 -o /tmp/fg.txt -w '%{http_code}' "http://$HUB:$p/api/config" 2>/dev/null)
  say "[$p] /api/config → $code"
  if [ "$code" = "200" ]; then
    say "カメラ名:"
    grep -o '"cameras": *{[^}]*' /tmp/fg.txt | head -c 400 >> "$OUT"
    say ""
  fi
done
say ""

say "---- 5. 外に出られるか（このMacから／ハブからではありません）----"
say "script.google.com: $(curl -s -m 8 -o /dev/null -w '%{http_code}' https://script.google.com/ 2>/dev/null)"
say "api.switch-bot.com: $(curl -s -m 8 -o /dev/null -w '%{http_code}' https://api.switch-bot.com/ 2>/dev/null)"
say ""

say "==== ここまで。このファイルをそのまま送ってください ===="
echo ""
echo "できました: $OUT"
echo "（中身をざっと見て、見せたくない行があれば消してから送ってください）"
