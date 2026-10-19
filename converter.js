// converter.js - Re-encodes audio to constant-bitrate MP3 for "compatibility mode".
// Loaded by offscreen.html. The audio is decoded here, then split across parallel workers
// (encoder-worker.js) because the encoder is slow. Needs a global report(id, percent, phase).

const COMPAT_SAMPLE_RATE = 44100;
const COMPAT_BITRATE_KBPS = 128;
const MIN_SLICE_SECONDS = 30;  // don't bother splitting short audio into many tiny slices
const MAX_WORKERS = 8;
const SEAM_SEARCH_SECONDS = 2; // look this far around a split point for a quiet spot
const SEAM_WINDOW = 2048;      // samples compared when looking for the quietest spot
const WHOLE_FILE_MAX_BYTES = 40 * 1024 * 1024; // bigger files are decoded in pieces
const PIECE_FRAMES = 8000;     // MP3 frames per decoded piece (about 3.5 minutes)
const LEAD_FRAMES = 2;         // extra frames decoded before each piece, then discarded
const DECODE_SHARE = 40;       // percent of the progress ring used by decoding in pieces

const abortError = () => new DOMException('Aborted', 'AbortError');

// Settles as soon as the signal aborts, even if the work itself can't be interrupted
// (a decode in progress, or workers that were terminated and so never reply)
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
    promise.then(resolve, reject);
  });
}

// Converts float samples [from, to) straight into a fresh 16-bit array
function toInt16(float32, from, to) {
  const out = new Int16Array(to - from);
  for (let i = from; i < to; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i - from] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// True when both channels are (near) identical, so mono loses nothing and encodes ~4x faster
function isEffectivelyMono(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 0.002) return false;
  }
  return true;
}

// Each slice is encoded separately and the results are joined, which leaves a few ms of
// encoder padding at every join. Putting the joins at the quietest nearby spot hides it.
// at(i) returns the sample at position i.
function splitPoints(length, at, pieces) {
  const points = [0];
  const reach = COMPAT_SAMPLE_RATE * SEAM_SEARCH_SECONDS;
  for (let k = 1; k < pieces; k++) {
    const ideal = Math.round((length * k) / pieces);
    let best = ideal;
    let bestEnergy = Infinity;
    const from = Math.max(points[k - 1] + SEAM_WINDOW, ideal - reach);
    const to = Math.min(length - SEAM_WINDOW, ideal + reach);
    for (let p = from; p < to; p += SEAM_WINDOW) {
      let energy = 0;
      for (let i = p; i < p + SEAM_WINDOW; i += 8) energy += Math.abs(at(i));
      if (energy < bestEnergy) { bestEnergy = energy; best = p; }
    }
    // Keep joins on a whole MP3 frame (1152 samples) boundary
    points.push(Math.round(best / 1152) * 1152);
  }
  points.push(length);
  return points;
}

function encodeSlice(worker, job) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') job.onProgress(data.samples);
      else resolve(data.parts);
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Encoder worker failed'));
    worker.postMessage(job.message, job.transfer);
  });
}

// Splits the decoded audio across workers and joins their MP3 output.
// makeSlice(start, end) returns the 16-bit samples { l, r } for that range (r is null for mono).
// Progress is reported from `base` to `base + span` percent.
async function encodeInParallel({ id, signal, length, channels, at, makeSlice, base, span }) {
  const pieces = Math.max(1, Math.min(
    MAX_WORKERS,
    (navigator.hardwareConcurrency || 4) - 1,
    Math.floor(length / (COMPAT_SAMPLE_RATE * MIN_SLICE_SECONDS))
  ));
  const points = splitPoints(length, at, pieces);

  const workers = [];
  const onAbort = () => workers.forEach((w) => w.terminate());
  signal.addEventListener('abort', onAbort);
  try {
    let done = 0;
    let lastPercent = -1;
    const onProgress = (samples) => {
      done += samples;
      const percent = Math.min(99, Math.round(base + (done / length) * span));
      if (percent !== lastPercent) {
        lastPercent = percent;
        report(id, percent, 'converting');
      }
    };

    const results = await raceAbort(Promise.all(points.slice(0, -1).map((start, k) => {
      const worker = new Worker('encoder-worker.js');
      workers.push(worker);
      const { l, r } = makeSlice(start, points[k + 1]);
      return encodeSlice(worker, {
        onProgress,
        message: { channels, sampleRate: COMPAT_SAMPLE_RATE, kbps: COMPAT_BITRATE_KBPS, left: l, right: r },
        transfer: r ? [l.buffer, r.buffer] : [l.buffer]
      });
    })), signal);
    if (signal.aborted) throw abortError();
    return new Blob(results.flat(), { type: 'audio/mpeg' });
  } catch (error) {
    if (signal.aborted) throw abortError(); // terminated workers surface as errors
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    workers.forEach((w) => w.terminate());
  }
}

