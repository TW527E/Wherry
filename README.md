# crosspost-bridge

X 為主來源的個人跨平台同步工具。X 的發文**永遠由你手動完成**；工具只讀取你自己的 X 內容，並自動同步到 Bluesky、dvd.chat（Sharkey）與 Telegram。

設計依據見 [`crosspost-decisions.md`](crosspost-decisions.md)（v1.2）與平台限制查核 [`crosspost-spec-review.md`](crosspost-spec-review.md)。

---

## 這個工具會做與不會做的事

**會做**

- 讀取你自己 X 個人頁的新推文（含幾乎同時發出的自串文），過濾後同步到 Bluesky、dvd.chat、Telegram 對外頻道。
- 在 Bluesky／dvd.chat 同步完成後，多發一則回覆串文，附上該串文最頂端主推文的 `fixupx.com` 連結。
- Telegram 對外頻道的每則訊息底部附 `原文連結`。
- 偵測你在 Bluesky／dvd.chat 發的原生貼文，用 Telegram 私聊送一則**互動式提醒**：內含「1️⃣ 要發 / 2️⃣ 不發」按鈕。按「要發」後回覆該訊息貼上 X 連結，工具即登記為鏡像；按「不發」則不同步。訊息會就地更新狀態。
- 認出你手動貼到 X 的鏡像內容（含互動提醒或 `/mirror` 登記的連結），**不再**回同步到其他平台。
- 把系統錯誤事件自動轉發到 Telegram（有設 `TELEGRAM_OPS_CHAT_ID` 就送 ops 頻道，否則送私聊），秘密會先遮蔽。
- 提供 CLI 與網頁介面，以及排程發布（排程只發布到下游並提醒你發 X）。

**不會做**

- ❌ 不會自動登入 X、選檔、按 Post。程式碼中沒有任何 X 寫入路徑。
- ❌ 不會反偵測、輪換代理、繞過驗證或速率限制。
- ❌ 不會同步回覆他人的推文、晚發的自回覆、轉貼、引用或非公開內容。
- ❌ 不做投票、純音訊、圖片與影片混合、X Premium 長文。

---

## ⚠️ 啟用 X 讀取前請先讀這段

X 官方 Automation Rules 明文禁止 `scripting the X website`，並寫明這**可能導致帳號被永久停權**。**讀取也包含在內**，不是只有發文。

這個工具只讀你自己的個人頁、不做任何互動、低頻輪詢，但仍屬該條款描述的技術。風險由你承擔，請自行判斷是否要在有價值的帳號上啟用。若不啟用 X 讀取（`X_ENABLED=false`），其他功能仍可運作（例如只用排程發布與 B/D → 手動 X 提醒）。

---

## 快速開始

```bash
cp .env.example .env      # 填入設定
npm install
npm run verify            # 型別檢查 + 測試 + 建置
npm run cli -- doctor     # 檢查設定與能力
npm run cli -- login      # 開瀏覽器手動登入 X 一次（只需一次）
npm run cli -- serve      # 啟動排程、worker 與網頁介面
```

**`login` 是必要的一步**：X 讀取靠一個持久化瀏覽器 profile，裡面要有已登入的 session。`login` 會用你選定的瀏覽器開一個可見視窗，你手動登入（含兩步驟驗證），回終端機按 Enter 後 session 就存進 `X_PROFILE_DIR`。之後所有 `scan` / `serve` 都用無頭模式重用這份登入，不必再登。沒做這一步的話，無頭瀏覽器會撞到 X 的登入牆、讀不到任何推文（`scan` 會回報 session 未登入）。

預設 `APP_MODE=preview`：**讀取、分類、組批次照常執行**（讀 X 是唯讀的、任何模式都安全），只有最後「發布」那步換成 stub 不對外送出。所以 preview 下你按「立刻檢查」就能看到工具偵測到你的新推文、預計會發什麼。確認行為正確後再改成 `live` 才會真的發到下游。

注意：Telegram 的對外發文、互動提醒與錯誤轉發**只在 `live` 模式送出**；preview 不會對外送任何 Telegram 訊息。指令輪詢（`/status`、`/sync` 等）與 session 上傳為 owner-only 的唯讀／管理操作，需 `TELEGRAM_POLL_COMMANDS=true` 並在 `live` 下才會啟動。

