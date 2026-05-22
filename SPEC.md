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
- 字幕直接從 YouTube watch 頁的播放器資料讀取，不經任何第三方伺服器
- Subflow 無後端基礎設施；不向任何第三方收集、儲存、轉發使用者資料

## 4. 非目標 (Non-goals)

| 非目標 | 說明 |
|---|---|
| 影片 / 音訊下載 | Subflow 不提供影片或音檔下載 |
| ASR / Whisper 轉錄 | 影片本身沒有字幕時，Subflow 不嘗試自行轉錄 |
| 跨裝置設定同步 | 工作流設定僅存在本機，不上雲 |
| YouTube 以外的平台 | 不支援 YouTube Music、Shorts UI 客製、其他影音站 |
| 直播 / 首映 | 不支援 live / premiere 狀態的影片 |
| 多輪對話 | 每次執行工作流為單次 POST，extension 不維護對話歷史 |
| 後端伺服器 / 共享快取 | Subflow 不維護任何後端服務，不在使用者之間共享字幕快取 |
| AI 端點代理 | Subflow 不在使用者與 AI 端點之間插入任何代理層；不持有使用者 API key |

---

## 5. 範圍 (Scope)

### 5.1 功能 (Features)

1. **YouTube 影片頁偵測**：偵測使用者位於 `https://www.youtube.com/watch?v=…` 並抽取 videoId
2. **字幕讀取**：從 YouTube watch 頁的播放器資料 (`ytInitialPlayerResponse`) 讀取字幕，依語言偏好優先序選擇
3. **工作流管理 UI**：建立、編輯、刪除、排序使用者自訂的工作流
4. **工作流執行**：把字幕與影片詮釋資料代入提示模板，POST 至工作流的 AI 端點
5. **側邊欄回應顯示**：將 AI 回應顯示於注入 YouTube 頁面的側邊欄
6. **手動字幕重新讀取**：使用者主動觸發清除本分頁字幕快取並重新從 YouTube 讀取

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
- Outcome：影片字幕讀取後，extension 自動執行該工作流；側邊欄顯示「執行中」狀態，完成後顯示 AI 回應

**手動字幕重新讀取**

- Context：使用者察覺字幕內容過時、不正確，或剛修改了語言偏好
- Action：在側邊欄點擊「重新抓取字幕」按鈕
- Outcome：清除本分頁的 (videoId, 語言) in-memory 快取，重新從 YouTube watch 頁讀取字幕；之後執行的工作流使用新字幕

---

## 6. 行為 (Behavior)

### 6.1 字幕讀取流程

字幕由 extension 直接從 YouTube watch 頁讀取，不經任何第三方伺服器：

1. Content script 讀取 watch 頁面的 `ytInitialPlayerResponse` 全域變數中的 `captions.playerCaptionsTracklistRenderer.captionTracks[]`
2. 依使用者語言優先序逐一比對：對每個優先語言，先找 `languageCode` 完全匹配的 track；同一語言代碼若有多個 source，依 `human > auto` 排序
3. 若該優先語言無直接匹配 track，但有任一 track 為 `isTranslatable: true`，挑選最高優先 source（`human > auto`）的 track 並在其 `baseUrl` 附加 `&tlang=<優先語言代碼>`，視為 `translation` source；若同 source 仍有多個可翻譯 track，取 `captionTracks` 陣列中索引最小者
4. 第一個命中者即為結果；其 `baseUrl` 由 extension 背景服務 `fetch()` 取得 timed-text XML
5. 背景服務解析 XML 為純文字字幕 (`transcript`) 與含時間戳字幕 (`transcriptWithTimestamps`) 兩種表示
6. 結果寫入本分頁的 in-memory cache（鍵為 `(videoId, 實際匹配的語言代碼)`）
7. 影片無 captionTracks 或所有 track 皆不匹配且不可翻譯 → 回應「無字幕」狀態
8. `ytInitialPlayerResponse` 缺失、解析失敗、或 `fetch` 失敗 → 回應「字幕讀取失敗」狀態

**匹配優先順序**：使用者語言優先序為外層；同一語言內部依 `human > auto > translation` 排序；第一個命中者即為結果。

### 6.2 字幕快取語意

| 屬性 | 規則 |
|---|---|
| 快取位置 | 本分頁的 in-memory cache（隨分頁關閉、重新載入、或切換到不同 videoId 清空） |
| 快取鍵 | `(videoId, 實際匹配的語言代碼)` |
| 寫入時機 | 第一次成功讀取字幕後立即寫入 |
| 過期 | 永不自動過期；清除路徑見「快取位置」與「失效路徑」列 |
| 失效路徑 | 使用者點擊側邊欄「重新抓取字幕」按鈕；或設定頁變更語言偏好後下一次 watch 頁載入 |
| 跨分頁 | 不共享；每個分頁獨立維護自己的 in-memory cache |
| 跨使用者 | 不共享；Subflow 無後端，不維護任何跨使用者狀態 |

