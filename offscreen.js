// offscreen.js - Fetches audio the page itself can't read (CORS-blocked host) and hands back a blob URL.
// Requests from here go through the extension's host permissions, and the background worker's
// declarativeNetRequest rule adds the Referer the media host requires.
// With compatibility mode on, the audio is also re-encoded to constant-bitrate MP3 (see converter.js).

const controllers = new Map();

function report(id, percent, phase) {
  chrome.runtime.sendMessage({ target: 'background', type: 'progress', id, percent, phase });
}

// Duration from the file's metadata (cheap, unlike decoding); NaN when it can't be determined
function audioDuration(blob) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(blob);
    const finish = (value) => {
      clearTimeout(timer);
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(NaN), 5000);
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish(NaN);
    audio.src = url;
  });
}

async function fetchAsBlobUrl(id, url, compat, minSeconds) {
  const controller = new AbortController();
  const entry = { controller, convert: null }; // convert: aborts just the re-encoding ("save original")
  controllers.set(id, entry);
  let converted = false;
  let note = '';
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const total = parseInt(response.headers.get('content-length'), 10) || 0;
    const chunks = [];
    let received = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) report(id, Math.round((received / total) * 100), 'downloading');
    }
    let blob = new Blob(chunks, { type: response.headers.get('content-type') || 'audio/mpeg' });
    // Short audio rarely has seeking problems, so it is saved as is. An unknown length is converted.
    if (compat && minSeconds > 0) {
      const duration = await audioDuration(blob);
      if (duration < minSeconds) compat = false;
    }
    if (compat) {
      const convert = new AbortController();
      entry.convert = convert;
      controller.signal.addEventListener('abort', () => convert.abort()); // a full cancel stops it too
      try {
        blob = await convertToCbrMp3(blob, id, convert.signal);
        converted = true;
      } catch (error) {
        if (error.name === 'AbortError') {
          if (controller.signal.aborted) throw error; // cancelled
          // otherwise the conversion was skipped: keep the original blob
        } else {
          // Don't lose the download: keep the original file and tell the user
          console.warn(`Conversion failed, saving the original: ${error.message} `
            + JSON.stringify({ type: blob.type, bytes: blob.size, url }));
          note = "Couldn't convert this file, so the original was saved";
        }
      }
    }
    return { blobUrl: URL.createObjectURL(blob), converted, note };
  } finally {
    controllers.delete(id);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === 'start') {
    fetchAsBlobUrl(msg.id, msg.url, msg.compat, msg.minSeconds).then(
      (result) => sendResponse({ ok: true, ...result }),
      (error) => sendResponse({ ok: false, cancelled: error.name === 'AbortError', error: error.message })
    );
    return true; // async response
  }
  if (msg.type === 'cancel') {
    controllers.get(msg.id)?.controller.abort();
  } else if (msg.type === 'skip-conversion') {
    controllers.get(msg.id)?.convert?.abort();
  } else if (msg.type === 'revoke') {
    URL.revokeObjectURL(msg.blobUrl);
  }
});
