#!/usr/bin/env bash
#
# crosspost-bridge systemd system service 部署腳本
#
# 只在 Linux + systemd 上執行，且需要 root 權限。它不會公開任何東西，也不會把秘密
# 印到畫面上：環境檔只會被寫入／檢查，內容不會被讀出來顯示。
#
#   sudo deploy/install.sh install     # 首次安裝（預設命令）
#   sudo deploy/install.sh update      # 更新程式碼並重啟（會先備份資料目錄）
#   sudo deploy/install.sh status      # 查看服務狀態與近期日誌
#   sudo deploy/install.sh uninstall   # 移除服務（預設保留資料與設定）
#
# 每個命令都支援 --dry-run：只印出即將執行的動作，不改動系統。
# 完整說明見 deploy/README.md。

set -Eeuo pipefail

PROG="$(basename "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

# ── 預設值（可用選項覆寫）────────────────────────────────────────────────────
SOURCE_DIR="$REPO_ROOT"
PREFIX="/opt/Twitter-Sharkey-Bluesky"
DATA_DIR="/var/lib/crosspost-bridge"
ENV_FILE="/etc/crosspost-bridge/crosspost-bridge.env"
SERVICE_NAME="crosspost-bridge"
SERVICE_USER="crosspost"
SERVICE_GROUP=""
BACKUP_DIR="/var/backups/crosspost-bridge"
BUILD_USER=""
NODE_BIN=""
UNIT_TEMPLATE=""
DRY_RUN=0
ASSUME_YES=0
DO_START=1
DO_BUILD=1
PRUNE_DEV=0
PURGE_CONFIG=0
PURGE_DATA=0
GROUP_GIVEN=0
COMMAND=""

# ── 輸出工具 ─────────────────────────────────────────────────────────────────
log()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

on_error() {
  local code=$?
  printf '\033[1;31m✘\033[0m 第 %s 行執行失敗（結束碼 %s）；系統可能停在中途狀態，請看上面的訊息再重跑。\n' \
    "${BASH_LINENO[0]:-?}" "$code" >&2
}
trap on_error ERR

TMP_FILES=()
cleanup() { local f; for f in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do rm -f -- "$f"; done; }
trap cleanup EXIT

quote_cmd() { local out="" a; for a in "$@"; do out+="$(printf '%q ' "$a")"; done; printf '%s' "${out% }"; }
dry_note()  { printf '  \033[2m[dry-run]\033[0m %s\n' "$*"; }

# 唯一會實際改變系統的入口；dry-run 時只印出來。
run() {
  if (( DRY_RUN )); then dry_note "$(quote_cmd "$@")"; return 0; fi
  printf '  \033[2m$ %s\033[0m\n' "$(quote_cmd "$@")"
  "$@"
}

need_root() {
  (( DRY_RUN )) && return 0
  [[ ${EUID:-$(id -u)} -eq 0 ]] || die "需要 root 權限。請用：sudo $PROG $COMMAND"
}

need_linux() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    if (( DRY_RUN )); then warn "目前不是 Linux（$(uname -s)）；--dry-run 只印出計畫，不會真的部署。"; return 0; fi
    die "這個腳本只能在 Linux 上部署 systemd service（目前是 $(uname -s)）。"
  fi
  command -v systemctl >/dev/null 2>&1 || die "找不到 systemctl；這台主機不是 systemd 系統。"
}

