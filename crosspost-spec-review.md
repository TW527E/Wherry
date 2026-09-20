# Twitter/X、Sharkey（dvd.chat）、Bluesky 跨平台同步方案 — 規格審核稿

| 項目 | 內容 |
|---|---|
| 文件名稱 | 跨平台同步規格審核稿 |
| 版本 | v1.0 |
| 查核基準日 | 2026-09-16 |
| 查核方式 | 官方文件、官方/上游原始碼、公開實例 API 與 NodeInfo、live 頁面 |
| 目前狀態 | **已審核完畢（2026-09-19）；決策與需求見 [crosspost-decisions.md](crosspost-decisions.md)（目前 v1.2）；尚未開始任何實作** |
| 目標平台 | X（x.com）、Sharkey（dvd.chat）、Bluesky（bsky.app） |

---

## 0. 給審核者的導讀

這份文件分成三個層次，建議依序看：

1. **第 1 節：決策摘要** — 你只需要先看這一節，就能決定專案方向。所有需要你拍板的問題都集中在這裡。
2. **第 2–5 節：事實查核** — 三個平台的實際限制與證據。若你要驗證我的說法，看這幾節。
3. **第 6–8 節：技術方案與風險** — 建議的技術棧、架構、風險與未知項目。這是等到第 1 節決策完成後才需要細看的內容。

### 標記說明

整份文件使用以下標記區分事實的可靠程度。**強烈建議只把 ✅ 的內容寫進程式，⚠️ 與 ❓ 一律做成執行時檢查。**

| 標記 | 意義 |
|---|---|
| ✅ 已確認 | 直接來自現行官方文件、官方 Lexicon 或公開實例 API，可作為硬性規格 |
| ⚠️ 有條件 | 官方資料本身有矛盾、或數值取決於帳號等級／實例設定，需抽成可設定參數 |
| ❓ 未公開 | 官方沒有公布可靠數值，或本次查核無法取得，需保留錯誤處理 |
| 📌 建議 | 我的實作建議，不是平台規定，你可以否決 |

---

## 1. 決策摘要（請先看這一節）

### 1.1 一句話總結

> **Bluesky 與 dvd.chat 都適合用官方 API 做自動同步；X 的無頭瀏覽器方案在技術上可行，但違反 X 官方自動化規則，且官方明文寫會導致永久停權。因此不建議把 X 無頭瀏覽器當成正式同步通道。**

### 1.2 三個平台的可行性判定

| 平台 | 建議做法 | 官方 API 成本 | 風險等級 |
|---|---|---|---|
| Bluesky（官方） | ✅ 官方 API + AT Protocol SDK | 免費 | 低 |
| dvd.chat（Sharkey） | ✅ 官方 HTTP API + Bearer Token | 免費（實例提供） | 低～中（需查實例 TOS） |
| X（x.com） | ⚠️ 官方 API，或人工確認 | 付費（你已表明不想用） | 低（官方 API）／**高（無頭瀏覽器）** |

### 1.3 需要你決定的 5 件事

#### 決策 1：X 通道要怎麼辦？

這是**唯一會阻擋實作**的決策。三個選項：

| 選項 | 說明 | 代價 |
|---|---|---|
| **A. X 改用官方 API** | 付費，但合規、穩定、不會被停權 | 需要 X API 費用 |
| **B. X 只做人工確認** | 工具產生好內容與媒體，你手動貼上並按 Post | X 端無法全自動，但零風險 |
| **C. 仍要做無頭瀏覽器** | 技術上能做，但違反 X 自動化規則 | 主要帳號可能永久停權 |

> 📌 **我的建議：B，之後視需求再評估 A。**
>
> 理由：C 的風險不是「可能失敗」而是「明確違規」。X 官方文件寫的是 `may result in the permanent suspension of your account`（可能導致你的帳號被永久停權），不是「不保證成功」等級的措辭。若這個 X 帳號本身有價值，不建議拿它賭。

#### 決策 2：媒體不相容時怎麼處理？

當同一篇內容要發到三個平台，但某個平台不接受某個附件時：

| 選項 | 行為 |
|---|---|
| **A. 整批拒發** | 只要有一個平台不支援，就完全不發 |
| **B. 只發可接受的平台** | 該平台跳過，其他平台照常發（建議） |
| **C. 降級成外部連結** | 把不支援的媒體放到圖床／雲端，貼連結代替 |
| **D. 自動轉碼或拆多篇** | 轉成平台可接受的格式，或拆成串文 |

> 📌 **我的建議：B 為主，影片類才啟用 D。**
> 純文字貼文不該因為影片限制而全部卡住；但影片若超過某平台限制，轉碼是合理的自動處理。

#### 決策 3：第一版支援範圍

| 範圍 | 內容 |
|---|---|
| **建議第一版** | 純文字 + 最多 4 張靜態圖片（JPEG/PNG，每張 ≤ 2 MB） |
| **第二階段** | 影片（需轉碼管線）、GIF／動畫、Quote、串文 |
| **不建議做** | Poll 跨平台同步、純音訊、X Premium 長文、平台特有 visibility |

理由：第一版的「共通安全區」只有純文字與 4 張小圖。影片牽涉三個平台各自的轉碼、時長、大小與每日配額，適合獨立做一個階段。

#### 決策 4：同步方向與架構

| 選項 | 說明 |
|---|---|
| **A. 本地內容為唯一來源**（建議） | 內容先進本地資料庫，再由適配器發到三個平台 |
| **B. 三平台互相監聽轉發** | 任一平台發布都會觸發其他平台 |

> 📌 **我的建議：A。**
> B 會產生同步回圈、重複貼文、編輯衝突與來源不明等問題，且難以判斷「這篇是我發的還是轉來的」。A 的架構下每次同步都有明確的 `canonical_post_id`，可以安全地做冪等與重試。

#### 決策 5：失敗策略

當平台 A 成功、平台 B 失敗時：

- 是否仍讓平台 C 發布？ → 📌 建議：是，各自獨立
- 是否允許人工修改某一平台的文字再發？ → 📌 建議：允許，且記錄差異
- 是否允許平台專屬的 hashtag、CW、alt text？ → 📌 建議：允許，存在 `platform_variants`

