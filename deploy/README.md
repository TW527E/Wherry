# Linux systemd 部署

這個目錄提供 **system service**（不是 `systemd --user`）的 unit。它不會在 macOS 或目前工作站自動安裝、建立帳號、啟動服務，也不會覆寫既有 `.env`、SQLite、X profile 或 session。以下命令請在你的 Debian/Ubuntu/Oracle Linux 主機上，由你確認路徑與秘密後手動執行。

## 目錄與權限

建議的固定位置：

| 用途 | 位置 | 建議擁有者／權限 |
|---|---|---|
| 程式碼與 `dist/` | `/opt/Twitter-Sharkey-Bluesky` | `root:root`，目錄 0755；服務只讀 |
| SQLite、WAL、媒體、X profile | `/var/lib/crosspost-bridge` | `crosspost:crosspost`，根目錄 0700 |
| service 環境與秘密 | `/etc/crosspost-bridge/crosspost-bridge.env` | `root:crosspost`，檔案 0640；不要進 git |
| systemd unit | `/etc/systemd/system/crosspost-bridge.service` | `root:root`，檔案 0644 |

正式服務使用獨立、非 root 的 `crosspost` 帳號。這同時讓 Chromium 可以保留 sandbox；不要為了省事以 root 跑服務或把 `X_SANDBOX=false` 當成一般修復。

## 首次安裝

先確認主機已安裝 Node.js 24 或更新版本、與 CPU 架構相容的 Chromium，以及 npm。`playwright-core` 不會替你下載瀏覽器。

```bash
sudo useradd --system --create-home --home-dir /var/lib/crosspost-bridge \
  --shell /usr/sbin/nologin crosspost
sudo install -d -o root -g root -m 0755 /opt/Twitter-Sharkey-Bluesky
sudo install -d -o crosspost -g crosspost -m 0700 /var/lib/crosspost-bridge
sudo install -d -o root -g crosspost -m 0750 /etc/crosspost-bridge
```

以安全方式把已核對的 source checkout 放到 `/opt/Twitter-Sharkey-Bluesky`，再在建置目錄執行：

```bash
cd /opt/Twitter-Sharkey-Bluesky
sudo npm ci
sudo npm run verify
sudo chown -R root:root /opt/Twitter-Sharkey-Bluesky
```

`npm ci` 會執行套件安裝 lifecycle；只使用你已審核的 lockfile，並在公開或不受信任的 checkout 上先檢查 `package.json`。若希望編譯時不讓服務帳號接觸 source，可在暫存建置目錄完成 `npm ci && npm run build`，再只部署已核對的 `dist/`、`node_modules/`、`package.json`。

建立服務環境檔。不要把現有設定直接覆蓋掉；逐項合併 `.env.example` 的新鍵：

```bash
sudo install -o root -g crosspost -m 0640 .env.example \
  /etc/crosspost-bridge/crosspost-bridge.env
sudoedit /etc/crosspost-bridge/crosspost-bridge.env
```

至少核對這些服務值：

```dotenv
APP_MODE=preview
DATA_DIR=/var/lib/crosspost-bridge
HOST=127.0.0.1
PORT=3000
X_PROFILE_DIR=/var/lib/crosspost-bridge/x-profile
X_SESSION_FILE=/var/lib/crosspost-bridge/x-session.json
# systemd unit 的 Node 路徑可在此覆寫；這是服務設定，不是應用功能。
NODE_BIN=/usr/bin/node
```

先用 preview 做設定核對。若要在正式 live 服務中啟用互動 Telegram 管理，還要填好 bot／owner／chat ID，並設定 `TELEGRAM_POLL_COMMANDS=true`。只要 private／ops 錯誤告警，不需要開命令輪詢。X 發文永遠由你手動完成。

安裝 unit 並啟動：

```bash
sudo install -o root -g root -m 0644 deploy/crosspost-bridge.service \
  /etc/systemd/system/crosspost-bridge.service
sudo systemd-analyze verify /etc/systemd/system/crosspost-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now crosspost-bridge.service
sudo systemctl status --no-pager crosspost-bridge.service
```

