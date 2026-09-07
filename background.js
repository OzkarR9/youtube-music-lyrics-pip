// Service worker：
// 1. 負責 LRCLIB 歌詞查詢（外部 API）
// 2. 工具列快捷鍵（manifest commands）轉發
//
// 歌詞與進度的推播不再經過這裡——content.js 直接以 window.postMessage 送給
// MAIN world 的 pip-opener.js，由其寫入子母畫面視窗（同源，無跨來源導航）。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'fetch-lyrics') {
    fetchLyricsFromLrclib(msg.meta || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, reason: 'error', message: String((err && err.message) || err) }));
    return true; // 非同步回應
  }

  sendResponse({ ok: false, reason: 'unknown-type' });
  return false;
});

// 工具列快捷鍵（manifest commands）：因為 Document PiP 需要頁面內的使用者啟動權，
// 這裡只能轉發給 content script 嘗試切換；若無法開啟，content script 會顯示 toast 引導。
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-pip') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    for (const tab of tabs || []) {
      if (tab.url && tab.url.startsWith('https://music.youtube.com')) {
        chrome.tabs.sendMessage(tab.id, { type: 'toggle-pip' }).catch(() => {});
      }
    }
  });
});

/* ---------------- LRCLIB 查詢 ---------------- */

// 清除 YT Music 曲名常見的後綴（Official Video / Audio / 頻道等），提高 LRCLIB 比對率
function cleanTitle(s) {
  return String(s || '')
    .replace(/\s*[\(\[（【].*?[\)\]）】]\s*$/g, '') // 結尾括號註解
    .replace(/\s*\|.*$/, '')                            // "| ..."
    .replace(/\s*[-–—]\s*(Official\s*)?(Music\s*)?Video(\s*Audio)?\s*$/i, '')
    .trim();
}

async function fetchLyricsFromLrclib(meta) {
  const title = cleanTitle(meta.title);
  const artist = String(meta.artist || '').trim();
  const album = String(meta.album || '').trim();
  const duration = meta.duration ? Math.round(Number(meta.duration)) : 0;

  if (!title) return { ok: false, reason: 'no-title' };

  const timeout = { signal: AbortSignal.timeout(8000) };

  // 多層次查詢：duration/album/artist 常因 YT Music 的影片時長或呈現方式而比對失敗，
  // 逐步放寬條件，確保能命中結果。
  const tiers = [];
  if (duration > 0) tiers.push({ track_name: title, artist_name: artist, album_name: album, duration: String(duration) });
  tiers.push({ track_name: title, artist_name: artist, album_name: album });
  tiers.push({ track_name: title, artist_name: artist });
  tiers.push({ track_name: title });

  let lastReason = 'no-match';

  for (const tier of tiers) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(tier)) {
      if (v) params.set(k, v);
    }

    let results;
    try {
      const res = await fetch(`https://lrclib.net/api/search?${params.toString()}`, timeout);
      if (!res.ok) { lastReason = 'http-' + res.status; continue; }
      results = await res.json();
    } catch (err) {
      lastReason = 'network';
      console.warn('[YMLP] LRCLIB search failed:', params.toString(), err);
      continue;
    }

    if (!Array.isArray(results) || results.length === 0) {
      console.log('[YMLP] LRCLIB no result for:', params.toString());
      continue;
    }

    const best = results.find((r) => r && r.syncedLyrics) || results[0];
    if (best && best.syncedLyrics) {
      const lines = parseLrc(best.syncedLyrics);
      if (lines.length) {
        console.log('[YMLP] LRCLIB matched:', best.trackName, '-', best.artistName, `(${lines.length} lines)`);
        return {
          ok: true,
          lines,
          source: 'lrclib',
          matched: {
            trackName: best.trackName,
            artistName: best.artistName,
            albumName: best.albumName
          }
        };
      }
    }
    lastReason = 'no-synced';
  }

  // 最後手段：直接以曲名呼叫 /api/get
  try {
    const gparams = new URLSearchParams({ track_name: title });
    const res = await fetch(`https://lrclib.net/api/get?${gparams.toString()}`, timeout);
    if (res.ok) {
      const rec = await res.json();
      if (rec && rec.syncedLyrics) {
        const lines = parseLrc(rec.syncedLyrics);
        if (lines.length) {
          return { ok: true, lines, source: 'lrclib', matched: { trackName: rec.trackName, artistName: rec.artistName, albumName: rec.albumName } };
        }
      }
      lastReason = 'no-synced';
    } else {
      lastReason = 'get-http-' + res.status;
    }
  } catch (err) {
    lastReason = 'network';
    console.warn('[YMLP] LRCLIB get failed:', err);
  }

  console.warn('[YMLP] LRCLIB all attempts failed, reason:', lastReason, 'for:', title, artist);
  return { ok: false, reason: lastReason };
}

/* ---------------- LRC 解析（含 enhanced LRC 逐字時間軸） ---------------- */

function parseLrc(text) {
  const lines = [];
  const lineRe = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)$/;
  const tagRe = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = lineRe.exec(raw);
    if (!m) continue;
    const time = toSeconds(m[1], m[2], m[3]);
    const content = String(m[4] || '').trim();
    if (!content) continue;

    const words = parseWords(content);
    const plain = content.replace(tagRe, '').replace(/\s+/g, ' ').trim();

    lines.push({ time, text: plain || content, words });
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

function toSeconds(mm, ss, frac) {
  let t = Number(mm) * 60 + Number(ss);
  if (frac !== undefined && frac !== '') {
    t += Number(frac) / (String(frac).length === 3 ? 1000 : 100);
  }
  return t;
}

// 解析 enhanced LRC 的逐字時間戳（<mm:ss.xx>word<mm:ss.xx>word）
// 若沒有逐字時間戳則回傳 null
function parseWords(content) {
  const parts = content.split(/(<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>)/);
  const words = [];
  let cur = null;

  for (const part of parts) {
    if (!part) continue;
    const tm = /^<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>$/.exec(part);
    if (tm) {
      cur = toSeconds(tm[1], tm[2], tm[3]);
    } else if (cur !== null) {
      const word = part.trim();
      if (word) words.push({ t: cur, word });
    }
  }

  return words.length ? words : null;
}