### 6.3 工作流執行流程

1. Extension 從 `chrome.storage.local` 取出工作流
2. 取得當前影片字幕（透過 §6.1 的流程，或從本分頁 in-memory cache 命中）
3. 將工作流的 `promptTemplate` 中的變數佔位符（見 §7.3）替換為實際值
4. 從 extension 背景服務以 `POST` 方式送出請求至工作流的 `url`，並帶上工作流的 `headers`
5. Request body 固定為 `Content-Type: application/json` 的 `{ "prompt": <替換後字串> }`
6. 收到回應後，將回應 body 顯示於側邊欄

### 6.4 側邊欄生命週期

| 狀態 | 行為 |
|---|---|
| 出現 | 使用者位於 YouTube `watch` 頁時注入 |
| 顯示內容 | 工作流按鈕列、最近 5 筆執行結果（成功與失敗都計入）、字幕狀態（已快取／剛讀取／無字幕）、手動重新抓取按鈕 |
| 收合 | 提供收合鈕；收合狀態於同分頁的後續影片切換中保留 |
| 跨影片切換 | YouTube SPA 切片時側邊欄保留；新影片載入後重設結果列表與本分頁字幕快取 |
| 結果排序 | 最新結果置頂 |
| 結果呈現 | 純文字保留換行；不執行 HTML 或 script |
| 按鈕溢位 | 工作流數超出側邊欄寬度時，按鈕列在水平方向可捲動；不換行、不截斷按鈕標籤 |

### 6.5 觸發語意

| 工作流設定 | 觸發點 | 重複執行規則 |
|---|---|---|
| `autoRun: true` | 該 videoId 的字幕首次讀取成功的當下（無論命中本分頁快取或新讀取） | 每組 (videoId, workflowId) 在同一次分頁開啟期間只自動執行一次；分頁關閉後狀態清空 |
| `autoRun: false` | 使用者點擊側邊欄上的該工作流按鈕 | 每次點擊都重新執行 |

當同一影片載入後有多個 `autoRun: true` 工作流符合觸發條件時，依 `workflows` 陣列順序並行觸發；各工作流獨立執行、獨立計入結果列表，不互相等待。

### 6.6 錯誤情境

| 情境 | 系統行為 |
|---|---|
| `languagePriority` 為空或未設定 | 側邊欄顯示「請於設定頁設定語言偏好」與設定頁連結；所有工作流按鈕停用；不讀取字幕 |
| 影片無 captionTracks，或所有 track 皆不匹配且不可翻譯 | 側邊欄顯示「此影片無可用字幕」；所有工作流按鈕停用；不發送任何工作流請求 |
| YouTube 字幕端點 `fetch` 失敗（網路錯誤、非 2xx 回應） | 側邊欄顯示「字幕讀取失敗」與「重試」按鈕；工作流按鈕停用 |
| `ytInitialPlayerResponse` 缺失或無法解析 | 側邊欄顯示「無法解析 YouTube 頁面資料」與「重新載入頁面」提示；工作流按鈕停用 |
| AI 端點回 4xx | 側邊欄顯示 HTTP status 與截斷至 2000 字元的回應 body |
| AI 端點回 5xx | 同上，並提供「重試」按鈕 |
| AI 端點逾時超過 60 秒 | 側邊欄顯示逾時訊息與「重試」按鈕；中止該請求 |
| 工作流設定缺欄位或 URL 非 HTTPS | 設定頁儲存時阻擋；inline 顯示錯誤；未儲存的工作流不出現在側邊欄 |
| 影片為直播或首映 | 側邊欄顯示「Subflow 不支援直播 / 首映」；不發送任何請求 |
| 模板變數未定義 | 把未定義的 `{{xxx}}` 原樣保留於送出字串中 |

### 6.7 對外請求行為

| 控制項 | 行為 |
|---|---|
| YouTube 字幕請求 | 每 (videoId, 語言) 只發出一次 `fetch` 至字幕 `baseUrl`；本分頁 in-memory 快取命中時不重發 |
| 工作流請求 | 由使用者觸發 (manual) 或自動觸發 (autoRun)，每次觸發發出一次 `POST` |
| 並行語意 | 多個 `autoRun` 工作流可並行；同一 (videoId, 語言) 的字幕讀取在分頁內為單一 in-flight 請求，重複請求共享該請求、不重發 `fetch` |
| Cookie 隔離 | YouTube 字幕請求由背景服務發出，不附帶任何工作流端點的 cookie；工作流請求不附帶任何 YouTube 來源 cookie |

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

### 7.1 YouTube 字幕資料來源

字幕資料來自 watch 頁面的 `ytInitialPlayerResponse` 全域變數，路徑為 `captions.playerCaptionsTracklistRenderer.captionTracks[]`。