本 unit 使用 `Restart=on-failure`、啟動限流與 60 秒的 SIGTERM 停止寬限。程式收到 SIGTERM 後會停止新輪詢、等待目前工作序列與瀏覽器關閉，再釋放資料目錄鎖。

## X session 安裝

推薦在有桌面的可信電腦使用 `login`／`export-session`，再以 SSH/SFTP 傳輸到服務使用者可讀的私密位置。伺服器上先停止服務，使用**同一份 environment file**執行 import，完成後刪除暫存檔：

```bash
sudo systemctl stop crosspost-bridge.service
sudo install -o crosspost -g crosspost -m 0600 /secure/x-session.json \
  /var/lib/crosspost-bridge/x-session.json
sudo -u crosspost -- /usr/bin/env NODE_ENV=production \
  DATA_DIR=/var/lib/crosspost-bridge \
  X_ENABLED=true X_HANDLE=你的帳號 X_SESSION_FILE=/var/lib/crosspost-bridge/x-session.json \
  /usr/bin/node /opt/Twitter-Sharkey-Bluesky/dist/cli.js import-session
sudo rm -f /secure/x-session.json
sudo systemctl start crosspost-bridge.service
```

上例中的非秘密值請依服務 environment file 填寫；不要把 bot token、app password、session 或完整設定貼在命令列／shell history。較安全的做法是讓一次性命令讀取受保護的 `EnvironmentFile`，或由受信任的 secret manager 注入必要鍵。若不確定，使用 Telegram `/session`（需 live + poll commands）或受信任的 secret manager。

## 更新

每次更新都先停止服務並備份完整狀態目錄；不要在服務運作中執行 `npm ci`、migration、`import-session` 或其他共用資料目錄的 CLI：

```bash
sudo systemctl stop crosspost-bridge.service
sudo tar --xattrs --acls -C /var/lib -czf /secure/crosspost-bridge-state-$(date +%Y%m%d%H%M%S).tar.gz crosspost-bridge
cd /opt/Twitter-Sharkey-Bluesky
sudo git fetch --tags
sudo git checkout <已核對的版本>
sudo npm ci
sudo npm run verify
sudo systemd-analyze verify /etc/systemd/system/crosspost-bridge.service
sudo systemctl daemon-reload
sudo systemctl start crosspost-bridge.service
sudo systemctl status --no-pager crosspost-bridge.service
```

不要刪除 `/var/lib/crosspost-bridge` 來「解決」卡住的工作。SQLite 的 `-wal`／`-shm` 也要一併備份；`unknown` 工作必須人工對帳，不可因更新而自動重送。

## 檢查與故障排除

```bash
sudo -u crosspost -- env NODE_ENV=production DATA_DIR=/var/lib/crosspost-bridge \
  /usr/bin/node /opt/Twitter-Sharkey-Bluesky/dist/cli.js doctor
sudo journalctl -u crosspost-bridge.service -n 200 --no-pager
sudo journalctl -u crosspost-bridge.service -f
sudo systemctl restart crosspost-bridge.service
```

若看到 `DATA_DIR is already in use`，表示服務或另一個 CLI 正在使用同一資料目錄；先用 `systemctl status`／`ps` 核對，不要手動刪 `runtime_lock` 或 SQLite。若 Node 路徑不同，將 `NODE_BIN=/實際/路徑/node` 放在 environment file 並執行 `daemon-reload`；服務仍須由該路徑執行 Node 24+。

systemd unit 使用 `ProtectSystem=strict`，只允許 `/var/lib/crosspost-bridge` 寫入；不設 `PrivateNetwork`，因為平台 API、Telegram、媒體與 X 讀取都需要出站網路。若主機的 systemd 版本不支援某項沙盒設定，先用 `systemd-analyze verify /etc/systemd/system/crosspost-bridge.service` 找出確切錯誤，再做最小化 drop-in 調整；不要直接移除所有隔離設定。

## 移除（需你明確決定）

```bash
sudo systemctl disable --now crosspost-bridge.service
sudo rm /etc/systemd/system/crosspost-bridge.service
sudo systemctl daemon-reload
```

以上不會刪除 `/var/lib/crosspost-bridge`、環境檔或程式碼。確認已完成備份及秘密撤銷後，才另外處理帳號、資料與 `/etc/crosspost-bridge`。
