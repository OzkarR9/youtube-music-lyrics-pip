// 工具列 popup：狀態顯示、開啟/關閉、字型大小設定、診斷資訊

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const SOURCE_LABEL = {
    'lrclib': 'LRCLIB',
    'youtube-music': 'YouTube Music',
    'none': '無'
  };

  function chromeMajor() {
    const m = /\bChrome\/(\d+)/.exec(navigator.userAgent || '');
    return m ? Number(m[1]) : 0;
  }

  async function getActiveTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs && tabs[0];
    } catch (e) {
      return null;
    }
  }

  function isYtMusicTab(tab) {
    return !!(tab && /^https?:\/\/music\.youtube\.com/.test(tab.url || ''));
  }

  async function refresh() {
    // 1) 讀 storage（content script 寫入的快照）
    let state = null;
    let settings = null;
    try {
      const res = await chrome.storage.local.get(['state', 'settings']);
      state = res.state || null;
      settings = res.settings || null;
    } catch (e) { /* ignore */ }

    const s = state || {};

    // 2) Chrome 版本與 Document PiP 支援
    const ver = chromeMajor();
    $('chrome-version').textContent = ver
      ? ('v' + ver + (ver >= 116 ? '（支援）' : '（不支援 PiP，需升級）'))
      : '未知';

    // 3) 即時向頁面 content script 查詢（比 storage 更準）
    const tab = await getActiveTab();
    let live = null;
    if (isYtMusicTab(tab)) {
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'get-status' });
        if (resp && resp.ok) live = resp;
      } catch (e) { /* content script 未載入 */ }
    }

    if (!isYtMusicTab(tab)) {
      $('injected').textContent = '請開啟 music.youtube.com';
    } else if (live) {
      $('injected').textContent = '已載入';
    } else {
      $('injected').textContent = '未載入（請重新整理分頁）';
    }

    // 合併 live / storage
    const pipOpen = live ? live.pipOpen : s.pipOpen;
    const song = live ? live.song : s.song;
    const source = live ? live.source : s.source;
    const hasLyrics = live ? live.hasLyrics : s.hasLyrics;
    const error = live ? live.error : s.error;
    const supported = live ? live.supported : s.supported;

    $('pip-state').textContent = pipOpen ? '開啟中' : '未開啟';
    $('song').textContent = song ? `${song.title} — ${song.artist}` : '—';

    if (hasLyrics) {
      $('source').textContent = SOURCE_LABEL[source] || source || '—';
    } else {
      $('source').textContent = source === 'none' ? '找不到歌詞' : '—';
    }

    $('error').textContent = error || '—';
    $('font-size').textContent = (settings && settings.fontSize) || 28;
    $('toggle').textContent = pipOpen ? '關閉子母畫面' : '開啟子母畫面';
  }

  function setHint(msg, warn) {
    $('hint').textContent = msg;
    $('hint').classList.toggle('warn', !!warn);
  }

  $('toggle').addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!isYtMusicTab(tab)) {
      setHint('請先開啟 YouTube Music 分頁。', true);
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle-pip' });
      setHint('已送出切換指令。若無法開啟，請點擊播放器旁的「PiP 歌詞」按鈕或按 Alt+L（瀏覽器限制需頁面操作）。');
    } catch (e) {
      setHint('頁面腳本未載入，請按「重新整理分頁」後再試。', true);
    }
    setTimeout(refresh, 400);
  });

  $('reload').addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!isYtMusicTab(tab)) {
      setHint('請先開啟 YouTube Music 分頁。', true);
      return;
    }
    try {
      await chrome.tabs.reload(tab.id);
      window.close();
    } catch (e) {
      setHint('無法重新整理分頁。', true);
    }
  });

  $('font-minus').addEventListener('click', () => changeFont(-2));
  $('font-plus').addEventListener('click', () => changeFont(2));

  async function changeFont(delta) {
    let settings = null;
    try {
      const res = await chrome.storage.local.get('settings');
      settings = res.settings || null;
    } catch (e) { /* ignore */ }
    const cur = (settings && settings.fontSize) || 28;
    const next = Math.min(64, Math.max(16, cur + delta));
    try {
      await chrome.storage.local.set({ settings: { fontSize: next } });
    } catch (e) { /* ignore */ }
    $('font-size').textContent = next;
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.state) refresh();
    });
  } catch (e) { /* ignore */ }

  refresh();
})();