usage() {
  cat <<EOF
$PROG — crosspost-bridge 的 systemd system service 部署腳本

用法：
  sudo $PROG [命令] [選項]

命令：
  install      首次安裝（預設）：建立帳號與目錄、安裝程式、產生 unit、啟用並啟動
  update       更新：停止服務、備份資料目錄、同步程式碼、重新建置、重啟
  status       顯示服務狀態、unit 內容與近期日誌
  uninstall    停止並移除 unit（預設保留環境檔與資料目錄）

選項：
  --source DIR        程式碼來源目錄（預設：$REPO_ROOT）
  --prefix DIR        程式安裝位置（預設：$PREFIX）
  --data-dir DIR      SQLite／媒體／X profile 的位置（預設：$DATA_DIR）
  --env-file FILE     環境檔位置（預設：$ENV_FILE）
  --service NAME      unit 名稱（預設：$SERVICE_NAME）
  --user NAME         服務執行帳號（預設：$SERVICE_USER）
  --group NAME        服務執行群組（預設：與帳號同名）
  --backup-dir DIR    update 的備份輸出目錄（預設：$BACKUP_DIR）
  --build-user NAME   用這個非 root 帳號跑 npm ci／npm run verify（預設：root，會跳警告）
  --prune-dev         建置後移除 devDependencies（縮小攻擊面；之後不能在該目錄跑測試）
  --no-start          安裝或更新後不要啟動服務
  --no-build          跳過 npm ci／npm run verify（假設 dist/ 已建好）

  --dry-run           只印出即將執行的動作，不改動系統
  -y, --yes           不互動確認（僅影響 uninstall 的破壞性選項）
  --purge-config      uninstall 時一併刪除環境檔
  --purge-data        uninstall 時一併刪除資料目錄（需要 --yes 或互動確認）
  -h, --help          顯示這份說明

範例：
  sudo $PROG install --dry-run                     # 先看它會做什麼
  sudo $PROG install                               # 正式安裝
  sudo $PROG install --build-user builder --prune-dev
  sudo $PROG update                                # 更新並自動備份
  sudo $PROG uninstall --purge-data --yes          # 連資料一起移除

注意：X 發文永遠是手動的，這個腳本不會、也無法代你發文到 X。
      X 登入 session 要在服務安裝後另外匯入（見 deploy/README.md）。
EOF
}

