# 跨平台同步 — 決策與需求規格

| 項目 | 內容 |
|---|---|
| 文件名稱 | 決策與需求規格（審核稿 v1.3） |
| 日期 | 2026-09-19 |
| 前置文件 | [crosspost-spec-review.md](crosspost-spec-review.md)（平台限制查核，2026-09-16 基準） |
| 狀態 | **Phase 1 已實作完成並通過測試（見 [README.md](README.md)）；預設 preview 模式，未對任何帳號發布內容** |
| 平台 | X（主發文平台）、Bluesky、Sharkey（dvd.chat）、Telegram（新增） |

---

## 0. 給審核者的導讀

這份文件記錄 2026-09-19 討論定案的需求與決策，是我之後實作時的唯一依據。

- **第 1 節**：整體資料流，一張圖看懂誰自動、誰手動。
- **第 2 節**：決策對照表，你回覆的每個選項與我的解讀。
- **第 3 節**：目前只保留真正會影響第一版行為的待定參數；X 發文的主要通道已按你的描述定為手動。
- **第 4–8 節**：核心流程、Telegram 整合、連結處理、媒體規格。
- **第 9–11 節**：部署、安全、目前瀏覽器登入狀態的定位。
- **第 12–14 節**：階段計畫、開放問題與變更記錄。

---

## 1. 角色與資料流總覽

```
                    ┌────────────────────────────┐
                    │   使用者主要在 X 發文        │
                    └────────────┬───────────────┘
                                 │ 發文（含幾乎同時的串文）
                                 ▼
                    ┌────────────────────────────┐
                    │  同步工具：X 監聽           │
                    │  （無頭瀏覽器，登入 session）│
                    └────────────┬───────────────┘
              過濾規則（見 §5.3）│只放行：主推文 + 同一窗口內的自串文
                                 ▼
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
  Bluesky（API）          dvd.chat（API）          Telegram 對外頻道
  同步內容                同步內容                  同步內容（串文以回覆上層發送）
  +結尾多一則串文          +結尾多一則串文            每則底部附 [原文連結](fixupx)
  附 fixupx 主推文連結     附 fixupx 主推文連結
```

```
  使用者在 Bluesky / dvd.chat 發原生貼文（非同步產生）
                                 │
                                 ▼
                    ┌────────────────────────────┐
                    │  同步工具偵測原生貼文        │
                    └────────────┬───────────────┘
                                 ▼
                    Telegram 機器人私聊，兩則訊息：
                    (1) 純通知：提醒需手動發到 X
                    (2) 內容本體 + 媒體（可直接轉發）
                                 │
                                 ▼
                    使用者手動發到 X
                                 │
                                 ▼
                    ┌────────────────────────────┐
                    │  防回音識別：該 X 貼文屬於   │
                    │  手動鏡像 → 不同步到其他平台 │
                    └────────────────────────────┘
```

其他固定通道：

- **Telegram 個人頻道**：接收本工具的運作通知（同步成功／失敗／錯誤），與你其他機器人的通知共用同一頻道。
- **Telegram 私聊指令**：你可以在私聊中對機器人下指令（指令集見 §6.4）。

---

## 2. 決策對照表

### 2.1 五大決策（原審核稿 §1.3）

| # | 決策 | 已採用規格 |
|---|---|---|
| 1 | X 通道 | **X 發文維持手動**；工具只讀取自己的 X 內容以觸發同步。這裡採用你多次描述的實際操作流程；不做自動登入發文、選檔、按 Post。 |
| 2 | 媒體不相容時 | **D：自動轉碼或拆多篇**；先做可逆、可預覽的 platform variant，單一平台失敗不阻擋其他平台。 |
| 3 | 第一版範圍 | **First：文字 + 最多 4 張靜態圖片**；影片與 GIF 保留為第二階段。第一版預檢以 X 一般帳號限制為基準，再對 B/D/TG 各自適配。 |
| 4 | 同步方向 | **X → Bluesky/dvd.chat/Telegram 自動；Bluesky/dvd.chat → Telegram 私聊提醒 → 你手動發 X**。不是三平台互相無限回流。 |
| 5 | 失敗策略 | 各平台獨立成敗、互不阻擋；允許平台專屬文字、hashtag、CW、alt text；每次結果寫入狀態資料。 |

### 2.2 第 9 章清單的採用結果

