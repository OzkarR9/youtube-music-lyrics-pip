// MAIN world content script：
// Document Picture-in-Picture 必須在「使用者啟動（user activation）」的同步呼叫中開啟，
// 而且擴充功能工具列按鈕 / manifest 快捷鍵不會把啟動權傳到頁面。因此真正的
// requestWindow() 呼叫放在這個頁面 context（MAIN world），由頁內按鈕 click 與
// 頁面 keydown（Alt+L）直接觸發，確保具備啟動權。
//
// 為了避免「導航到 chrome-extension:// 造成子母畫面被關閉」的問題，這裡不導航到
// 擴充功能頁面，而是直接把 UI 寫進子母畫面視窗（同源），再由 content.js（ISOLATED）
// 以 window.postMessage 送來歌詞與進度，本腳本負責渲染與逐行高亮。
//
// 通訊：
//   content.js (ISOLATED) --postMessage--> 本腳本 (MAIN) --DOM--> 子母畫面視窗
//   本腳本 (MAIN) --CustomEvent--> content.js（回報開啟/關閉/字型大小）

(() => {
  'use strict';

  let pipWindow = null;
  let pipDoc = null;
  let pipEls = null;
  const supported = 'documentPictureInPicture' in window;

  let current = { songId: null, lines: [], meta: null, source: null, error: null, loading: false };
  let lastLyrics = null;
  let fontSize = 28;
  let lastActive = -1;
  let lastTime = 0;
  // 切歌時設為 true，等歌詞（含「載入中」的空列表）渲染完後才重置捲動位置，
  // 避免上一首停在最底的捲動位置被沿用。
  let needScrollReset = false;
  let scrollGen = 0;
  // 方案 A：切歌後硬鎖。content 的 locked 旗標或 t>=START_MAX 都當 0；
  // 必須連續兩次收到未鎖定且 t<START_MAX 才跟進度。
  const START_MAX = 5;
  const START_HITS = 2;
  let pendingTimeReset = false;
  let startHits = 0;

  /* ---------------- UI 樣式與結構（寫入子母畫面視窗） ---------------- */

  const PIP_CSS = [
    ':root{color-scheme:dark;}',
    '*{box-sizing:border-box;}',
    'html,body{margin:0;padding:0;height:100%;background:transparent;color:#fff;font-family:system-ui,-apple-system,"Segoe UI","PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif;overflow:hidden;}',
    '#app{position:relative;height:100vh;background:linear-gradient(180deg,rgba(24,24,32,.72),rgba(8,8,12,.88));backdrop-filter:blur(12px);}',
    // 歌詞捲動區：上下各留 50vh 內距，讓目前行（含首行與末行）都能垂直置中
    '#viewport{height:100%;overflow-y:auto;padding:50vh 18px;}',
    '#viewport::-webkit-scrollbar{display:none;}',
    '#lyrics{list-style:none;margin:0;padding:0;}',
    '.lyric-line{font-size:1.5rem;line-height:1.6;color:rgba(255,255,255,.30);padding:9px 6px;border-radius:10px;text-align:center;transition:color .25s;}',
    '.lyric-line.active{color:#fff;font-weight:650;}',
    '#empty{position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;color:#888;font-size:1rem;padding:40px 20px;}',
    '#empty.visible{display:flex;}',
    // 自動隱藏的控制列：滑鼠移動時淡入、停止後淡出，讓歌詞保持純淨
    '#overlay{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:10px;padding:10px 14px 20px;background:linear-gradient(to bottom,rgba(10,10,14,.9),rgba(10,10,14,0));opacity:0;transition:opacity .3s ease;pointer-events:none;}',
    '#overlay.show{opacity:1;pointer-events:auto;}',
    '#overlay-title{flex:1;min-width:0;font-size:.95rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '#overlay-controls{display:flex;gap:6px;flex:none;}',
    '#overlay button{width:34px;height:34px;border:none;border-radius:50%;background:rgba(255,255,255,.12);color:#eee;cursor:pointer;font-size:1rem;line-height:1;}',
    '#overlay button:hover{background:rgba(255,255,255,.24);color:#fff;}'
  ].join('\n');

  // UI 不使用 innerHTML 建立，改以 createElement 逐個建立——
  // 因為子母畫面視窗的文件啟用了 Trusted Types，字串指派給 innerHTML 會擲出例外。

  /* ---------------- 與 content.js（ISOLATED）通訊 ---------------- */

  function notify(type, extra) {
    try {
      document.dispatchEvent(new CustomEvent('ymlp:status', { detail: Object.assign({ type: type }, extra || {}) }));
    } catch (e) { /* ignore */ }
  }

  try {
    document.dispatchEvent(new CustomEvent('ymlp:ready', { detail: { supported: supported } }));
  } catch (e) { /* ignore */ }

  // content.js 以 postMessage 送來歌詞 / 進度 / 字型設定
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.__ymlp !== true) return;

    if (d.type === 'lyrics') {
      lastLyrics = d;
      if (pipWindow && !pipWindow.closed) applyLyrics(d);
    } else if (d.type === 'progress') {
      if (pipWindow && !pipWindow.closed) {
        if (d.songId === current.songId) {
          updateProgress(resolveProgressTime(d));
        } else {
          // 歌曲已切換、但新歌詞還沒送達：先清除舊高亮，避免進度停在上一首的最後一行
          clearActiveHighlight();
        }
      }
    } else if (d.type === 'settings') {
      fontSize = clamp(Number(d.fontSize) || 28);
      if (pipWindow && !pipWindow.closed) applyFontSize();
    }
  });

  // popup / manifest 快捷鍵轉發過來的切換請求（此路徑可能沒有啟動權）
  document.addEventListener('ymlp:toggle', () => { togglePip(); });

  /* ---------------- 開啟 / 關閉子母畫面 ---------------- */

  function openPip() {
    if (!supported) {
      notify('unsupported');
      return Promise.resolve();
    }
    if (pipWindow && !pipWindow.closed) return Promise.resolve();

    // 必須在使用者啟動的同步呼叫中呼叫 requestWindow（不可先 await）
    return window.documentPictureInPicture
      .requestWindow({ width: 420, height: 640, transparent: true })
      .then((w) => {
        pipWindow = w;
        buildPipUi(w);
        // 因為不再導航，這個 pagehide 只會在「使用者真的關掉視窗」時觸發
        w.addEventListener('pagehide', () => {
          pipWindow = null;
          notify('closed');
        });
        console.log('[YMLP] PiP 視窗已建立（直接寫入 UI，無跨來源導航）');
        notify('opened');
      })
      .catch((err) => {
        console.warn('[YMLP] 開啟 PiP 失敗:', err);
        notify('error', { message: String((err && err.message) || err) });
      });
  }

  function togglePip() {
    if (pipWindow && !pipWindow.closed) {
      try { pipWindow.close(); } catch (e) { /* ignore */ }
      pipWindow = null;
      notify('closed');
      return;
    }
    pipWindow = null;
    openPip();
  }

  function el(doc, tag, id, cls, text) {
    const e = doc.createElement(tag);
    if (id) e.id = id;
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function buildPipUi(w) {
    const doc = w.document;
    // 盡量精簡標題列。注意：Document PiP 視窗頂部由瀏覽器顯示的「來源網域」
    // （music.youtube.com）屬於瀏覽器 UI，無法由頁面程式碼移除。
    doc.title = '';

    const style = doc.createElement('style');
    style.textContent = PIP_CSS;
    doc.head.appendChild(style);

    const app = el(doc, 'div', 'app');

    const viewport = el(doc, 'main', 'viewport');
    const list = el(doc, 'ul', 'lyrics');
    viewport.appendChild(list);

    const empty = el(doc, 'div', 'empty', 'visible', '尚未收到歌詞…');

    // 自動隱藏控制列：只保留字型大小，歌名以極簡方式在懸停時顯示
    const overlay = el(doc, 'div', 'overlay');
    const title = el(doc, 'div', 'overlay-title', null, '');
    const controls = el(doc, 'div', 'overlay-controls');
    const minus = el(doc, 'button', 'font-minus', null, 'A−');
    minus.title = '縮小字型（−）';
    const plus = el(doc, 'button', 'font-plus', null, 'A+');
    plus.title = '放大字型（+）';
    controls.appendChild(minus);
    controls.appendChild(plus);
    overlay.appendChild(title);
    overlay.appendChild(controls);

    app.appendChild(viewport);
    app.appendChild(empty);
    app.appendChild(overlay);
    doc.body.appendChild(app);

    pipDoc = doc;
    pipEls = { title, list, empty, minus, plus, overlay, viewport };

    applyFontSize();

    pipEls.minus.addEventListener('click', () => setFontSize(fontSize - 2));
    pipEls.plus.addEventListener('click', () => setFontSize(fontSize + 2));

    // 控制列：滑鼠移動時顯示，停止 2.2 秒後自動淡出
    let hideTimer = null;
    const poke = () => {
      overlay.classList.add('show');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => overlay.classList.remove('show'), 2200);
    };
    doc.addEventListener('mousemove', poke, { passive: true });
    doc.addEventListener('mousedown', poke, true);
    poke(); // 開啟時先短暫顯示，提示控制列存在

    // 鍵盤快捷鍵：− / + 調整字型（維持最少介面操作）
    doc.addEventListener('keydown', (e) => {
      if (e.key === '-' || e.key === '_') { e.preventDefault(); setFontSize(fontSize - 2); }
      else if (e.key === '=' || e.key === '+') { e.preventDefault(); setFontSize(fontSize + 2); }
    });

    if (lastLyrics) applyLyrics(lastLyrics);
  }

  /* ---------------- 渲染 ---------------- */

  function applyLyrics(msg) {
    const isNewSong = (msg.songId !== current.songId);
    if (isNewSong) {
      // 必須在覆寫 current.songId 前判斷：只有「本來就有上一首」才硬鎖。
      // 剛開啟 PiP 時 current.songId 為 null，應直接跟目前進度。
      pendingTimeReset = current.songId != null;
      startHits = 0;
      lastTime = 0;
      lastActive = -1;
      needScrollReset = true;
      if (pipEls && pipEls.viewport) {
        try { pipEls.viewport.scrollTop = 0; } catch (e) { /* ignore */ }
      }
    }
    current.songId = msg.songId;
    current.meta = msg.meta || null;
    current.lines = Array.isArray(msg.lines)
      ? msg.lines.map((l) => ({ time: Number(l.time) || 0, text: l.text || '' }))
      : [];
    current.source = msg.source || 'none';
    current.error = msg.error || null;
    current.loading = !!msg.loading;
    render();
  }

  function render() {
    const doc = pipDoc;
    if (!doc || !pipEls) return;

    pipEls.title.textContent = (current.meta && current.meta.title) || '';
    pipEls.list.replaceChildren();
    lastActive = -1;

    if (current.lines.length) {
      pipEls.empty.classList.remove('visible');
      const frag = doc.createDocumentFragment();

      for (const line of current.lines) {
        const li = doc.createElement('li');
        li.className = 'lyric-line';
        li.textContent = line.text;
        frag.appendChild(li);
      }

      pipEls.list.appendChild(frag);
    } else {
      pipEls.empty.textContent = current.loading
        ? '載入歌詞中…'
        : (current.source === 'none'
          ? ('找不到歌詞' + (current.error ? '（' + current.error + '）' : ''))
          : '尚未收到歌詞…');
      pipEls.empty.classList.add('visible');
    }

    applyScrollReset();
    updateProgress(pendingTimeReset ? 0 : lastTime);
  }

  // 硬鎖期間：locked 或偏高的時間都當成 0。連續兩次「未鎖定且接近開頭」才放行。
  function resolveProgressTime(d) {
    const t = Number(d.time);
    const time = isFinite(t) && t > 0 ? t : 0;
    if (!pendingTimeReset) return time;
    if (d.locked || time >= START_MAX) {
      startHits = 0;
      return 0;
    }
    startHits += 1;
    if (startHits >= START_HITS) {
      pendingTimeReset = false;
      return time;
    }
    return 0;
  }

  // Document PiP 裡 scrollIntoView 常對 overflow 容器無效，改直接算 viewport.scrollTop。
  function scrollToLine(li, smooth) {
    const viewport = pipEls && pipEls.viewport;
    if (!viewport || !li) return;
    try {
      const vRect = viewport.getBoundingClientRect();
      const lRect = li.getBoundingClientRect();
      const top = viewport.scrollTop + (lRect.top - vRect.top) - (viewport.clientHeight / 2) + (lRect.height / 2);
      if (typeof viewport.scrollTo === 'function') {
        viewport.scrollTo({ top: top, behavior: smooth ? 'smooth' : 'auto' });
      } else {
        viewport.scrollTop = top;
      }
    } catch (e) {
      try { viewport.scrollTop = Math.max(0, li.offsetTop - (viewport.clientHeight / 2) + (li.offsetHeight / 2)); }
      catch (e2) { /* ignore */ }
    }
  }

  function afterPipLayout(fn) {
    const w = pipWindow;
    if (!w || w.closed) return;
    try {
      w.requestAnimationFrame(() => {
        try { w.requestAnimationFrame(fn); } catch (e) { fn(); }
      });
    } catch (e) { fn(); }
  }

  // 切歌時把捲動位置重置：
  // - 歌詞已到 → 把目前行（或第一行）垂直置中。排版完成後再捲，避免 PiP 尚未 layout。
  // - 歌詞還在載入（空列表）→ 先回最頂，保留旗標，等歌詞送達時再置中。
  function applyScrollReset() {
    if (!needScrollReset || !pipEls || !pipEls.viewport) return;
    try { pipEls.viewport.scrollTop = 0; } catch (e) { /* ignore */ }
    if (current.lines.length && pipEls.list.firstElementChild) {
      const gen = ++scrollGen;
      afterPipLayout(() => {
        if (gen !== scrollGen || !pipEls || !pipEls.list) return;
        try { pipEls.viewport.scrollTop = 0; } catch (e) { /* ignore */ }
        const li = pipEls.list.firstElementChild;
        if (li) scrollToLine(li, false);
        needScrollReset = false;
      });
    }
  }

  function clearActiveHighlight() {
    if (!pipEls) return;
    const lis = pipEls.list.children;
    for (let i = 0; i < lis.length; i++) {
      lis[i].classList.remove('active');
    }
    lastActive = -1;
  }

  function updateProgress(time) {
    if (!pipEls) return;
    const lines = current.lines;
    if (!lines.length) return;
    lastTime = time;

    let activeIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= time + 0.05) activeIdx = i;
      else break;
    }

    const lis = pipEls.list.children;

    // 進度在第一句之前（前奏）或尚未有可高亮的行：清除舊高亮。
    // 切歌重置的捲動交給 applyScrollReset（等 PiP layout 完成）。
    if (activeIdx < 0) {
      clearActiveHighlight();
      return;
    }

    for (let i = 0; i < lis.length; i++) {
      lis[i].classList.toggle('active', i === activeIdx);
    }

    const li = lis[activeIdx];
    if (activeIdx !== lastActive) {
      lastActive = activeIdx;
      // 切歌當下由 afterPipLayout 負責第一次置中，避免 layout 前 getBoundingClientRect 是錯的。
      if (!needScrollReset && li) scrollToLine(li, true);
    }
  }

  /* ---------------- 字型大小 ---------------- */

  function clamp(v) {
    return Math.min(64, Math.max(16, v));
  }

  function applyFontSize() {
    if (pipDoc) pipDoc.documentElement.style.fontSize = fontSize + 'px';
  }

  function setFontSize(v) {
    fontSize = clamp(v);
    applyFontSize();
    try {
      document.dispatchEvent(new CustomEvent('ymlp:fontsize', { detail: { fontSize: fontSize } }));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 觸發入口 ---------------- */

  // 頁內按鈕（由 content.js 注入）——capture 階段攔截，確保同步取得啟動權
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('#ymlp-pip-button')) {
      e.preventDefault();
      console.log('[YMLP] 頁內按鈕點擊');
      togglePip();
    }
  }, true);

  // 快捷鍵 Alt+L
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyL') {
      e.preventDefault();
      console.log('[YMLP] 快捷鍵 Alt+L');
      togglePip();
    }
  }, true);
})();
