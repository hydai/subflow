# Subflow — 規格書

Subflow 是一個 Chrome 擴充功能，把 YouTube 影片的字幕變成可直接餵給使用者自訂 AI 工作流的文字資料管線。

---

## 1. 目的 (Purpose)

Subflow 消除「看 YouTube 影片 → 手動複製字幕 → 貼到 AI 工具」這個中介步驟，讓使用者在不離開 YouTube 頁面的前提下，把當前影片的字幕送進自己的 AI workflow（摘要、翻譯、知識庫筆記、問答、後續自動化等）。

## 2. 使用者 (Users)

| 使用者 | 主要場景 |
|---|---|
| 知識工作者 | 用 AI 摘要技術演講、訪談、課程影片 |
| 內容創作者 / 研究員 | 把影片重點抽出存進知識庫筆記 |
| 語言學習者 / 譯者 | 將整支影片字幕翻譯成目標語言 |

## 3. 影響 (Impacts)

成功時可觀察到：

- 使用者完成「影片 → AI 處理 → 結果」全流程不需離開 YouTube 分頁
- 同一支熱門影片的字幕只會被抓取一次，後續請求由 Cloudflare 邊緣快取或 KV 回應
- 後端不保留任何個人識別資料；僅保留公開影片字幕作為共享快取

## 4. 非目標 (Non-goals)

| 非目標 | 說明 |
|---|---|
| 影片 / 音訊下載 | Subflow 不提供影片或音檔下載 |
| ASR / Whisper 轉錄 | 影片本身沒有字幕時，Subflow 不嘗試自行轉錄 |
| 跨裝置設定同步 | 工作流設定僅存在本機，不上雲 |
| YouTube 以外的平台 | 不支援 YouTube Music、Shorts UI 客製、其他影音站 |
| 直播 / 首映 | 不支援 live / premiere 狀態的影片 |
| 多輪對話 | 每次執行工作流為單次 POST，extension 不維護對話歷史 |
| AI 端點代理 | 後端不轉送 AI 請求、不持有使用者 API key |

---

## 5. 範圍 (Scope)

### 5.1 功能 (Features)

1. **YouTube 影片頁偵測**：偵測使用者位於 `https://www.youtube.com/watch?v=…` 並抽取 videoId
2. **字幕快取讀取**：透過後端取得 (videoId, 語言) 對應的字幕內容
3. **工作流管理 UI**：建立、編輯、刪除、排序使用者自訂的工作流
4. **工作流執行**：把字幕與影片詮釋資料代入提示模板，POST 至工作流的 AI 端點
5. **側邊欄回應顯示**：將 AI 回應顯示於注入 YouTube 頁面的側邊欄
6. **手動字幕刷新**：使用者主動觸發後端重新抓取字幕

### 5.2 使用者旅程 (User journeys)

**首次設定** — *Context → Action → Outcome*

- Context：使用者剛安裝 Subflow，尚未建立任何工作流
- Action：開啟 Subflow 設定頁；填入語言偏好優先序（如 `zh-TW, en`）；建立第一個工作流（名稱、HTTPS 端點 URL、headers、提示模板、auto 或 manual）
- Outcome：工作流寫入 `chrome.storage.local`；下次造訪 YouTube 影片頁時，側邊欄會列出該工作流

**手動執行工作流**

- Context：使用者位於有字幕的 YouTube 影片頁；側邊欄已顯示至少一個 manual 工作流按鈕
- Action：點擊該工作流按鈕
- Outcome：Extension 取得字幕 → 代換提示模板變數 → POST 至 AI 端點 → 回應顯示在側邊欄

**自動執行工作流**

- Context：使用者已建立一個 `autoRun: true` 工作流；開啟一支新的 YouTube 影片
- Action：無需操作
- Outcome：影片字幕取得後，extension 自動執行該工作流；側邊欄顯示「執行中」狀態，完成後顯示 AI 回應

**手動刷新字幕**

- Context：使用者察覺字幕內容過時或不正確
- Action：在側邊欄點擊「重新抓取字幕」按鈕
- Outcome：後端清除該 (videoId, language) 的邊緣快取與 KV，重新從 YouTube 抓取並回填快取；之後執行的工作流使用新字幕

---

## 6. 行為 (Behavior)

### 6.1 字幕抓取流程

Extension 對後端發出 `GET /transcripts/:videoId?lang=<優先序>`：