| # | 問題 | 採用結果 |
|---|---|---|
| 1 | X 通道 | **C 的「無頭瀏覽器讀取」+ B 的「手動發文」**；不做自動 X 發文。 |
| 2 | 媒體不相容 | D：轉碼／拆文。 |
| 3 | 第一版範圍 | First：文字 + ≤4 張靜態圖。 |
| 4 | 同步方向 | X 為主要來源，B/D/TG 為下游；B/D 原生內容只產生私聊手動提醒。 |
| 5 | A 失敗 B/C 照發 | 是，各平台獨立。 |
| 6 | 平台專屬文字調整 | 是。 |
| 7 | 部署環境 | Oracle ARM64 VPS，Debian，2C/2T，12GB，Tokyo。 |
| 8 | 排程發文 | 是；第一版排程的是 B/D/TG 發布與提醒，不是自動 X 發文。 |
| 9 | 雙向同步 | 是，但採**受控雙向**：X→下游自動；B/D→私聊提醒→人工 X，不讓人工 X 再回流。 |
| 10 | 介面 | CLI + Web UI。 |

### 2.3 明確不做的項目

依「你不建議做的就不要做」：

- ✅ 原生投票跨平台同步（更新決策）：Sharkey／Telegram 以其原生投票 API 各自建立一份**獨立**投票（票數互不合併、不從 X 帶入），期限沿用 X 的**絕對截止時間**（不重啟倒數）；Bluesky 沒有原生 poll，改以文字呈現選項與 X 原投票連結。
- ❌ 跨平台合併投票票數（各平台投票彼此獨立，不回填 X 或其他平台的票數）
- ❌ 純音訊貼文
- ✅ 圖片與影片混合附件（更新決策）：照 X 原順序同步，合計最多 4 個。Telegram 合成一個相簿、Sharkey 同一則 note；Bluesky 單則貼文只能放圖片或一支影片，因此連續圖片共用一則、每支影片各占一則，依序接成串文。GIF 仍不同步。
- ❌ X Premium 長文（保留不自動同步；可由 Telegram 通知手動放行，發布時自動分段）
- ❌ 平台特有 visibility 映射（第一版）

---

## 3. 目前仍可調整的工作參數

主要方向已定案；以下是實作前可以採用預設值、之後由 Web UI／CLI 調整的參數，不會阻擋 Phase 1：

| 參數 | 暫定值 | 用途 |
|---|---:|---|
| X 監聽輪詢間隔 | 60–180 秒，帶抖動 | 降低重複讀取與突發請求 |
| 正常串文起始時間窗 | 10 分鐘 | 判斷 root 後續自回覆是否屬同一批次 |
| 手動鏡像待認領時間 | 72 小時 | 將 B/D 原生貼文與手動 X 貼文配對 |
| 模糊鏡像搜尋範圍 | 7 天 | 找不到 pending mirror 時的第二層輔助比對 |
| 私聊通知 | 兩則 | 純提醒一則 + 內容／媒體一則 |
| 重試上限 | 由佇列策略設定 | 僅重試該平台，不重發已成功平台 |

> 這些是設定，不是平台限制。所有自動同步前都會保存「待同步／已同步／跳過／疑似鏡像」狀態。

## 4. 已採用的工作語意（可調參數）

### 4.1 排程的語意

已按你的回答啟用排程，但第一版語意固定為：

- 到時間自動發布到 Bluesky、dvd.chat、Telegram 對外頻道；
- 同時私聊通知你「現在請手動發到 X」；
- **不會**由工具自動在 X 發文。

如果之後要改成「只提醒、不自動發布下游」，只需改排程策略，不改資料模型。

### 4.2 Telegram 指令與通知量

第一版先採用 §6.4 的指令與 §6.5 的個人頻道通知範圍；所有指令只接受你的 Telegram user ID。後續可透過設定檔關閉某類通知。

### 4.3 Quote

第一版先把 X 文字中的 X status 連結當作普通連結改寫成 fixupx；Quote 的平台原生互動語意列入第二階段，不阻擋文字與圖片同步。

### 4.4 B/D 原生回覆

為避免把對話回覆誤當成要轉發的獨立內容，第一版只對你帳號的 root 貼文產生「手動發 X」私聊通知；回覆他人、回覆自己既有貼文、轉貼／引用等非 root 內容預設跳過。若日後需要，可用指令手動升格單則內容。

---

## 5. 核心流程

### 5.1 X → 其他平台（自動，主要流程）

1. **監聽**：無頭瀏覽器以登入 session 定期輪詢你自己的 X 個人頁，偵測新推文。
   - 📌 輪詢間隔暫定 60–180 秒隨機抖動，只讀自己的頁面、不做任何互動，降低風險。