---

## 2. X（x.com）限制

### 2.1 文字

| 項目 | 數值 | 標記 | 來源 |
|---|---|---|---|
| 一般帳號網頁貼文 | 280 個加權字元 | ✅ | [X How to Post](https://help.x.com/en/using-x/how-to-post) |
| Premium 長文 | 25,000 字元（僅 Premium 可建立，所有人可閱讀） | ✅ | 同上 |
| 媒體是否佔用字數 | 不佔用 | ✅ | 同上 |

### 2.2 字元加權規則（重要）

X 不是單純計算 Unicode 字元數：

| 內容類型 | 計數 |
|---|---|
| 一般拉丁字母、標點、常見符號 | 1 |
| Emoji | 2 |
| CJK（中日韓）字元 | 2 |
| 其他 Unicode 預設 | 2 |
| 有效 URL | **一律 23 個字元**（經 t.co 縮短規則） |
| 回覆開頭自動帶入的 @mention | 0 |
| 手動加入的 mention | 依一般規則計算 |
| Hashtag | 依一般規則計算 |

> ⚠️ 這是 X 開發者文件的計數規則，網頁端介面很可能使用相同規則，但官方沒有明文保證。
> 來源：[X Counting Characters](https://docs.x.com/fundamentals/counting-characters)

### 2.3 媒體組合

官方文件**互相矛盾**，這點必須知道：

| 來源 | 說法 |
|---|---|
| 網頁發文說明 | 最多 4 張照片、1 個 GIF，或 1 支影片 |
| 圖片／GIF 說明頁 | 網頁可選 1–4 張照片；**動畫 GIF 不能與多張圖片同時存在**；一篇只能 1 個 GIF |
| 行動版通用文字 | 出現「2 張照片、1 個 GIF、1 支影片」的混合例子 |
| 影片時間戳說明 | 提到「影片加圖片」的貼文 |

> 📌 **建議採最保守規則：`1–4 張圖片` 或 `1 個 GIF` 或 `1 支影片`，三者不混用。**

| 組合 | 判定 | 標記 |
|---|---|---|
| 1–4 張圖片 | 支援 | ✅ |
| 1 個 GIF | 支援（網頁 15 MB） | ✅ |
| 1 支影片 | 支援 | ✅ |
| 圖片 + 影片 | **不應依賴** | ⚠️ |
| 圖片 + 動畫 GIF | **明確受限** | ✅ |

來源：[X Photos and GIFs](https://help.x.com/en/using-x/posting-gifs-and-pictures)

### 2.4 圖片與 GIF

| 項目 | 數值 | 標記 |
|---|---|---|
| 圖片最大 | 5 MB | ✅ |
| 動畫 GIF 最大（網頁） | 15 MB | ✅ |
| 動畫 GIF 最大（行動） | 5 MB | ✅ |
| 接受格式（網頁） | GIF、JPEG、PNG | ✅ |
| 不接受 | BMP、TIFF、其他 | ✅ |
| WEBP | 僅列於 API 文件，**不能推論網頁端支援** | ⚠️ |
| 網頁端 alt text 上限 | **官方未提供明確值** | ❓ |

API 文件另有 GIF 建議值（非硬性）：解析度 ≤ 1280×1080、≤ 350 frames、≤ 3 億像素、≤ 15 MB。

### 2.5 影片

#### 網頁端（適用於瀏覽器情境）

| 項目 | 非 Premium | Premium | 標記 |
|---|---|---|---|
| 最長時長 | 140 秒 | < 4 小時（> 2 小時且 < 4 小時時為 720p） | ✅ |
| 最大檔案 | 512 MB | 16 GB | ✅ |
| 最小解析度 | 32 × 32 | 同左 | ✅ |
| 最大解析度 | 1920 × 1200 或 1200 × 1900 | 同左 | ✅ |
| 長寬比 | 1:2.39 ～ 2.39:1 | 同左 | ✅ |
| 最大幀率 | 40 fps | 同左 | ✅ |
| 最大 bitrate | 25 Mbps | 同左 | ✅ |
| Codec／container／audio 規格 | **網頁文件未公開** | — | ❓ |

> ⚠️ **官方文件本身矛盾**：X Premium 功能頁寫「約 3 小時、8 GB」，影片專頁寫「< 4 小時、16 GB」。建議以影片專頁為準，但程式仍需容忍伺服器端拒絕。

#### API 端（與網頁端不同，僅供對照）

| 項目 | 數值 |
|---|---|
| 一般帳號貼文影片 | 20 分鐘 / 8 GB |
| Premium 或 verified | 125 分鐘 / 16 GB |
| 最短時長 | 0.5 秒 |
| 建議 codec | H.264 High Profile |
| Audio | AAC-LC |
| Pixel format | YUV 4:2:0 |
| 幀率（API 上限） | 60 fps |
| 尺寸（API） | 32×32 ～ 1280×1024 |
| 長寬比（API） | 1:3 ～ 3:1 |

來源：[X Video Best Practices](https://docs.x.com/x-api/media/quickstart/best-practices)

### 2.6 速率限制

| 情境 | 限制 | 標記 |
|---|---|---|
| 網頁端發文 | **無公開數值** | ❓ |
| API `POST /2/tweets` | 每使用者 100 次／15 分鐘；每 app 10,000 次／24 小時 | ✅ |

> ⚠️ API 的 100/15min **不可**套用到網頁端。X 對網頁帳號另有未公開的風控與行為限制。

### 2.7 自動化政策（本案最關鍵）

X 官方 Automation Rules 原文：

> "Use non-API-based forms of automation, such as scripting the X website. The use of these techniques may result in the permanent suspension of your account."

同份規則另禁止或限制：

- 腳本操作 X 網站
- 繞過或濫用速率限制
- 重複或實質相似的內容（單一帳號或多帳號）
- 未經同意自動 mention／reply
- 自動按讚、自動隱藏回覆
- 大量或侵略性的 follow／unfollow
- 未經書面批准的 AI 自動回覆機器人

X 現行 ToS 另禁止：未經書面許可的 scraping、繞過技術限制、以未公布方式自動存取、干擾服務的內容建立腳本、規避安全或驗證控制。

| 判定 | 標記 |
|---|---|
| 無頭瀏覽器技術上可登入、選檔、輸入、按 Post | ✅ |
| 這是 X 官方不允許的自動發布方式 | ✅ |
| 可能導致永久停權 | ✅ |

來源：[X Automation Rules](https://help.x.com/en/rules-and-policies/x-automation)、[X Terms of Service](https://x.com/en/tos)、[X Developer Guidelines](https://docs.x.com/developer-guidelines)

---

## 3. Sharkey / dvd.chat 限制

### 3.1 實例基本資訊

| 項目 | 值 | 標記 |
|---|---|---|
| 軟體 | Sharkey | ✅ |
| 版本 | `2025.4.7` | ✅ |
| 上游儲存庫 | `https://github.com/DDVD233/sharkey`（實例採用的 fork，stable 分支） | ✅ |
| 官方上游 | `https://activitypub.software/TransFem-org/Sharkey` | ✅ |
| 註冊 | 開放，但需 email、啟用 Turnstile | ✅ |
| 本地時間軸／全球時間軸 | 皆啟用 | ✅ |

來源：[dvd.chat NodeInfo](https://dvd.chat/nodeinfo/2.1)、[dvd.chat api.json](https://dvd.chat/api.json)

> ⚠️ **可驗證性限制**：NodeInfo 與 `/api/meta` 能證明「版本號」與「公開設定」，但無法證明實際部署的 commit。以下數值屬於「查核當下的公開設定」，站方隨時可調整。

### 3.2 文字與內容欄位

| 項目 | 數值 | 標記 |
|---|---|---|
| 本地貼文文字上限 | 3,000 | ✅ |
| CW（內容警告）上限 | 500 | ✅ |
| alt text 上限 | 20,000 | ✅ |
| 遠端貼文文字上限（轉入） | 100,000 | ✅ |
| 遠端 CW 上限 | 5,000 | ✅ |
| 遠端 alt text 上限 | 100,000 | ✅ |

> ⚠️ 原始碼比對方式是 JavaScript `string.length`。這代表**以 UTF-16 code unit 計算**，不是 byte 也不是 grapheme。Emoji 等代理對會算 2。

### 3.3 可見性與旗標

| 參數 | 值 | 說明 |
|---|---|---|
| `visibility` | `public`（預設）／`home`／`followers`／`specified` | ✅ |
| `visibleUserIds` | 搭配 `specified` 使用 | ✅ |
| `localOnly` | 獨立布林旗標，預設 `false` | ✅ |
| `canPublicNote` | `true` | ✅ |
| `isSensitive`（媒體） | 在上傳時設定，預設 `false` | ✅ |
| `cw` | 與敏感標記分開處理 | ✅ |

### 3.4 附件數量與混合

| 項目 | 值 | 標記 |
|---|---|---|
| 單篇附件上限 | **16 個**（`fileIds` / `mediaIds`） | ✅ |
| 是否允許媒體類型混合 | **原始碼沒有 MIME 同質性檢查**，圖片／影片／音訊理論上可混 | ✅ |
| 每次 multipart 上傳檔案數 | **1 個**（parser 設 `files: 1`） | ✅ |
| `fileIds` 與 `mediaIds` 併用 | `fileIds` 優先，**不會合併** | ✅ |

> 📌 實作方式：先逐一上傳檔案取得 file ID，再將多個 ID 一次傳給 `notes/create`。

### 3.5 檔案大小（關鍵區別）

這裡有兩個不同層級的限制，實務上要取較小者：

| 層級 | 數值 | 標記 |
|---|---|---|
| 全域 multipart parser 硬上限 | **262,144,000 bytes（約 250 MiB）** | ✅ |
| 角色政策欄位 `maxFileSizeMb` | 公開 meta 顯示 `1000` | ⚠️ |
| 每人儲存配額 `driveCapacityMb` | `200000` MiB | ⚠️ |
| Sharkey 上游預設角色政策 | 25 MB / 100 MiB | ✅ |

> ⚠️ **重要**：`maxFileSizeMb: 1000` 是角色政策值，**不代表**能突破全域 parser 的 250 MiB。而且角色政策可依帳號角色調降。
>
> 📌 建議描述為：「全域硬上限約 250 MiB；實際可用上限取『全域上限、角色政策、反向代理限制』三者最小值。」

> ⚠️ 高流量角色或站方自訂角色可能被調降，程式應在上傳失敗時明確回報實際錯誤碼（`MAX_FILE_SIZE_EXCEEDED`、`NO_FREE_SPACE`）。

### 3.6 媒體格式

**可被瀏覽器直接呈現的類型**（`FILE_TYPE_BROWSERSAFE`）：

| 類別 | 格式 |
|---|---|
| 圖片 | PNG、GIF、JPEG、WebP、AVIF、APNG、BMP、TIFF |
| 影片 | OGG、QuickTime/MOV、MP4、M4V、3GPP、3GPP2、MPEG、WebM |
| 音訊 | Opus、OGG、MP4 audio、M4A、MPEG audio、WebM、AAC、FLAC、WAV |

**其他行為**：

| 行為 | 說明 | 標記 |
|---|---|---|
| MIME 判定 | 使用 magic-byte `file-type` 偵測，**不是**客戶端宣稱的 Content-Type | ✅ |
| 上傳端 MIME 白名單 | **沒有**，未知格式會存成 `application/octet-stream` | ✅ |
| SVG | 可被偵測但**刻意排除**於瀏覽器安全清單（XSS 考量） | ✅ |
| `image/x-icon` | 列在 `FILE_TYPE_IMAGE`，但**不在** browser-safe 清單 | ✅ |
| 圖片尺寸 | 單邊 > 16,383 px 會被降級為 octet-stream（**不是拒絕上傳**） | ✅ |
| 動畫偵測 | `pages > 1` 判定為動畫，略過 webpublic 轉換，生成動畫 WebP 縮圖 | ✅ |
| 動畫上限 | **沒有找到 frame count 或動畫時長限制** | ❓ |
| 影片時長上限 | **原始碼沒有硬性限制** | ❓ |
| 影片 codec 要求 | 未找到硬性限制；僅對 MP4/M4A/M4V/MOV 做 faststart 最佳化 | ❓ |

> 📌 因為沒有找到影片時長與 codec 限制，程式**不能假設無限**。應在 `notes/create` 與上傳階段都保留錯誤處理，並在文件中標記為「未公開」。

### 3.7 貼文關係（回覆／轉貼／引用）

| 功能 | 參數 | 備註 | 標記 |
|---|---|---|---|
| 回覆 | `replyId` | 不可回覆純轉貼；回覆 `specified` 對象時自己也須用 `specified` | ✅ |
| 純轉貼 | `renoteId`（不含文字／檔案／投票） | 不可轉貼 `specified`／他人的 `followers` 貼文；不可轉貼純轉貼 | ✅ |
| 引用 | `renoteId` **加上**引用內容 | **此版本沒有獨立的 `quoteId` 參數** | ✅ |
| 引用限制 | 使用者若設 `rejectQuotes` 會回 `QUOTE_DISABLED_FOR_USER` | 公開 meta 無法查詢他人設定 | ⚠️ |

### 3.8 投票

| 項目 | 值 | 標記 |
|---|---|---|
| 選項數 | 2 ～ 10 | ✅ |
| 每選項長度 | ≤ 150 字元 | ✅ |
| 多重選 | `multiple` 布林 | ✅ |
| 到期 | `expiresAt` 或 `expiredAfter`（≥ 1） | ✅ |
| 最長投票期間 | **未找到上限** | ❓ |
| 可否與檔案並存 | schema 允許 | ✅ |

### 3.9 速率限制

Sharkey 使用 leaky bucket，並依角色調整（`rateLimitFactor`，dvd.chat 目前為 `1`，表示採原始值）。

| 端點 | 限制 | 標記 |
|---|---|---|
| `/notes/create` | 300 / 小時，最小間隔 1 秒 | ✅ |
| `/drive/files/create` | 1,200 / 小時 | ✅ |
| `/drive/files/upload-from-url` | 60 / 小時 | ✅ |
| `/meta` | 3 / 秒 | ✅ |
| `/notes/show` | 2 / 秒 | ✅ |
| 未特別宣告的端點 | 預設 10 / 秒 | ✅ |

回應標頭：`X-RateLimit-Remaining`、`X-RateLimit-Clear`；被阻擋時另有 `Retry-After`、`X-RateLimit-Reset` 與 HTTP 429。

### 3.10 認證與發文流程

```
1. POST /api/app/create
   { name, description, permission: ["write:drive", "write:notes"], callbackUrl }
   → 取得 app secret

2. POST /api/auth/session/generate  { appSecret }
   → 取得 { token, url }，使用者於瀏覽器授權

3. POST /api/auth/session/userkey   { appSecret, token }
   → 取得 { accessToken, user }

4. POST /api/drive/files/create     （multipart，一次一個檔案）
   → 取得 DriveFile（含 id）

5. POST /api/notes/create
   { text, cw, visibility, fileIds: [...], poll, replyId, renoteId }
   → { createdNote }
```

認證方式：`Authorization: Bearer <token>` 或 body 欄位 `i`。Token 權限需包含 `write:drive`（上傳）與 `write:notes`（發文）。

> 📌 實例也支援 MiAuth（`features.miauth: true`），但 `/api/miauth/gen-token` 被標記為 internal，第三方整合建議走標準 app 流程。

### 3.11 未解的實例政策問題

| 項目 | 狀態 |
|---|---|
| dvd.chat 的 bot／大量發文／跨平台轉貼條款 | ❓ 頁面存在但本次未能可靠擷取 |
| 是否有跨平台同步的特別限制 | ❓ |

> 📌 **建議**：若同步量不大（個人帳號、低頻率），風險可控；若要做高頻或大量跨帳號同步，應先向站方確認。不要假設「Sharkey 上游開源 = 實例站方允許」。

---

## 4. Bluesky（官方）限制

### 4.1 核心原則：協議 vs 產品

Bluesky 的限制分成兩層，混用會出錯：

| 層級 | 說明 | 是否跨網路通用 |
|---|---|---|
| **Protocol（Lexicon）** | AT Protocol 的 schema 限制 | ✅ 是，所有 PDS 都需遵守 |
| **Product（bsky.app）** | Bluesky 官方 app 與官方服務的行為 | ❌ 否，其他客戶端／PDS 可不同 |

### 4.2 文字

| 項目 | 數值 | 標記 |
|---|---|---|
| `text` 最大長度 | **3,000 UTF-8 bytes** | ✅ |
| `text` 最大 grapheme | **300** | ✅ |
| 兩者關係 | **同時成立**，需同時滿足 | ✅ |
| 有 embed 時可否空字串 | 可以 | ✅ |
| `langs` | 最多 3 個 | ✅ |
| `tags` | 最多 8 個，每個 ≤ 640 bytes / 64 graphemes | ✅ |

> ⚠️ `maxLength` 是 **UTF-8 bytes**，不是 JavaScript 字串長度，也不是可見字元數。中日韓與 emoji 會佔多個 byte。
> ⚠️ `maxGraphemes` 是 Unicode grapheme cluster，接近「肉眼可見字元數」。

### 4.3 Facet（連結、mention、hashtag）

| 項目 | 規則 | 標記 |
|---|---|---|
| 索引單位 | **zero-based UTF-8 byte offset** | ✅ |
| 邊界 | `byteStart` 含、`byteEnd` 不含 | ✅ |
| 是否可重疊 | **不可重疊** | ✅ |
| mention | 存 **DID**，不是 handle | ✅ |
| link | 存**完整 URI**，即使顯示文字被縮短 | ✅ |
| tag | 存不含 `#` 的標籤 | ✅ |
| 解析失敗 | handle 解析失敗時，官方建議省略該 facet（會以純文字呈現） | ✅ |

> ⚠️ JavaScript 的 UTF-16 索引**不能**直接當作 facet 的 byte offset，必須先轉 UTF-8。

### 4.4 圖片

| 項目 | 數值 | 標記 |
|---|---|---|
| 傳統圖片 embed 張數 | **最多 4 張** | ✅ |
| Gallery（新）schema 上限 | 20 | ✅ |
| Gallery 目前 UI 建議上限 | **10**（Lexicon 明說是 future-proof ceiling） | ✅ |
| 每張圖片 blob 大小 | **2,000,000 bytes**（2 MB） | ✅ |
| 圖片 MIME | `image/*`（通配，Lexicon 未細分） | ✅ |
| `alt` 欄位 | **必填**（schema 要求，但無長度上限） | ✅ |
| `aspectRatio` | 傳統 images 可省略；gallery **必填** | ✅ |
| 協議圖片尺寸上限 | **無** | ✅ |

> ⚠️ **官方文件不同步**：部分舊教學頁仍寫 1,000,000 bytes。現行 Lexicon 描述為「May be up to 2 MB, formerly limited to 1 MB」，**以 2,000,000 bytes 為準**。

**bsky.app 產品層行為**（非協議）：

| 行為 | 值 |
|---|---|
| 最大邊長 | 4,000 px |
| 輸出大小 | 2,000,000 bytes |
| 常見輸出格式 | JPEG |
| alt text UI 上限 | 2,000 graphemes |

### 4.5 影片

| 項目 | 數值 | 標記 |
|---|---|---|
| 協議 MIME | **僅 `video/mp4`** | ✅ |
| 協議大小上限 | **300,000,000 bytes**（300 MB） | ✅ |
| 每篇影片數 | 1 | ✅ |
| 協議時長上限 | **無** | ✅ |
| 協議解析度／幀率／codec／audio 要求 | **無** | ✅ |
| 字幕軌數 | 最多 20 | ✅ |
| 字幕格式 | `text/vtt`，每檔 ≤ 20,000 bytes | ✅ |
| 字幕語言 | 每軌需 BCP-47 `lang` | ✅ |
| 影片 `alt` | 選填，無長度限制 | ✅ |
| `presentation` | `default` / `gif`（僅呈現提示，非格式契約） | ✅ |

**bsky.app 產品層行為**：

| 行為 | 值 |
|---|---|
| 最長時長 | 10 分鐘 |
| 最大檔案 | 300 MB |
| 接受的輸入格式 | MP4、MPEG、WebM、QuickTime/MOV、image/gif |
| 壓縮目標 | 最長邊 1,920 px、3 Mbps、30 fps |
| 前端字幕軌 | 僅 1 軌（協議允許 20） |

**Bluesky 託管帳號限制**：

| 項目 | 值 | 標記 |
|---|---|---|
| 上傳影片前需 email 驗證 | 是 | ✅ |
| 每日影片數量／容量 | **動態**，需呼叫 `app.bsky.video.getUploadLimits` | ✅ |
| 一般 PDS `uploadBlob` 上限 | 52,428,800 bytes（50 MB） | ✅ |

> ⚠️ **重要區別**：協議允許 300 MB 影片，但**一般 PDS 的通用上傳只有 50 MB**。大於 50 MB 的影片必須走 Bluesky 專用影片服務（它會代為上傳到 PDS）。第三方 PDS 可能拒絕大型 blob。

### 4.6 GIF 行為（容易誤解的一項）

Bluesky **沒有**原生的 GIF embed 類型。實際有兩條路徑：

| 來源 | 實際序列化結果 |
|---|---|
| GIF 選擇器（貼圖庫） | `app.bsky.embed.external` 外部卡片（含 URI、標題、說明、可選縮圖） |
| 上傳本地動畫 GIF | 走**影片管線**，最終為 `app.bsky.embed.video` 並標記 `presentation: "gif"` |
| 靜態 GIF | 當作一般圖片處理 |

> 📌 底層 blob **仍必須是 `video/mp4`**。不要嘗試把 GIF blob 直接當作 video embed 提交。

### 4.7 Embed 組合（結構性限制）

一篇貼文只有**一個**頂層 `embed`：

```
images | video | gallery | external | record | recordWithMedia
```

| 組合 | 結果 | 標記 |
|---|---|---|
| 圖片 + 影片 | **不支援** | ✅ |
| 圖片 + 連結卡片 | **不支援**（同一層只能選一個） | ✅ |
| 引用 + 媒體 | ✅ 支援，用 `recordWithMedia` | ✅ |
| 引用 + 圖片 | ✅ 支援 | ✅ |
| 引用 + 連結卡片 | ✅ 支援 | ✅ |
| 超過 4 張圖片 | 用 gallery（≤ 10） | ✅ |

### 4.8 引用、回覆、串文

| 項目 | 規則 | 標記 |
|---|---|---|
| 引用 | `app.bsky.embed.record` + strongRef（URI + CID） | ✅ |
| 回覆 | 需同時提供 `root` 與 `parent` strongRef | ✅ |
| 串文 | 就是一連串 post record，**協議無長度上限** | ✅ |
| 批次發布 | 官方 app 使用 `com.atproto.repo.applyWrites`，每篇一個 CREATE | ✅ |

> ⚠️ `applyWrites` 內每個 record 操作都會**分別計入**寫入配額。

### 4.9 投票

| 項目 | 結果 | 標記 |
|---|---|---|
| 現行 `app.bsky.feed.post` 是否有 poll 欄位 | **沒有** | ✅ |
| 官方 Lexicon 是否有 poll 型別 | **沒有找到** | ✅ |
| 官方文件是否有 poll API | **沒有** | ✅ |

> 📌 **Bluesky 目前沒有原生投票功能**。第三方用連結或卡片實作的方式不在協議內。因此**不要**規劃把 dvd.chat 或 X 的投票同步到 Bluesky。

### 4.10 速率限制（Bluesky 官方服務）

**Repository 寫入配額（每帳號）**：

| 項目 | 值 |
|---|---|
| 每小時 | 5,000 points |
| 每日 | 35,000 points |
| CREATE | 3 points |
| UPDATE | 2 points |
| DELETE | 1 point |
| 推導上限（純 create） | 1,666 / 小時、11,666 / 日 |

**HTTP 限制**：

| 端點 | 限制 |
|---|---|
| 全部端點 | 3,000 次 / IP / 5 分鐘 |
| `createSession` | 30 / 帳號 / 5 分鐘；300 / 日 |
| `createAccount` | 100 / IP / 5 分鐘 |
| `updateHandle` | 10 / 帳號 / 5 分鐘；50 / 日 |

**回應標頭**：`RateLimit-Limit`、`RateLimit-Reset`、`RateLimit-Remaining`、`RateLimit-Policy`；超限時 `Retry-After` + HTTP 429。

> ⚠️ 這些是 **Bluesky 官方服務**的限制。第三方 PDS 可能不同。

### 4.11 上傳流程

**圖片／一般 blob（簡單）**：

```
1. 登入帳號所屬 PDS
2. POST /xrpc/com.atproto.repo.uploadBlob（raw bytes，正確 Content-Type）
3. 取得 { blob }
4. 放入 embed
5. createRecord 或 applyWrites
```

**影片（官方建議）**：

```
1. 取得 service auth token
   - audience = 帳號的 PDS
   - lxm = com.atproto.repo.uploadBlob
   - 約 30 分鐘有效期
2. POST https://video.bsky.app/xrpc/app.bsky.video.uploadVideo
3. 輪詢 app.bsky.video.getJobStatus 直到取得 BlobRef
4. 使用 BlobRef 建立貼文
```

**目前官方 app 使用的 multipart 流程**（較新，建議採用）：

```
1. getUploadLimits              → canUpload / remainingDailyVideos / remainingDailyBytes
2. 取得 service auth token
3. startUpload { sizeBytes, mimeType, name, [duration,width,height 為 advisory] }
   → { jobId, partSizeBytes, partCount, expiresAt }
4. 逐一分片上傳（1-indexed，application/octet-stream，Content-Length 必須精確）
5. finishUpload
6. 輪詢狀態直到完成
7. 使用 BlobRef 建立貼文
```

`startUpload` 可能回傳的錯誤：`UnsupportedContentType`、`VideoTooLarge`、`VideoTooLong`、`BadAspectRatio`、`DailyLimitExceeded`、`TooManyOpenUploads`、`UploadForbidden`、`ServiceOverloaded`。

> ⚠️ 傳入的 duration/width/height 只是 advisory（用於提早失敗），真正的驗證在非同步處理階段。

來源：[Bluesky Uploading Video](https://bsky.network/docs/about-bluesky-content/video/)、[Bluesky Rate Limits](https://bsky.network/docs/rate-limits)、[atproto Lexicons](https://github.com/bluesky-social/atproto/tree/main/lexicons/app/bsky)

---

## 5. 跨平台相容矩陣

### 5.1 文字

| 項目 | X | dvd.chat | Bluesky |
|---|---|---|---|
| 一般上限 | 280 加權字元 | 3,000（UTF-16 code unit） | 300 graphemes + 3,000 UTF-8 bytes |
| URL 計數 | 一律 23 | 一般處理 | 不適用（用 facet） |
| Emoji／CJK | 通常算 2 | `string.length` | bytes + graphemes 雙重限制 |
| 長文 | Premium 25,000 | 無 | 無 |
| CW | 無此概念 | 500 | 用 self-label |

### 5.2 媒體

| 媒體組合 | X | dvd.chat | Bluesky | 共通安全區 |
|---|---|---|---|---|
| 1–4 張圖片 | ✅ | ✅ | ✅ | ✅ **可用** |
| 5–10 張圖片 | ❌ | ✅ | ✅（gallery） | ❌ |
| 1 支影片 | ✅ | ✅ | ✅ | ✅ **可用**（需轉碼） |
| 1 個 GIF | ✅ | ✅ | ⚠️ 轉影片或外部卡片 | ⚠️ |
| 圖片 + 影片 | ⚠️ 不應依賴 | ✅ | ❌ | ❌ |
| 圖片 + GIF | ⚠️ 受限 | ✅ | ❌ | ❌ |
| 音訊 | ❌ | ✅ | ❌ | ❌ |
| 投票 | ✅ | ✅ | ❌ | ❌ |
| 引用 + 媒體 | ⚠️ | ✅ | ✅ | ⚠️ |

### 5.3 格式

| 類別 | X | dvd.chat | Bluesky |
|---|---|---|---|
| 圖片格式 | GIF / JPEG / PNG（網頁）；WEBP 僅 API | PNG/GIF/JPEG/WebP/AVIF/APNG/BMP/TIFF | `image/*` |
| 圖片大小 | 5 MB（GIF 15 MB） | 受 250 MiB 全域限制，無個別圖片限制 | **2 MB** |
| 影片格式 | 網頁未公開；API 建議 H.264 | MP4/MOV/M4V/OGG/3GPP/MPEG/WebM 等 | **僅 MP4** |
| 影片大小 | 512 MB / 16 GB（依訂閱） | 250 MiB | 300 MB（協議）／50 MB（一般 PDS） |
| 影片時長 | 140 秒 / 4 小時 | 未公開 | 協議無限制；官方 app 10 分鐘 |

### 5.4 最保守的共同規格（建議第一版 profile）

```
文字：
  - 先以 X 一般帳號的 280 加權字元為上限
  - 再檢查 Bluesky 的 300 graphemes 與 3,000 UTF-8 bytes
  - 三個平台各自重新解析 URL、mention、hashtag

圖片：
  - 最多 4 張
  - 每張 ≤ 2,000,000 bytes
  - 統一轉為 JPEG 或 PNG

影片（第二階段）：
  - MP4 / H.264 / AAC-LC / YUV 4:2:0
  - 30 fps
  - 16:9、9:16 或 1:1
  - 最長 140 秒（對齊一般 X 帳號）
  - ≤ 250 MiB（對齊 dvd.chat 全域硬上限）
  - 若走一般 PDS uploadBlob，需 ≤ 50 MB；否則使用 Bluesky 影片服務

不做：
  - 圖片與影片混合
  - 純音訊
  - 原生投票跨平台
  - 超過 4 張圖片
  - X Premium 長文
```

> ⚠️ 這是**建議的轉碼與預檢 profile**，不是三個平台共同公布的官方規格。X 網頁端未公開完整 codec 要求，仍需保留上傳失敗處理。

---

## 6. 建議技術棧

### 6.1 核心

| 元件 | 選擇 | 理由 |
|---|---|---|
| 語言 | **TypeScript + Node.js** | 三個平台都有成熟官方／社群 SDK |
| 資料庫 | **PostgreSQL** | 需要關聯式結構保存貼文映射與狀態 |
| 佇列 | **Redis + BullMQ** | 需要延遲、重試、速率控制與冪等 |
| 圖片處理 | **Sharp** | 尺寸、格式、壓縮、EXIF 清除 |
| 影片處理 | **FFmpeg / FFprobe** | 檢查、轉碼、取得長寬與時長 |
| 容器化 | **Docker Compose** | 本機即可部署，之後易於搬遷 |

### 6.2 各平台 SDK

| 平台 | 方式 |
|---|---|
| Bluesky | `@atproto/api`（官方 SDK） |
| dvd.chat | 原生 HTTP（`fetch` / `undici`），端點簡單且 schema 公開 |
| X | 官方 API SDK，或**不實作自動化**（決策 1） |

### 6.3 為什麼不建議用現成的跨平台發文服務

- 難以控制各平台媒體轉碼細節
- 無法自訂失敗與重試策略
- 無法保存 canonical 來源與平台映射
- 對 X 的政策風險無法自行決定

---

## 7. 建議架構

### 7.1 核心資料模型

```
canonical_posts
  id                  UUID
  source              -- 來源平台或 local
  source_post_id      -- 來源貼文 ID
  text                -- 原始文字
  content_warning
  created_at

attachments
  id
  canonical_post_id
  local_path          -- 原始檔
  mime_type
  size_bytes
  width / height / duration_ms
  content_hash        -- 用於去重

platform_variants
  id
  canonical_post_id
  platform            -- x / sharkey / bluesky
  text                -- 平台專屬文字
  attachments_json    -- 平台專屬附件設定
  visibility
  status              -- pending / uploading / published / failed / skipped
  remote_post_id
  remote_url
  error_code
  error_message
  published_at

sync_jobs
  id
  canonical_post_id
  platform
  attempt
  scheduled_at
  idempotency_key
```

### 7.2 同步流程

```
1. 建立 canonical post（本地）
2. 為每個平台產生 platform_variant
3. 對每個 variant 做限制預檢（見 7.3）
4. 上傳媒體到各平台，取得 media ID / blob
5. 建立貼文
6. 保存 remote_post_id / remote_url
7. 失敗時只重試該平台
8. 以 canonical_post_id 阻止回音與重複發布
```

### 7.3 預檢清單（每個平台各自執行）

**X**（若採用官方 API 或人工確認）
- [ ] 加權字元數 ≤ 280（或帳號等級對應值）
- [ ] 附件為 1–4 張圖片，或 1 GIF，或 1 影片
- [ ] 圖片 ≤ 5 MB、格式為 GIF/JPEG/PNG
- [ ] 影片符合帳號等級的時長與大小

**dvd.chat**
- [ ] 文字長度 ≤ 3,000（注意是 UTF-16 code unit）
- [ ] CW ≤ 500
- [ ] 每個檔案 ≤ 250 MiB 且帳號仍有儲存空間
- [ ] 附件數 ≤ 16
- [ ] 每個檔案單獨上傳
- [ ] 遵守 300/小時、最小間隔 1 秒

**Bluesky**
- [ ] 文字 ≤ 300 graphemes **且** ≤ 3,000 UTF-8 bytes
- [ ] facet 的 byte offset 正確且不重疊
- [ ] 圖片 ≤ 4 張（或 gallery ≤ 10），每張 ≤ 2 MB
- [ ] 每張圖片都有 `alt`（必填）
- [ ] 影片為 MP4 且 ≤ 300 MB
- [ ] 影片上傳前呼叫 `getUploadLimits` 確認 `canUpload`
- [ ] 帳號已完成 email 驗證（上傳影片需要）

### 7.4 第一版實作順序建議

```
Phase 1：Bluesky + dvd.chat，純文字
Phase 2：加上最多 4 張靜態圖片
Phase 3：影片（轉碼管線 + Bluesky 影片服務）
Phase 4：Quote、串文、GIF
Phase 5：（視決策 1）X 官方 API，或維持人工確認
```

---

## 8. 風險與未解項目

### 8.1 已識別風險

| 風險 | 等級 | 說明 | 緩解方式 |
|---|---|---|---|
| X 帳號停權 | **高** | 無頭瀏覽器違反 X 自動化規則 | 決策 1 選 A 或 B |
| X 網頁 DOM 變動 | 高 | 前端改版會讓腳本失效 | 若做無頭，需多層定位與告警 |
| dvd.chat 實例政策變更 | 中 | 站方可隨時調整限制或關閉 | 啟動時重新讀取 `/api/meta` |
| dvd.chat 角色政策調降 | 中 | 個別帳號可用上限可能更低 | 保留 413 錯誤處理 |
| Bluesky 每日影片配額 | 中 | 動態且未公開 | 上傳前呼叫 `getUploadLimits` |
| 三方 TOS 對跨平台轉貼的認定 | 中 | 尤其 dvd.chat 條款未確認 | 低頻率使用；必要時詢問站方 |
| X 文件矛盾 | 低 | 媒體組合與影片上限有兩套說法 | 採最保守值 |
| Bluesky 文件過時 | 低 | 舊頁面仍寫 1 MB 圖片 | 以現行 Lexicon 為準 |

### 8.2 明確的未知項目

以下項目**沒有**可靠公開值，程式中必須以錯誤處理而非假設來面對：

| 項目 | 狀態 |
|---|---|
| X 網頁端發文速率限制 | ❓ 無公開數值 |
| X 網頁端完整 codec／container 要求 | ❓ 未公開 |
| X 網頁端 alt text 上限 | ❓ 未公開 |
| dvd.chat 影片時長上限 | ❓ 原始碼無限制，實例未知 |
| dvd.chat 影片 codec 要求 | ❓ 未找到 |
| dvd.chat GIF frame／動畫時長上限 | ❓ 未找到 |
| dvd.chat bot／跨平台轉貼條款 | ❓ 未能可靠擷取 |
| dvd.chat 實際可用上傳上限（角色層級） | ❓ 需實測 |
| Bluesky 每日影片數量／容量具體數字 | ❓ 動態，需查詢 |
| Bluesky 影片後端 codec／解析度／fps 限制 | ❓ 未公開 |
| Bluesky 串文長度硬上限 | ❓ 協議無限制，PDS 請求大小有影響 |

### 8.3 建議的驗證實驗（實作前或早期）

若你決定要降低未知項目的風險，這幾個實驗成本低、資訊量大：

| 實驗 | 目的 |
|---|---|
| 在 dvd.chat 上傳一支超過 100 MB 的影片 | 確認實際可用上傳上限與是否被角色政策攔截 |
| 在 dvd.chat 發一篇混合圖片與影片的貼文 | 確認混合媒體是否真的正常呈現 |
| 用非 Premium X 帳號在網頁端試上傳不同容器格式 | 縮小 X 網頁端可接受格式範圍 |
| 查 dvd.chat 完整 TOS 頁面 | 確認 bot 與跨平台轉貼條款 |
| 呼叫 Bluesky `getUploadLimits` | 取得你帳號目前的每日影片配額 |

---

## 9. 待你確認的問題清單

請直接在這份文件上回覆，或逐項回覆：

| # | 問題 | 選項 | 你的決定 |
|---|---|---|---|
| 1 | X 通道怎麼做？ | A 官方 API / B 人工確認 / C 無頭瀏覽器 | |
| 2 | 媒體不相容時？ | A 拒發 / B 只發可接受平台 / C 降級連結 / D 轉碼拆文 | |
| 3 | 第一版範圍？ | 文字+4圖 / 加上影片 / 加上 GIF / 其他 | |
| 4 | 同步方向？ | A 本地為唯一來源 / B 三平台互相同步 | |
| 5 | A 平台失敗時 B、C 是否照發？ | 是 / 否 | |
| 6 | 是否允許平台專屬文字調整？ | 是 / 否 | |
| 7 | 部署環境？ | 本機 / VPS / NAS / 其他 | |
| 8 | 是否要做排程發文？ | 是 / 否 / 僅本地排程 | |
| 9 | 需要雙向同步嗎？ | 只從本地發 / 也要從平台抓回 | |
| 10 | 是否需要 Web UI？ | CLI / Web UI / 兩者 | |

---

## 10. 附錄：來源清單

### X

- [X How to Post](https://help.x.com/en/using-x/how-to-post)
- [X Photos and GIFs](https://help.x.com/en/using-x/posting-gifs-and-pictures)
- [X Videos](https://help.x.com/en/using-x/x-videos)
- [X Premium](https://help.x.com/en/using-x/x-premium)
- [X Automation Rules](https://help.x.com/en/rules-and-policies/x-automation)
- [X Terms of Service](https://x.com/en/tos)
- [X Developer Guidelines](https://docs.x.com/developer-guidelines)
- [X Counting Characters](https://docs.x.com/fundamentals/counting-characters)
- [X API Media Best Practices](https://docs.x.com/x-api/media/quickstart/best-practices)
- [X API Chunked Upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked)
- [X API Rate Limits](https://docs.x.com/x-api/fundamentals/rate-limits)
- [X API Create Post](https://docs.x.com/x-api/posts/create-post)

### Sharkey / dvd.chat

- [dvd.chat NodeInfo 2.1](https://dvd.chat/nodeinfo/2.1)
- [dvd.chat API Schema](https://dvd.chat/api.json)
- [dvd.chat API 說明頁](https://dvd.chat/api-doc)
- [dvd.chat TOS](https://dvd.chat/@dvd/pages/TOS)
- [實例 fork 儲存庫](https://github.com/DDVD233/sharkey)
- [Sharkey 上游儲存庫](https://activitypub.software/TransFem-org/Sharkey)
- [Sharkey 文件](https://docs.joinsharkey.org/)

引用原始碼檔案（stable 分支）：

- `packages/backend/src/config.ts`
- `packages/backend/src/const.ts`
- `packages/backend/src/core/FileInfoService.ts`
- `packages/backend/src/core/DriveService.ts`
- `packages/backend/src/core/VideoProcessingService.ts`
- `packages/backend/src/core/RoleService.ts`
- `packages/backend/src/server/api/endpoints/notes/create.ts`
- `packages/backend/src/server/api/endpoints/drive/files/create.ts`
- `packages/backend/src/server/api/ApiCallService.ts`

### Bluesky / AT Protocol

- [Bluesky Uploading Video](https://bsky.network/docs/about-bluesky-content/video/)
- [Bluesky Posts in-depth](https://bsky.network/docs/about-bluesky-content/posts/)
- [Bluesky Rate Limits](https://bsky.network/docs/rate-limits)
- [AT Protocol Lexicon 規格](https://atproto.com/specs/lexicon)
- [Blob Lifecycle](https://atproto.com/guides/blob-lifecycle)
- [Video Handling Guide](https://atproto.com/guides/video-handling)
- [Identity Guide](https://atproto.com/guides/identity)
- [OAuth Guide](https://atproto.com/guides/about-oauth)
- [XRPC 規格](https://atproto.com/specs/xrpc)

現行 Lexicon：

- `app.bsky.feed.post`
- `app.bsky.embed.images`
- `app.bsky.embed.gallery`
- `app.bsky.embed.video`
- `app.bsky.embed.external`
- `app.bsky.embed.record`
- `app.bsky.embed.recordWithMedia`
- `app.bsky.richtext.facet`
- `app.bsky.video.*`
- `com.atproto.repo.uploadBlob`
- `com.atproto.repo.createRecord`
- `com.atproto.repo.applyWrites`

---

## 11. 文件變更記錄

| 版本 | 日期 | 變更 |
|---|---|---|
| v1.0 | 2026-09-16 | 初版，完成三平台限制查核與方案建議 |

---

> **狀態更新（2026-09-19）**：第 9 節問題清單已回覆完畢，決策與後續需求整理於 [crosspost-decisions.md](crosspost-decisions.md)（v1.2）。本文件保留為平台限制的查核基線。