# ── 參數解析 ─────────────────────────────────────────────────────────────────
parse_args() {
  while (($#)); do
    case "$1" in
      install|update|status|uninstall)
        [[ -z "$COMMAND" ]] || die "只能指定一個命令（已有 $COMMAND）"
        COMMAND="$1"; shift ;;
      --source)     SOURCE_DIR="${2:?--source 需要一個路徑}"; shift 2 ;;
      --prefix)     PREFIX="${2:?--prefix 需要一個路徑}"; shift 2 ;;
      --data-dir)   DATA_DIR="${2:?--data-dir 需要一個路徑}"; shift 2 ;;
      --env-file)   ENV_FILE="${2:?--env-file 需要一個路徑}"; shift 2 ;;
      --service)    SERVICE_NAME="${2:?--service 需要一個名稱}"; shift 2 ;;
      --user)       SERVICE_USER="${2:?--user 需要一個名稱}"; shift 2 ;;
      --group)      SERVICE_GROUP="${2:?--group 需要一個名稱}"; GROUP_GIVEN=1; shift 2 ;;
      --backup-dir) BACKUP_DIR="${2:?--backup-dir 需要一個路徑}"; shift 2 ;;
      --build-user) BUILD_USER="${2:?--build-user 需要一個名稱}"; shift 2 ;;
      --prune-dev)  PRUNE_DEV=1; shift ;;
      --no-start)   DO_START=0; shift ;;
      --no-build)   DO_BUILD=0; shift ;;
      --dry-run)    DRY_RUN=1; shift ;;
      -y|--yes)     ASSUME_YES=1; shift ;;
      --purge-config) PURGE_CONFIG=1; shift ;;
      --purge-data)   PURGE_DATA=1; shift ;;
      -h|--help)    usage; exit 0 ;;
      *) die "未知參數：$1（用 --help 看用法）" ;;
    esac
  done
  COMMAND="${COMMAND:-install}"
  (( GROUP_GIVEN )) || SERVICE_GROUP="$SERVICE_USER"

  # 路徑必須是絕對路徑，且不能含有會破壞 unit 樣板的換行或分隔字元。
  local name value
  for name in PREFIX DATA_DIR ENV_FILE SOURCE_DIR BACKUP_DIR; do
    value="${!name}"
    [[ "$value" == /* ]] || die "$name 必須是絕對路徑（目前：$value）"
    case "$value" in
      *$'\n'*|*'|'*) die "$name 不能包含換行或 | 字元（目前：$value）" ;;
      *[[:space:]]*) die "$name 不能包含空白字元；unit 檔無法安全引用這種路徑（目前：$value）" ;;
    esac
  done
  [[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]] || die "--service 只允許英數字與 _ . @ -（目前：$SERVICE_NAME）"
  [[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "--user 不是合法的 Linux 帳號名稱（目前：$SERVICE_USER）"
  [[ "$SERVICE_GROUP" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "--group 不是合法的 Linux 群組名稱（目前：$SERVICE_GROUP）"
  if (( BUILD_USER )) && [[ ! "$BUILD_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
    die "--build-user 不是合法的 Linux 帳號名稱（目前：$BUILD_USER）"
  fi
}

# ── 前置檢查 ─────────────────────────────────────────────────────────────────
require_node() {
  command -v node >/dev/null 2>&1 || die "找不到 node；請先安裝 Node.js 24 或更新版本。"
  local version major
  version="$(node -p 'process.versions.node' 2>/dev/null)" || die "無法執行 node。"
  major="${version%%.*}"
  (( major >= 24 )) || die "需要 Node.js >= 24，這台主機是 $version。"
  NODE_BIN="$(command -v node)"
}

check_source() {
  [[ -f "$SOURCE_DIR/package.json" ]] || die "在 $SOURCE_DIR 找不到 package.json；用 --source 指定程式碼目錄。"
  UNIT_TEMPLATE="$SOURCE_DIR/deploy/$SERVICE_NAME.service"
  [[ -f "$UNIT_TEMPLATE" ]] || die "找不到 unit 樣板 $UNIT_TEMPLATE"
  [[ -f "$SOURCE_DIR/.env.example" ]] || die "找不到 $SOURCE_DIR/.env.example，無法產生環境檔範本。"
  if (( ! DO_BUILD )) && [[ ! -f "$SOURCE_DIR/dist/cli.js" ]]; then
    die "--no-build 需要 $SOURCE_DIR/dist/cli.js 已存在。"
  fi
}

check_data_dir_location() {
  case "$DATA_DIR" in
    /home/*|/root/*|/run/user/*)
      die "資料目錄 $DATA_DIR 位於家目錄底下，但 unit 有 ProtectHome=true，服務會無法寫入。
    請改用 /var/lib/... ，或在 $SERVICE_NAME.service.d/ 放一個 drop-in 設定 ProtectHome=read-only。" ;;
  esac
}

# 只讀非秘密鍵，且不外印環境檔其他內容。
env_file_value() {
  local file="$1" key="$2" line
  [[ -r "$file" ]] || return 1
  line="$(sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=[[:space:]]*//p" "$file" | tail -n 1)"
  [[ -n "$line" ]] || return 1
  line="${line%%$'\r'}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "${line%"${line##*[![:space:]]}"}"
}

# ── 帳號與目錄 ───────────────────────────────────────────────────────────────
ensure_account() {
  local nologin="/usr/sbin/nologin"
  [[ -x "$nologin" ]] || nologin="/sbin/nologin"
  [[ -x "$nologin" ]] || nologin="/bin/false"

  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    ok "服務帳號 $SERVICE_USER 已存在，沿用。"
  else
    run useradd --system --create-home --home-dir "$DATA_DIR" --shell "$nologin" "$SERVICE_USER"
    (( DRY_RUN )) || ok "已建立系統帳號 $SERVICE_USER。"
  fi
  if (( GROUP_GIVEN )) && ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    run groupadd --system "$SERVICE_GROUP"
  fi
}

ensure_dirs() {
  run install -d -o root -g root -m 0755 "$PREFIX"
  run install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0700 "$DATA_DIR"
  run install -d -o root -g "$SERVICE_GROUP" -m 0750 "$(dirname -- "$ENV_FILE")"
}

# ── 程式碼部署與建置 ─────────────────────────────────────────────────────────
sync_source() {
  if [[ "${SOURCE_DIR%/}" == "${PREFIX%/}" ]]; then
    ok "程式碼目錄與安裝目錄相同，跳過程式碼複製。"
    return 0
  fi
  log "同步程式碼：$SOURCE_DIR → $PREFIX"
  # 只複製程式碼；資料、設定與秘密一律不進安裝目錄。
  if (( DRY_RUN )); then
    dry_note "rsync -a --delete（排除 .git data node_modules .env dist x-session.json） $SOURCE_DIR/ $PREFIX/"
    return 0
  fi
  if command -v rsync >/dev/null 2>&1; then
    run rsync -a --delete --exclude=.git --exclude=data --exclude=node_modules \
      --exclude=.env --exclude=dist --exclude=x-session.json "$SOURCE_DIR/" "$PREFIX/"
  else
    # 沒有 rsync 時用 tar 管線。這裡不能用 run()：它會把命令列印到 stdout，破壞管線內容。
    printf '  \033[2m$ tar 管線複製程式碼\033[0m\n'
    tar -C "$SOURCE_DIR" \
      --exclude=./.git --exclude=./data --exclude=./node_modules \
      --exclude=./.env --exclude=./dist --exclude=./x-session.json \
      -cf - . | tar -C "$PREFIX" -xf -
  fi
}

build_app() {
  if (( ! DO_BUILD )); then
    warn "--no-build：跳過 npm ci 與 npm run verify。"
    return 0
  fi
  if [[ -n "$BUILD_USER" ]]; then
    log "以 $BUILD_USER 身分建置（避免安裝腳本以 root 執行）"
    run chown -R "$BUILD_USER" "$PREFIX"
  else
    warn "npm ci 會以 root 執行套件安裝腳本；只在你已審核過 lockfile 的 checkout 上這樣做。"
    warn "想避免的話，加 --build-user <非root帳號> 重跑。"
  fi
  log "安裝相依並建置（npm ci → npm run verify）"
  if (( DRY_RUN )); then
    if [[ -n "$BUILD_USER" ]]; then
      dry_note "runuser -u $BUILD_USER -- npm ci --no-audit --no-fund   （在 $PREFIX）"
      dry_note "runuser -u $BUILD_USER -- npm run verify              （在 $PREFIX）"
    else
      dry_note "npm ci --no-audit --no-fund   （在 $PREFIX）"
      dry_note "npm run verify                （在 $PREFIX）"
    fi
    (( PRUNE_DEV )) && dry_note "npm prune --omit=dev          （在 $PREFIX）"
  else
    local npm_prefix=(env "HOME=$PREFIX" "PATH=$PATH")
    if [[ -n "$BUILD_USER" ]]; then
      ( cd "$PREFIX" && runuser -u "$BUILD_USER" -- "${npm_prefix[@]}" npm ci --no-audit --no-fund )
      ( cd "$PREFIX" && runuser -u "$BUILD_USER" -- "${npm_prefix[@]}" npm run verify )
      (( PRUNE_DEV )) && ( cd "$PREFIX" && runuser -u "$BUILD_USER" -- "${npm_prefix[@]}" npm prune --omit=dev )
    else
      ( cd "$PREFIX" && npm ci --no-audit --no-fund )
      ( cd "$PREFIX" && npm run verify )
      (( PRUNE_DEV )) && ( cd "$PREFIX" && npm prune --omit=dev )
    fi
  fi
  run chown -R root:root "$PREFIX"
  run chmod -R go-w "$PREFIX"
  (( DRY_RUN )) || ok "程式已建置並鎖定為 root 唯讀。"
}

# ── 環境檔 ───────────────────────────────────────────────────────────────────
# 設定單一非秘密鍵（只用於剛從範本建立的新檔；既有檔案一律不動）。
set_env_value() {
  local file="$1" key="$2" value="$3" escaped
  if (( DRY_RUN )); then dry_note "把 $file 的 $key 設為 $value"; return 0; fi
  escaped="$(printf '%s' "$value" | sed -e 's/[\\&|]/\\&/g')"
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file"; then
    sed -i -E "s|^[[:space:]]*(export[[:space:]]+)?${key}=.*|${key}=${escaped}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

ensure_env_file() {
  if [[ -e "$ENV_FILE" ]]; then
    ok "環境檔已存在，保持不動：$ENV_FILE"
    run chmod 0640 "$ENV_FILE"
    run chown root:"$SERVICE_GROUP" "$ENV_FILE"

    local configured
    configured="$(env_file_value "$ENV_FILE" DATA_DIR || true)"
    if [[ -n "$configured" && "$configured" != /* ]]; then
      warn "環境檔的 DATA_DIR=$configured 是相對路徑。服務的工作目錄是唯讀的 $PREFIX，"
      warn "相對路徑會讓它寫不進 SQLite。請改成絕對路徑（例如 DATA_DIR=$DATA_DIR）。"
    elif [[ -n "$configured" && "${configured%/}" != "${DATA_DIR%/}" ]]; then
      warn "環境檔裡的 DATA_DIR=$configured 與 --data-dir $DATA_DIR 不一致。"
      warn "unit 的 ReadWritePaths 用的是 $DATA_DIR；請改環境檔，或用 --data-dir $configured 重跑。"
    fi
    return 0
  fi

  log "從範本建立環境檔：$ENV_FILE"
  run install -o root -g "$SERVICE_GROUP" -m 0640 "$SOURCE_DIR/.env.example" "$ENV_FILE"
  # 服務的 cwd 是安裝目錄（ProtectSystem=strict 下唯讀），範本裡的 DATA_DIR=./data
  # 這種相對路徑會讓服務寫不進資料庫，所以新檔一律改寫成絕對路徑。
  # X_PROFILE_DIR／X_SESSION_FILE 留空即可，它們會跟著 DATA_DIR 解析成絕對路徑。
  set_env_value "$ENV_FILE" DATA_DIR "$DATA_DIR"
  if (( ! DRY_RUN )); then
    local written
    written="$(env_file_value "$ENV_FILE" DATA_DIR || true)"
    [[ "$written" == "${DATA_DIR%/}" || "${written%/}" == "${DATA_DIR%/}" ]] \
      || die "環境檔的 DATA_DIR 沒有正確寫入（目前：${written:-空}）；請手動設定成 $DATA_DIR。"
  fi
  warn "環境檔目前是範本內容：請編輯 $ENV_FILE，填好 token／chat id 後再 restart。"
  warn "預設 APP_MODE=preview，不會對外發布；確認抓取正常後再改成 live。"
}

# ── unit 檔 ──────────────────────────────────────────────────────────────────
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

render_unit() {
  local out="$1" p d e u g n
  p="$(sed_escape "$PREFIX")"; d="$(sed_escape "$DATA_DIR")"; e="$(sed_escape "$ENV_FILE")"
  u="$(sed_escape "$SERVICE_USER")"; g="$(sed_escape "$SERVICE_GROUP")"; n="$(sed_escape "$NODE_BIN")"
  # ExecStart 的執行檔必須是字面絕對路徑：systemd 不會展開程式位置上的變數。
  sed -e "s|/opt/Twitter-Sharkey-Bluesky|$p|g" \
      -e "s|/var/lib/crosspost-bridge|$d|g" \
      -e "s|/etc/crosspost-bridge/crosspost-bridge.env|$e|g" \
      -e "s|^User=.*|User=$u|" \
      -e "s|^Group=.*|Group=$g|" \
      -e "s|^WorkingDirectory=.*|WorkingDirectory=$p|" \
      -e "s|^ExecStart=.*|ExecStart=$n $p/dist/cli.js serve|" \
      -e "s|^EnvironmentFile=.*|EnvironmentFile=$e|" \
      -e "s|^ReadWritePaths=.*|ReadWritePaths=$d|" \
      "$UNIT_TEMPLATE" > "$out"
}

install_unit() {
  local tmp
  tmp="$(mktemp)"; TMP_FILES+=("$tmp")
  render_unit "$tmp"
  if (( DRY_RUN )); then
    dry_note "寫入 /etc/systemd/system/$SERVICE_NAME.service（由 $UNIT_TEMPLATE 產生）："
    sed 's/^/      /' "$tmp"
    return 0
  fi
  run install -o root -g root -m 0644 "$tmp" "/etc/systemd/system/$SERVICE_NAME.service"
  if command -v systemd-analyze >/dev/null 2>&1; then
    local output status
    output="$(systemd-analyze verify "/etc/systemd/system/$SERVICE_NAME.service" 2>&1)" && status=0 || status=$?
    [[ -n "$output" ]] && printf '%s\n' "$output" | sed 's/^/    /'
    if (( status == 0 )); then ok "unit 語法檢查通過。"
    else warn "systemd-analyze 對 unit 提出警告（常見於舊版 systemd 不認得某些沙盒選項）；請看上面的訊息。"; fi
  fi
}

# ── systemd 操作 ─────────────────────────────────────────────────────────────
daemon_reload() { run systemctl daemon-reload; }

start_service() {
  run systemctl enable "$SERVICE_NAME.service"
  if (( ! DO_START )); then
    (( DRY_RUN )) || ok "已設為開機啟動（--no-start：這次不啟動）。"
    return 0
  fi
  run systemctl restart "$SERVICE_NAME.service"
  (( DRY_RUN )) && return 0

  local waited=0
  while (( waited < 20 )); do
    systemctl is-active --quiet "$SERVICE_NAME.service" && break
    sleep 1; waited=$((waited + 1))
  done
  if systemctl is-active --quiet "$SERVICE_NAME.service"; then
    ok "服務已啟動：$SERVICE_NAME.service"
    return 0
  fi
  warn "服務沒有在 20 秒內進入 active 狀態；以下是最近的日誌："
  systemctl --no-pager --full status "$SERVICE_NAME.service" 2>&1 | sed 's/^/    /' || true
  journalctl -u "$SERVICE_NAME.service" -n 40 --no-pager 2>&1 | sed 's/^/    /' || true
  warn "常見原因：環境檔還是範本、必填設定缺失、資料目錄權限不對。修好後：systemctl restart $SERVICE_NAME"
  return 1
}

# ── 命令實作 ─────────────────────────────────────────────────────────────────
cmd_install() {
  log "步驟 1/7：建立帳號與目錄"
  ensure_account
  ensure_dirs

  log "步驟 2/7：同步程式碼"
  sync_source

  log "步驟 3/7：安裝相依並建置"
  build_app

  log "步驟 4/7：準備環境檔"
  ensure_env_file

  log "步驟 5/7：產生並安裝 systemd unit"
  install_unit
  daemon_reload

  log "步驟 6/7：啟用並啟動"
  local rc=0
  start_service || rc=1

  log "步驟 7/7：完成"
  print_next_steps
  return "$rc"
}

cmd_update() {
  log "更新 $SERVICE_NAME"
  local backup="$BACKUP_DIR/${SERVICE_NAME}-$(date +%Y%m%d%H%M%S).tar.gz"
  if systemctl is-active --quiet "$SERVICE_NAME.service" 2>/dev/null; then
    log "停止服務（避免與共用資料目錄的 CLI 衝突）"
    run systemctl stop "$SERVICE_NAME.service"
  fi
  if [[ -d "$DATA_DIR" ]]; then
    log "備份資料目錄 → $backup"
    run install -d -o root -g root -m 0700 "$BACKUP_DIR"
    if (( DRY_RUN )); then
      dry_note "tar -C $(dirname -- "$DATA_DIR") --xattrs --acls -czf $backup $(basename -- "$DATA_DIR")"
    else
      # 不能用 run()：命令列輸出會混進 tar 的 stdout。
      tar -C "$(dirname -- "$DATA_DIR")" --xattrs --acls -czf "$backup" "$(basename -- "$DATA_DIR")"
      ok "備份完成：$backup（含 SQLite 的 -wal／-shm）"
    fi
  else
    warn "找不到資料目錄 $DATA_DIR，跳過備份。"
  fi
  sync_source
  build_app
  ensure_env_file
  install_unit
  daemon_reload
  local rc=0
  start_service || rc=1
  print_next_steps
  return "$rc"
}

cmd_status() {
  local unit="/etc/systemd/system/$SERVICE_NAME.service"
  printf '\n\033[1m%s.service\033[0m\n' "$SERVICE_NAME"
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$SERVICE_NAME.service" >/dev/null 2>&1; then
    systemctl --no-pager --full status "$SERVICE_NAME.service" 2>&1 | sed 's/^/  /' || true
  fi
  [[ -f "$unit" ]] || warn "找不到 $unit（服務可能尚未安裝）。"
  printf '\n\033[1m近期日誌\033[0m\n'
  journalctl -u "$SERVICE_NAME.service" -n 40 --no-pager 2>&1 | sed 's/^/  /' || true
  printf '\n\033[1m提示\033[0m\n'
  echo "  · 服務執行中時不要跑同一份 DATA_DIR 的 CLI（doctor／once／import-session 都要它的鎖）。"
  echo "    需要時先 systemctl stop $SERVICE_NAME，或改用 Telegram 指令（/status、/session）。"
  echo "  · 環境檔：$ENV_FILE（這個腳本不會顯示它的內容）"
  echo "  · 追蹤日誌：journalctl -u $SERVICE_NAME -f"
}

confirm_purge() {
  local what=""
  (( PURGE_DATA )) && what+="資料目錄 $DATA_DIR "
  (( PURGE_CONFIG )) && what+="環境檔 $ENV_FILE"
  printf '\033[1;31m即將刪除%s。\033[0m 這是不可逆的動作，請輸入 yes 確認：' "$what"
  local answer
  read -r answer < /dev/tty || return 1
  [[ "$answer" == "yes" ]]
}

# --purge-data 會 rm -rf 整個目錄，所以先拒絕把系統目錄當成資料目錄的誤用。
check_purge_target() {
  (( PURGE_DATA )) || return 0
  case "$DATA_DIR" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/sbin|/srv|/sys|/tmp|/usr|/var)
      die "拒絕 --purge-data：$DATA_DIR 是系統目錄，不可能是這個服務的資料目錄。" ;;
    /usr/*|/etc/*|/bin/*|/sbin/*|/boot/*|/dev/*|/proc/*|/sys/*|/lib/*)
      die "拒絕 --purge-data：$DATA_DIR 位於系統目錄底下。" ;;
  esac
  [[ "$DATA_DIR" == */*/* ]] || die "拒絕 --purge-data：$DATA_DIR 看起來不像專用的資料目錄。"
}

cmd_uninstall() {
  log "移除 $SERVICE_NAME（資料與設定預設保留）"
  check_purge_target
  if (( PURGE_DATA || PURGE_CONFIG )); then
    if (( ASSUME_YES )); then
      warn "依 --yes 直接執行破壞性刪除。"
    elif [[ -e /dev/tty ]]; then
      confirm_purge || die "已取消，未刪除任何資料。"
    else
      die "沒有互動終端可確認；要真的刪除請加 --yes。"
    fi
  fi

  if systemctl is-enabled --quiet "$SERVICE_NAME.service" 2>/dev/null \
     || [[ -f "/etc/systemd/system/$SERVICE_NAME.service" ]]; then
    run systemctl disable --now "$SERVICE_NAME.service" || true
  else
    warn "找不到已安裝的 $SERVICE_NAME.service，仍會清理殘留檔案。"
  fi
  run rm -f "/etc/systemd/system/$SERVICE_NAME.service"
  daemon_reload

  if (( PURGE_CONFIG )); then
    run rm -f "$ENV_FILE"
    run rmdir --ignore-fail-on-non-empty -- "$(dirname -- "$ENV_FILE")" || true
    ok "已刪除環境檔（內含秘密，建議一併撤銷那些 token）。"
  else
    ok "保留環境檔：$ENV_FILE"
  fi
  if (( PURGE_DATA )); then
    run rm -rf -- "$DATA_DIR"
    ok "已刪除資料目錄：$DATA_DIR"
  else
    ok "保留資料目錄：$DATA_DIR（含 SQLite、媒體、X profile）"
  fi
  echo
  echo "服務已移除。程式目錄 $PREFIX 與帳號 $SERVICE_USER 仍保留；"
  echo "確定不再需要時再自行處理（該目錄唯讀、不含秘密）。"
}

print_next_steps() {
  cat <<EOF

接下來（由你手動完成，腳本不會代做）
  1. 檢查設定：sudoedit $ENV_FILE
     先維持 APP_MODE=preview 確認抓取正常，再改成 live。
  2. 匯入 X 登入（服務執行中會鎖住資料目錄，先停再匯入）：
     sudo systemctl stop $SERVICE_NAME.service
     sudo -u $SERVICE_USER -- env DATA_DIR=$DATA_DIR X_ENABLED=true X_HANDLE=<你的帳號> \\
       X_SESSION_FILE=$DATA_DIR/x-session.json $NODE_BIN $PREFIX/dist/cli.js import-session
     （或在本機 login 後用 Telegram /session 上傳，不必停機）
     sudo systemctl start $SERVICE_NAME.service
  3. 看狀態：$PROG status      追日誌：journalctl -u $SERVICE_NAME -f
  4. 互動提醒與指令輪詢需要 TELEGRAM_POLL_COMMANDS=true 且 live 模式。

提醒：X 發文永遠是手動的；這個服務只讀 X，不會也不能代你發文。
EOF
}

# ── 進入點 ───────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  if (( DRY_RUN )); then
    printf '\n\033[1mcrosspost-bridge 部署：%s\033[0m（dry-run：不會改動系統）\n\n' "$COMMAND"
  else
    printf '\n\033[1mcrosspost-bridge 部署：%s\033[0m\n\n' "$COMMAND"
  fi

  # status 是唯讀的，不需要 root。
  if [[ "$COMMAND" == "status" ]]; then cmd_status; return 0; fi

  need_linux
  need_root
  if [[ "$COMMAND" == "uninstall" ]]; then cmd_uninstall; return 0; fi

  require_node
  check_source
  check_data_dir_location

  case "$COMMAND" in
    install) cmd_install ;;
    update)  cmd_update ;;
    *) die "未預期的命令：$COMMAND" ;;
  esac
}

# 明確保留 main 的結束碼（服務起不來時整體要回非 0），但不要在最後再觸發一次 ERR 訊息。
exit_code=0
main "$@" || exit_code=$?
exit "$exit_code"