2. **過濾**（見 §5.3）：只放行「主推文」與「同一固定窗口內的自串文」。回覆他人、晚發自回覆一律跳過。
3. **分發**：
   - **Bluesky**：API 發布；串文用 reply chain；完成後**多加一則串文**附 fixupx 主推文連結。
   - **dvd.chat**：API 發布（`notes/create` + `replyId`）；同樣**多加一則串文**附 fixupx 主推文連結。
   - **Telegram 對外頻道**：內容照發；**串文以回覆上一則訊息的方式發送**；每則訊息最底部附 `[原文連結](https://fixupx.com/…)`。
4. **記錄**：每則同步結果（成功/失敗/跳過）寫入資料庫，並摘要在個人頻道。

### 5.2 Bluesky / dvd.chat → X（手動輔助流程）

1. **偵測原生貼文**：你在 Bluesky／dvd.chat 發的新貼文，且**不是**本工具同步產生的（同步產生的會有記錄，直接排除）。
2. **私聊兩則訊息**（機器人與你的私聊）：
   - **訊息一（純通知）**：告知來源平台、時間、摘要，提醒「這則需要你手動發到 X」。
   - **訊息二（內容本體）**：完整文字 + 媒體（圖片/影片直接進私聊，可轉發）。
3. **你手動發到 X**。
4. **防回音**：X 監聽看到這則新推文時，識別為「手動鏡像」，**不再**同步到 Bluesky/dvd.chat/Telegram。

### 5.3 過濾與防回音演算法（X 側）

#### 5.3.1 串文判定（要同步的）

```
每次輪詢後，先依建立時間排序自己的候選貼文：

1. 只有 `in_reply_to = null` 的 root post 才能開啟一個新批次。
2. root 開啟批次後，以 root 的建立時間為基準保留固定窗口 `T=10 分鐘`。
   窗口不是「每回覆一次就重新延長」；因此每 9 分鐘回覆一次不能讓串文無限延長。
3. 只有同一作者、直接回覆鏈上的前一則、且 `created_at - root.created_at <= T` 的貼文，才加入該批次。
4. 若 `in_reply_to` 指向他人，或是自回覆但超過 root 的窗口，標為 `skipped_reply`。
5. 批次在 root 窗口結束後封存；封存後新出現的自回覆不會補發到下游。

發布策略：root 可以先發布；窗口內新確認的自串文再依序追加。若要避免下游先看到不完整串文，設定 `batch_settle_delay` 可讓 root 延遲數分鐘發布。
```

#### 5.3.2 不同步的（你明確要求）

| 類型 | 判定 | 動作 |
|---|---|---|
| 回覆**他人**的推文 | `in_reply_to` 指向非本人帳號 | 一律不同步 |
| 晚發的自串文 | 自回覆，但超過 root 的固定窗口 `T` | 不同步，標記為 `skipped_late_self_reply` |
| 手動鏡像 | 命中 §5.3.3 鏡像識別 | 不同步，標記為 `manual_mirror` |

#### 5.3.3 鏡像識別（防止手動發的 X 被再同步）

```
1. 工具送出「請手動發 X」私聊通知時，同時建立一筆 pending_mirror 記錄：
   { 來源平台, 來源貼文 ID, 預期段落順序, 內容指紋, 媒體指紋, 建立時間, 有效視窗 }
   有效視窗暫定 72 小時。

2. X 監聽發現新推文時：
   a. 先比對 pending_mirror：文字正規化後完全相同，且媒體指紋相同或來源沒有媒體
      → 判定為鏡像，整個 root batch 標記為 manual_mirror，不同步。
      但**純文字**比對需具備足夠長度（正規化後 ≥20 **UTF-8 位元組**）才算確證；過短的相同文字
      （例如「早安」＝6 位元組）視為巧合，改走 b 的 `mirror_review` 由你確認，避免新貼文被靜默吞掉。
      有相符的媒體指紋時不受此限。
      > 以位元組而非字元計算：一個 CJK 字元佔 3 位元組但承載接近一個完整詞，用字元數計會讓幾乎所有
      > 中文貼文都落在門檻下（連「這部電影真的很好看，推薦大家去看」也只有 16 字元），於是全部被送去
      > 人工確認。位元組讓兩種書寫系統的「說了多少」大致可比。
      > 候選範圍另有兩項限制：只有**仍在 72 小時 pending 窗內、且尚未配對**的下游原生貼文算候選。
      > 首次掃描下游帳號掃進來的歷史（基準快照，本來就不回填）不建立 pending_mirror；已配對到某則
      > X 貼文的鏡像退出比對，因為一則下游貼文最多只能是一則 X 貼文的手動複本。
   b. 若只有部分相似，或文字相似但媒體不一致 → 標記 `mirror_review`，暫停分發，送個人頻道通知；
      不可只靠模糊相似度直接發布。
   c. 若完全沒有鏡像證據 → 視為新的 X 原生內容，進入 §5.1 同步。

3. 指令覆寫：你可私聊指令標記「這則是鏡像/不要同步」或「強制同步」。
   在 `mirror_review` 狀態下，預設選擇是不要同步，直到你明確覆寫。

正規化（做雜湊前）：
  - Unicode NFC、轉小寫
  - 去除多餘空白與換行差異
  - URL 只移除追蹤參數，不改變 URL 的主要 path
  - 保留文字與媒體兩種指紋；不能忽略媒體
```