1. 後端依語言優先序逐一處理；每個語言先查邊緣快取，未命中再查 KV
2. 任一語言命中即回 200 與該語言字幕（`language` 欄位指出實際語言）
3. 全部未命中 → 後端從 YouTube 抓取可用字幕清單 → 依下方匹配規則選出字幕 → 解碼 → 寫入 KV 與邊緣快取 → 回 200
4. 影片完全無字幕 → 回 404 (`error: "no_captions"`)
5. YouTube 抓取失敗 → 回 502 (`error: "youtube_unavailable"`)

**匹配規則**：依使用者語言優先序逐一檢查；同一語言代碼若有多個 source，依 `human > auto > translation` 排序；第一個命中者即為結果。

### 6.2 快取語意

| 屬性 | 規則 |
|---|---|
| 快取鍵 | `(videoId, 實際匹配的語言代碼)` |
| 寫入時機 | 冷啟動的後端抓取成功後立即寫入 |
| 過期 | 永不自動過期；只接受手動刷新 |
| 失效路徑 | `POST /transcripts/:videoId/refresh?lang=<單一語言>` 同步清除 (videoId, 該語言) 的邊緣快取與 KV |
| Cache-Control | 200 回應為 `public, immutable, max-age=31536000`；404 / 502 為 `no-store` |
| 匿名性 | 後端不要求授權；任何人都可讀取已快取的公開影片字幕 |

### 6.3 工作流執行流程

1. Extension 從 `chrome.storage.local` 取出工作流
2. 取得當前影片字幕（透過 §6.1 的流程）
3. 將工作流的 `promptTemplate` 中的變數佔位符（見 §7.3）替換為實際值
4. 從 extension 背景服務以 `POST` 方式送出請求至工作流的 `url`，並帶上工作流的 `headers`
5. Request body 固定為 `Content-Type: application/json` 的 `{ "prompt": <替換後字串> }`
6. 收到回應後，將回應 body 顯示於側邊欄

### 6.4 側邊欄生命週期

| 狀態 | 行為 |
|---|---|
| 出現 | 使用者位於 YouTube `watch` 頁時注入 |
| 顯示內容 | 工作流按鈕列、最近 5 筆執行結果（成功與失敗都計入）、字幕狀態（已快取／剛抓取／無字幕）、手動刷新按鈕 |
| 收合 | 提供收合鈕；收合狀態於同分頁的後續影片切換中保留 |
| 跨影片切換 | YouTube SPA 切片時側邊欄保留；新影片載入後重設結果列表 |
| 結果排序 | 最新結果置頂 |
| 結果呈現 | 純文字保留換行；不執行 HTML 或 script |
| 按鈕溢位 | 工作流數超出側邊欄寬度時，按鈕列在水平方向可捲動；不換行、不截斷按鈕標籤 |

### 6.5 觸發語意

| 工作流設定 | 觸發點 | 重複執行規則 |
|---|---|---|
| `autoRun: true` | 該 videoId 的字幕請求首次回應 200 的當下（命中快取或冷抓取成功皆觸發） | 每組 (videoId, workflowId) 在同一次分頁開啟期間只自動執行一次；分頁關閉後狀態清空 |
| `autoRun: false` | 使用者點擊側邊欄上的該工作流按鈕 | 每次點擊都重新執行 |

當同一影片載入後有多個 `autoRun: true` 工作流符合觸發條件時，依 `workflows` 陣列順序並行觸發；各工作流獨立執行、獨立計入結果列表，不互相等待。

### 6.6 錯誤情境

| 情境 | 系統行為 |
|---|---|
| `languagePriority` 為空或未設定 | 側邊欄顯示「請於設定頁設定語言偏好」與設定頁連結；所有工作流按鈕停用；不向後端發送任何字幕請求 |
| 影片任何語言皆無字幕 | 側邊欄顯示「此影片無可用字幕」；所有工作流按鈕停用；不發送任何工作流請求 |
| 後端無法連線 | 側邊欄顯示連線錯誤訊息與「重試」按鈕；工作流按鈕停用 |
| AI 端點回 4xx | 側邊欄顯示 HTTP status 與截斷至 2000 字元的回應 body |
| AI 端點回 5xx | 同上，並提供「重試」按鈕 |
| AI 端點逾時超過 60 秒 | 側邊欄顯示逾時訊息與「重試」按鈕；中止該請求 |
| 工作流設定缺欄位或 URL 非 HTTPS | 設定頁儲存時阻擋；inline 顯示錯誤；未儲存的工作流不出現在側邊欄 |
| 影片為直播或首映 | 側邊欄顯示「Subflow 不支援直播 / 首映」；不發送任何請求 |
| 模板變數未定義 | 把未定義的 `{{xxx}}` 原樣保留於送出字串中 |

### 6.7 成本控制行為

