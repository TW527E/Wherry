# Linux systemd 部署

這個目錄提供 **system service**（不是 `systemd --user`）的 unit 與一支自動化部署腳本。它們不會在 macOS 或目前工作站自動安裝、建立帳號、啟動服務，也不會覆寫既有 `.env`、SQLite、X profile 或 session。以下命令請在你的 Debian/Ubuntu/Oracle Linux 主機上，由你確認路徑與秘密後執行。

## 快速路徑：`install.sh`

`deploy/install.sh` 把下面「首次安裝／更新／移除」的步驟自動化，而且可以先用 `--dry-run` 檢視它打算做什麼：

```bash
sudo bash deploy/install.sh install --dry-run   # 只印出計畫，不改動系統
sudo bash deploy/install.sh install             # 建立帳號、目錄、unit，建置並啟動
sudo bash deploy/install.sh update              # 先備份資料目錄，再更新並重啟
sudo bash deploy/install.sh status              # 狀態與日誌（唯讀，不需要 root）
sudo bash deploy/install.sh uninstall --purge-data --yes
```

它的安全設計：

- **`--dry-run` 先看再做**：任何命令都先印出即將執行的動作，不觸碰系統。
- **絕不覆蓋既有環境檔**：只有在 `/etc/crosspost-bridge/crosspost-bridge.env` 不存在時才從 `.env.example` 建立，並把 `DATA_DIR` 改寫成絕對路徑（範本裡的 `DATA_DIR=./data` 是相對路徑，在 `ProtectSystem=strict` 之下服務寫不進 SQLite）。既有檔案只會被檢查權限，內容不會被讀出或顯示。
- **秘密不外洩**：腳本只讀 `DATA_DIR` 這類非秘密鍵做一致性檢查，token／session 一律不印。
- **預設不刪資料**：`uninstall` 預設保留環境檔與資料目錄；要刪除必須明示 `--purge-config`／`--purge-data`，且需要互動確認或 `--yes`。
- **更新前先備份**：`update` 先停止服務，把整個資料目錄（含 SQLite 的 `-wal`／`-shm`）tar 到 `/var/backups/crosspost-bridge/`，再同步程式碼與重建。
- **避開以 root 跑 npm**：預設會警告 `npm ci` 會以 root 執行套件安裝腳本；可加 `--build-user <非root帳號>` 改用該帳號建置，完成後安裝目錄會鎖成 `root:root` 並移除群組寫入權。`--prune-dev` 可進一步移除 devDependencies。
- **路徑先驗證**：拒絕相對路徑、含空白或換行的路徑，以及位於家目錄底下的資料目錄（unit 有 `ProtectHome=true`，會寫不進去）。

常用選項：`--prefix`、`--data-dir`、`--env-file`、`--service`、`--user`、`--group`、`--build-user`、`--prune-dev`、`--no-start`、`--no-build`。完整清單：`bash deploy/install.sh --help`。

腳本只負責程式與服務的部署；**匯入 X 登入仍是手動步驟**（見下方「X session 安裝」），`install` 結束時會把接下來該做什麼印在最後。以下各節是同樣步驟的手動版本，也是腳本實際執行的內容。

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
```

Node 的絕對路徑是寫在 unit 的 `ExecStart` 裡（systemd 不會展開程式位置上的變數），由 `deploy/install.sh` 依偵測結果產生，不在這個環境檔設定。

先用 preview 做設定核對。若要在正式 live 服務中啟用互動 Telegram 管理，還要填好 bot／owner／chat ID，並設定 `TELEGRAM_POLL_COMMANDS=true`。只要 private／ops 錯誤告警，不需要開命令輪詢。X 發文永遠由你手動完成。

安裝 unit 並啟動。unit 樣板的 `ExecStart` 預設寫 `/usr/bin/node`；先確認你的 node 就在那裡（`command -v node`），若不是，安裝後改掉那一行的執行檔路徑：

```bash
sudo install -o root -g root -m 0644 deploy/crosspost-bridge.service \
  /etc/systemd/system/crosspost-bridge.service
# node 不在 /usr/bin/node 時（把 /usr/bin/node 換成 command -v node 的結果）：
# sudo sed -i "s|^ExecStart=/usr/bin/node |ExecStart=$(command -v node) |" \
#   /etc/systemd/system/crosspost-bridge.service
sudo systemd-analyze verify /etc/systemd/system/crosspost-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now crosspost-bridge.service
sudo systemctl status --no-pager crosspost-bridge.service
```

`ExecStart` 的執行檔必須是字面絕對路徑——systemd 不會展開程式位置上的變數（`ExecStart=${NODE_BIN} …` 會導致 `Failed at step EXEC … No such file or directory`）。用 `install.sh` 的話這行會自動填成偵測到的 node 路徑，不必手改。node 也必須裝在系統路徑：unit 有 `ProtectHome=true`，`/home` 底下（例如 nvm）的 node 無法被執行。

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

若看到 `DATA_DIR is already in use`，表示服務或另一個 CLI 正在使用同一資料目錄；先用 `systemctl status`／`ps` 核對，不要手動刪 `runtime_lock` 或 SQLite。若 Node 不是裝在 unit 裡寫的路徑，重跑 `sudo bash deploy/install.sh update`（會把偵測到的 node 絕對路徑重寫進 `ExecStart`），或手動改 unit 該行後 `daemon-reload`。注意：node 必須裝在系統路徑（如 NodeSource 的 `/usr/bin/node`）；unit 有 `ProtectHome=true`，放在 `/home` 底下的 node（例如 nvm）無法被執行。

systemd unit 使用 `ProtectSystem=strict`，只允許 `/var/lib/crosspost-bridge` 寫入；不設 `PrivateNetwork`，因為平台 API、Telegram、媒體與 X 讀取都需要出站網路。若主機的 systemd 版本不支援某項沙盒設定，先用 `systemd-analyze verify /etc/systemd/system/crosspost-bridge.service` 找出確切錯誤，再做最小化 drop-in 調整；不要直接移除所有隔離設定。

## 移除（需你明確決定）

```bash
sudo systemctl disable --now crosspost-bridge.service
sudo rm /etc/systemd/system/crosspost-bridge.service
sudo systemctl daemon-reload
```

以上不會刪除 `/var/lib/crosspost-bridge`、環境檔或程式碼。確認已完成備份及秘密撤銷後，才另外處理帳號、資料與 `/etc/crosspost-bridge`。
