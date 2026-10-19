// encoder-worker.js - Encodes one slice of PCM audio to constant-bitrate MP3 (lamejs).
// Several of these run in parallel from offscreen.js; each reports how many samples it has finished.

importScripts('lame.min.js');

const BLOCK = 1152 * 40;

onmessage = ({ data: { channels, sampleRate, kbps, left, right } }) => {
  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, kbps);
  const parts = [];
  for (let i = 0; i < left.length; i += BLOCK) {
    const chunk = encoder.encodeBuffer(
      left.subarray(i, i + BLOCK),
      right ? right.subarray(i, i + BLOCK) : undefined
    );
    if (chunk.length) parts.push(chunk);
    postMessage({ type: 'progress', samples: Math.min(BLOCK, left.length - i) });
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(tail);
  postMessage({ type: 'done', parts }, parts.map((p) => p.buffer));
};
