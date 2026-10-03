# 設定與維運參考

本文件說明 [`src/config.ts`](../src/config.ts) 讀取的設定、憑證取得方法與維運方式。可直接使用的安全起點是 [`.env.example`](../.env.example)；日常操作入口見 [README](../README.md)。未啟用的帳戶欄位可以留空，不需要為了啟動工具申請所有平台的憑證。

## 目錄

- [載入規則](#loading)
- 設定表：[基本與 Web](#basics)、[X](#x)、[Bluesky](#bluesky)、[Sharkey](#sharkey)、[Telegram](#telegram)、[時間與限制](#timing)、[影片模組](#video)
- [ID 映射（@提及）](#mentions)
- [官方憑證與帳號資料取得](#credentials)
- [X 登入與 session 安全](#x-session)
- [Docker 部署](#docker)
- [備份、還原與更新](#maintenance)
- [故障排除](#troubleshooting)

<a id="loading"></a>
## 載入規則

1. CLI 使用 Node 內建的 `process.loadEnvFile()` 讀取**目前工作目錄**的 `.env`（檔案不存在就略過）。已由 shell、容器或服務管理器設定的環境變數優先，不會被 `.env` 覆蓋。改檔後須重新啟動程式。
2. 下表的預設值指「沒有設定該環境變數」時的值。字串欄位多數也會在空字串時採用預設；**布林與整數不能一概留空**。
3. 布林值只有小寫 `true` 會變成真；`false`、空字串、`1`、`yes`、`TRUE` 都會變成假。請只用 `true`／`false`。尤其 `X_SANDBOX` 要採自動預設時，應整行省略或註解，不能填空白或 `auto`。
4. 整數必須落在表列範圍內，上下限都包含；使用不帶單位的十進位數字。空字串會轉成 `0`，本表整數設定都會因此驗證失敗。
5. 路徑以**工作目錄**解析，不是以 `.env` 所在位置解析。不要依賴 `~`、`$DATA_DIR` 或 `${DATA_DIR}` 展開；`.env` 不做變數展開。含空白的路徑請加雙引號，伺服器上建議用絕對路徑。
6. `X_PROFILE_DIR`／`X_SESSION_FILE` 留空才會跟隨 `DATA_DIR`。若寫死 `./data/x-profile`，之後改 `DATA_DIR` 不會一起搬動它。
7. `.env.example` 同時列出必填與選填設定；有預設值的選填項目可保留註解，該行仍寫出預設值供參考。未知鍵不會自動變成新功能；沒有 `X_PASSWORD`、`MAX_IMAGE_BYTES` 或回填歷史貼文開關。

**preview 不是離線沙盒。** 它使用模擬 publisher，不送出平台貼文、Telegram 提醒／告警／指令回覆；但已啟用的來源仍會連網讀取，媒體可能下載，本機基準、批次與模擬送出狀態仍會保存。Telegram 命令輪詢只在 `live` 啟動。需要完全離線時，停用所有來源及 Telegram，且不要執行 `login`／`import-session` 等會連線的命令。

**試跑與正式資料不要混用。** Preview 的 `succeeded` 表示模擬完成，不代表平台已收到；不要拿包含模擬工作的資料庫直接當成待發布清單。正式上線使用另一個 `DATA_DIR`，重新建立基準；新基準之前的內容不會自動補發。

<a id="basics"></a>
## 基本與 Web（6 個）

| 設定鍵 | 預設值 | 作用、格式與限制 | 如何取得／選擇 |
|---|---|---|---|
| `APP_MODE` | `preview` | 僅接受 `preview` 或 `live`。前者模擬發布，後者可對下游真正發布；X 永遠手動發文。 | 先以 preview 核對分類；確認帳號、目的地與資料目錄後才改 live。 |
| `DESTINATIONS` | 空清單 | 逗號分隔 `bluesky`、`sharkey`、`telegram`；會去除項目前後空白與重複值。不得包含 `x`。控制對外發布，不控制來源收集或 Telegram 私聊／告警。 | 只列出你要公開發布的平台。Bluesky／Sharkey 必須啟用對應來源；Telegram 要另設 public chat。 |
| `DATA_DIR` | 工作目錄下的 `data` | 私密、可寫的狀態根目錄；SQLite 固定為其中的 `crosspost.sqlite`。同一目錄只可由一個執行中的實例使用。 | 自行建立並指定；新測試可用 `./data-preview`，systemd 的位置見 [部署文件](../deploy/README.md)。自訂目錄也須自行排除版控與公開備份。 |
| `HOST` | `127.0.0.1` | Web 監聽位址。只有字面值 `127.0.0.1`、`::1` 可不設 token；其他值（包括 `localhost`）必須搭配長度至少 32 的 `WEB_TOKEN`。 | 本機／主機部署保持 loopback。容器內若需讓轉發連接埠可達，見 [Docker](#docker)。 |
| `PORT` | `3000` | TCP 連接埠，整數 **1–65535**。低於 1024 的埠可能需要額外系統權限，不應因此以 root 啟動。 | 選擇未使用的高位埠；反向代理與連接埠映射須一致。 |
| `WEB_TOKEN` | 空字串 | 有設定時，所有 POST／PUT／PATCH／DELETE 都必須帶 `Authorization: Bearer <token>`；非 loopback 至少 32 字元。**GET 頁面、狀態與貼文 API 並未因此加上登入保護。** | 用密碼管理器或密碼學安全亂數產生，建議至少 32 隨機 bytes，再編碼為 hex 等可儲存字串；用編輯器／secret store 存入，不貼到命令列。 |

Web 頁面可輸入 token；目前 UI 會把它保存在該瀏覽器來源的 `localStorage`，請使用自己的受信任瀏覽器，勿在共用電腦保留。預設 loopback 且未設 token 時，寫入端點仍要求 JSON 並拒絕不符的跨來源請求；這不是完整的多使用者認證機制。正式部署優先用 SSH 通道；若使用反向代理，應在代理層對**所有路由**加上認證與 TLS。

<a id="x"></a>
## X：唯讀來源（9 個）

| 設定鍵 | 預設值 | 作用、格式與限制 | 如何取得／選擇 |
|---|---|---|---|
| `X_ENABLED` | `false` | 啟用自己 X 個人頁的瀏覽器讀取。開啟時必須有有效 `X_HANDLE`；login／session 匯入匯出也要求此設定。 | 先閱讀 [README 的政策風險](../README.md#x-policy)，自行決定是否啟用。 |
| `X_HANDLE` | 空字串 | 自己的 X 帳號，不含 `@`；啟用讀取時限 **1–15 個英數字或底線**。手動鏡像登記也用它檢查連結是否屬於自己。 | 從自己的 X 個人頁取得，不是顯示名稱。即使停用讀取，若要登記手動鏡像也應填入。 |
| `X_BROWSER` | `auto` | `auto`、`chrome`、`chrome-beta`、`msedge`、`msedge-beta`、`chromium`、`path`；值會轉成小寫。`auto` 依序找 Chrome → Edge → Chromium，最後使用 Playwright 的 Chrome channel。 | 安裝自己平台／CPU 架構適用的瀏覽器。`playwright-core` 不會隨 `npm ci` 自動下載瀏覽器。用 `doctor` 檢視解析結果。 |
| `CHROMIUM_PATH` | 空字串 | 瀏覽器執行檔路徑；只要非空就優先於任何 `X_BROWSER` 選擇，`X_BROWSER=path` 時必填。不是 profile 路徑。 | 從實際安裝位置取得，例如 Linux 的 `/usr/bin/chromium`。桌面 bundle 要指定內部執行檔，不是 `.app` 目錄。 |
| `X_PROFILE_DIR` | `DATA_DIR/x-profile` | 持久化登入 profile 目錄。空字串也採此預設；不應與日常瀏覽器或其他執行中的實例共用。 | 使用專用位置，由 `login`／`import-session` 建立；限制目錄存取權。 |
| `X_HEADLESS` | `true` | 來源讀取是否無頭。`login` 固定用可見視窗，匯入／匯出固定用無頭瀏覽器，不受本值改變。 | 有桌面且要觀察讀取時可暫設 false；無桌面的 VPS 保持 true。 |
| `X_MAX_PAGES` | `4` | 單次讀取的捲動／解析輪數上限，整數 **1–10**。不是每天篇數或串文長度上限。 | 積壓超過掃描範圍時可適度提高；不保證讀到所有內容，更不應用於大量抓取。 |
| `X_SESSION_FILE` | `DATA_DIR/x-session.json` | `export-session` 寫入與 `import-session` 讀取的檔案路徑；空字串採預設。檔案接受上限固定 **262144 bytes（256 KiB）**。 | 由 `export-session` 產生，不是任意瀏覽器 cookie 匯出檔；自訂位置要先建立私密父目錄。 |
| `X_SANDBOX` | **Linux 且 UID=0：`false`；其他環境：`true`** | Chromium sandbox 開關。不設定時依平台與使用者判斷；若強制設定，仍按一般布林規則解析。設 false 會降低瀏覽器隔離。 | 正式部署使用非 root 專用帳戶並保留 sandbox。只有了解環境限制時才明確覆寫，勿以空值或 `auto` 表示自動。 |

`chrome-beta`／`msedge-beta` 也會先查找已知的 stable 安裝位置，找不到才回退到對應 channel；它們不是版本鎖定。若需要精確執行檔，使用 `X_BROWSER=path` + `CHROMIUM_PATH`。作業系統的 `HOME`／Windows 安裝路徑環境變數會影響自動偵測，這些不是本程式的應用設定鍵。

目前 collector 讀取 X 個人頁的主時間軸，不是完整歷史 API，也不保證呈現所有自回覆。核心只能組合**實際收集到且關係明確**的線性串文；不要把 `X_MAX_PAGES` 或時間窗口當成「完整串文一定不漏」的保證。

<a id="bluesky"></a>
## Bluesky（5 個）

| 設定鍵 | 預設值 | 作用、格式與限制 | 如何取得／選擇 |
|---|---|---|---|
| `BLUESKY_ENABLED` | `false` | 啟用來源觀察；runtime 還要求非空的 identifier 與 app password 才建立 client。若列為 destination，必須為 true。 | 先設定同一帳號的識別值與應用程式密碼。 |
| `BLUESKY_IDENTIFIER` | 空字串 | 完整 handle（不含 `@`）、支援的 DID（`did:plc`／`did:web`）或登入 email。 | 建議從自己的官方 App 個人頁複製 handle；email 是登入識別值，不是公開名稱。 |
| `BLUESKY_APP_PASSWORD` | 空字串 | 專用應用程式密碼，不是主密碼。即使只觀察來源，目前 runtime 也要求此值。 | 在 [官方 App passwords 頁](https://bsky.app/settings/app-passwords) 建立，見 [詳細步驟](#credentials)。 |
| `BLUESKY_SERVICE_URL` | `https://bsky.social` | 使用 email 登入時的 bootstrap 服務；必須是 HTTPS 基底位址。實際 PDS 仍透過帳戶 DID 文件探索，並非任意指定公開 AppView 的開關。 | 官方託管帳戶通常保持預設；自架 PDS 使用管理員公布的服務原點，且不得是被 HTTP 防護拒絕的內網位址。 |
| `BLUESKY_SENSITIVE_LABEL` | `graphic-media` | 來源標為敏感但未提供已知分類時的 self-label；只接受 `porn`、`sexual`、`nudity`、`graphic-media`，空值會報錯。已知來源分類優先保留。 | 依實際內容選擇；`graphic-media` 指血腥／暴力等刺激性媒體，不是通用警告。詳見下方說明。 |

公開 AppView 固定為 `https://public.api.bsky.app`，沒有對應 env 設定。Handle／DID 會透過公開解析與 DID 文件找 PDS；不要為了登入問題把憑證放到 URL 或隨意改成不受信任的服務。

### 敏感內容如何同步

已偵測到的敏感標記不再單獨構成保留原因，但非公開內容、不完整資料及不支援的媒體仍照原規則處理。投票會照常同步（Sharkey／Telegram 原生、Bluesky 文字），惟資料不完整、已過期或敏感的投票仍會保留 —— 敏感投票因 Telegram 無法對投票題目加防雷而無法安全發布。

- **Bluesky**：每個內容分段都帶 `selfLabels` 及可見的 `CW: …` 前綴。來源已有 `porn`／`sexual`／`nudity`／`graphic-media` 時保留分類；未分類才用 `BLUESKY_SENSITIVE_LABEL`。媒體遮蔽受讀者偏好控制，這些標籤不會自動折疊純文字。自行附上的 `!warn` 會被 Bluesky 的 moderation 規則忽略，因此不使用它假裝通用警告。
- **Sharkey**：每段都有 CW，媒體檔案同時設定 `isSensitive=true`。沿用來源 CW；只有敏感旗標或空白 CW 時，使用「來源標記為敏感內容」。
- **Telegram**：保留可見警告，正文與圖片說明使用 spoiler，單張圖片、相簿每張圖片及影片都帶 `has_spoiler`；敏感文字訊息停用連結預覽，避免預覽繞過遮蔽。私人手動 X 提醒也保留警告。

分段會預留 CW／HTML 的長度，不會在發布時才把原本剛好達上限的內容擠爆。若 CW 本身過長而無法容納，工作會明確報錯，不會刪掉警告後繼續發送。舊的 review 批次不會因更新而自行補發；仍須人工檢查後處理。

X 目前只辨認頁面可見的警告文案，若帳戶設定隱藏了警告，或 X 改版／語言不受支援，仍可能漏偵測；這不是對未標記內容的自動分類器。

<a id="sharkey"></a>
## Sharkey（8 個）

| 設定鍵 | 預設值 | 作用、格式與限制 | 如何取得／選擇 |
|---|---|---|---|
| `SHARKEY_ENABLED` | `false` | 啟用來源觀察；runtime 還要求非空 token 才建立 client。若列為 destination，必須為 true。 | 開啟前確認是自己的本機帳戶，並填入 token 與帳戶識別值。 |
| `SHARKEY_URL` | `https://dvd.chat` | 自己實例的 HTTPS 基底位址，不加 `/api`、帳密、query 或 fragment。預設只是程式既有值，**可以覆寫**。 | 從自己登入的 Sharkey 實例取得；範例網域可寫成 `https://social.example`，不要複製他人的實際主機。 |
| `SHARKEY_TOKEN` | 空字串 | 實例 API 存取權杖。發文需 `write:notes`，上傳圖需 `write:drive`；若兩個帳戶識別欄位都沒填，帳戶探索還需 `read:account`。 | 由自己的實例「設定 → API／存取權杖」建立；不同版本標籤可能不同，詳見下方步驟。 |
| `SHARKEY_USER_ID` | 空字串 | 選填的本機 user ID；有值時優先用 `users/show` 查詢。ID 是平台識別碼，不一定是數字。 | 從實例官方 API 的 `users/show` 回應 `id` 取得，不是貼文 ID。與 username 同填時必須一致。 |
| `SHARKEY_USERNAME` | 空字串 | 本機帳號名，不含 `@` 或 `@實例網域`；未填 user ID 時用它查詢。不是顯示名稱，也不是遠端聯邦帳號。 | 從自己的實例個人頁取得；建議填它，避免僅為帳戶探索額外授予 `read:account`。 |
| `SHARKEY_SIGNATURE` | 內建 Wherry MFM 署名 | 附在 X 同步貼文內文底部，`{url}` 換成該則原文連結；空字串停用。 | 自訂 MFM／Markdown，或留空不署名。 |
| `SHARKEY_DRIVE_FOLDER` | `Wherry` | 在 Drive 根目錄依名稱尋找／建立資料夾，並快取其 ID；空字串直接上傳至根目錄。 | 啟用資料夾時另需 `read:drive` 與 `write:drive`。 |
| `SHARKEY_UPLOAD_NAME` | `Wherry_{timestamp}-{index}.{ext}` | 上傳檔名樣板；替換後只允許英數字、`_`、`.`、`-`。 | 可使用 `{timestamp}`、`{index}`、`{ext}`，同一預留位置可重複。 |

欄位、token 及實例必須屬於**同一個自己擁有的帳戶**。不要假設填入公開 username 就能證明 token 所屬帳戶正確。實例／角色／反向代理的文字、容量與發文限制仍可能拒絕請求；程式沒有「解除可見性限制」的 env 設定，也不會替你修改帳戶的可見性選項。

<a id="telegram"></a>
## Telegram（7 個）

| 設定鍵 | 預設值 | 作用、格式與限制 | 如何取得／選擇 |
|---|---|---|---|
| `TELEGRAM_ENABLED` | `false` | 啟用 Telegram client，還需非空 bot token。`live` 才實際送出訊息；此值不會自動加入對外發布目的地。 | 建立自己的 bot 後啟用；私聊提醒與維運告警可獨立於 public destination 使用。 |
| `TELEGRAM_BOT_TOKEN` | 空字串 | Bot API 憑證；持有者可控制 bot，也可能接觸 bot 收到的檔案。 | 透過 [官方 BotFather](https://t.me/BotFather) 建立／管理 bot，不向第三方索取。 |
| `TELEGRAM_OWNER_ID` | 空字串 | 唯一允許下指令、點按提醒與上傳 session 的本人數字 user ID。 | 從自己與 bot 私聊的 `message.from.id` 取得；不能填 bot ID 或 `@username`。 |
| `TELEGRAM_PRIVATE_CHAT_ID` | `TELEGRAM_OWNER_ID`；兩者皆空則空 | 手動 X 提醒、命令回覆與 session 管理的私人 chat。只接受 owner 在指定私人 chat 的操作。 | 從 `message.chat.id` 核對，並確認 `message.chat.type` 為 `private`。先向 bot 送出 `/start`。 |
| `TELEGRAM_OPS_CHAT_ID` | 空字串 | 保留給明確指定 ops audience 的呼叫；目前自動錯誤告警一律送到 private chat。 | 日常通知不需設定；不要把此欄位當成錯誤轉發目的地開關。 |
| `TELEGRAM_PUBLIC_CHAT_ID` | 空字串 | 對外同步的目的地；還需 `live`、Telegram enabled/token，且 `DESTINATIONS` **包含 `telegram`**。 | 從自己要發文的頻道取得數字 ID，並給 bot 最小必要發文權。僅填此值不會啟用對外同步。 |
| `TELEGRAM_POLL_COMMANDS` | `false` | `live` 下設 true 才登記 `/` 指令選單，以 25 秒長輪詢接收指令、按鈕、回覆與 session 檔案；回應後稍候 0.5 秒再輪詢。preview 不啟動輪詢。 | 要透過 bot 管理時才開；false 仍可在 live 發送提醒與告警，但提醒按鈕／回覆不會被處理。 |

所有非空 Telegram ID 均須為數字字串（驗證格式為 `^-?\d+$`）；頻道 ID 常以 `-100` 開頭，**保留負號**。Owner 使用自己的正數 user ID，不是電話號碼。格式驗證不會替你檢查 chat 是否存在、是否屬於你或 bot 是否有權限。

告警目前針對 `error` 事件，不等於每次成功、每筆 `warn` 或服務啟停都會通知。常駐程式另以約 15 秒週期處理告警，並保存處理游標；首次啟用不會把所有舊錯誤一次重播。Telegram 本身故障時，仍須看本機事件與服務日誌；告警不是保證送達的監控系統。

<a id="mentions"></a>
## ID 映射（@提及）

X 貼文 tag 的 `@帳號` 到了 Bluesky／Sharkey／Telegram 不一定存在同名帳號（X 的 `@alice` 與 Bluesky 的 `@alice.bsky.social` 是不同人），照原樣送出就變成「沒有此用戶」。現在的行為：

- **只有 X 頁面上真的是帳號連結的提及**才會被處理：必須是貼文本體內、顯示文字與連結路徑一致的個人頁連結。純文字裡的 `@某人`、看起來像個人頁的其他路徑（`x.com/alice/status/…`）、引用推文裡的提及都**不算**。
- **沒有映射** → 換成該帳號的 X 個人頁連結（`https://x.com/帳號`），其他平台不會再把它當成自己站上的帳號。
- **有映射** → 換成該平台的 ID：Bluesky 用完整 handle（`alice.bsky.social`）、Sharkey 用 `@alice` 或 `@alice@dvd.chat`、Telegram 用 `@alice_tg`。Bluesky 在發布前會先 `resolveHandle` 換成 DID 並寫入 facet，才是真正的提及。

只有**你自己用指令建立**的映射才會生效；工具不會拿同名帳號去猜測。

### 用 Telegram 管理

跟 bot 私聊送出指令（需 `TELEGRAM_POLL_COMMANDS=true` 且 `live`，只接受 `TELEGRAM_OWNER_ID`）：

| 指令 | 作用 |
|---|---|
| `/map <X_ID>` | 查看這個 X ID 目前的映射 |
| `/map <X_ID> bluesky=alice.bsky.social sharkey=@alice@dvd.chat telegram=@alice_tg` | 設定或更新；可只填其中一個平台，未填的平台保持原值 |
| `/map <X_ID> telegram=-` | 清除單一平台（`-` 表示移除），其餘平台不動 |
| `/maps` | 列出全部映射 |
| `/unmap <X_ID>` | 刪除這個 X ID 的所有映射（回到 X 連結） |

`X_ID` 可寫 `@Alice` 或 `alice`，不分大小寫。指令會先驗證格式再寫入，失敗時回應原因且不改動任何映射。Telegram 的映射是公開的 `@username`，與 `TELEGRAM_OWNER_ID`／chat ID 那組數字權限無關。

兩點要留意：

- **映射只影響之後的發布。** 已經有送出紀錄的工作會沿用開始時的版本，不會因為改設定而重送或漏送；改完之後的新貼文才生效。
- **格式驗證不等於帳號存在。** 工具只檢查形狀（Bluesky 要完整網域、Sharkey 是 `user@host`、Telegram 是 5–32 字元的 `@username`），不會查證那個帳號是不是對方本人。

映射存在 `DATA_DIR/crosspost.sqlite` 的 settings，跟著資料庫一起備份。

<a id="timing"></a>
## 時間與限制（6 個）

這些值由你選擇，不需要到平台取得。時間均以秒計，bytes 採十進位位元組。

| 設定鍵 | 預設值 | 作用、格式與限制 | 如何選擇 |
|---|---|---|---|
| `POLL_SECONDS` | `120` | 常駐收集／worker 週期，整數 **30–86400**。固定間隔，不是保證有隨機抖動的排程。 | 保守低頻開始；週期過長可能造成讀取積壓。它不改變 Telegram 的獨立長輪詢。 |
| `THREAD_WINDOW_SECONDS` | `600` | 從 X root **發布時間**起算的固定自串文窗口，整數 **30–3600**。後續回覆不會延長窗口。 | 依自己通常完成串文所需時間調整，不是允許無限追加舊推文。 |
| `THREAD_SETTLE_SECONDS` | `180` | 窗口結束與 root 首次收集時間兩者中較晚者，再加的等待時間，整數 **30–1800**。 | 保留緩衝以等待可收集的後續內容。不是從最後一則回覆重新計時。 |
| `SOURCE_FRESHNESS_SECONDS` | `300` | 封存批次時，所需來源最近一次成功掃描最多可早於**本輪收集開始**幾秒，整數 **30–3600**；X 掃描還必須不早於串文窗口結束。本輪掃成功的來源一律算新鮮，不受掃描耗時影響。 | 只影響本輪漏掃（失敗）的來源：超過此值就先不封存。批次超過預定封存時間 30 分鐘仍卡住時，會發一次 Telegram 錯誤通知，可用 `/approve <id>` 直接發布。 |
| `MAX_ATTEMPTS` | `5` | **可確認安全重試**的暫時錯誤，自動嘗試上限（含首次），整數 **1–20**。不是所有失敗都會自動重试，也不是 unknown 的豁免。 | 保持保守值；會遵循 `retry_after` 與退避。手動重試前先確認錯誤已排除。 |
| `MAX_DOWNLOAD_BYTES` | `20000000` | 每個媒體輸入／下載大小上限，整數 **1000–100000000**；本機圖片檔也受此限制。不是每批總大小，也不是所有 API 的回應上限。 | 配合可用記憶體與合理圖片大小；提高它不會啟用影片，也不改變圖片輸出上限。 |

正常新 root 的預設最早封存時間約為「root 發布後 600 + 180 秒」，仍須等到實際輪詢及來源新鮮度合格。若很晚才第一次讀到該 root，至少再等 180 秒。`once` 不會駐留等待窗口结束；需要之後再執行，或用 `serve` 常駐。

固定而非 env 的限制包括：每篇最多 4 張靜態圖、每張輸出最多 **2000000 bytes**、圖片解碼最多 4000 萬像素、pending mirror 初始有效期 72 小時、Telegram session 上傳上限 256 KiB。Bluesky／Sharkey collector 目前各最多讀 3 頁、每頁最多 100 筆；沒有對應 env 可調整。

<a id="video"></a>
## 選用影片轉碼（3 個）

| 設定鍵 | 預設值 | 作用、格式與限制 | 如何取得／選擇 |
|---|---|---|---|
| `VIDEO_ENABLED` | `false` | 設 true 後，解析得到可下載來源的影片會轉成 MP4，再交給下游 publisher；同一則推文可以像 X 一樣混合圖片與影片（合計最多 4 個）。開啟時每則含影片的推文會多打一次 `cdn.syndication.twimg.com`（公開嵌入端點）取 MP4 與完整媒體順序。GIF 在 X 上本身就是 MP4，照影片流程同步：Bluesky 以 GIF 呈現（`presentation: gif`）、Telegram 單獨一個時用 `sendAnimation`（相簿裡則當影片）、Sharkey 上傳 MP4。只有 HLS 沒有 MP4、超過 140 秒的影片仍保留。 | 只在已安裝 FFmpeg、確認帳戶限制後啟用；不保證所有平台帳戶都能接受。 |
| `FFMPEG_PATH` | `ffmpeg` | 轉碼程式名（由 `PATH` 搜尋）或執行檔路徑；不是 shell 命令或額外參數欄位。 | 從系統套件管理器安裝 FFmpeg，確認包含 H.264／AAC 編碼器。 |
| `FFPROBE_PATH` | `ffprobe` | 探測影片資訊的程式名或執行檔路徑。一般文字與靜態圖片同步不會呼叫。 | 通常隨 FFmpeg 套件提供；自行確認實際安裝路徑。 |

影片管線已接入 Engine 與 Bluesky／Sharkey／Telegram。圖片與影片混合的推文照原順序發布：Telegram 合成一個相簿、Sharkey 放在同一則 note；Bluesky 一則貼文只能放圖片或一支影片，所以連續的圖片共用一則、每支影片各占一則，依序接成串文（各組依序放在內文分段的每一則上，內文只有一則時，其餘各組以只有媒體的回覆接在後面）。輸入必須是可下載的自含媒體檔，或位於 `DATA_DIR/media` 內的本機檔案，並受 `MAX_DOWNLOAD_BYTES` 限制；不接受播放清單另開網路或其他本機檔案。輸出保留比例、最長邊不超過 1280、30 fps、H.264／AAC、最長 140 秒。Bluesky 使用專用影片服務。

X 的影片來源由公開嵌入端點 `cdn.syndication.twimg.com/tweet-result` 解析：X 自己的播放器串 `blob:` 的 HLS，頁面裡沒有可下載的 URL，該端點則會回傳同一則推文的漸進式 MP4 各畫質版本。含影片的推文整份媒體清單（圖片、影片與順序、替代文字）都以該端點為準。程式挑「估算大小仍塞得進 `MAX_DOWNLOAD_BYTES` 的最高 bitrate」——X 最高給到 4K（單支可達數百 MB），而管線無論如何都會重新編碼到最長邊 1280，取最大版本只是白花下載預算。這個端點未公開文件化，行為可能隨時改變；解析不到任何 MP4 時（推文已刪、受保護、回應格式改變、或只有 HLS）影片就照舊保留為 `x_video_has_no_downloadable_source`，不會誤發。保留理由另有 `video_exceeds_duration_limit`（超過 140 秒，在下載前就判定）。GIF 的 MP4 只有一個版本、沒有時長資訊，下載後轉碼時才檢查長度。真實平台配額與上傳能力需另行驗證。

<a id="credentials"></a>
## 官方憑證與帳號資料取得

以下是**由帳戶擁有人自行操作**的設定指引，不需要把主密碼、token、cookie、session 或完整 API 回應貼到聊天、issue、終端指令參數或截圖中。

### X

- 不需要 X developer token，本程式沒有 X 發文 API。
- 在 `X_HANDLE` 填自己的帳號；安裝瀏覽器後使用 `login` 開啟 X 官方登入頁，由你完成帳密與兩步驟驗證。
- 這不是自動填寫密碼或代替你發文；程式設定也沒有 X 主密碼欄位。
- [X 自動化規則](https://help.x.com/en/rules-and-policies/x-automation) 對非 API 網站自動化有限制；唯讀與低頻都不代表沒有停權風險。

### Bluesky

1. 登入 [Bluesky 官方 App](https://bsky.app/)，到設定中的 **App passwords／應用程式密碼**；也可直接開 [官方入口](https://bsky.app/settings/app-passwords)。選單位置可能隨版本調整。
2. 建立一組專供本工具使用的 app password，名稱可用 `crosspost-bridge`。不需要為本工具啟用私訊存取。
3. 將它保存在密碼管理器及私密 `.env` 的 `BLUESKY_APP_PASSWORD`；不要填 Bluesky 主密碼。
4. `BLUESKY_IDENTIFIER` 填同一帳戶的完整 handle（例如 `your-handle.bsky.social`，這只是佔位示例）或 DID；使用 email 時請核對 bootstrap 服務。
5. 若懷疑外洩，在官方 App 撤銷這組 app password、建立新的並重新啟動服務，不必把其他用途的密碼一併共用。

### Sharkey

1. 登入**自己所屬實例**，在設定尋找 **API／存取權杖（Access token）**，新增本工具專用權杖；介面名稱依版本而異。以實例提供的 API 說明與 [Sharkey 官方文件](https://docs.joinsharkey.org/) 為準。
2. 對需要發布文字與圖片的用途，授予 `write:notes`、`write:drive`；預設啟用的 Drive 資料夾另需 `read:drive`。若不授予讀取權，將 `SHARKEY_DRIVE_FOLDER` 設為空字串。不要直接開所有權限。
3. 建議填自己的 `SHARKEY_USERNAME`；若要用 ID，透過實例官方 API console 的 `users/show`，以自己的本機 username、`host: null` 查詢，取回應的 `id`。不要把整份回應公開。
4. 若 `SHARKEY_USER_ID` 與 `SHARKEY_USERNAME` 都留空，程式改用 `/api/i` 探索自己的帳戶，權杖還需 `read:account`。這是額外權限，不是填 username 後仍必需的權限。
5. `SHARKEY_URL` 設為同一實例，token 與識別值也必須是同一帳戶。更換實例／帳戶應按 [維運方式](#maintenance) 使用新的狀態目錄，避免混淆既有對映。

### Telegram bot、owner ID 與三種 chat ID

1. 在 Telegram 開啟經核對的 [官方 `@BotFather`](https://t.me/BotFather)，用 `/newbot` 建立專用 bot，依指示命名。將取得的 token 保存在私密設定中；若外洩，用 BotFather 撤銷／重新產生 token。
2. 使用你自己的 Telegram 帳號與新 bot **私人聊天**，送出 `/start`。Bot 不能無緣無故先向從未啟動對話的使用者發私訊。
3. 若需要對外頻道，把 bot 加入**自己的對應頻道**並授予發文的最小必要權限。自動錯誤告警仍走私人聊天；不要把私人 session 檔傳到頻道。
4. 由本機受信任、可遮蔽秘密且不記錄完整請求的 API 用戶端，呼叫官方 Bot API 的 **`getUpdates`**。Token 從私密設定／secret 欄位載入，在記憶體中組合請求；**不要把含 token 的完整 URL 放到 `curl` 參數、shell history、瀏覽器網址列或雲端 API 測試器**。本文件不提供會把 token 暴露在命令列的範例。
5. 取得 ID 時先停用本工具及其他 `getUpdates` 輪詢者，避免消耗或競爭更新。官方 API 接收哪些事件受 `allowed_updates` 影響；用於設定時可要求 `message`、`channel_post`、`my_chat_member`，再自行發一則新的私人／頻道測試訊息。程式日常命令輪詢只收 `message` 與 `callback_query`，不應拿它的結果當成所有頻道資料。
6. 只在自己的本機查看必要 JSON 欄位，不公開整份回應：

   | JSON 欄位 | 設定用途 |
   |---|---|
   | 私人對話的 `result[].message.from.id` | `TELEGRAM_OWNER_ID`，是你的 user ID，不是 bot ID。 |
   | 同一訊息的 `result[].message.chat.id` | `TELEGRAM_PRIVATE_CHAT_ID`；同時核對 `chat.type` 為 `private`。 |
   | 頻道更新的 `result[].channel_post.chat.id` | 對應頻道的 `TELEGRAM_OPS_CHAT_ID` 或 `TELEGRAM_PUBLIC_CHAT_ID`；核對 `chat.title`／`chat.type` 後再填。 |
   | Bot 被加入時的 `result[].my_chat_member.chat.id` | 另一種核對頻道 ID 的來源；不要只看名稱猜 ID。 |

7. 空的 `result` 不表示 ID 是 0，可能是尚無新事件、已被另一輪詢者消耗，或 `allowed_updates` 不包含該事件。若 bot 已使用 webhook，`getUpdates` 不會並行運作；先確認既有服務用途，不要擅自移除其他服務的 webhook。最簡單的隔離方式是為本工具新建專用 bot。
8. 填妥後，只有正式環境需要互動管理時才設 `APP_MODE=live`、`TELEGRAM_POLL_COMMANDS=true`。若只要私聊／ops 通知，命令輪詢可以保持 false。

官方參考：[建立 bot](https://core.telegram.org/bots/tutorial)、[getUpdates 與 Update 結構](https://core.telegram.org/bots/api#getupdates)、[Bot FAQ](https://core.telegram.org/bots/faq)。頻道 ID、owner ID 不應交由不明的「查 ID bot」代查；即使 ID 本身不是密碼，完整更新可能含私人內容。

<a id="x-session"></a>
## X 登入與 session 安全

**工具只讀 X，不代表 session 憑證本身是唯讀的。** 被竊取的 cookie／profile 可能讓他人取得帳戶控制權。把它們視為密碼，勿放入版本控制、公開雲端連結、日誌、工單或未加密備份。

### 本機首次登入

先停止使用相同 `DATA_DIR`／`X_PROFILE_DIR` 的服務與瀏覽器，設定自己的 `X_HANDLE`、`X_ENABLED=true`，再於有桌面的電腦執行：

```bash
npm run cli -- login
npm run cli -- export-session
```

`login` 會開可見視窗，由你完成 X 登入與兩步驟驗證，回終端按 Enter 後保存 profile。匯出寫到 `X_SESSION_FILE`，包含本工具的 `crosspost-x-session` 格式；不是把日常 Chrome profile 當檔案傳走。預設目錄為 `DATA_DIR/x-profile`，匯出檔为 `DATA_DIR/x-session.json`。

### 無桌面伺服器：優先使用 SSH 傳輸

1. 在可信的本機登入並匯出；用經主機金鑰驗證的 SSH／SFTP／SCP 將檔案送到伺服器的私密暫存位置。
2. 將檔案安裝到**服務使用者可讀、其他人不可讀**的 `X_SESSION_FILE`。通常檔案權限為 `0600`、父目錄為 `0700`，並核對所有者。不要為了讓服務讀取而改成全員可讀。
3. 停止使用該 profile 的服務，以服務使用者及**同一份設定、同一工作目錄**執行 `node dist/cli.js import-session`，避免不小心寫入另一套 `data`。systemd 的實際命令見 [部署文件](../deploy/README.md)。
4. 匯入會開無頭瀏覽器連到 X 驗證，不是離線操作，也不發布貼文。完成後再啟動常駐服務。
5. 移除不再需要的本機／伺服器暫存副本；session 到期、被撤銷或要求驗證時重新登入匯出。不要假設一次登入永久有效。

不建議直接跨作業系統複製整個 Chrome／Edge profile：其中可能有其他網站資料、鎖定檔與依賴系統金鑰的內容。本工具的專用 session 匯出／匯入比較容易控制傳輸範圍。

### 選用：Telegram `/session`

只有 `live` + `TELEGRAM_ENABLED=true` + `TELEGRAM_POLL_COMMANDS=true`、正確 owner/private chat 及啟用 X 時才使用。可先傳 `/session` 再上傳匯出 JSON，或直接在該文件的 caption 寫 `/session`。**單純丟一份文件不會自動安装。**

程式會驗證格式與大小，並嘗試刪除上傳的訊息；若權限、網路或 Telegram 政策導致刪除失敗，需你手動刪除。刪除訊息不等於能保證第三方從未取得副本。Telegram 伺服器與持有 bot token 者可能接觸此登入檔；如果不能接受這個取捨，請使用 SSH，不要透過 bot 傳送。

<a id="docker"></a>
## Docker 部署

[Dockerfile](../Dockerfile) 使用 Node 24、內建 Chromium，以非 root `bridge` 使用者執行；[Compose](../docker-compose.yml) 將主機 `./data` 掛載到容器 `/app/data`，主機端連接埠限制在 loopback。這與 systemd 的專用 `crosspost` 使用者是兩種不同部署方式，不要混用資料目錄。

1. 在受保護的專案目錄建立 `.env`，保持 `APP_MODE=preview`。容器內的服務需讓埠映射可達，將**容器用設定**的 `HOST` 設為 `0.0.0.0`，並產生至少 32 字元的 `WEB_TOKEN`。主機端仍維持 Compose 的 `127.0.0.1:3000:3000`，不要改成公開埠。
2. Compose 會覆寫 `DATA_DIR=/app/data`、`X_BROWSER=auto`、`CHROMIUM_PATH=/usr/bin/chromium`。`X_PROFILE_DIR` 與 `X_SESSION_FILE` 留空即可跟隨資料目錄；不要填主機的 macOS／Windows 路徑。
3. 先建立主機 bind mount 的私密資料目錄，讓映像內 UID/GID `10001` 可寫入。不要對既有資料盲目 `chmod 777` 或啟用 root。若要更改 `PORT`，也需自行保持映射／健康檢查一致。
4. 啟動與看日誌：

   ```bash
   docker compose up -d --build
   docker compose logs -f bridge
   ```

5. 有疑問先停止 `bridge`。執行 `doctor`／`import-session` 等一次性命令時，使用相同 volume 與設定，且不要與常駐程式同時操作它。
6. 不要同時讓主機版程式與容器處理同一資料庫、同一 X profile 或同一 bot。若 Chromium 報 sandbox／核心功能受限，先核對宿主環境與服務權限，不要直接關閉所有隔離保護。

Web 介面可透過 SSH 通道存取，例如將本機埠轉送到伺服器 `127.0.0.1:3000`。`WEB_TOKEN` 仍不保護所有 GET 路由，不能取代防火牆、SSH 或代理層認證。

<a id="maintenance"></a>
## 備份、還原與更新

### 需要保存什麼

- `DATA_DIR/crosspost.sqlite`：來源基準、批次、mirror、已送出步驟、提醒決策、ID 映射及 Telegram 游標；這是防止重複發布的關鍵，不是可任意清空的快取。
- 整個 `DATA_DIR/media`、`X_PROFILE_DIR`、仍需要保留的 `X_SESSION_FILE`；若路徑移出 `DATA_DIR`，要另外納入。
- `.env` 或服務的環境檔，與當時程式版本、`package-lock.json`、部署設定的識別資訊。憑證檔和 session 的備份必須加密並限制讀取。

### 安全備份

1. 停止排程與服務，讓進行中的工作／瀏覽器結束；確認沒有另一個 CLI／容器操作相同目錄。
2. 在完全停止後備份整個狀態目錄。SQLite 使用 WAL；若 `crosspost.sqlite-wal`／`crosspost.sqlite-shm` 仍存在，**不可只複製主檔便丟棄其餘狀態**。需要線上備份時應使用 SQLite 支援的 backup API，而不是一般檔案複製。
3. 驗證備份可解密、檔案權限正確，再移到非公開的保存位置；不要把設定或資料目錄塞進公開發行包。

### 還原

1. 停止所有會發文的實例，先把設定改成 `preview`；還原到空的私密目錄，不要把不同時間的資料庫／WAL 混在一起。
2. 還原一致的資料、所需 session 及環境設定，確認 Node／程式版本與目錄所有者。移機後瀏覽器路徑需重新核對。
3. 先用 `doctor`、`status` 檢視設定與狀態；不要立刻執行 `once`／`serve`。如要試跑收集，使用另存的 preview 副本，避免模擬工作污染要恢复的正式狀態。
4. **舊備份可能缺少之後已經發到平台的紀錄。** 在恢復 live 前，人工核對遠端貼文與未完成工作；清空資料庫、還原舊狀態或重送「unknown」都可能造成重複內容。
5. 只有核對完成後才改回 live 並啟動一個正式實例。不要在沒有對帳能力時直接手改 SQLite 把 `unknown` 變成 `pending`。

### 更新與回退

1. 停止服務、備份狀態與私密設定，保存目前可用版本；更新程式碼時不要覆蓋 `.env` 或資料。
2. 安裝與驗證：

   ```bash
   npm ci
   npm run verify
   ```

   `verify` 已包含型別檢查、測試及 `npm run build`。若是在只有 production dependencies 的執行環境，應於獨立建置環境安裝開發相依後完成驗證，不能以缺少測試工具當成驗證通過。
3. 比對新版 `.env.example`／本設定表，**逐項補入**新設定，不要複製整份範例蓋掉現有秘密。檢查 `doctor`，再啟動服務。
4. systemd 的安裝／更新／日誌命令見 [部署文件](../deploy/README.md)；Docker 以新版重新建置映像，但不要刪除資料 bind mount。
5. 回退程式版本前確認資料庫格式相容；若必須回復舊備份，重新依還原流程對帳。舊狀態不是安全的「撤銷發布」。

更換 X／Bluesky／Sharkey 帳戶、Telegram bot／目的頻道時，不要沿用不相容的來源基準與外送對映。先停機、備份與處理未完成工作，再為新設定建立新的私密狀態目錄。程式發現來源帳戶識別改變時會拒絕繼續，不應繞過該檢查。

<a id="troubleshooting"></a>
## 故障排除

| 現象 | 先檢查與安全處理 |
|---|---|
| 設定載入即失敗 | 核對布林／整數格式、範圍、`DESTINATIONS` 拼字、對應 enabled、X handle、非 loopback 的 token 長度與 Telegram 數字 ID；空值不一定代表預設。 |
| `doctor` 正常但沒有任何貼文 | Doctor 不是帳密／發文能力的連線測試。檢查 enabled、必要憑證、destination 與事件；首次完整快照只建基準、不補發舊貼文。 |
| preview 工作顯示 `succeeded` 卻沒在平台看到 | 這是模擬結果，不是遠端送達。使用獨立 live 資料目錄及新基準，不要自動重播 preview 工作。 |
| 同步後的 `@帳號` 在別的平台變成「沒有此用戶」 | 這是被 tag 的人沒有對應帳號。用 `/map <X_ID> <平台>=<ID>` 建立映射（見 [ID 映射](#mentions)）；未映射的提及應該呈現為 X 個人頁連結，若沒有 link 請回報。 |
| X 找不到瀏覽器／profile 被鎖 | 核對執行檔、CPU 架構、目錄所有者；停止使用相同 profile 的程式。`npm ci` 不會下載 Chromium。 |
| Linux root 或服務環境無法啟動 sandbox | 改用專用非 root 使用者，檢查系統支援與部署文件。`X_SANDBOX` 的自動預設見設定表；不要先關閉 sandbox 當万能解法。 |
| X 出現登入牆、challenge、零推文或解析失敗 | 在本機自行重新驗證，匯出新 session 後安全匯入；不要自動繞過驗證。也可能是 X 前端改版，保留檢查點並查看錯誤。 |
| `Incomplete snapshot`／backlog 超出預算 | 結構性失敗不推進檢查點。X 若提供已解析的最舊時間，會推進至該時間並警告可能漏掉更早内容；可在上限內調整 `X_MAX_PAGES`。B/S 超出頁數仍保留檢查點。不要清空狀態來隱藏缺口。 |
| X 批次停在 `open` | 檢查窗口、settle 時間與來源新鮮度。從未成功觀察的來源仍會阻止封存；下游連續失敗三次後可使用舊鏡像資料並記警告，X 本身的新鮮度不放寬。 |
| 批次或工作停在 `review` | 先看原因；疑似鏡像或長文要人工決定，非公開／不完整或不支援媒體不能用 approve 強行放行。敏感標記本身不再保留；無其他問題時會帶警告同步。 |
| 短貼文一直被判 `possible_manual_mirror` 要人工審核 | 只有仍在 72 小時窗內、且尚未配對的下游原生貼文才是鏡像候選；基準快照掃進來的下游歷史不算（舊資料庫啟動時會自動清掉並記一筆事件）。文字完全相同且正規化後 ≥20 **UTF-8 位元組**（約 7 個中文字或 20 個英文字母）就直接判定鏡像；更短的（如「早安」）才問你，避免把巧合當成鏡像而靜默吞掉新貼文。 |
| 401／403／Sharkey `read:account` 不足 | 核對同帳戶的憑證與實例；Sharkey 優先填自己的 username 或 user ID，若採 `/api/i` 才另外需要 read scope。不要把 token 或完整回應貼到 issue。 |
| Telegram 不回指令／按鈕沒反應 | 需 live、enabled、token、`TELEGRAM_POLL_COMMANDS=true`，且 owner/private chat 都正確；先 `/start`，檢查是否另有 poller／webhook。preview 不會回應。 |
| Telegram 沒有告警 | 需 live 及可用 Telegram 設定；自動告警一律送 private chat。只轉送新 `error` 事件，並非所有訊息；pollCommands=false 仍可發告警。 |
| Telegram 私聊可用，但對外頻道沒內容 | 確認 `DESTINATIONS` 含 `telegram`、public chat 數字 ID 正確及 bot 可發文。只設 enabled 或 public chat 不會建立對外發布工作。 |
| `/session` 被拒絕 | 核對 owner/private chat、live、輪詢、X enabled、明確的 `/session` 指令／caption、本工具匯出格式與 256 KiB 上限；勿反覆把登入檔傳到其他 chat。 |
| `unknown` 或送出後連線中斷 | 先人工確認遠端是否已有內容並處理對帳。`/retry`、`/resync`、CLI retry 都不是強制重送 unknown 的後門，不能靠重啟解決。 |
| 429／暫時失敗 | 已確認安全重試的工作會按伺服器延遲／退避處理，至 `MAX_ATTEMPTS` 上限；不要密集手動重試。送出結果不明則另走對帳。 |
| 影片／GIF／超過四個附件不發布 | 圖片、影片與 GIF 合計最多四個，可混合。影片與 GIF 需 `VIDEO_ENABLED=true`、FFmpeg，且嵌入端點解析得到每一個的 MP4；任何一個解析不到、只有 HLS 或超過 140 秒，整則都會保留，理由寫在事件與網頁的貼文列表裡。 |
| 想知道某則為什麼沒同步 | 看網頁介面的「最近讀到的貼文」，每則都列出分類與原因；`self_reply_outside_new_batch` 若伴隨 `never collected` 的 warn 事件，代表上一則沒被收集到（可提高 `X_MAX_PAGES` 或縮短 `POLL_SECONDS`）。 |
| 外部 URL 被拒絕 | API／媒體通道會拒絕私有、loopback、保留／metadata 位址、不允許的埠與不安全重導向。先核對服務 URL，不要停用防護或嵌入帳密。 |
| Web 寫入回 401 | 設 token 後須在 UI 填入相同值；未設 token 的 loopback 仍要求 JSON／同來源。不要為了方便把服務直接公開。 |
| 已有服務時 CLI 回報資料目錄正在使用 | 這是避免兩個 worker／recovery 同時改寫狀態的保護。用現有 Web／Telegram 介面，或停止服務後再執行維護命令；不要刪鎖硬闖。 |

對 API 與圖片下載，程式提供公開位址驗證、DNS 位址固定、重新導向、大小與逾時限制。**不要把這描述成所有瀏覽器流量都經過同一個 HTTP 通道**；X 瀏覽器另有來源網域／讀取方法限制，仍應使用隔離的服務使用者及合理的系統網路防護。

問題回報只提供版本、作業系統／架構、已遮蔽的錯誤與必要狀態；**不要附上 `.env`、SQLite、完整 Telegram 更新、session 或瀏覽器 profile**。自動遮蔽不保證涵蓋每種秘密，分享前仍需人工檢查。
