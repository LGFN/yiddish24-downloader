// background.js - Fallback downloader for files the page itself can't fetch (CORS-blocked hosts)

// The media host rejects requests that don't carry the site as the Referer (the site's own
// player sends it). Chrome's download manager ignores this rule, so the file is fetched from an
// offscreen document instead (see offscreen.js) and then saved from a blob URL.
chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://www.yiddish24.com/' }]
    },
    condition: { urlFilter: '||cloudfront.yiddish24.com/' }
  }]
});

const ports = new Map(); // download id -> content-script port

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Fetch audio with the required Referer and save it as a file'
  });
}

function toOffscreen(message) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

function filenameFor(url, compat) {
  const name = url.split('?')[0].split('/').pop() || 'audio';
  if (compat) return `${name.replace(/\.[a-z0-9]{2,4}$/i, '')}.mp3`;
  return /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.mp3`;
}

function saveBlob(blobUrl, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        reject(new Error(chrome.runtime.lastError?.message || 'Download failed to start'));
        return;
      }
      const onChanged = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === 'complete') {
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve();
        } else if (delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(new Error('Download interrupted'));
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
  });
}

async function runFallback(id, url, compat, minSeconds, port) {
  console.log('[Yiddish24 Downloader] Fallback download:', url, compat ? '(compatibility mode)' : '');
  try {
    await ensureOffscreen();
    const result = await toOffscreen({ type: 'start', id, url, compat, minSeconds });
    if (!result?.ok) {
      port.postMessage(result?.cancelled ? { type: 'cancelled' } : { type: 'error', error: result?.error });
      return;
    }
    try {
      await saveBlob(result.blobUrl, filenameFor(url, result.converted));
      port.postMessage({ type: 'done', note: result.note });
    } finally {
      toOffscreen({ type: 'revoke', blobUrl: result.blobUrl });
    }
  } catch (error) {
    console.error('[Yiddish24 Downloader] Fallback failed:', error);
    // The offscreen document vanishing mid-job means the browser killed it, almost always for memory
    const message = /message channel closed/i.test(error.message)
      ? 'The converter stopped unexpectedly (probably out of memory on a very long episode)'
      : error.message;
    try { port.postMessage({ type: 'error', error: message }); } catch (e) { /* tab closed */ }
  } finally {
    ports.delete(id);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fallback-download') return;
  const id = crypto.randomUUID();

  port.onMessage.addListener((msg) => {
    if (msg.type === 'start') {
      ports.set(id, port);
      runFallback(id, msg.url, !!msg.compat, Number(msg.minSeconds) || 0, port);
    } else if (msg.type === 'skip-conversion') {
      toOffscreen({ type: 'skip-conversion', id }).catch(() => {});
    } else if (msg.type === 'cancel') {
      toOffscreen({ type: 'cancel', id }).catch(() => {});
    }
  });
  port.onDisconnect.addListener(() => {
    toOffscreen({ type: 'cancel', id }).catch(() => {});
    ports.delete(id);
  });
});

// Progress reports from the offscreen document, relayed to the tab that asked
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target === 'background' && msg.type === 'progress') {
    ports.get(msg.id)?.postMessage({ type: 'progress', percent: msg.percent, phase: msg.phase });
  }
});
