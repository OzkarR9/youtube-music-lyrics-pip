// ISOLATED world content script：
// 1. 抓取目前歌曲資訊（曲名/歌手/專輯/時長/影片 ID）
// 2. 混合策略解析歌詞（LRCLIB 逐字優先、YouTube Music 介面文字降級）
// 3. 注入頁內「PiP 歌詞」按鈕、輪詢播放進度，經 window.postMessage 推播給 MAIN world
// 4. 與 MAIN world（pip-opener.js）通訊：資料用 postMessage，狀態用 DOM CustomEvent

(() => {
  'use strict';
  if (window.__ymlpContentLoaded) return;
  window.__ymlpContentLoaded = true;

  const state = {
    pipOpen: false,
    supported: false,
    lastError: null,
    currentSong: null,   // { id, title, artist, album, duration, videoId }
    currentLyrics: null  // { songId, meta, lines, source }
  };

  let toastEl = null;
  let toastTimer = null;
  let detectTimer = null;
  let progressTimer = null;
  let lyricsTimer = null;

  /* ---------------- 小工具 ---------------- */

  function q(sel) {
    try { return document.querySelector(sel); } catch (e) { return null; }
  }

  function textOf(sel) {
    const el = q(sel);
    return el ? String(el.textContent || '').trim() : '';
  }

  // 送資料給 MAIN world（structured clone，跨 world 最乾淨的方式）
  function postToMain(msg) {
    try {
      window.postMessage(Object.assign({ __ymlp: true }, msg), '*');
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 與 MAIN world（pip-opener.js）通訊 ---------------- */

  // MAIN world 回報支援狀態
  document.addEventListener('ymlp:ready', (e) => {
    state.supported = !!(e.detail && e.detail.supported);
    updateState();
  });

  // MAIN world 回報 PiP 開啟/關閉/錯誤
  document.addEventListener('ymlp:status', (e) => {
    const d = e.detail || {};
    switch (d.type) {
      case 'opened':
        state.pipOpen = true;
        pushCurrentLyrics();
        startProgress();
        updateState();
        break;
      case 'closed':
        state.pipOpen = false;
        stopProgress();
        updateState();
        break;
      case 'unsupported':
        showToast('此瀏覽器不支援 Document Picture-in-Picture（需 Chrome 116 或更新版本）');
        break;
      case 'error':
        showToast('需要於頁面操作才能開啟：請點擊播放器旁的「PiP 歌詞」按鈕，或按 Alt+L');
        break;
    }
  });

  // 使用者在子母畫面裡調整字型大小 → 存回 storage（供 popup 顯示）
  document.addEventListener('ymlp:fontsize', (e) => {
    const v = e.detail && e.detail.fontSize;
    if (v != null) {
      chrome.storage.local.set({ settings: { fontSize: v } }).catch(() => {});
    }
  });

  // 把目前字型設定送給 MAIN world（popup 調整時也會經 storage.onChanged 觸發）
  function sendSettings() {
    chrome.storage.local.get('settings', (res) => {
      const fs = (res && res.settings && res.settings.fontSize) || 28;
      postToMain({ type: 'settings', fontSize: fs });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings && changes.settings.newValue && changes.settings.newValue.fontSize != null) {
      postToMain({ type: 'settings', fontSize: changes.settings.newValue.fontSize });
    }
  });

  /* ---------------- 接收 popup / 快捷鍵指令 ---------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'toggle-pip') {
      document.dispatchEvent(new CustomEvent('ymlp:toggle'));
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'get-status') {
      const s = state.currentSong;
      sendResponse({
        ok: true,
        pipOpen: state.pipOpen,
        supported: state.supported,
        song: s ? { title: s.title, artist: s.artist, album: s.album, duration: s.duration, videoId: s.videoId } : null,
        source: state.currentLyrics ? state.currentLyrics.source : null,
        hasLyrics: !!(state.currentLyrics && state.currentLyrics.lines.length),
        error: state.lastError
      });
      return false;
    }
  });

  /* ---------------- Toast ---------------- */

  function showToast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'ymlp-toast';
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
  }

  /* ---------------- 頁內按鈕注入 ---------------- */

  const STYLE_TEXT = [
    '#ymlp-pip-button{display:inline-flex!important;align-items:center;justify-content:center;width:40px;height:40px;border:none;border-radius:50%;background:transparent;cursor:pointer;color:#fff;opacity:.85;transition:opacity .15s,background-color .15s;vertical-align:middle;flex:none;}',
    '#ymlp-pip-button:hover{opacity:1;background-color:rgba(255,255,255,.15);}',
    '#ymlp-pip-button.floating{position:fixed;right:16px;bottom:100px;z-index:2147483646;background:rgba(20,20,20,.75);box-shadow:0 2px 12px rgba(0,0,0,.4);}',
    '#ymlp-pip-button svg{fill:currentColor;}',
    '#ymlp-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(20px);background:rgba(30,30,30,.95);color:#fff;padding:10px 16px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.4);opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;max-width:80vw;}',
    '#ymlp-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}'
  ].join('\n');

  function injectButton() {
    if (document.getElementById('ymlp-pip-button')) return;

    if (!document.getElementById('ymlp-style')) {
      const st = document.createElement('style');
      st.id = 'ymlp-style';
      st.textContent = STYLE_TEXT;
      (document.head || document.documentElement).appendChild(st);
    }

    const btn = document.createElement('button');
    btn.id = 'ymlp-pip-button';
    btn.type = 'button';
    btn.title = '歌詞子母畫面 (Alt+L)';
    btn.setAttribute('aria-label', '歌詞子母畫面');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
      '<path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z"/>' +
      '</svg>';

    const targets = [
      q('ytmusic-player-bar .right-controls'),
      q('ytmusic-player-bar #right-controls'),
      q('#right-controls'),
      q('ytmusic-player-bar .left-controls'),
      q('ytmusic-player-bar #left-controls'),
      q('ytmusic-player-bar'),
      q('#player-bar'),
      q('ytmusic-app-layout')
    ];
    const host = targets.find(Boolean);
    if (host) {
      host.appendChild(btn);
      console.log('[YMLP] 頁內按鈕已注入:', host.className || host.id || host.tagName);
    } else {
      btn.classList.add('floating');
      (document.body || document.documentElement).appendChild(btn);
      console.log('[YMLP] 頁內按鈕（浮動備援）已注入');
    }
  }

  const btnTimer = setInterval(() => {
    if (!document.getElementById('ymlp-pip-button')) injectButton();
  }, 1000);
  injectButton();

  /* ---------------- 歌曲資訊偵測 ---------------- */

  function titleFromDocTitle() {
    let t = String(document.title || '').replace(/\s*-\s*YouTube Music\s*$/i, '');
    const parts = t.split(/\s*[•·–—|-]\s*/);
    return {
      title: (parts[0] || '').trim(),
      artist: parts.slice(1).filter(Boolean).join(', ')
    };
  }

  function getTitle() {
    const sels = [
      'ytmusic-player-bar yt-formatted-string.title',
      'ytmusic-player-bar .song-info .title',
      'ytmusic-player-bar .content-info-wrapper .title'
    ];
    for (const s of sels) {
      const t = textOf(s);
      if (t && !/^(廣告|advertisement)$/i.test(t)) return t;
    }
    return titleFromDocTitle().title;
  }

  function getArtist() {
    const sels = [
      'ytmusic-player-bar .song-info span.byline a',
      'ytmusic-player-bar span.byline a',
      'ytmusic-player-bar .song-info .byline a',
      'ytmusic-player-bar .byline a'
    ];
    for (const s of sels) {
      let els = [];
      try { els = Array.from(document.querySelectorAll(s)); } catch (e) { /* ignore */ }
      const names = [];
      for (const el of els) {
        const t = String(el.textContent || '').trim();
        if (t && !names.includes(t)) names.push(t);
      }
      if (names.length) return names.join(', ');
    }
    return titleFromDocTitle().artist;
  }

  function getAlbum() {
    const sels = [
      'ytmusic-player-bar .song-info .album',
      'ytmusic-player-bar .byline .album'
    ];
    for (const s of sels) {
      const t = textOf(s);
      if (t) return t;
    }
    return '';
  }

  function getVideoId() {
    try {
      if (location.pathname === '/watch') {
        return new URLSearchParams(location.search).get('v') || '';
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function getVideo() {
    return q('video') || q('video.html5-main-video');
  }

  function getDuration() {
    const v = getVideo();
    if (v && isFinite(v.duration) && v.duration > 0) return v.duration;
    return 0;
  }

  // 最可靠的來源：Media Session（YT Music 會設定目前播放的曲目/歌手/專輯）
  function mediaSessionMeta() {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      if (md) {
        const title = String(md.title || '').trim();
        if (title) {
          return {
            title,
            artist: String(md.artist || '').trim(),
            album: String(md.album || '').trim()
          };
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function detectSong() {
    const ms = mediaSessionMeta();
    let title, artist, album;
    if (ms) {
      title = ms.title;
      artist = ms.artist;
      album = ms.album;
    } else {
      title = getTitle();
      artist = getArtist();
      album = getAlbum();
    }
    if (!title) return;

    const duration = getDuration();
    const videoId = getVideoId();
    const id = [title, artist, videoId].filter(Boolean).join('|');

    if (state.currentSong && state.currentSong.id === id) return;

    state.currentSong = { id, title, artist, album, duration, videoId };
    console.log('[YMLP] 偵測到歌曲:', JSON.stringify({ title, artist, album, duration, videoId, via: ms ? 'mediaSession' : 'dom' }));
    updateState();
    resolveLyrics();
  }

  /* ---------------- 歌詞解析（混合策略） ---------------- */

  // 抓取 YouTube Music 歌詞面板文字（best-effort，僅供降級靜態顯示）
  function scrapeYtMusicLyrics() {
    const roots = [
      q('ytmusic-description-shelf #description'),
      q('ytmusic-description-shelf .description'),
      q('ytmusic-description-shelf')
    ];
    for (const root of roots) {
      if (!root) continue;
      const kids = Array.from(root.children || []);
      if (kids.length >= 2) {
        const lines = kids.map((k) => String(k.textContent || '').trim()).filter(Boolean);
        if (lines.length) return lines;
      }
      const text = String(root.textContent || '').trim();
      const lines = text.split(/\n+/).map((x) => x.trim()).filter(Boolean);
      if (lines.length) return lines;
    }
    return [];
  }

  function staticLines(texts, duration) {
    const dur = duration || 0;
    const step = texts.length > 1 && dur > 0 ? dur / texts.length : 3;
    return texts.map((t, i) => ({ time: +(i * step).toFixed(3), text: t, words: null }));
  }

  let resolveSeq = 0;

  async function resolveLyrics() {
    const song = state.currentSong;
    if (!song) return;
    const seq = ++resolveSeq;

    const ytText = scrapeYtMusicLyrics();

    let lr = null;
    try {
      lr = await chrome.runtime.sendMessage({
        type: 'fetch-lyrics',
        meta: { title: song.title, artist: song.artist, album: song.album, duration: song.duration }
      });
    } catch (e) { lr = null; }

    // 過期結果丟棄
    if (seq !== resolveSeq || !state.currentSong || state.currentSong.id !== song.id) return;

    let lines = [];
    let source = 'none';
    if (lr && lr.ok && Array.isArray(lr.lines) && lr.lines.length) {
      lines = lr.lines;
      source = 'lrclib';
      state.lastError = null;
    } else if (ytText && ytText.length) {
      lines = staticLines(ytText, song.duration);
      source = 'youtube-music';
      state.lastError = null;
    } else {
      state.lastError = (lr && lr.reason) ? lr.reason : 'no-lyrics';
      console.warn('[YMLP] 找不到歌詞:', JSON.stringify({ title: song.title, artist: song.artist, album: song.album }), '原因:', state.lastError, 'YT介面行數:', ytText.length);
    }

    state.currentLyrics = {
      songId: song.id,
      meta: { title: song.title, artist: song.artist, album: song.album, duration: song.duration },
      lines,
      source
    };

    console.log('[YMLP] 歌詞解析完成:', source, lines.length + ' 行', state.lastError ? ('原因=' + state.lastError) : '');
    if (state.pipOpen) pushCurrentLyrics();
    updateState();
  }

  function pushCurrentLyrics() {
    if (!state.pipOpen || !state.currentLyrics) return;
    postToMain({
      type: 'lyrics',
      songId: state.currentLyrics.songId,
      meta: state.currentLyrics.meta,
      lines: state.currentLyrics.lines,
      source: state.currentLyrics.source,
      error: state.lastError
    });
  }

  /* ---------------- 播放進度推播 ---------------- */

  function currentTime() {
    const v = getVideo();
    if (v && isFinite(v.currentTime) && v.currentTime >= 0) return v.currentTime;
    // 找不到 <video> 時，從進度條元素估計
    try {
      const p = q('#progress-bar');
      const val = p && p.getAttribute('aria-valuenow');
      if (val != null && isFinite(Number(val))) return Number(val);
      const tp = q('tp-yt-paper-slider');
      if (tp && tp.value != null && isFinite(Number(tp.value))) return Number(tp.value);
    } catch (e) { /* ignore */ }
    return 0;
  }

  function startProgress() {
    stopProgress();
    progressTimer = setInterval(() => {
      if (!state.currentSong) return;
      postToMain({
        type: 'progress',
        songId: state.currentSong.id,
        time: currentTime()
      });
    }, 250);
    // 定期重送歌詞：補救 PiP 剛開啟時的競態
    lyricsTimer = setInterval(pushCurrentLyrics, 2000);
  }

  function stopProgress() {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    if (lyricsTimer) {
      clearInterval(lyricsTimer);
      lyricsTimer = null;
    }
  }

  /* ---------------- 狀態同步到 storage（供 popup 讀取） ---------------- */

  function updateState() {
    const s = state.currentSong;
    chrome.storage.local.set({
      state: {
        pipOpen: state.pipOpen,
        supported: state.supported,
        song: s ? { title: s.title, artist: s.artist, album: s.album, duration: s.duration, videoId: s.videoId } : null,
        source: state.currentLyrics ? state.currentLyrics.source : null,
        hasLyrics: !!(state.currentLyrics && state.currentLyrics.lines.length),
        error: state.lastError
      }
    }).catch(() => {});
  }

  /* ---------------- 啟動偵測迴圈 ---------------- */

  detectSong();
  detectTimer = setInterval(detectSong, 800);
  sendSettings();
  updateState();
})();
