#!/bin/bash
#
# AI Uribo 第2バックアップ（Mac → 清水NAS）
# 05_バックアップ運用仕様.md 準拠
#
# 【配置手順】
#   1. このファイルを ~/bin/sync_to_nas.sh に置く
#        mkdir -p ~/bin && cp sync_to_nas.sh ~/bin/ && chmod +x ~/bin/sync_to_nas.sh
#   2. 下の設定を自分の環境に合わせて書き換える（SRC / DEST）
#   3. 手動で1回実行して成功することを確認する
#        ~/bin/sync_to_nas.sh
#   4. com.uribo.aiuribo.backup.plist を ~/Library/LaunchAgents/ に置いて登録する
#        cp com.uribo.aiuribo.backup.plist ~/Library/LaunchAgents/
#        launchctl load ~/Library/LaunchAgents/com.uribo.aiuribo.backup.plist
#
# 【動作】
#   毎週日曜4:00とMac起動時に、Google Drive上のバックアップフォルダをNASへミラーする。
#   Macが閉じていた週はスキップされるが、次回起動時にrsyncの差分同期で自動的に追いつく。
#
set -u

# ---- 設定 -------------------------------------------------------------------
# Google Drive for Desktop の同期フォルダ内にある AI_Uribo_Backup
SRC="$HOME/Library/CloudStorage/GoogleDrive-info@urilabo.com/マイドライブ/AI_Uribo_Backup"

# NAS（LinkStation）のマウント先。Tailscale経由の場合もホスト名/IPは 192.168.1.20
NAS_HOST="192.168.1.20"
NAS_SHARE="ウリボ単体"
MOUNT_POINT="/Volumes/${NAS_SHARE}"
DEST="${MOUNT_POINT}/AI_Uribo_Backup"

LOG="$HOME/Library/Logs/ai_uribo_backup.log"
# -----------------------------------------------------------------------------

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

log "==== 同期開始 ===="

# 1. 同期元の存在確認（Drive for Desktop 未起動なら中止）
if [ ! -d "$SRC" ]; then
  log "ERROR: 同期元が見つかりません: $SRC"
  log "  → Google Drive for Desktop が起動しているか、パスが正しいか確認してください。"
  log "==== 同期中止 ===="
  exit 1
fi

# 2. NASがマウントされていなければマウントを試みる
if [ ! -d "$MOUNT_POINT" ]; then
  log "NASが未マウントのためマウントを試みます: smb://${NAS_HOST}/${NAS_SHARE}"
  mkdir -p "$MOUNT_POINT" 2>/dev/null
  # キーチェーンに保存済みの認証情報を使う（初回のみFinderから手動接続して保存しておくこと）
  mount_smbfs "//${NAS_HOST}/${NAS_SHARE}" "$MOUNT_POINT" >> "$LOG" 2>&1
fi

if [ ! -d "$MOUNT_POINT" ]; then
  log "ERROR: NASに接続できませんでした（電源・ネットワーク・Tailscaleを確認）"
  log "==== 同期中止 ===="
  exit 1
fi

# 3. ミラーリング（--delete は付けない：Drive側の保持ルールでの削除がNASにも波及しないようにするため）
mkdir -p "$DEST"
rsync -rtv --exclude=".DS_Store" "$SRC/" "$DEST/" >> "$LOG" 2>&1
RC=$?

if [ $RC -eq 0 ]; then
  log "同期成功: $SRC → $DEST"
else
  log "ERROR: rsyncが異常終了しました（コード $RC）"
fi

log "==== 同期終了 ===="
exit $RC