網頁介面預設只在 `127.0.0.1:3000`。若綁到其他位址，`WEB_TOKEN` 必須至少 32 字元，且所有寫入請求都要帶 `Authorization: Bearer <token>`。

### 用 Docker

```bash
docker compose up -d --build
docker compose logs -f
```

---

## 設定重點

| 變數 | 說明 |
|---|---|
| `APP_MODE` | `preview` 用 stub publisher；`live` 才真的發布 |
| `DESTINATIONS` | 要同步過去的平台，例如 `bluesky,sharkey,telegram` |
| `X_ENABLED` / `X_HANDLE` | 啟用 X 唯讀監聽 |
| `X_BROWSER` | X 讀取用的瀏覽器：`auto`（偵測系統 Chrome → Edge → Chromium）、`chrome`、`msedge`、`chromium`、`path`（用 `CHROMIUM_PATH` 指定的執行檔） |
| `CHROMIUM_PATH` | `X_BROWSER=path` 時的瀏覽器執行檔路徑 |
| `X_PROFILE_DIR` | 你手動登入一次後保留的瀏覽器 profile 目錄（請保持私密） |
| `BLUESKY_*` | 官方 API，請用 **app password**，不要用主密碼 |
| `SHARKEY_*` | dvd.chat API token，權限只需 `write:drive`、`write:notes` |
| `TELEGRAM_TOKEN` | bot token（BotFather 取得） |
| `TELEGRAM_PUBLIC_CHAT_ID` | 對外同步的頻道（一律用數字 ID，不是 @username） |
| `TELEGRAM_PRIVATE_CHAT_ID` | 你的私聊：互動提醒、session 上傳、指令回覆 |
| `TELEGRAM_OPS_CHAT_ID` | 錯誤轉發目標；留空則錯誤送私聊 |
| `TELEGRAM_OWNER_ID` | 唯一可下指令、按提醒按鈕、上傳 session 的使用者 ID |
| `TELEGRAM_POLL_COMMANDS` | `true` 才輪詢並處理指令與互動按鈕（僅 `live`） |

完整 40 個設定鍵（用途＋取得方式）見 [`docs/configuration.md`](docs/configuration.md)。

**設定會強制檢查**：若 `DESTINATIONS` 含 `bluesky`，就必須同時 `BLUESKY_ENABLED=true`，`sharkey` 同理。原因是工具必須觀察那個帳號才能排除「手動鏡像」，否則防回音會失去依據。這是刻意的設計，不是可以繞過的選項。

---

## CLI

```bash
npm run cli -- serve                    # 常駐：輪詢、worker、Web UI
npm run cli -- once                     # 跑一輪：收集 → 收斂串文 → 發布
npm run cli -- status                   # 列出 jobs、batches、近期事件
npm run cli -- publish <batchId>        # 對已封存的批次補發布
npm run cli -- schedule <ISO時間> <文字>  # 排程發布（不會排程 X 寫入）
npm run cli -- action skip <id>         # 不同步這個批次
npm run cli -- action mirror <id>       # 標記為手動鏡像
npm run cli -- action approve <id>      # 人工放行被保留的批次
npm run cli -- action retry <jobId>     # 重試明確失敗的工作
npm run cli -- doctor                   # 檢查設定
npm run cli -- login                    # 本機開瀏覽器登入 X（只需一次）
npm run cli -- export-session           # 匯出 X 登入到 X_SESSION_FILE
npm run cli -- import-session           # 在伺服器安裝 X_SESSION_FILE 的登入
```

Telegram 私聊指令（需 `TELEGRAM_POLL_COMMANDS=true` 且 `live`，只接受 `TELEGRAM_OWNER_ID`）：

| 指令 | 作用 |
|---|---|
| `/status` | 目前模式、X session 狀態、任務與近期事件 |
| `/sync` | 立即檢查一次（X 發文仍需手動） |
| `/pending` | 列出等待處理的批次與 X 提醒 |
| `/approve <batchId>` | 放行被保留的批次 |
| `/skip <batchId>` | 不同步某批次 |
| `/mirror <id>` | 標記為手動鏡像，不再同步 |
| `/mirror <id> <X_URL>` | 登記你手動發的 X 連結（設定防回音來源） |
| `/retry <jobId>`、`/resync <jobId>` | 重試明確失敗的工作 |
| `/session` | 更新 X 登入：接著上傳 `x-session.json` |
| `/help` | 顯示所有指令 |

