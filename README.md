<p align="center"><img src="docs/avatar.svg" width="128" alt="Wherry"></p>

# Wherry

以 X 為主來源的個人跨平台同步工具。X 的發文**永遠由你手動完成**；工具只讀取你自己的 X 內容，並同步到 Bluesky、dvd.chat（Sharkey）與 Telegram。

- 設定與維運：[`docs/configuration.md`](docs/configuration.md)
- systemd 部署：[`deploy/README.md`](deploy/README.md)
- 設計依據：[`crosspost-decisions.md`](crosspost-decisions.md)（v1.2）、平台限制查核 [`crosspost-spec-review.md`](crosspost-spec-review.md)

**目錄**：[會做與不會做](#scope) · [X 政策風險](#x-policy) · [快速開始](#quickstart) · [設定重點](#config) · [指令](#commands) · [同步規則](#rules) · [資料與狀態](#state) · [媒體與網路](#media) · [部署](#deploy) · [已知限制](#limits) · [開發](#dev)

---

<a id="scope"></a>
## 會做與不會做

**會做**

- 讀取你 X 個人頁的新推文（含幾乎同時發出的自串文），過濾後同步到 Bluesky、dvd.chat、Telegram 對外頻道。
- 附上原文連結：Bluesky 在串文最後多回覆一則 `fixupx.com` 連結；Sharkey 在各則內文附可設定的署名與連結；Telegram 每則底部附 `原文連結`。
- 轉換 @提及：貼文裡真的 tag 到的 X 帳號，有映射就換成該平台的原生 ID，沒映射就換成 X 個人頁連結（[細節](#mentions)）。
- 你在 Bluesky／dvd.chat 發原生貼文時，用 Telegram 私聊送**互動提醒**，請你決定要不要手動搬到 X（[細節](#telegram)）。
- 認出你手動貼到 X 的鏡像內容，**不再**回同步到其他平台（[防回音](#echo)）。
- 系統錯誤自動轉發到 Telegram 私聊，秘密先遮蔽。
- CLI、網頁介面，以及排程發布（排程只發到下游，並提醒你發 X）。

**不會做**

- ❌ 自動登入 X、選檔、按 Post。程式碼中沒有任何 X 寫入路徑。
- ❌ 反偵測、輪換代理、繞過驗證或速率限制。
- ❌ 同步回覆他人、晚發的自回覆、轉貼、引用或非公開內容。
- ❌ 純音訊、動態圖片檔（APNG 等）、X Premium 長文：一律**保留**並通知原因。長文可由通知手動放行（發布時自動分段），其餘沒有發布路徑。

投票不在上面兩類：Sharkey／Telegram 各建一份**獨立**原生投票（票數不與 X 或彼此合併，沿用 X 的截止時間）；Bluesky 沒有原生投票，改以文字列出選項並附 X 原投票連結。資料不完整、已過期或敏感的投票仍會保留。

---

<a id="x-policy"></a>
## ⚠️ 啟用 X 讀取前請先讀這段

X 官方 Automation Rules 明文禁止 `scripting the X website`，並寫明**可能導致帳號被永久停權**。**讀取也包含在內**，不只是發文。

這個工具只讀你自己的個人頁、不做任何互動、低頻輪詢，但仍屬該條款描述的技術。風險由你承擔，請自行判斷是否在有價值的帳號上啟用。不啟用（`X_ENABLED=false`）時其他功能照常運作，例如排程發布與 B/D → 手動 X 提醒。

`VIDEO_ENABLED=true` 時，每則含影片的推文會多打一次 `cdn.syndication.twimg.com`（網頁嵌入推文用的公開端點）取得可下載的 MP4，因為 X 播放器只給 `blob:` 的 HLS。這是唯讀、無認證的請求，但仍是對 X 基礎設施的請求，請一併納入判斷。不開影片同步就不會發出。

---

<a id="quickstart"></a>
## 快速開始

需要 Node.js 24 以上。

```bash
cp .env.example .env      # 填入設定
npm install
npm run verify            # 型別檢查 + 測試 + 建置
npm run cli -- doctor     # 檢查設定與實際偵測到的瀏覽器
npm run cli -- login      # 開瀏覽器手動登入 X（只需一次）
npm run cli -- serve      # 啟動排程、worker 與網頁介面
```

**`login` 不能省**：X 讀取靠一個持久化瀏覽器 profile。`login` 用你選的瀏覽器開可見視窗，你手動登入（含兩步驟驗證）後回終端機按 Enter，session 就存進 `X_PROFILE_DIR`，之後 `scan`／`serve` 都以無頭模式重用。沒登入的話會撞到登入牆、讀不到任何推文（`scan` 會回報 session 未登入）。

**先用 preview 確認行為**：預設 `APP_MODE=preview` 時，讀取、分類、組批次照常執行（讀 X 是唯讀的），只有「發布」換成 stub 不對外送出。在網頁按「立刻檢查」就能看到偵測到哪些推文、預計發什麼。確認無誤再改 `live`。

- Telegram 的對外發文、互動提醒、錯誤轉發**只在 `live` 送出**。指令與 session 上傳另需 `TELEGRAM_POLL_COMMANDS=true`。
- 網頁介面預設只綁 `127.0.0.1:3000`。綁其他位址時 `WEB_TOKEN` 必須至少 32 字元，所有寫入請求都要帶 `Authorization: Bearer <token>`。遠端存取請用 SSH 通道：`ssh -L 3000:127.0.0.1:3000 user@host`。

---

<a id="config"></a>
## 設定重點

| 變數 | 說明 |
|---|---|
| `APP_MODE` | `preview` 用 stub publisher；`live` 才真的發布 |
| `DESTINATIONS` | 要同步過去的平台，例如 `bluesky,sharkey,telegram` |
| `X_ENABLED` / `X_HANDLE` | 啟用 X 唯讀監聽 |
| `X_BROWSER` | `auto`（依序找系統 Chrome → Edge → Chromium）、`chrome`、`msedge`、`chromium`、`path`（用 `CHROMIUM_PATH`） |
| `X_PROFILE_DIR` | 登入後保留的瀏覽器 profile 目錄（視同密碼，請保持私密） |
| `BLUESKY_*` | 官方 API，請用 **app password**，不要用主密碼 |
| `BLUESKY_SENSITIVE_LABEL` | 未分類敏感內容的 self-label，預設 `graphic-media`（血腥／暴力，不是通用警告）；可選 `porn`、`sexual`、`nudity` |
| `SHARKEY_*` | API token 權限：發文 `write:notes`、上傳 `write:drive`；指定預設 Drive 資料夾另需 `read:drive` |
| `TELEGRAM_ENABLED` / `TELEGRAM_BOT_TOKEN` | 啟用 bot（token 由 BotFather 取得） |
| `TELEGRAM_PUBLIC_CHAT_ID` | 對外同步的頻道，一律用數字 ID，不是 @username |
| `TELEGRAM_PRIVATE_CHAT_ID` | 你的私聊：互動提醒、錯誤告警、指令回覆、session 上傳 |
| `TELEGRAM_OWNER_ID` | 唯一能下指令、按提醒按鈕、上傳 session 的使用者 |
| `TELEGRAM_POLL_COMMANDS` | `true` 才處理指令與按鈕（僅 `live`） |

完整設定（用途與取得方式）見 [`docs/configuration.md`](docs/configuration.md)。

**設定會強制檢查**：`DESTINATIONS` 含 `bluesky` 就必須 `BLUESKY_ENABLED=true`，`sharkey` 同理。工具必須觀察那個帳號才能辨認「手動鏡像」，否則防回音失去依據。這是刻意的設計，不能繞過。

---

<a id="commands"></a>
## 指令

### CLI

```bash
npm run cli -- serve                     # 常駐：輪詢、worker、網頁介面
npm run cli -- once                      # 跑一輪：收集 → 收斂串文 → 發布
npm run cli -- scan                      # 只收集，不發布
npm run cli -- status                    # 列出 jobs、batches、近期事件
npm run cli -- publish <batchId>         # 對已封存的批次補發布
npm run cli -- schedule <ISO時間> <文字>   # 排程發布（不會排程 X 寫入）
npm run cli -- action <動作> <id>         # 見下表
npm run cli -- doctor                    # 檢查設定
npm run cli -- login                     # 本機開瀏覽器登入 X
npm run cli -- export-session            # 匯出 X 登入到 X_SESSION_FILE
npm run cli -- import-session            # 安裝 X_SESSION_FILE 的登入
```

`action` 的動作與 Telegram 指令對應同一套操作：

| 動作 | Telegram | 作用 |
|---|---|---|
| `approve <batchId>` | `/approve` | 放行被保留的批次 |
| `skip <batchId>` | `/skip` | 不同步這個批次 |
| `mirror <id>` | `/mirror <id> [X_URL]` | 標記為手動鏡像；Telegram 可附上你發的 X 連結作為防回音依據 |
| `retry <jobId>` | `/retry`、`/resync` | 重試**明確失敗**（`failed`）的工作 |
| `reconcile <jobId>` | `/reconcile` | 重送結果不明（`unknown`）的工作——**先自己確認遠端沒有發出** |
| `cancel <jobId>` | `/cancel` | 放棄發不出去的工作（例如投票已過期），不再發送或重試 |

<a id="telegram"></a>
### Telegram

指令只接受 `TELEGRAM_OWNER_ID` 在私聊下達，且需 `live` + `TELEGRAM_POLL_COMMANDS=true`。除上表外：

| 指令 | 作用 |
|---|---|
| `/status` | 模式、X session 狀態、任務與近期事件 |
| `/sync` | 立即檢查一次（X 發文仍需手動） |
| `/pending` | 列出等待處理的批次與 X 提醒 |
| `/map <X_ID> [平台=ID …]` | 查看或設定 @提及映射，例如 `/map alice bluesky=alice.bsky.social` |
| `/maps`、`/unmap <X_ID>` | 列出／刪除映射 |
| `/session` | 更新 X 登入：接著上傳 `x-session.json`（或在檔案說明填 `/session`） |
| `/help` | 顯示所有指令 |

**互動提醒**：偵測到你在 Bluesky／dvd.chat 的原生貼文時，私聊會收到附「1️⃣ 要發 / 2️⃣ 不發」按鈕的訊息。按「要發」後**回覆該訊息貼上 X 連結**即登記為鏡像；按「不發」則不同步。訊息會就地更新狀態。

---

<a id="rules"></a>
## 同步規則

### 什麼會被同步

1. 只有 `in_reply_to` 為空的推文能開啟新批次。
2. 從該 root 的**發布時間**起算 `THREAD_WINDOW_SECONDS`（預設 600 秒）窗口，不會因後續回覆而延長。
3. 同一作者、沿直接回覆鏈、且在窗口內的自回覆加入同一批次。
4. 窗口結束、且**每個下游平台都有近期掃描**後才封存；封存後才發布。

### 不同步與特殊處理

| 情況 | 判定 |
|---|---|
| 回覆他人 | `reply_to_other`，忽略 |
| 晚發的自回覆（超過 root 窗口） | `skipped_late_self_reply` |
| 回覆一串早已同步完成的舊推文 | `self_reply_outside_new_batch` |
| 自回覆的上一則從未被收集到 | `self_reply_outside_new_batch`，並記一筆 `warn` 說明收集缺口 |
| 串文分支（非線性） | 保留待審，不強行攤平 |
| 轉貼、引用、非公開、超過 4 個附件 | 保留或忽略，不會靜默降級 |
| 影片、GIF | `VIDEO_ENABLED=true`、每支都解析得到 MP4、長度 ≤140 秒才同步；否則保留並說明理由。GIF 在 X 上本身就是 MP4，照影片流程同步：Bluesky 以 GIF 呈現（`presentation: gif`）、Telegram 單獨一個時用 `sendAnimation`（相簿裡則當影片）、Sharkey 上傳 MP4。 |
| 圖片與影片混合 | 照原順序同步：Telegram 一個相簿、Sharkey 一則 note；Bluesky 不能混放，連續圖片共用一則、每支影片各一則，依序接成串文 |
| 投票 | 見[會做與不會做](#scope)；資料不完整／已過期／敏感才保留 |
| 敏感內容（標了敏感的媒體、來源 CW） | 照常同步，見下方 |
| 你手動貼到 X 的鏡像 | `manual_mirror`，不同步 |

**敏感內容**：Bluesky 每段加 selfLabels＋CW 文字、Sharkey 每段加 CW＋敏感檔案、Telegram 正文與媒體加 spoiler。來源沒有 CW 時使用「來源標記為敏感內容」。敏感標記不會解除非公開或不支援媒體的限制；敏感投票不會在 Telegram 發布（無法對題目防雷）。Bluesky 的媒體遮蔽依讀者設定，純文字只保留可見 CW、不保證折疊。X 偵測只涵蓋頁面可見的警告。詳見[敏感內容同步說明](docs/configuration.md#敏感內容如何同步)。

<a id="mentions"></a>
### @提及

只處理 X 頁面上**真的是帳號連結**的提及（顯示文字與連結路徑一致、位於貼文本體）。純文字 `@某人`、引用推文裡的提及都不算。

- 沒映射 → 換成 `https://x.com/帳號`，下游不會誤當成自己站上的帳號。
- 有映射 → Bluesky 用完整 handle（發布時查 DID 寫入 mention facet）、Sharkey 用 `@user` 或 `@user@host`、Telegram 用 `@username`。

用 `/map`、`/maps`、`/unmap` 管理（格式與驗證規則見[設定文件](docs/configuration.md#mentions)）。映射只影響之後的發布；已開始送出的工作沿用當時的版本，不會因改設定而漏送或重送。

<a id="echo"></a>
### 防回音

你在 Bluesky／dvd.chat 發原生貼文時，工具**先寫入資料庫再發 Telegram 提醒**，並建立一筆 pending mirror（文字指紋＋媒體指紋，有效 72 小時）。

只有「你可能還在手動搬到 X」的貼文才是候選：首次掃描下游帳號時的歷史（基準快照）不算，已配對到某則 X 貼文的也會退出比對。否則短貼文幾乎必然「像」某則舊文而被攔下審核。

X 出現新批次時：

| 證據 | 結果 |
|---|---|
| 已透過互動提醒或 `/mirror <id> <X_URL>` 登記過該 X 貼文 ID | 判定鏡像，忽略且不通知（確定性比對） |
| 正規化文字完全相同、媒體指紋相容、文字 ≥20 UTF-8 位元組（約 7 個中文字），且**只有唯一**候選 | 判定鏡像，不同步 |
| 部分相似、媒體不一致或沒雜湊、文字相同但太短（如「早安」）、多個候選 | `mirror_review`，**暫停並通知你** |
| 完全沒有證據 | 視為 X 原生內容，正常同步 |

> 寧可多問你一次，也不要重複發一篇。

---

<a id="state"></a>
## 資料與狀態

SQLite 在 `DATA_DIR/crosspost.sqlite`（WAL、權限 600），媒體快取在 `DATA_DIR/media`，X profile 在 `DATA_DIR/x-profile`。

| 工作狀態 | 意義 |
|---|---|
| `pending` / `running` | 等待中／執行中 |
| `succeeded` | 已送達 |
| `failed` | 明確被拒絕，可安全 `retry` |
| `unknown` | **送出結果不明**（連線中斷、程序中途停止）。不會自動重試：遠端沒發出就 `reconcile`，已發出就 `cancel` |
| `review` | 等待你決定 |
| `cancelled` | 已放棄 |

已成功的子步驟有記錄，重試**不會重複發送**。程序在送出途中中斷時，下次啟動會把該工作標為 `unknown` 而不是重播。

---

<a id="media"></a>
## 媒體與網路

- 預設只支援**靜態圖片**，每篇最多 4 張；依平台限制壓縮（Bluesky 上限 2 MB），先轉正、移除 EXIF，透明圖保留 PNG、其餘轉 JPEG。
- 動態圖片檔（APNG 等）不處理。`VIDEO_ENABLED=true` 時，影片與 GIF 從公開嵌入端點取能塞進 `MAX_DOWNLOAD_BYTES` 的最高畫質 MP4，經 FFmpeg 轉碼後同步，可與圖片或其他影片混在同一則（合計最多 4 個，[限制](docs/configuration.md#video)）。

API、媒體下載與上傳都經過同一個受保護的 HTTP 通道：

- 只允許 `http`／`https`；帶憑證與變更性請求**必須** HTTPS。
- 拒絕 localhost、環回、私有、link-local、保留與雲端 metadata 位址（IPv4／IPv6）。
- DNS 解析出的**所有**位址都必須公開，連線綁定到已驗證位址（防 DNS rebinding）。
- 每次重導向重新驗證；不跨來源轉送憑證；HTTPS 不得降級。
- 限制逾時、回應大小與解壓後大小；本機檔案只能讀 `DATA_DIR/media`。

X 瀏覽器不走這個通道，另有網域與唯讀方法限制。

---

<a id="deploy"></a>
## 部署（Oracle ARM64 / Debian）

**systemd**：用部署腳本，先 `--dry-run` 看它會做什麼。更新前會自動備份資料目錄；完整說明見 [`deploy/README.md`](deploy/README.md)。

```bash
sudo bash deploy/install.sh install --dry-run
sudo bash deploy/install.sh install
```

**Docker**：容器內需設 `HOST=0.0.0.0` 與 32 字元以上的 `WEB_TOKEN`、資料目錄要讓 UID 10001 可寫，細節見 [Docker 部署](docs/configuration.md#docker)。

```bash
cp .env.example .env && vi .env
docker compose up -d --build
docker compose logs -f bridge
```

收到 SIGTERM 後程式會停止新輪詢、等現有工作與瀏覽器收尾、釋放資料目錄鎖再退出。

### 把 X 登入帶到伺服器

VPS 通常開不了可見瀏覽器，所以**在本機登入、匯出 session 再帶過去**。session 檔等同你的 X 登入憑證，請當密碼保管。

```bash
# 本機（有桌面環境）
npm run cli -- login
npm run cli -- export-session          # 寫到 X_SESSION_FILE（預設 data/x-session.json）
```

**方式 A — SSH 傳輸（建議）**

```bash
scp data/x-session.json user@host:/path/to/data/x-session.json
# 伺服器上，先停止服務，用服務帳號與同一份設定執行：
npm run cli -- import-session
```

**方式 B — Telegram 上傳（方便，但有取捨）**：在 bot 私聊先傳 `/session`，五分鐘內上傳 `x-session.json`（或在檔案說明填 `/session`）。伺服器在 `live` 且啟用指令輪詢時會驗證（格式、有效 cookie、≤256KB）、安裝並嘗試刪除該訊息。只接受 owner 本人在私聊上傳；沒下指令也沒填說明的檔案不會安裝。
> 經 Telegram 傳輸代表 Telegram 伺服器與持有 bot token 者理論上能看到內容。不能接受就用方式 A。

session 過期或被要求重新驗證時，重跑本機 `login` + `export-session` 再傳一次。權限與安全細節見 [X 登入與 session 安全](docs/configuration.md#x-session)。

---

<a id="limits"></a>
## 已知限制

- **X 前端改版可能讓選擇器失效。** 解析失敗時保留檢查點並回報錯誤，不會誤判成「沒有新內容」。
- **Telegram 頻道內的回覆外觀**受頻道設定與 linked discussion 影響。工具保證送出正確的 reply 參照，實際呈現請在你的頻道驗證一次。
- **dvd.chat 的上傳上限**由實例與角色政策決定，程式不寫死，以伺服器回應為準。
- **影片**：嵌入端點未公開文件化，解析失敗（推文已刪、受保護、格式改變、只有 HLS）就保留為 `x_video_has_no_downloadable_source`；超過 140 秒在下載前以 `video_exceeds_duration_limit` 保留。
- **網頁介面**已有文字排程、待決批次與失敗工作的批量處理、最近讀到的貼文（含分類與原因）；排程附件與批次編輯尚未實作。

---

<a id="dev"></a>
## 開發

```bash
npm run check   # tsc --noEmit
npm test        # node:test
npm run verify  # check + test + build
```

測試不需要網路與帳號，也不會發送任何訊息。