> ⚠️ 已知邊界：手動轉發時若大幅改寫文字或重新壓縮媒體，工具可能無法自動認領。為了避免誤同步，疑似鏡像會先暫停並通知你，不會直接猜測為新內容。

#### 5.3.4 B/D 原生貼文到私聊的判定

- 只偵測你帳號的 **root post**。
- 本工具同步產生的貼文（資料庫已有 `outbound_sync` 記錄）→ 排除。
- 回覆他人、回覆自己既有貼文、轉貼／引用等非 root 內容 → 預設標記 `ignored_non_root`，不發私聊。
- 如需例外，使用 `/mirror` 或 `/send-to-x`（名稱可調）建立明確的人工任務；不自動發 X。

---

## 6. Telegram 整合

### 6.1 帳號與權限

| 項目 | 設定 |
|---|---|
| Bot | 一個 bot，同時服務私聊指令、兩個頻道 |
| 對外頻道 | bot 需為管理員（發文權） |
| 個人頻道 | bot 需為管理員（發文權） |
| 私聊 | 只有你的 user ID 可下指令（白名單） |

### 6.2 私聊兩則式通知（其他平台 → X 提醒）

提醒本質是「通知你」，因此只有在該訊息送得出去時才會排入佇列：live 模式需要 Telegram 已啟用且有
bot token，preview 模式需要 `telegram` 在 `DESTINATIONS` 內。沒有管道可送時不排工作（原生貼文本身
仍會記錄為待手動發 X），否則每則原生貼文都會留下一個失敗工作與一筆錯誤事件，純屬噪音。

範本（📌 可調）：

```
訊息一：
🔔 [dvd.chat] 有新貼文需要手動發到 X
時間：2026-09-19 14:32
摘要：前 50 字…
處理方式：下方訊息為內容本體，轉發/複製到 X 後即完成。
（工具會自動防止該則 X 貼文被再同步）

訊息二：
（完整文字內容）
（媒體：圖片/影片直接附上，可長按轉發）
```

### 6.3 對外頻道發布格式

```
每則訊息 = 內容（文字或媒體+caption）
         + 最底部一行：[原文連結](https://fixupx.com/…)

串文：
  第 1 則 → 直接發
  第 2 則 → 回覆第 1 則（reply_parameters）
  第 3 則 → 回覆第 2 則，以此類推
```

### 6.3.1 Telegram Bot API 實作邊界

以下是第一版 adapter 要遵守的保守規格；最終仍以 Bot API 回應與 `retry_after` 為準：

| 項目 | 第一版規格 | 狀態 |
|---|---|---|
| 文字訊息 | `sendMessage` 的 text 不超過 4096 字元（實體解析後） | ✅ 官方 Bot API |
| 媒體 caption | 不超過 1024 字元（實體解析後） | ✅ 官方 Bot API |
| 圖片 | 優先 `sendPhoto`；超出圖片端限制時改用 `sendDocument` 或拆分 | ⚠️ 依 Bot API 方法限制 |
| 一般雲端 Bot 上傳 | 媒體方法的檔案上限由官方 Bot API 方法限制；不要假設可傳任意大檔 | ✅／⚠️ |
| 下載 | 不用 `getFile` 下載大型原檔；私聊通知應直接引用／上傳可轉發版本 | ⚠️ 受雲端 Bot API 下載上限影響 |
| 媒體群組 | `sendMediaGroup` 每組 2–10 個；音訊／文件只與同類型分組 | ✅ 官方 Bot API |
| 串文回覆 | 使用 `reply_parameters`，保存實際回傳的 `message_id`；不可只保存發送順序 | 📌 |
| 回覆目標不存在 | 預設不允許靜默改成獨立訊息；失敗時進入重試／通知 | 📌 `allow_sending_without_reply=false` |
| 連結 | 使用 HTML `<a href="https://fixupx.com/...">原文連結</a>`，並對顯示文字與 URL 正確 escaping | ✅ 官方支援 HTML parse mode |
| Flood control | 收到 429 與 `retry_after` 時按指定秒數延遲，不自行密集重試 | ✅ 官方 Bot API |

