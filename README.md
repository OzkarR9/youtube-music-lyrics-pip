# YouTube Music 歌詞子母畫面（Chrome Extension）

在 YouTube Music 播放歌曲時，把「正在播放」的歌詞以 **逐字同步（KTV 式）** 方式投影到
**Document Picture-in-Picture（子母畫面）** 視窗。

- 歌詞來源：**混合策略** —— 優先以 LRCLIB 外部 API 取得同步時間軸（逐字 / 逐行）；
  LRCLIB 無結果時，改用 YouTube Music 介面文字作為靜態捲動降級。
- 觸發方式：**頁內「PiP 歌詞」按鈕**、**頁面快捷鍵 `Alt+L`**、以及工具列 popup 控制器。
- 僅支援桌面版 **Chrome 116+**（Document Picture-in-Picture API）。

## 安裝

1. 開啟 Chrome，網址列輸入 `chrome://extensions`。
2. 右上角開啟「開發人員模式」。
3. 點「載入未封裝項目」，選擇本資料夾 `youtube-music-lyrics-pip`。
4. 開啟 `https://music.youtube.com` 播放歌曲。

## 使用方式

| 方式 | 說明 |
| --- | --- |
| 頁內按鈕 | 播放器控制列旁的「PiP 歌詞」按鈕（最可靠） |
| 快捷鍵 | 在頁面上按 `Alt+L` 開啟 / 關閉 |
| 工具列 popup | 點工具列圖示，查看狀態並按「開啟 / 關閉」；因瀏覽器啟動權限制，開啟時可能需改用頁內按鈕 |

- 子母畫面內可用 `A−` / `A+` 調整字型大小（會記憶）。
- 歌曲切換時，子母畫面會自動更新歌詞並重置時間軸。
- 來源標示顯示於子母畫面與 popup：`LRCLIB`、`YouTube Music（靜態）` 或「找不到歌詞」。

## 運作原理

```
content.js (ISOLATED)      pip-opener.js (MAIN)        background.js
      │ 抓曲目/歌詞              │  requestWindow()          │  LRCLIB 查詢
      │ 進度輪詢                 │  直接寫入子母畫面 UI      │  LRC 解析
      └── window.postMessage ────┘  與 KTV 渲染             │
      └──────────── chrome.runtime 訊息 ────────────────────┘
```

- `content.js`（ISOLATED world）用 Media Session + DOM 輪詢偵測目前歌曲，抓取
  `{title, artist, album, duration, videoId}`，並以混合策略解析歌詞。
- `pip-opener.js`（MAIN world）負責**同步**呼叫 `documentPictureInPicture.requestWindow()`。
  因為 Document PiP 必須由使用者啟動權觸發，而擴充功能工具列 / manifest 快捷鍵不會把
  啟動權傳遞到頁面，所以真正的開啟動作放在頁面 context，由按鈕 click 與 `Alt+L` 直接觸發。
- **子母畫面視窗不導航到擴充功能頁面**（避免跨來源導航導致視窗被關閉），而是由
  `pip-opener.js` 直接把 UI 寫進同源的子母畫面視窗，並依 content 傳來的進度做逐行＋逐字高亮。
- `background.js` 負責 LRCLIB 查詢與 LRC 解析。

## 重要假設與限制

- **逐字時間軸以 LRCLIB 為主要來源**。LRCLIB 提供的是逐行同步（line-synced）LRC；
  若歌詞本身含 enhanced LRC 逐字時間戳則使用真實逐字，否則以估算逐字呈現。
  YouTube Music 介面僅供「歌詞文字」與無時間軸時的降級顯示（其同步時間軸存在於
  應用程式 JS 狀態，DOM 不直接暴露，無法穩定抓取）。
- 專輯資訊在 YouTube Music 播放列中不直接顯示，`album` 為 best-effort（通常為空）。
- 僅支援桌面版 Chrome 116+。

## 驗證清單

1. `chrome://extensions` 載入資料夾，無 manifest 錯誤。
2. 播放有歌詞的歌 → 點頁內「PiP 歌詞」按鈕 → 子母畫面出現、歌詞隨進度高亮。
3. 按 `Alt+L` → 開啟 / 關閉正常。
4. 點工具列按鈕 → popup 顯示歌曲與來源；「開啟」若無啟動權會顯示 toast 引導。
5. 未開啟 YT Music 歌詞分頁 → 仍能經 LRCLIB 顯示歌詞（驗證混合 fallback）。
6. 播放無歌詞歌曲 → 子母畫面顯示「找不到歌詞」，不崩潰。
7. 換下一首 → 歌詞自動切換、時間軸重置。
8. 關閉子母畫面 → 頁面停止推播；再次開啟正常。