// ---- MP3 frame parsing, used to decode very long files in pieces ----

const MP3_BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const MP3_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// Finds every Layer III frame. Returns null if this isn't a plain MP3 stream.
function parseMp3Frames(bytes) {
  let pos = 0;
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) { // ID3v2 tag
    pos = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f))
      + ((bytes[5] & 0x10) ? 10 : 0);
  }
  const offsets = [];
  let sampleRate = 0;
  let samplesPerFrame = 0;
  while (pos + 4 <= bytes.length) {
    const b1 = bytes[pos + 1];
    const b2 = bytes[pos + 2];
    if (bytes[pos] !== 0xff || (b1 & 0xe0) !== 0xe0) {
      if (!offsets.length && pos > 1 << 20) return null; // no audio near the start
      pos++;
      continue;
    }
    const version = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    const bitrateIndex = (b2 >> 4) & 15;
    const rateIndex = (b2 >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) { pos++; continue; }
    const rate = MP3_SAMPLE_RATES[version][rateIndex];
    const isV1 = version === 3;
    const kbps = (isV1 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[bitrateIndex];
    const length = Math.floor(((isV1 ? 144000 : 72000) * kbps) / rate) + ((b2 >> 1) & 1);
    if (pos + length > bytes.length) break; // truncated last frame
    // The next frame must start right after this one, otherwise this was a false sync
    if (pos + length + 1 < bytes.length && !(bytes[pos + length] === 0xff && (bytes[pos + length + 1] & 0xe0) === 0xe0)) { pos++; continue; }
    if (!sampleRate) { sampleRate = rate; samplesPerFrame = isV1 ? 1152 : 576; }
    else if (rate !== sampleRate) { pos++; continue; }
    offsets.push(pos);
    pos += length;
  }
  return offsets.length ? { offsets, end: pos, sampleRate, samplesPerFrame } : null;
}

// ---- Conversion ----

// Decodes the whole file in one go: simplest and exact, but Chrome can't do this for very long audio
async function convertWhole(arrayBuffer, id, signal) {
  // Decoding through a 44.1 kHz context resamples the audio to 44.1 kHz
  const context = new OfflineAudioContext(2, 1, COMPAT_SAMPLE_RATE);
  const audio = await raceAbort(context.decodeAudioData(arrayBuffer), signal);
  const leftF = audio.getChannelData(0);
  const rightF = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
  const channels = rightF && !isEffectivelyMono(leftF, rightF) ? 2 : 1;
  return encodeInParallel({
    id, signal, base: 0, span: 100, length: leftF.length, channels,
    at: (i) => leftF[i],
    // Each worker's 16-bit slice is made from the float data on demand, so a long episode
    // never exists in memory in more than one full-length copy.
    makeSlice: (start, end) => ({
      l: toInt16(leftF, start, end),
      r: channels === 2 ? toInt16(rightF, start, end) : null
    })
  });
}