| 控制項 | 行為 |
|---|---|
| 邊緣快取前置 | 後端在寫入 KV 前同時寫入 Cloudflare 邊緣快取 |
| 200 回應快取頭 | `Cache-Control: public, immutable, max-age=31536000` 由 CDN 自動快取至邊緣節點 |
| 失效路徑 | 只有 `POST /…/refresh` 會同時清除邊緣與 KV；其他路徑不會觸發失效 |
| 後端日誌 | Subflow 應用層日誌僅記錄 videoId、語言、命中層級（邊緣快取 / KV / 冷抓取）；不記錄 IP、cookie、使用者識別。Cloudflare 平台預設的邊緣請求日誌依平台政策保留，Subflow 不額外開啟亦不延長保留 |
| Subrequest 預算 | 單次 `GET` 命中邊緣 = 1；命中 KV = 2；冷抓取 ≤ 5（YouTube 字幕清單 1 + 字幕內容 1 + KV 寫 1 + 邊緣快取寫 1 + 額外回應 1） |
| 單次 `refresh` | KV 刪除 1 + 邊緣清除 1 + 冷抓取 ≤ 4，總計 ≤ 6 subrequests |

### 6.8 設定頁

設定 UI 為 Chrome extension options page，與側邊欄為兩個獨立 UI。

| 屬性 | 規則 |
|---|---|
| 進入點 | (a) 點擊瀏覽器工具列上的 Subflow 圖示；(b) 從 `chrome://extensions` 的 Subflow 條目點「選項」 |
| 顯示內容 | 語言偏好優先序編輯器、工作流列表、單一工作流編輯表單 |
| 操作 | 建立 / 編輯 / 刪除 / 重新排序工作流；變更語言偏好 |
| 儲存驗證 | 依 §7.4 必填規則檢查；任一驗證失敗，阻擋儲存並 inline 顯示錯誤 |
| 對側邊欄的影響 | 設定變更於下一次 watch 頁載入或側邊欄重新整理時生效；不會主動推送到既有開啟的側邊欄 |

---

## 7. 介面與契約 (Refinement)

### 7.1 後端 API 契約

**`GET /transcripts/:videoId`**

| 參數 | 位置 | 必要 | 規則 |
|---|---|---|---|
| `videoId` | path | 是 | 11 字元 YouTube videoId（`[A-Za-z0-9_-]{11}`） |
| `lang` | query | 是 | 一個或多個 BCP-47 語言代碼，以逗號分隔；左側為優先 |

200 回應 body：

```json
{
  "transcript": "整段純文字字幕（含換行）",
  "transcriptWithTimestamps": "[00:00] …\n[00:05] …",
  "language": "zh-TW",
  "source": "human | auto | translation",
  "fetchedAt": "2026-05-22T10:00:00Z"
}
```

非 200 回應：

| 狀態碼 | body | 意義 |
|---|---|---|
| 400 | `{ "error": "invalid_request" }` | `videoId` 不符合 `[A-Za-z0-9_-]{11}`、`lang` 缺失、為空字串、或包含非 BCP-47 格式的代碼 |
| 404 | `{ "error": "no_captions" }` | 該影片在所請求的所有語言皆無字幕 |
| 502 | `{ "error": "youtube_unavailable" }` | 後端無法從 YouTube 取得字幕 |

**`POST /transcripts/:videoId/refresh`**

| 參數 | 位置 | 必要 | 規則 |
|---|---|---|---|
| `videoId` | path | 是 | 同 `GET` |
| `lang` | query | 是 | **單一** BCP-47 語言代碼；不接受逗號分隔的優先序 |

副作用：先清除 (videoId, 該語言) 的邊緣快取與 KV，再對該語言執行冷抓取並回填。200 回應 body 結構同 `GET`；400、404、502 錯誤碼語意同 `GET`，且 `lang` 包含逗號時亦回 400。

### 7.2 工作流執行契約

| 項目 | 規則 |
|---|---|
| 方法 | `POST` |
| URL | 工作流的 `url`，必須 `https://` |
| Headers | 工作流的 `headers` 鍵值表，原樣套用；額外固定 `Content-Type: application/json` |
| Body | `{ "prompt": "<提示模板替換後的字串>" }` |
| 來源 | Request 自 extension 背景服務發出，`Origin` 為 extension ID 的 `chrome-extension://…` |
| Timeout | 60 秒 |
| 回應處理 | 整個 response body 以純文字顯示於側邊欄；不解析、不渲染 HTML |

### 7.3 提示模板變數