> Telegram 頻道中的「回覆」視覺呈現可能受到頻道設定與 linked discussion 影響。第一版只保證送出時使用正確的 reply reference，實際呈現需用目標頻道做一次整合測試；不把頻道 reply 宣稱成一定等同論壇式串文。
>
> 官方參考：[Telegram Bot API](https://core.telegram.org/bots/api)、[Telegram Bot FAQ](https://core.telegram.org/bots/faq)。

技術限制備註：

- 超過文字或 caption 限制時自動拆分，**不截斷原文**。
- 媒體與原文連結的排列由 adapter 固定：媒體 caption 放可容納的內容，超出部分另發文字訊息，最後一則補上原文連結。
- 媒體群組的回覆鏈以群組第一個回傳的 `message_id` 作為下一則 reply target；若 Bot API 回傳行為與頻道不一致，降級為逐件發送並保持回覆鏈。

### 6.4 私聊指令（第一版預設，可調整）

| 指令 | 功能 |
|---|---|
| `/status` | 顯示各平台最近同步狀態、佇列、X session 狀態 |
| `/sync` | 立即觸發一次 X 輪詢 |
| `/skip <id>` | 標記某則待同步內容為不同步 |
| `/mirror <id>` | 標記某則 X 推文為手動鏡像（防回音修正） |
| `/resync <id>` | 重試某則失敗的同步 |
| `/help` | 指令清單 |

### 6.5 個人頻道通知（第一版預設，可調整）

- 同步成功摘要（可批次，避免洗版）
- 同步失敗與錯誤碼
- X session 失效／需要重新登入的告警
- 服務啟停

---

## 7. 連結處理規則

### 7.1 fixupx 改寫（所有涉及 X 推文連結之處）

```
輸入：任何 x.com / twitter.com 的 status 連結
  1. 去除 query 追蹤參數（t、s 等，即 ?s=20&t=… 全砍）
  2. 網域換成 fixupx.com
輸出：https://fixupx.com/<user>/status/<id>

適用位置：
  - 同步內容內文中的 X 連結（例如引用推文時貼的連結）
  - dvd.chat／Bluesky 結尾串文附的主推文連結
  - Telegram 對外頻道每則底部的 [原文連結]
```

### 7.2 dvd.chat / Bluesky：結尾串文

```
同步完成後，自動在該平台「再多加一則串文」（作為 reply 接在同步內容之後）：
  - 內容：連到 X 平台上「該串文最上面的主推文」的 fixupx 連結
  - 並表明此連結到原推文
  - 📌 範本：🔗 原文：https://fixupx.com/<user>/status/<root_id>
    （文字可調，例如「X 原文連結」）

注意：
  - 連結指向「主推文」（thread root），不是最後一則
  - 單則推文（非串文）同樣適用：同步該則 + 一則結尾連結串文
```

### 7.3 Telegram 對外頻道

每則訊息最底部：`[原文連結](https://fixupx.com/…)`（實作用 HTML anchor）。

### 7.4 實作注意

> ⚠️ **Bluesky facet 重建**：改寫內文中的 X 連結（網域替換、去 query）會**改變文字長度**，所有 facet 的 byte offset 必須在改寫**之後**重新計算，不能沿用原 offset。

---

## 8. 媒體與內容規格

### 8.1 基準：以 X（非 Premium）限制為主（決策 3）

| 項目 | 基準值 |
|---|---|
| 文字 | 280 加權字元（URL=23、emoji/CJK=2） |
| 圖片 | ≤4 張，每張 ≤5 MB，GIF/JPEG/PNG |
| GIF | 1 個，網頁端 ≤15 MB |
| 影片（二階段） | ≤140 秒、≤512 MB |

> 超過基準的內容一律**保留**（不自動同步）並發送一則 Telegram 通知說明原因；通知提供「略過」與「這是我手動鏡像的」，其中只有長文多一個放行選項（發布時自動分段成一串貼文）。其餘保留原因（投票**資料不完整或缺少可用截止時間**、GIF／動畫、無可下載來源的影片）沒有可用的發布路徑，因此不提供放行。資料完整且仍在期限內的 X 投票不在保留之列 —— Sharkey／Telegram 各自建立一份獨立原生投票、Bluesky 以文字呈現（見 2.3）。來源標記為敏感的內容**不在保留之列**，改為帶著標記照常發布（見 8.2）；但敏感投票因 Telegram 無法對投票題目加防雷，仍會保留待人工處理。
>
> 長文判定採上表的加權長度，且只有當發布真的會被分段（超過最嚴格的 Bluesky 單則上限）時才保留 —— 收集器會先把 t.co 短連結展開成真實網址，若改用原始字元數判定，一則正常推文會被展開後的長網址誤判成長文。

### 8.2 各平台仍需自動適配（決策 2 = D 轉碼/拆文）

「以 X 為主」不代表其他平台照抄就一定能發，以下衝突點由工具自動處理：

| 衝突 | 處理 |
|---|---|
| Bluesky 圖片 ≤2 MB（比 X 的 5 MB 嚴） | 自動壓縮/轉 JPEG 至 ≤2 MB（Sharp） |
| Bluesky 文字 ≤300 graphemes 且 ≤3000 bytes | 超出時自動拆成串文 |
| Bluesky 影片僅 MP4 | 二階段轉碼管線 |
| dvd.chat CW ≤500、文字 ≤3000 | 自動截斷或拆文 |
| Telegram 4096/1024 限制 | 自動拆則 |
| 來源標記為敏感（X 的媒體警告、來源端的 CW） | 照常發布並保留警告：Bluesky 每段 `selfLabels` 與 CW 前綴；Sharkey 每段 CW、所有媒體檔 `isSensitive=true`；Telegram 正文與媒體 spoiler、停用敏感文字訊息的連結預覽 |

Bluesky 優先保留來源已知分類，未分類時用 `BLUESKY_SENSITIVE_LABEL`（預設 `graphic-media`，可設 `porn`／`sexual`／`nudity`／`graphic-media`）。`graphic-media` 指血腥／暴力等刺激性媒體，**不是通用警告**；請依實際內容選擇。Bluesky 的自行標記 `!warn` 不生效，媒體標籤也不折疊純文字，因此另保留可見的 CW。沒有來源 CW 時使用「來源標記為敏感內容」；分段預留警告長度，不會為了送出而靜默刪除警告。

### 8.3 dvd.chat 檔案大小（使用者補充資訊）

- 你確認：**朋友開的站，超過 100 MB 能傳**。✅ 採納為實測事實。
- 對照原始碼：全域 multipart 上限為 262,144,000 bytes（250 MiB），>100 MB 可傳與此一致。
- 📌 結論：dvd.chat 側以 **250 MiB** 為內部預檢值；實際以伺服器 413 回應為準，不做更嚴的人為限制。

### 8.4 二階段影片轉碼 profile（屆時實作）

MP4 / H.264 / AAC-LC / YUV 4:2:0 / 30 fps / 16:9 或 9:16 或 1:1 / ≤140 秒（對齊 X 非 Premium）。Bluesky >50 MB 走官方影片服務上傳流程。

---

## 9. 資料模型與狀態機

### 9.1 核心資料表

```text
canonical_posts
  id                  UUID
  source_platform     x | bluesky | dvd_chat | telegram | local
  source_post_id      平台原始 ID
  source_root_id      串文 root ID
  source_created_at
  text_original
  normalized_text
  content_hash
  classification      root | self_thread | reply_to_other | late_self_reply |
                      manual_mirror | mirror_review | ignored_non_root
  classification_reason
  created_at

attachments
  id
  canonical_post_id
  source_media_id
  local_path_or_object_key
  mime_type
  size_bytes
  width / height / duration_ms
  content_hash
  alt_text

platform_variants
  id
  canonical_post_id
  platform            bluesky | dvd_chat | telegram
  variant_order
  text
  attachments_json
  status              pending | transforming | uploading | published |
                      failed | skipped | manual_mirror | mirror_review
  decision_reason
  remote_post_id
  remote_message_id
  remote_url
  error_code
  error_message
  published_at

pending_mirrors
  id
  source_platform
  source_post_id
  expected_text_hash
  expected_media_hashes
  expires_at
  matched_x_post_id
  status              pending | matched | expired | overridden

sync_jobs
  id
  canonical_post_id
  platform
  operation           detect | transform | publish | notify | retry
  attempt
  scheduled_at
  idempotency_key
  last_error
```

### 9.2 狀態判定原則

- **先分類，後發布**：任何候選貼文先進 `classification`，分類未完成不得進入發布佇列。
- **成功與跳過分開**：`published` 表示已發布；`skipped`、`manual_mirror`、`mirror_review` 表示決策結果，不是發布失敗。
- **平台獨立冪等**：`idempotency_key = canonical_post_id + platform + variant_order`；同一平台重試不得建立第二篇。
- **下游回音排除**：B/D/TG 發布前先寫入 `outbound_sync` 記錄；監聽器用來源 ID、內容指紋與發佈時間排除自己產生的事件。
- **疑似鏡像預設不發**：`mirror_review` 只通知個人頻道，等待 `/mirror` 或 `/force-sync` 類指令。
- **X 發文永遠沒有 publish job**：X adapter 只允許讀取、分類、產生手動任務；不建立自動 X 發布操作。

### 9.3 串文批次資料

每個 X root 建立一個 `thread_batch` 概念（可作為資料表或欄位群組）：

```text
thread_batch
  root_post_id
  root_created_at
  settle_at                 -- root_created_at + T + optional batch_settle_delay
  state                     open | settled | published | skipped | review
  member_post_ids[]         -- 依 X 回覆鏈順序
  excluded_post_ids[]       -- late self reply / reply to other
```

追加成員時必須同時滿足：

1. 回覆作者是本人；
2. `in_reply_to` 可沿鏈追溯到 root；
3. 該貼文建立時間不超過 root 的固定 `T`；
4. 未被標成鏡像或疑似鏡像。

---

## 10. 部署環境

| 項目 | 值 |
|---|---|
| 機器 | Oracle Cloud VPS |
| 架構 | **ARM64（aarch64）** — 所有相依需 ARM 相容 |
| 系統 | Debian |
| 規格 | 2C/2T、12 GB RAM |
| 地區 | Tokyo |

ARM64 相容性確認（皆無慮）：

- Node.js、Playwright Chromium（官方支援 linux-arm64）
- ffmpeg / ffprobe（apt 版即可）
- Sharp（有 arm64 prebuilt）
- PostgreSQL、Redis（docker 官方 arm64 映像）

常駐元件：

```
x-monitor    無頭瀏覽器輪詢 X（persistent profile，見 §11）
worker       佇列消費：轉檔、發布 B/D/TG、重試
telegram-bot 長輪詞（long polling）接收指令、發送通知
web          Web UI（both 決策）+ CLI
db / redis   docker compose
```

---

## 10. 安全與法務約定

### 10.1 對外請求防護（實作驗收條件）

> 服務端請求 URL 時：僅允許 http/https；發請求前校驗 host，並拒絕 localhost、環回、私有和保留地址。

適用於所有對外 fetch（Telegram API、Bluesky PDS、dvd.chat API、以及未來任何連結預覽／OG 抓取）。

### 10.2 憑證管理

- Bluesky：app password（不用主密碼）
- dvd.chat：API token，權限最小化（`write:drive`、`write:notes`、`read` 必要項）
- Telegram：bot token
- X：VPS 上 Playwright persistent profile 的 session cookie，檔案權限限縮
- 全部存 .env／secret store，不進 git

### 10.3 X 自動化風險（知情聲明）

- 已如實告知：X 官方 Automation Rules 禁止 scripting the X website，**讀取也算**；可能導致帳號永久停權。
- 你選擇繼續（清單填 C／已登入帳號），記錄為**知情接受風險**。
- 緩解措施（工具側自律，不做的都不做）：
  - 只讀取自己的個人頁，不做任何互動自動化（不按讚、不追蹤、不回覆）
  - 低頻輪詢 + 隨機間隔
  - 不做反偵測、代理輪換或驗證繞過
  - 發文維持手動；風險集中在 X 讀取側

---

## 11. 目前瀏覽器登入狀態的定位

你在 ZCode 內建瀏覽器（browser-use）登入了 x.com、bsky.app、dvd.chat。

| 用途 | 說明 |
|---|---|
| 開發／設定階段（本環境） | ✅ 可用來：驗證 X 頁面結構與抓取 selector、協助建立 Bluesky app password、協助建立 dvd.chat API token、驗證發布結果 |
| VPS 執行期 | ❌ 不依賴這些 session。X 用 VPS 上自己的 Playwright persistent profile（首次需你透過 noVNC 登入一次）；Bluesky／dvd.chat 用 API 憑證 |

---

## 12. 修訂後階段計畫

```
Phase 1（目前先做）
  - 建立資料模型、狀態機與去重索引
  - X 監聽（無頭瀏覽器只讀自己的頁面）+ root 固定時間窗過濾
  - Bluesky 發布（API）+ dvd.chat 發布（API）
  - Telegram：私聊兩則式手動 X 提醒、對外頻道鏡像、個人頻道通知
  - 防回音：pending mirror + 媒體/文字指紋 + mirror_review 暫停
  - fixupx 改寫、B/D 結尾連結回覆
  - 內容範圍：文字 + ≤4 張靜態圖（自動壓縮適配各平台）
  - CLI + 基本 Web UI

Phase 2
  - 影片（轉碼管線、Bluesky 影片服務上傳）與 GIF
  - Telegram 大型媒體的分片/降級策略

Phase 3
  - Quote 原生互動處理
  - 更完整的排程編輯與批次管理
  - Web UI 進階控制與指令擴充
```

---

## 13. 開放問題（不阻擋 Phase 1）

| # | 項目 | 目前處理 |
|---|---|---|
| 1 | Telegram 指令名稱與個人頻道通知細節 | 先用 §6.4/§6.5 預設，之後可調整 |
| 2 | `batch_settle_delay` 是否啟用 | 預設關閉，避免不必要延遲；可在 Web UI 開啟 |
| 3 | Quote 的原生互動同步 | 第一版只改寫 X 連結，原生 Quote 留第二階段 |
| 4 | Telegram 頻道回覆呈現 | 以實際 Bot API/頻道測試確認；不假設回覆一定等同討論串 |
| 5 | 媒體 caption 與連結排列 | 第一版超過平台限制時拆成訊息，不截斷原文 |

這些項目不改變目前已定案的來源方向、手動 X 發文或防回音規則。

---

## 14. 變更記錄

| 版本 | 日期 | 變更 |
|---|---|---|
| v1.3 | 2026-09-19 | Phase 1 實作完成：狀態機、防回音、串文批次、Telegram 三通道、CLI／Web UI、Docker 部署；29 項自動測試通過 |
| v1.2 | 2026-09-19 | 明確採用 X 只讀取、手動發文；修正固定 root 時間窗；補上 mirror_review 狀態、資料模型、Telegram Bot API 保守邊界與 Phase 1 範圍 |
| v1.1 | 2026-09-19 | 定案 X 手動發文、修正章節引用、補上固定 root 時間窗與保守防回音狀態 |
| v1.0 | 2026-09-19 | 初版：記錄全部決策、Telegram 整合、連結規則、過濾演算法、部署環境 |

---

## 15. 實作現況（2026-09-19）

Phase 1 已完成，操作方式與限制見 [README.md](README.md)。

已實作：

- SQLite 狀態機（`baseline` / `collecting` / `ready` / `manual_mirror` / `mirror_review` / `ignored` / `unsupported`）與可續傳工作佇列。
- X 唯讀 collector（固定 profile、只讀自己的頁面、不做任何互動、不自動登入）。
- root 固定時間窗串文判定、非線性分支保留待審、晚發自回覆與回覆他人排除。
- 防回音：pending mirror（文字＋媒體指紋）、唯一匹配才自動判定、模糊情況一律 `mirror_review` 並暫停。
- Bluesky（官方 API，含 DID／PDS 解析與 session 輪替）與 dvd.chat（HTTP API）發布，含結尾 X 原推文連結串文。
- Telegram：私聊兩則式手動 X 提醒、個人通知頻道、對外鏡像頻道（串文以回覆上層發送、每則附原文連結）。
- CLI（serve／once／status／publish／schedule／action／doctor）與基本 Web UI。
- 對外請求單一受保護通道（SSRF、DNS rebinding、重新導向、大小與逾時限制）。
- Dockerfile 與 docker-compose（ARM64 相容、非 root、僅綁 loopback）。

尚未實作（後續階段）：影片與 GIF、原生 Quote 互動、Web UI 的排程表單與批次編輯。

> **目前狀態**：預設 `APP_MODE=preview`，所有發布走 stub、不接觸任何帳號。要實際上線需填入憑證、把模式改為 `live`，並自行接受啟用 X 讀取的風險。
