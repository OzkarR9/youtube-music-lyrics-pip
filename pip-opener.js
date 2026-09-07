// MAIN world content script：
// Document Picture-in-Picture 必須在「使用者啟動（user activation）」的同步呼叫中開啟，
// 而且擴充功能工具列按鈕 / manifest 快捷鍵不會把啟動權傳到頁面。因此真正的
// requestWindow() 呼叫放在這個頁面 context（MAIN world），由頁內按鈕 click 與
// 頁面 keydown（Alt+L）直接觸發，確保具備啟動權。
//
// 為了避免「導航到 chrome-extension:// 造成子母畫面被關閉」的問題，這裡不導航到
// 擴充功能頁面，而是直接把 UI 寫進子母畫面視窗（同源），再由 content.js（ISOLATED）
// 以 window.postMessage 送來歌詞與進度，本腳本負責渲染與逐字高亮。
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

  /* ---------------- UI 樣式與結構（寫入子母畫面視窗） ---------------- */

  const PIP_CSS = [
    ':root{color-scheme:dark;}',
    '*{box-sizing:border-box;}',
    'html,body{margin:0;padding:0;height:100%;background:#0f0f13;color:#fff;font-family:system-ui,-apple-system,"Segoe UI","PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif;overflow:hidden;}',
    '#app{display:flex;flex-direction:column;height:100vh;}',
    '#topbar{display:flex;align-items:flex-start;gap:8px;padding:12px 14px 6px;}',
    '#meta{flex:1;min-width:0;}',
    '#song-title{font-size:1.05rem;font-weight:700;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '#song-artist{font-size:.85rem;color:#aaa;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '#controls{display:flex;gap:4px;flex:none;}',
    '#controls button{width:30px;height:30px;border:none;border-radius:8px;background:rgba(255,255,255,.1);color:#ddd;cursor:pointer;font-size:.9rem;line-height:1;}',
    '#controls button:hover{background:rgba(255,255,255,.2);color:#fff;}',
    '#source{padding:0 14px 6px;font-size:.75rem;color:#777;}',
    '#viewport{flex:1;overflow-y:auto;padding:8px 14px 64px;}',
    '#viewport::-webkit-scrollbar{width:8px;}',
    '#viewport::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:4px;}',
    '#lyrics{list-style:none;margin:0;padding:0;}',
    '.lyric-line{font-size:1.35rem;line-height:1.55;color:rgba(255,255,255,.32);padding:10px 6px;border-radius:10px;transition:color .25s,background-color .25s;}',
    '.lyric-line.active{color:#fff;font-weight:650;}',
    '.lyric-line .word{transition:color .12s linear;}',
    '.lyric-line.active .word.sung{color:#ffd166;}',
    '.lyric-line.active .word.current{color:#fff;text-shadow:0 0 14px rgba(255,209,102,.65);}',
    '#empty{display:none;text-align:center;color:#888;font-size:1rem;padding:40px 16px;}',
    '#empty.visible{display:block;}'
  ].join('\n');

  // UI 不使用 innerHTML 建立，改以 createElement 逐個建立——
  // 因為子母畫面視窗的文件啟用了 Trusted Types，字串指派給 innerHTML 會擲出例外。

  const SOURCE_LABEL = { 'lrclib': 'LRCLIB', 'youtube-music': 'YouTube Music（靜態）', 'none': '無' };

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
          updateProgress(Number(d.time) || 0);
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
      .requestWindow({ width: 420, height: 640 })
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
    doc.title = '歌詞子母畫面';

    const style = doc.createElement('style');
    style.textContent = PIP_CSS;
    doc.head.appendChild(style);

    const app = el(doc, 'div', 'app');

    const topbar = el(doc, 'header', 'topbar');
    const meta = el(doc, 'div', 'meta');
    const title = el(doc, 'div', 'song-title', null, '—');
    const artist = el(doc, 'div', 'song-artist', null, '—');
    meta.appendChild(title);
    meta.appendChild(artist);

    const controls = el(doc, 'div', 'controls');
    const minus = el(doc, 'button', 'font-minus', null, 'A−');
    minus.title = '縮小字型';
    const plus = el(doc, 'button', 'font-plus', null, 'A+');
    plus.title = '放大字型';
    const close = el(doc, 'button', 'close', null, '✕');
    close.title = '關閉';
    controls.appendChild(minus);
    controls.appendChild(plus);
    controls.appendChild(close);

    topbar.appendChild(meta);
    topbar.appendChild(controls);

    const source = el(doc, 'div', 'source', null, '來源：—');

    const viewport = el(doc, 'main', 'viewport');
    const list = el(doc, 'ul', 'lyrics');
    const empty = el(doc, 'div', 'empty', 'visible', '尚未收到歌詞…');
    viewport.appendChild(list);
    viewport.appendChild(empty);

    app.appendChild(topbar);
    app.appendChild(source);
    app.appendChild(viewport);
    doc.body.appendChild(app);

    pipDoc = doc;
    pipEls = { title, artist, source, list, empty, close, minus, plus };

    applyFontSize();

    pipEls.close.addEventListener('click', () => {
      try { w.close(); } catch (e) { /* ignore */ }
    });
    pipEls.minus.addEventListener('click', () => setFontSize(fontSize - 2));
    pipEls.plus.addEventListener('click', () => setFontSize(fontSize + 2));

    if (lastLyrics) applyLyrics(lastLyrics);
  }

  /* ---------------- 詞彙切分（支援中日韓逐字） ---------------- */

  function tokenize(text) {
    const raw = [];
    const re = /[A-Za-z0-9']+|[^\sA-Za-z0-9']/g;
    let m;
    while ((m = re.exec(text))) {
      const tok = m[0];
      if (/^[A-Za-z0-9']+$/.test(tok)) {
        raw.push(tok);
      } else {
        for (const ch of tok) raw.push(ch);
      }
    }
    const tokens = [];
    for (const t of raw) {
      if (/^[\s]$/.test(t)) continue;
      if (/^[\u3000-\u303f\uff00-\uffef!-/:-@[-`{-~。，、！？：；「」『』（）《》]$/.test(t) && tokens.length) {
        tokens[tokens.length - 1] += t;
      } else {
        tokens.push(t);
      }
    }
    return tokens;
  }

  // 沒有逐字時間軸時，依「下一行時間」與字元數等比例估算逐字時間，維持 KTV 效果
  function ensureWords() {
    const lines = current.lines;
    const dur = (current.meta && Number(current.meta.duration)) || 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.words && line.words.length) continue;
      const text = String(line.text || '').trim();
      if (!text) continue;
      const tokens = tokenize(text);
      if (!tokens.length) continue;
      const end = (i + 1 < lines.length)
        ? lines[i + 1].time
        : (dur > line.time ? dur : line.time + 5);
      const span = Math.max(0.001, end - line.time);
      const totalChars = tokens.reduce((s, w2) => s + w2.length, 0) || 1;
      let acc = 0;
      line.words = tokens.map((w2) => {
        const t = (acc / totalChars) * span;
        acc += w2.length;
        return { t: t, word: w2 };
      });
    }
  }

  /* ---------------- 渲染 ---------------- */

  function applyLyrics(msg) {
    const isNewSong = (msg.songId !== current.songId);
    current.songId = msg.songId;
    current.meta = msg.meta || null;
    current.lines = Array.isArray(msg.lines)
      ? msg.lines.map((l) => ({ time: Number(l.time) || 0, text: l.text || '', words: l.words || null }))
      : [];
    current.source = msg.source || 'none';
    current.error = msg.error || null;
    current.loading = !!msg.loading;
    if (isNewSong) {
      lastTime = 0;
      lastActive = -1;
    }
    ensureWords();
    render();
  }

  function render() {
    const doc = pipDoc;
    if (!doc || !pipEls) return;

    pipEls.title.textContent = (current.meta && current.meta.title) || '—';
    pipEls.artist.textContent = (current.meta && current.meta.artist) || '';
    pipEls.source.textContent = '來源：' + (SOURCE_LABEL[current.source] || current.source || '—');
    pipEls.list.replaceChildren();
    lastActive = -1;

    if (!current.lines.length) {
      pipEls.empty.textContent = current.loading
        ? '載入歌詞中…'
        : (current.source === 'none'
          ? ('找不到歌詞' + (current.error ? '（' + current.error + '）' : ''))
          : '尚未收到歌詞…');
      pipEls.empty.classList.add('visible');
      return;
    }

    pipEls.empty.classList.remove('visible');
    const frag = doc.createDocumentFragment();

    for (const line of current.lines) {
      const li = doc.createElement('li');
      li.className = 'lyric-line';
      if (line.words && line.words.length) {
        for (let i = 0; i < line.words.length; i++) {
          const w = line.words[i];
          const span = doc.createElement('span');
          span.className = 'word';
          span.textContent = w.word;
          li.appendChild(span);
          const next = line.words[i + 1];
          const needSpace = /[A-Za-z0-9]$/.test(w.word) || (next && /^[A-Za-z0-9]/.test(next.word));
          if (needSpace) li.appendChild(doc.createTextNode(' '));
        }
      } else {
        li.textContent = line.text;
      }
      frag.appendChild(li);
    }

    pipEls.list.appendChild(frag);
    updateProgress(lastTime);
  }

  function clearActiveHighlight() {
    if (!pipEls) return;
    const lis = pipEls.list.children;
    for (let i = 0; i < lis.length; i++) {
      const li = lis[i];
      li.classList.remove('active');
      const words = li.querySelectorAll('.word');
      for (let j = 0; j < words.length; j++) {
        words[j].classList.remove('sung', 'current');
      }
    }
    lastActive = -1;
  }

  function updateProgress(time) {
    if (!pipEls) return;
    lastTime = time;
    const lines = current.lines;
    if (!lines.length) return;

    let activeIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= time + 0.05) activeIdx = i;
      else break;
    }

    // 進度在第一句之前（前奏）或尚未有可高亮的行：清除舊高亮，避免殘留
    if (activeIdx < 0) {
      clearActiveHighlight();
      return;
    }

    const lis = pipEls.list.children;
    for (let i = 0; i < lis.length; i++) {
      lis[i].classList.toggle('active', i === activeIdx);
    }

    const li = lis[activeIdx];
    const line = lines[activeIdx];
    if (line.words && line.words.length) {
      let wordIdx = -1;
      for (let i = 0; i < line.words.length; i++) {
        if (line.time + line.words[i].t <= time + 0.05) wordIdx = i;
        else break;
      }
      const wordEls = li.querySelectorAll('.word');
      wordEls.forEach((el, i) => {
        el.classList.toggle('sung', i <= wordIdx);
        el.classList.toggle('current', i === wordIdx);
      });
    }

    if (activeIdx !== lastActive) {
      lastActive = activeIdx;
      try { li.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { li.scrollIntoView(); } catch (e2) {} }
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