// Decodes one run of frames [f0, f1) on its own and returns 16-bit samples at 44.1 kHz.
// It also decodes a couple of frames before f0 (decoders need them to rebuild the first
// frame's audio) and then discards them, so every piece lines up on the frame count.
async function decodePiece(bytes, parsed, f0, f1, signal) {
  const { offsets, end, sampleRate, samplesPerFrame } = parsed;
  const ratio = COMPAT_SAMPLE_RATE / sampleRate;
  const lead = Math.min(f0, LEAD_FRAMES);
  const from = offsets[f0 - lead];
  const to = f1 < offsets.length ? offsets[f1] : end;
  const context = new OfflineAudioContext(2, 1, COMPAT_SAMPLE_RATE);
  const audio = await raceAbort(context.decodeAudioData(bytes.slice(from, to).buffer), signal);

  const skip = Math.round(lead * samplesPerFrame * ratio);
  const want = Math.round((f1 - f0) * samplesPerFrame * ratio);
  const have = Math.max(0, Math.min(want, audio.length - skip));
  const leftF = audio.getChannelData(0).subarray(skip, skip + have);
  const rightF = audio.numberOfChannels > 1 ? audio.getChannelData(1).subarray(skip, skip + have) : null;
  const left = new Int16Array(want);
  left.set(toInt16(leftF, 0, have));
  const mono = !rightF || isEffectivelyMono(leftF, rightF);
  let right = null; // only kept when the channels really differ
  if (!mono) {
    right = new Int16Array(want);
    right.set(toInt16(rightF, 0, have));
  }
  return { left, right, mono, want };
}

// Decodes a long MP3 a few minutes at a time, keeping only 16-bit samples, then encodes as above.
async function convertInPieces(bytes, parsed, id, signal) {
  const { offsets } = parsed;
  const pcm = []; // { start, left, right } in 44.1 kHz samples; right is null while the audio is mono
  let total = 0;
  let allMono = true;

  for (let f0 = 0; f0 < offsets.length; f0 += PIECE_FRAMES) {
    const f1 = Math.min(offsets.length, f0 + PIECE_FRAMES);
    const piece = await decodePiece(bytes, parsed, f0, f1, signal);
    const { left, want } = piece;
    if (!piece.mono && allMono) {
      allMono = false;
      for (const p of pcm) p.right = p.left; // earlier pieces were identical in both channels
    }
    pcm.push({ start: total, left, right: allMono ? null : (piece.right || left) });
    total += want;
    report(id, Math.round((DECODE_SHARE * f1) / offsets.length), 'converting');
  }

  const starts = pcm.map((p) => p.start);
  const locate = (i) => {
    let lo = 0;
    let hi = pcm.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= i) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  const channels = allMono ? 1 : 2;
  return encodeInParallel({
    id, signal, base: DECODE_SHARE, span: 100 - DECODE_SHARE, length: total, channels,
    at: (i) => { const k = locate(i); return pcm[k].left[i - starts[k]]; },
    makeSlice: (start, stop) => {
      const l = new Int16Array(stop - start);
      const r = channels === 2 ? new Int16Array(stop - start) : null;
      for (let k = locate(start); k < pcm.length && pcm[k] && starts[k] < stop; k++) {
        const p = pcm[k];
        const a = Math.max(start, p.start);
        const b = Math.min(stop, p.start + p.left.length);
        l.set(p.left.subarray(a - p.start, b - p.start), a - start);
        if (r) r.set(p.right.subarray(a - p.start, b - p.start), a - start);
      }
      // Pieces that end before this slice does can't be needed again: let them be freed
      for (let k = 0; k < pcm.length; k++) {
        if (pcm[k] && pcm[k].start + pcm[k].left.length <= stop) pcm[k] = null;
      }
      return { l, r };
    }
  });
}

async function convertToCbrMp3(blob, id, signal) {
  report(id, 0, 'converting'); // decoding comes first
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parsed = parseMp3Frames(bytes);
  if (!(parsed && bytes.length > WHOLE_FILE_MAX_BYTES)) {
    try {
      return await convertWhole(bytes.slice().buffer, id, signal); // decodeAudioData detaches what it's given
    } catch (error) {
      if (error.name === 'AbortError' || !parsed) throw error;
      console.warn('Decoding the whole file failed, decoding it in pieces:', error.message);
    }
  }
  return convertInPieces(bytes, parsed, id, signal);
}