互動提醒：偵測到 B/D 原生貼文時，私聊會收到帶「1️⃣ 要發 / 2️⃣ 不發」按鈕的訊息。按「要發」後**回覆該訊息貼上 X 連結**即完成鏡像登記；按「不發」則取消同步。訊息會就地更新狀態。

另外，**直接把 `x-session.json` 檔案傳到私人聊天即可更新 X 登入**（見下方部署段的方式 A，或先打 `/session`）。

---

## 同步規則

### 什麼會被同步（X → 下游）

1. 只有 `in_reply_to` 為空的推文能開啟新的批次。
2. 以該 root 的**發布時間**起算固定 `THREAD_WINDOW_SECONDS`（預設 600 秒）窗口。窗口不會因為後續回覆而延長。
3. 只有同一作者、沿著直接回覆鏈、且在窗口內的自回覆會加入同一批次。
4. 批次在窗口結束、且**每個下游平台都有近期掃描**之後才封存；封存才發布。

### 什麼不會被同步

| 情況 | 判定 |
|---|---|
| 回覆他人 | `reply_to_other`，忽略 |
| 晚發的自回覆（超過 root 窗口） | `skipped_late_self_reply` |
| 回覆一串早已同步完成的舊推文 | `self_reply_outside_new_batch` |
| 串文分支（非線性） | 保留待審，不強行攤平 |
| 轉貼、引用、非公開、敏感、投票、影片、GIF、超過 4 張圖 | 保留或忽略，不會靜默降級 |
| 你手動貼到 X 的鏡像 | `manual_mirror`，不同步 |

### 防回音怎麼判斷

工具在 Bluesky／dvd.chat 發原生貼文時，**先寫入資料庫才發 Telegram 提醒**，並建立一筆 pending mirror（文字指紋＋媒體指紋，72 小時）。

當 X 出現新批次時：

- 你已透過互動提醒或 `/mirror <id> <X_URL>` **明確登記過該 X 貼文 ID** → 直接判定為鏡像，忽略且不通知（確定性比對，最可靠）。
- 文字正規化後完全相同、媒體指紋相容，且**只有唯一符合**的候選 → 判定為鏡像，不同步。
- 只有部分相似、媒體不一致、媒體沒有雜湊、或有多個候選 → 標記 `mirror_review`，**暫停並通知你**，不會自動發布。
- 完全沒有證據 → 視為新的 X 原生內容，正常同步。

> 寧可多問你一次，也不要重複發一篇。

---

## 資料與狀態

SQLite 位於 `DATA_DIR/crosspost.sqlite`（WAL、權限 600），媒體快取在 `DATA_DIR/media`，X profile 在 `DATA_DIR/x-profile`。

工作狀態語意：

| 狀態 | 意義 |
|---|---|
| `pending` / `running` | 等待中／執行中 |
| `succeeded` | 已送達 |
| `failed` | 明確被拒絕，可安全重試 |
| `unknown` | **送出結果不明**（連線中斷等）。不會自動重試，需你確認後 `action retry` |
| `review` | 等待你決定 |
| `cancelled` | 被你取消 |

已成功的子步驟有記錄，重試時**不會重複發送**。若程序在送出過程中中斷，下次啟動會把該工作標記為 `unknown` 而不是重播。

---

## 媒體處理（第一版）

- 只支援**靜態圖片**，每篇最多 4 張。
- 依各平台限制自動壓縮（Bluesky 上限 2 MB），會先轉正、移除 EXIF，透明圖保留 PNG、其餘轉 JPEG。
- 動畫 GIF／APNG、影片一律不處理，保留待第二階段。
- 下載與上傳都經過同一個受保護的 HTTP 通道。

### 對外請求的安全邊界

所有對外請求（含 API、媒體下載、X 瀏覽器流量）都經過同一個通道：

- 只允許 `http`／`https`；帶憑證與變更性請求**必須** HTTPS。
- 拒絕 localhost、環回、私有、link-local、保留位址與雲端 metadata 位址，IPv4 與 IPv6 皆含。
- DNS 解析出的**所有**位址都必須是公開位址，並把連線綁定到已驗證的位址（防 DNS rebinding）。
- 每次重導向都重新驗證；不跨來源轉送憑證；HTTPS 不得降級。
- 限制逾時、回應大小與解壓縮後大小；本機檔案只能讀取 `DATA_DIR/media` 之內。