每個 track 至少需提供以下欄位：

| 欄位 | 型別 | 用途 |
|---|---|---|
| `baseUrl` | string | timed-text 端點 URL；附加 `&tlang=<bcp47>` 即取得 YouTube 端的翻譯 |
| `languageCode` | string | BCP-47 語言代碼，用於匹配使用者偏好 |
| `kind` | `"asr"` \| undefined | `"asr"` 表示自動產生（source = `auto`）；undefined 表示人工字幕（source = `human`） |
| `isTranslatable` | boolean | 是否支援透過 `&tlang=` 衍生其他語言版本 |

Source 對應規則：
- `kind === "asr"` → `auto`
- `kind === undefined` → `human`
- 透過 `&tlang=` 衍生的請求 → `translation`

Subflow 對 YouTube 字幕請求不附加額外 header、cookie、token，也不偽造 Origin；`baseUrl` 的 `fetch` 由 extension 背景服務發出，由 `manifest.json` 的 `host_permissions` 授權。

回傳格式為 YouTube 的 timed-text XML；extension 自行解析為 §7.3 的 `{{transcript}}` 與 `{{transcript_with_timestamps}}` 兩種表示。`baseUrl` 與 timed-text XML schema 的細節由 YouTube 決定，Subflow 視為外部相依。

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

`{{title}}`、`{{channel}}`、`{{duration_seconds}}` 從 `ytInitialPlayerResponse.videoDetails` 取得。

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
| `host_permissions` | `https://www.youtube.com/*` | DOM 注入側邊欄、讀取 `ytInitialPlayerResponse`、`fetch()` 字幕 `baseUrl` |
| `permissions` | `storage` | 讀寫 `chrome.storage.local` |
| `permissions` | `scripting` | 注入內容 script |

顯式不申請：`tabs`、`cookies`、`<all_urls>`、`history`、`downloads`。

字幕 `baseUrl` 與 timed-text 回傳皆位於 `https://www.youtube.com/*` 之下，由既有 `host_permissions` 授權；若 YouTube 將字幕端點遷出此網域，視為外部相依破壞，需發行 extension 更新。

工作流的 AI 端點請求由背景服務發出。Chrome MV3 對未列於 `host_permissions` 的網域強制 CORS preflight，因此使用者的 AI 端點**必須**回應允許 Origin `chrome-extension://*` 的 CORS header（至少包含 `Access-Control-Allow-Origin` 與 `Access-Control-Allow-Headers`）。Subflow 不支援動態申請 host_permissions；無法配置 CORS 的端點不能作為 Subflow 的工作流目標。

### 7.6 一致性模式

| 模式 | 規則 |
|---|---|
| 錯誤呈現 | 觀看影片過程中產生的錯誤訊息一律顯示於側邊欄；設定頁的儲存驗證錯誤顯示為欄位旁 inline 訊息。任何使用者可見錯誤皆不以 `chrome.notifications`、`alert()`、或主控台訊息呈現 |
| HTTPS only | 工作流 URL 必須為 `https://`；HTTP 在儲存或請求時阻擋 |
| 時間表示 | 所有時間以 UTC ISO 8601 儲存；UI 顯示時轉成使用者時區 |
| 文字渲染 | AI 回應與字幕在側邊欄一律以純文字呈現，保留換行；不解析 Markdown / HTML / script |
| 截斷 | 對 4xx / 5xx 回應 body 顯示時截斷至前 2000 字元，超過部分以 `…(truncated)` 結尾 |

---

## 8. 術語表 (Terminology)

| 詞彙 | 定義 |
|---|---|
| Workflow | 使用者自訂的一組 (名稱, URL, headers, promptTemplate, autoRun)，定義一次 AI 呼叫 |
| Transcript | YouTube 影片字幕的純文字版本，由 Subflow 從 YouTube watch 頁的字幕端點讀取 |
| Sidebar | 注入 YouTube `watch` 頁面的擴充功能 UI，顯示工作流按鈕與執行結果 |
| Cache hit / miss | hit 指本分頁的 in-memory 字幕快取已存在 (videoId, 語言) 對應字幕；miss 指必須向 YouTube 重新讀取 |
| Language preference | 使用者設定的 BCP-47 語言代碼優先序，決定字幕匹配順序 |
| Auto-run | 工作流屬性 `autoRun: true`；表示在影片載入後自動執行該工作流一次 |
| Manual refresh | 使用者主動觸發清除本分頁字幕快取並重新從 YouTube 讀取的動作 |
| `ytInitialPlayerResponse` | YouTube watch 頁面注入的全域 JavaScript 物件，包含影片詮釋資料 (`videoDetails`) 與 caption tracks (`captions.playerCaptionsTracklistRenderer.captionTracks[]`) |
