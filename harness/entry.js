import { createPlayer } from '../dist/index.js';

const params = new URLSearchParams(location.search);
const src = params.get('src');
const kind = params.get('kind') || undefined;

const stage = document.getElementById('stage');
if (kind === 'audio' || /\.mp3($|\?)/.test(src)) stage.className = 'audio';
document.getElementById('label').textContent = `${kind ?? 'auto'} — ${src}`;

const handle = createPlayer(stage, {
  src,
  ...(kind ? { kind } : {}),
  mediaId: `harness:${src}`,
  shareUrl: (s) => `https://example.test/x?t=${s}`,
});

window.__player = handle;
window.__ready = true;