---

## 部署（Oracle ARM64 / Debian）

兩種常駐方式：Docker，或 Linux systemd system service。systemd 有一支部署腳本 `deploy/install.sh`（`install`／`update`／`status`／`uninstall`，支援 `--dry-run` 先看再做），會建立服務帳號與目錄、安裝並建置程式、產生 unit、啟用啟動，更新前先備份資料目錄；完整說明見 [`deploy/README.md`](deploy/README.md)，unit 檔在 [`deploy/crosspost-bridge.service`](deploy/crosspost-bridge.service)。

```bash
sudo bash deploy/install.sh install --dry-run   # 先看它會做什麼
sudo bash deploy/install.sh install
```

收到 SIGTERM 後程式會停止新輪詢、等現有工作與瀏覽器收尾、釋放資料目錄鎖再退出。

Docker：

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
cp .env.example .env && vi .env
docker compose up -d --build
```

首次登入 X（只需一次）。VPS 通常沒有桌面環境、開不了可見瀏覽器，所以**在本機登入、把 session 帶到伺服器**。有三種方式，擇一即可：

**方式 A — Telegram 上傳（最方便，推薦）**

```bash
# 在本機（有桌面環境）：
npm run cli -- login              # 開瀏覽器登入 X 一次
npm run cli -- export-session     # 匯出登入到 data/x-session.json
```

然後把產生的 `data/x-session.json` 直接**傳給你的 Telegram 機器人的「私人聊天」**（就是拖檔案進去傳送）。伺服器端在 `serve` 執行時會自動收下、驗證、安裝到 X profile，並回你一則成功/失敗訊息。安裝後建議把那則上傳訊息刪掉。

> 只有 `TELEGRAM_OWNER_ID` 本人在私人聊天上傳才會被接受；其他來源一律忽略。檔案會嚴格驗證（必須是 export-session 產生的格式、含有效的 X 登入 cookie），大小上限 256KB。
> 注意：session 檔＝你的 X 登入憑證。經 Telegram 傳輸代表 Telegram 伺服器與持有 bot token 者理論上能看到內容；這是為了方便換來的取捨。若不接受，用方式 B 或 C。

**方式 B — 本機匯出、scp 到伺服器安裝**

```bash
# 本機匯出後：
scp data/x-session.json user@host:/path/to/data/x-session.json
# 伺服器上：
npm run cli -- import-session     # 讀 X_SESSION_FILE 安裝到 profile
```

**方式 C — 直接搬整個 profile 目錄**

在本機 `npm run cli -- login` 後，把整個 `data/x-profile` 目錄上傳到伺服器對應的 volume。若伺服器上真的有可見瀏覽器，也可以直接跑：

```bash
docker compose run --rm --entrypoint /usr/bin/chromium bridge \
  --user-data-dir=/app/data/x-profile --no-first-run https://x.com/login
```

session 過期或被要求重新驗證時，重跑本機 `login` + `export-session`，再上傳一次即可。

在非容器環境（例如桌機測試）可以用系統已安裝的 Chrome／Edge 讀取 X：

```bash
X_BROWSER=chrome npm run cli -- doctor   # 顯示實際偵測到的瀏覽器
```

或用 SSH 通道看網頁介面：`ssh -L 3000:127.0.0.1:3000 user@host`。

---

## 已知限制

- **X 讀取的選擇器可能隨 X 前端改版失效。** 解析失敗時會保留檢查點並回報錯誤，不會誤判成「沒有新內容」。
- **Telegram 頻道內的回覆呈現**受頻道設定與 linked discussion 影響。工具保證送出正確的 reply 參照，實際外觀需在你的頻道上驗證一次。
- **dvd.chat 的實際可用上傳上限**由實例與角色政策決定，程式不寫死數字，以伺服器回應為準。
- 影片、GIF、投票、純音訊、Quote 原生互動屬第二階段。`VIDEO_ENABLED`／`FFMPEG_PATH`／`FFPROBE_PATH` 與轉碼規劃已存在，但**尚未接進發布流程**；含影片的內容目前仍被保留、不會自動發布。
- 第一版尚未實作：Web UI 上的排程表單與批次編輯（CLI 已可用）。

---

## 開發

```bash
npm run check   # tsc --noEmit
npm test        # node:test
npm run verify  # check + test + build
```

測試不需要網路、不需要帳號，也不會發送任何訊息。