| 變數 | 內容 |
|---|---|
| `{{transcript}}` | 純文字字幕，逐行以 `\n` 分隔，不含時間戳 |
| `{{transcript_with_timestamps}}` | 含時間戳的字幕，每行格式 `[mm:ss] 文字`；影片時長 ≥ 60 分鐘時改為 `[hh:mm:ss] 文字`，同一支影片內格式統一 |
| `{{title}}` | 影片標題 |
| `{{video_id}}` | YouTube videoId |
| `{{video_url}}` | `https://www.youtube.com/watch?v=<video_id>` |
| `{{channel}}` | 頻道名稱 |
| `{{language}}` | 實際使用的字幕語言 BCP-47 代碼 |
| `{{duration_seconds}}` | 影片總時長（秒，整數） |

未定義或拼錯的變數佔位符在替換階段不被處理，原樣保留於送出字串中。變數替換為**單回合操作**：替換後的內容（例如字幕文字本身）不再進行第二次掃描，即使字幕中出現 `{{transcript}}` 字串也不被視為變數。

### 7.4 `chrome.storage.local` 結構

```
preferences: {
  languagePriority: string[]              // 必填；至少一個 BCP-47 代碼，例如 ["zh-TW", "en"]
}

workflows: Workflow[]

Workflow: {
  id:             string                  // 必填；UUID v4，由系統產生
  name:           string                  // 必填；非空字串，使用者命名
  url:            string                  // 必填；必須以 https:// 開頭
  promptTemplate: string                  // 必填；非空字串；含 §7.3 變數
  autoRun:        boolean                 // 必填
  headers:        Record<string, string>  // 選填；預設為 {}
}
```

儲存時依此規則驗證；任一必填欄位缺失、為空字串、或 `url` 非 `https://` 開頭，設定頁阻擋儲存並 inline 顯示錯誤。

### 7.5 `manifest.json` 權限介面

| 類型 | 值 | 用途 |
|---|---|---|
| `host_permissions` | `https://www.youtube.com/*` | DOM 注入側邊欄、讀取頁面詮釋資料 |
| `permissions` | `storage` | 讀寫 `chrome.storage.local` |
| `permissions` | `scripting` | 注入內容 script |

顯式不申請：`tabs`、`cookies`、`<all_urls>`、`history`、`downloads`。

工作流的 AI 端點請求由背景服務發出。Chrome MV3 對未列於 `host_permissions` 的網域強制 CORS preflight，因此使用者的 AI 端點**必須**回應允許 Origin `chrome-extension://*` 的 CORS header（至少包含 `Access-Control-Allow-Origin` 與 `Access-Control-Allow-Headers`）。Subflow 不支援動態申請 host_permissions；無法配置 CORS 的端點不能作為 Subflow 的工作流目標。

### 7.6 一致性模式

| 模式 | 規則 |
|---|---|
| 錯誤呈現 | 觀看影片過程中產生的錯誤訊息一律顯示於側邊欄；設定頁的儲存驗證錯誤顯示為欄位旁 inline 訊息。任何使用者可見錯誤皆不以 `chrome.notifications`、`alert()`、或主控台訊息呈現 |
| HTTPS only | 工作流 URL 與後端 URL 必須為 `https://`；HTTP 在儲存或請求時阻擋 |
| 時間表示 | 所有時間以 UTC ISO 8601 儲存；UI 顯示時轉成使用者時區 |
| 文字渲染 | AI 回應與字幕在側邊欄一律以純文字呈現，保留換行；不解析 Markdown / HTML / script |
| 截斷 | 對 4xx / 5xx 回應 body 顯示時截斷至前 2000 字元，超過部分以 `…(truncated)` 結尾 |

---

## 8. 術語表 (Terminology)

| 詞彙 | 定義 |
|---|---|
| Workflow | 使用者自訂的一組 (名稱, URL, headers, promptTemplate, autoRun)，定義一次 AI 呼叫 |
| Transcript | YouTube 影片字幕的純文字版本，由 Subflow 後端從 YouTube 取得後快取 |
| Sidebar | 注入 YouTube `watch` 頁面的擴充功能 UI，顯示工作流按鈕與執行結果 |
| Cache hit / miss | Cache hit 指後端在邊緣快取或 KV 中找到請求字幕；miss 指必須回到 YouTube 抓取 |
| Language preference | 使用者設定的 BCP-47 語言代碼優先序，決定字幕匹配順序 |
| Auto-run | 工作流屬性 `autoRun: true`；表示在影片載入後自動執行該工作流一次 |
| Manual refresh | 使用者主動觸發後端清除快取並重新抓取字幕的動作 |
| Subrequest | Cloudflare Worker 單次請求中對外發出的 fetch / KV / Cache API 操作；平台上限 1000 |
