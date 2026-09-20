# crosspost-bridge

X 為主來源的個人跨平台同步工具。X 的發文**永遠由你手動完成**；工具只讀取你自己的 X 內容，並自動同步到 Bluesky、dvd.chat（Sharkey）與 Telegram。

設計依據見 [`crosspost-decisions.md`](crosspost-decisions.md)（v1.2）與平台限制查核 [`crosspost-spec-review.md`](crosspost-spec-review.md)。

---

## 這個工具會做與不會做的事

**會做**

- 讀取你自己 X 個人頁的新推文（含幾乎同時發出的自串文），過濾後同步到 Bluesky、dvd.chat、Telegram 對外頻道。
- 在 Bluesky／dvd.chat 同步完成後，多發一則回覆串文，附上該串文最頂端主推文的 `fixupx.com` 連結。
- Telegram 對外頻道的每則訊息底部附 `原文連結`。
- 偵測你在 Bluesky／dvd.chat 發的原生貼文，用 Telegram 私聊送兩則訊息：一則提醒你要手動發到 X，一則附完整內容與媒體供你轉發。
- 認出你手動貼到 X 的鏡像內容，**不再**回同步到其他平台。
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
npm run cli -- serve      # 啟動排程、worker 與網頁介面
```

預設 `APP_MODE=preview`：整條流程照跑，但只寫入記錄，**不會**對外發布。確認行為正確後再改成 `live`。

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
| `TELEGRAM_*` | bot token 與三個 chat id（一律用數字 ID，不是 @username） |

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
```

Telegram 私聊指令（需 `TELEGRAM_POLL_COMMANDS=true`，且只接受 `TELEGRAM_OWNER_ID`）：
`/status`、`/sync`、`/skip <id>`、`/mirror <id>`、`/approve <id>`、`/retry <job>`、`/help`。

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

```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2
cp .env.example .env && vi .env
docker compose up -d --build
```

首次登入 X profile（用你選定的瀏覽器登入一次，憑證留在 volume）：

```bash
docker compose run --rm --entrypoint /usr/bin/chromium bridge \
  --user-data-dir=/app/data/x-profile --no-first-run https://x.com/login
```

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
- 影片、GIF、投票、純音訊、Quote 原生互動屬第二階段。
- 第一版尚未實作：Web UI 上的排程表單與批次編輯（CLI 已可用）。

---

## 開發

```bash
npm run check   # tsc --noEmit
npm test        # node:test
npm run verify  # check + test + build
```

測試不需要網路、不需要帳號，也不會發送任何訊息。
