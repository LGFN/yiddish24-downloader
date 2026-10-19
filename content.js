// content.js - Adds download buttons to Yiddish24 tracks

console.log('[Yiddish24 Downloader] Content script loaded');

// Validate extension context
if (typeof chrome === 'undefined' || !chrome.runtime) {
  console.error('[Yiddish24 Downloader] Chrome extension context not available');
} else {
  console.log('[Yiddish24 Downloader] Chrome extension context OK');
}

// Native title tooltips don't refresh while open, so progress is shown in our own tooltip,
// which setStatus keeps updated while the pointer rests on the button.
let tipEl = null;
let tipOwner = null;
function showTip(owner, text) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'yiddish24-tip';
    document.body.appendChild(tipEl);
  }
  tipOwner = owner;
  tipEl.textContent = text;
  tipEl.style.display = 'block';
  const r = owner.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  const left = Math.min(Math.max(4, r.left + r.width / 2 - tw / 2), document.documentElement.clientWidth - tw - 4);
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${r.bottom + 8}px`;
}
function hideTip(owner) {
  if (tipEl && tipOwner === owner) { tipEl.style.display = 'none'; tipOwner = null; }
}

// Where a track's buttons live in the site's card layouts: most homepage cards have a row of
// small buttons (queue, share), video cards only a date row, and category pages a single
// share button above the title. On a video's own page the main item has a bar with an
// audio toggle and a share button. Carousel slides have none and get no button.
function findButtonSlot(panel) {
  const card = panel.closest('.playing-card, .news-card-item, .playing-content-wrapper') || panel.parentElement;
  if (!card) return null;
  const metaBar = card.querySelector('.channel-meta-wrapper > .share-meta-btn');
  if (metaBar) return metaBar;
  const group = card.querySelector('.card-btn-group');
  if (group) return group;
  const share = card.querySelector('.share-info-btn');
  if (share && share.querySelector('a')) return share; // still a loading placeholder otherwise
  return card.querySelector('.news-action');
}

function addDownloadButtons() {
  console.log('[Yiddish24 Downloader] Running addDownloadButtons()');

  // Every playable track carries its audio URL on a .playing-panel element
  const panels = document.querySelectorAll('.playing-panel[data-song-url]');
  console.log(`[Yiddish24 Downloader] Found ${panels.length} track panels`);

  let buttonsAdded = 0;

  panels.forEach((panel, index) => {
    const audioUrl = panel.getAttribute('data-song-url');
    if (!audioUrl) return; // articles without audio

    const slot = findButtonSlot(panel);
    if (!slot) {
      console.log(`[Yiddish24 Downloader] Track ${index + 1}: No button area found`);
      return;
    }
    if (slot.querySelector('.yiddish24-download-btn')) return; // already added

    console.log(`[Yiddish24 Downloader] Track ${index + 1}: Audio URL = ${audioUrl}`);

    // Same anchor class as the site's own card buttons so it picks up their styling
    const downloadBtn = document.createElement('a');
    downloadBtn.href = 'javascript:void(0)';
    downloadBtn.className = 'card-item-btn yiddish24-download-btn';
    downloadBtn.title = 'Download audio';
    downloadBtn.setAttribute('data-yiddish24-download', audioUrl);
    const icon = document.createElement('i');
    icon.className = 'fa-regular fa-circle-down';
    downloadBtn.appendChild(icon);

    // Add click handler with capture phase to intercept before any other handlers
    // Status display: swaps the icon, tooltip, and an optional percent label
    const statusIcons = {
      idle: 'fa-circle-down',
      downloading: 'fa-circle-down',
      cancel: 'fa-circle-xmark', // shown on hover while downloading
      done: 'fa-circle-check',
      error: 'fa-circle-exclamation'
    };
    // '' = keep the page's own theme color
    const statusColors = { idle: '', downloading: '', cancel: '#f44336', done: '#4CAF50', error: '#f44336' };
    let isDownloading = false;
    let resetTimer = null;
    let abortController = null;
    let fallbackPort = null;
    let currentText = '';
    let currentPhase = 'downloading';
    let hovering = false;
    let runId = 0; // a cancelled run can still be unwinding when the next one starts
    let doneNote = ''; // set when the original was saved because conversion failed
    let skipped = false;   // conversion was skipped; ignore its remaining progress
    let cancelling = false; // late progress from a cancelled job must not revive the UI

    // Sits after the download button, on its outer side (the site lays the buttons out right-to-left)
    const statusLabel = document.createElement('span');
    statusLabel.className = 'yiddish24-status';
    statusLabel.hidden = true;
    const statusText = document.createElement('span');
    statusText.textContent = 'Converting…';
    // Lets the user stop re-encoding and save the file as downloaded
    const skipButton = document.createElement('button');
    skipButton.type = 'button';
    skipButton.className = 'yiddish24-skip';
    skipButton.textContent = 'Download unconverted';
    skipButton.title = 'Stop converting and download the original file';
    statusLabel.append(statusText, skipButton);
    skipButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!fallbackPort) return;
      skipped = true;
      fallbackPort.postMessage({ type: 'skip-conversion' });
      currentPhase = 'downloading';
      setStatus('downloading'); // plain spinning ring until the original is saved
    });

    const setStatus = (state, text = '') => {
      currentText = text;
      // While downloading, hovering reveals an X to signal that a click cancels
      const iconState = state === 'downloading' && hovering ? 'cancel' : state;
      const statusIcon = downloadBtn.querySelector('i');
      if (statusIcon) {
        statusIcon.className = statusIcon.className
          .split(/\s+/)
          .filter(c => c && !/^fa-(circle-down|spinner|spin|circle-check|circle-exclamation|circle-xmark)$/.test(c))
          .concat(statusIcons[iconState].split(' '))
          .join(' ');
      }
      // The site colors the <i> itself, so the anchor's color never reaches the icon
      // (or the ring, which uses currentColor); set it on the icon with !important.
      if (statusIcon) {
        const color = iconState === 'done' && doneNote ? '#e69500' : statusColors[iconState]; // amber: saved, but unconverted
        if (color) statusIcon.style.setProperty('color', color, 'important');
        else statusIcon.style.removeProperty('color');
      }
      // Progress ring drawn around the icon (see styles.css)
      downloadBtn.classList.toggle('yiddish24-busy', state === 'downloading');
      downloadBtn.classList.toggle('yiddish24-indeterminate', state === 'downloading' && !text);
      downloadBtn.style.setProperty('--y24-progress', text || '25%');
      // Visible label beside the buttons while re-encoding (see styles.css)
      // Also used for a short notice after a download that fell back to the original file
      const converting = state === 'downloading' && currentPhase === 'converting';
      const notice = state === 'done' && doneNote;
      statusLabel.hidden = !(converting || notice);
      statusText.textContent = notice ? "Couldn't convert – original saved" : 'Converting…';
      skipButton.hidden = !converting;
      const tooltips = {
        idle: 'Download audio',
        downloading: (currentPhase === 'converting' ? 'Converting…' : 'Downloading…')
          + (text ? ` ${text}` : '') + ' – click to cancel',
        done: doneNote ? `Downloaded – ${doneNote}` : 'Downloaded!',
        error: 'Download failed – click to retry'
      };
      if (state === 'downloading') {
        // Own tooltip instead of title so the percentage updates live under a resting pointer
        downloadBtn.removeAttribute('title');
        if (hovering) showTip(downloadBtn, tooltips.downloading);
      } else {
        hideTip(downloadBtn);
        downloadBtn.title = tooltips[state];
      }
    };

    // Fetch via the extension (background + offscreen document) for hosts that block
    // cross-origin reads. Resolves 'done' or 'cancelled'; rejects on failure.
    const extensionDownload = (url, compat, minSeconds = 0) => new Promise((resolve, reject) => {
      const port = chrome.runtime.connect({ name: 'fallback-download' });
      fallbackPort = port;
      const finish = (fn, value) => {
        fallbackPort = null;
        port.disconnect();
        fn(value);
      };
      port.onMessage.addListener((msg) => {
        if (msg.type === 'progress') {
          if (cancelling || (skipped && msg.phase === 'converting')) return;
          currentPhase = msg.phase || 'downloading';
          setStatus('downloading', `${msg.percent}%`);
        }
        else if (msg.type === 'done') {
          doneNote = msg.note || '';
          if (doneNote) console.log('[Yiddish24 Downloader] Saved the original:', doneNote);
          finish(resolve, 'done');
        }
        else if (msg.type === 'cancelled') finish(resolve, 'cancelled');
        else if (msg.type === 'error') finish(reject, new Error(msg.error));
      });
      port.onDisconnect.addListener(() => {
        if (fallbackPort === port) { fallbackPort = null; reject(new Error('Extension disconnected')); }
      });
      port.postMessage({ type: 'start', url, compat, minSeconds });
    });

    downloadBtn.addEventListener('mouseenter', () => {
      hovering = true;
      if (isDownloading) setStatus('downloading', currentText);
    });
    downloadBtn.addEventListener('mouseleave', () => {
      hovering = false;
      hideTip(downloadBtn);
      if (isDownloading) setStatus('downloading', currentText);
    });

    downloadBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // Clicking while a download is running cancels it
      if (isDownloading) {
        abortController.abort();
        fallbackPort?.postMessage({ type: 'cancel' });
        // Reset right away; a decode in progress can't stop instantly, so don't wait for it
        cancelling = true;
        isDownloading = false;
        setStatus('idle');
        return;
      }
      isDownloading = true;
      cancelling = false;
      skipped = false;
      doneNote = '';
      const run = ++runId;
      abortController = new AbortController();
      const { signal } = abortController;
      clearTimeout(resetTimer);

      console.log(`[Yiddish24 Downloader] Download button clicked for: ${audioUrl}`);
      currentPhase = 'downloading';
      setStatus('downloading');

      try {
        // Compatibility mode re-encodes the audio, which only the extension's offscreen
        // document can do, so it always takes the extension route.
        let compat = false;
        let minSeconds = 0; // shorter audio is saved as is
        try {
          const settings = await chrome.storage.local.get({ compatibilityMode: false, compatMinMinutes: 10 });
          compat = settings.compatibilityMode;
          minSeconds = Math.max(0, Number(settings.compatMinMinutes) || 0) * 60;
        } catch (e) { /* storage unavailable: keep the default (off) */ }
        if (compat) {
          console.log('[Yiddish24 Downloader] Compatibility mode on, using extension download');
          const outcome = await extensionDownload(audioUrl, true, minSeconds);
          if (outcome === 'done') {
            setStatus('done');
            resetTimer = setTimeout(() => setStatus('idle'), doneNote ? 7000 : 3000);
          } else {
            setStatus('idle');
          }
          return;
        }

        console.log('[Yiddish24 Downloader] Fetching audio file...');

        // Fetch the file as a blob (this includes the referer automatically)
        const response = await fetch(audioUrl, { signal });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Read the body in chunks so we can report progress
        const total = parseInt(response.headers.get('content-length'), 10) || 0;
        const chunks = [];
        let received = 0;
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total) setStatus('downloading', `${Math.round((received / total) * 100)}%`);
        }

        console.log('[Yiddish24 Downloader] File fetched successfully, creating blob...');
        const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'audio/mpeg' });
        
        // Create object URL from blob
        const blobUrl = URL.createObjectURL(blob);
        
        // Create temporary anchor element for download
        const tempLink = document.createElement('a');
        tempLink.href = blobUrl;
        tempLink.download = audioUrl.split('/').pop() || 'audio.mp3';
        tempLink.style.display = 'none';
        document.body.appendChild(tempLink);
        
        console.log('[Yiddish24 Downloader] Triggering download...');
        tempLink.click();
        
        console.log('[Yiddish24 Downloader] Cleaning up...');
        document.body.removeChild(tempLink);
        
        // Clean up blob URL after a delay
        setTimeout(() => {
          URL.revokeObjectURL(blobUrl);
          console.log('[Yiddish24 Downloader] Blob URL revoked');
        }, 1000);
        
        console.log('[Yiddish24 Downloader] Download triggered successfully');
        
        setStatus('done');
        resetTimer = setTimeout(() => setStatus('idle'), 3000);

      } catch (error) {
        if (error.name === 'AbortError') {
          console.log('[Yiddish24 Downloader] Download cancelled by user');
          setStatus('idle');
          return;
        }
        // A TypeError from fetch means the host blocks cross-origin reads (CORS).
        // Fall back to the extension's own fetch, which isn't subject to that.
        let outcome = 'error';
        if (error instanceof TypeError && !signal.aborted) {
          console.log('[Yiddish24 Downloader] Fetch blocked, using extension download');
          try {
            outcome = await extensionDownload(audioUrl);
          } catch (fallbackError) {
            console.error('[Yiddish24 Downloader] Fallback failed:', fallbackError);
          }
        } else {
          console.error('[Yiddish24 Downloader] Error in download handler:', error);
        }
        if (run !== runId) {
          // superseded by a newer click; leave the UI to that run
        } else if (outcome === 'cancelled') {
          setStatus('idle');
        } else if (outcome === 'done') {
          setStatus('done');
          resetTimer = setTimeout(() => setStatus('idle'), 3000);
        } else {
          setStatus('error');
          resetTimer = setTimeout(() => setStatus('idle'), 4000);
        }
      } finally {
        if (run === runId && !cancelling) isDownloading = false;
      }
    }, true); // Use capture phase to intercept before bubbling
    
    slot.append(downloadBtn, statusLabel);
    buttonsAdded++;
  });
  
  console.log(`[Yiddish24 Downloader] Finished! Added ${buttonsAdded} download buttons`);
}

// Run when page loads
if (document.readyState === 'loading') {
  console.log('[Yiddish24 Downloader] Document still loading, waiting for DOMContentLoaded');
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[Yiddish24 Downloader] DOMContentLoaded event fired');
    addDownloadButtons();
  });
} else {
  console.log('[Yiddish24 Downloader] Document already loaded, running immediately');
  addDownloadButtons();
}

// Watch for dynamically added content
console.log('[Yiddish24 Downloader] Setting up MutationObserver');
let updateTimer = null;
const observer = new MutationObserver((mutations) => {
  let shouldUpdate = false;
  
  mutations.forEach((mutation) => {
    if (mutation.addedNodes.length > 0) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1 && (
          node.matches?.('.playing-panel[data-song-url], .card-btn-group, .share-info-btn') ||
          node.querySelector?.('.playing-panel[data-song-url]')
        )) {
          console.log('[Yiddish24 Downloader] New content detected, will add buttons');
          shouldUpdate = true;
        }
      });
    }
  });
  
  if (shouldUpdate) {
    // Cards are filled in from placeholders in bursts, so coalesce into one pass
    clearTimeout(updateTimer);
    updateTimer = setTimeout(addDownloadButtons, 100);
  }
});

// Start observing
observer.observe(document.body, {
  childList: true,
  subtree: true
});

console.log('[Yiddish24 Downloader] MutationObserver started');
