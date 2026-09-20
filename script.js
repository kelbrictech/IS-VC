// ---------- State ----------
let frames = [];            // { id, dataUrl, durationMs: number|null }
let viewMode = 'master'; // 'master' | 'tabular' \u2014 one global switch covering Movie Generator, Audio, and Subtitles
let selectedFrameId = null;
let selectedFrameIds = new Set(); // multi-select for bulk move/delete; selectedFrameId still drives the duration inspector
let selectionAnchorId = null;     // last clicked frame, for shift-click range select
let globalFps = 12;
let audioClip = null;       // { name, dataUrl, buffer: AudioBuffer, peaks: number[], trimStart, trimEnd, offsetMs, volume } | null
let captureStream = null;
let nextFrameId = 1;
let bundles = {};           // { [bundleId]: { id, label, collapsed } } \u2014 groups of frames added together from an extracted group
let nextBundleId = 1;
let subtitles = [];         // { id, text, startMs, durationMs, size: 'small'|'medium'|'large', style: 'light-shadow'|'dark-glow', xFrac, yFrac, revealMode: 'all'|'words'|'letters' }
let nextSubtitleId = 1;
let selectedSubtitleId = null;
let watermark = null;       // { dataUrl, img, naturalWidth, naturalHeight, position } | null

const previewCanvas = document.getElementById('preview-canvas');
const previewCtx = previewCanvas.getContext('2d');
const previewCaption = document.getElementById('preview-caption');
const captureVideo = document.getElementById('capture-video');
const frameTrack = document.getElementById('frame-track');
const frameCountLabel = document.getElementById('frame-count');
const frameDurationInput = document.getElementById('frame-duration-input');
const globalFpsInput = document.getElementById('global-fps-input');
const audioNameLabel = document.getElementById('audio-name');
const audioCanvas = document.getElementById('audio-waveform');
const exportModal = document.getElementById('export-modal');
const exportStatus = document.getElementById('export-status');
const exportPresetSelect = document.getElementById('export-preset');
const customSizeRow = document.getElementById('custom-size-row');

// ---------- Helpers ----------
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function drawContain(ctx, img, W, H) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const scale = Math.min(W / img.width, H / img.height);
  const w = img.width * scale, h = img.height * scale;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

function formatTime(ms) {
  const totalSeconds = Math.max(0, ms) / 1000;
  const m = Math.floor(totalSeconds / 60);
  const s = (totalSeconds % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

// ---------- Memory budget constants ----------
const THUMBNAIL_MAX_DIM = 160;        // timeline/tray thumbnails never hold more than this
const DECODE_CACHE_LIMIT = 6;         // full-res bitmaps kept decoded at once during playback/export
const LITE_BUNDLE_THRESHOLD = 40;     // extractor batches above this store recipes, not baked images
const SOFT_WARN_SLICE_COUNT = 100;    // slice-count field shows a heads-up past this
const HARD_CONFIRM_SLICE_COUNT = 250; // requires an explicit confirm past this
const SMOOTH_PAN_TARGET_STEP_RATIO = 0.03; // strict: aim for \u22643% of the box's own diagonal moved per slice

// ---------- Streaming decode cache ----------
// Holds at most DECODE_CACHE_LIMIT decoded bitmaps at a time (keyed by frame
// id), evicting the least-recently-used one. This is what lets playback and
// export step through hundreds of frames without ever holding more than a
// handful of full-resolution bitmaps in memory simultaneously.
const frameImageCache = new Map(); // frame.id -> { img, lastUsed }
const sourceImageCache = new Map(); // sourceDataUrl -> Image (decoded once, reused by every recipe frame from that source)
let frameCacheCounter = 0;

function evictOldestFromCache() {
  let oldestKey = null, oldestUsed = Infinity;
  frameImageCache.forEach((v, k) => { if (v.lastUsed < oldestUsed) { oldestUsed = v.lastUsed; oldestKey = k; } });
  if (oldestKey !== null) frameImageCache.delete(oldestKey);
}

async function getSourceImage(sourceDataUrl) {
  if (sourceImageCache.has(sourceDataUrl)) return sourceImageCache.get(sourceDataUrl);
  const img = await loadImage(sourceDataUrl);
  sourceImageCache.set(sourceDataUrl, img);
  return img;
}

// Regenerates a lite (recipe-only) frame's full-resolution pixels on demand.
// Never stored back onto the frame \u2014 callers that need it repeatedly go
// through getFrameImage(), which caches the decoded result transiently.
async function resolveFrameDataUrlFromRecipe(recipe) {
  const srcImg = await getSourceImage(recipe.sourceDataUrl);
  const off = document.createElement('canvas');
  off.width = recipe.outW; off.height = recipe.outH;
  const octx = off.getContext('2d');
  octx.drawImage(srcImg, recipe.sx, recipe.sy, recipe.sw, recipe.sh, 0, 0, recipe.outW, recipe.outH);
  return off.toDataURL('image/png');
}

// The single entry point playback/export/preview use to get a frame's
// decoded bitmap \u2014 transparently handles both baked frames (real dataUrl)
// and lite frames (regenerated from a recipe), through the same small cache.
async function getFrameImage(frame) {
  const hit = frameImageCache.get(frame.id);
  if (hit) { hit.lastUsed = ++frameCacheCounter; return hit.img; }
  const dataUrl = frame.dataUrl || await resolveFrameDataUrlFromRecipe(frame.recipe);
  const img = await loadImage(dataUrl);
  frameImageCache.set(frame.id, { img, lastUsed: ++frameCacheCounter });
  if (frameImageCache.size > DECODE_CACHE_LIMIT) evictOldestFromCache();
  return img;
}

function makeThumbnailFromCanvas(canvas, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const tc = document.createElement('canvas');
  tc.width = w; tc.height = h;
  tc.getContext('2d').drawImage(canvas, 0, 0, w, h);
  return tc.toDataURL('image/jpeg', 0.72); // preview-only artifact \u2014 never used for export
}

async function makeThumbnail(dataUrl, maxDim) {
  const img = await loadImage(dataUrl);
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return makeThumbnailFromCanvas(c, maxDim);
}

// Lazily fills in a frame's thumbnail the first time it's actually rendered,
// then swaps it into the given element without a full track re-render.
// Extractor-generated frames already carry a thumbUrl from generation time,
// so this only does real work for imported/captured/loaded frames.
function ensureThumbnail(frame, el) {
  if (frame.thumbUrl || frame._thumbPending || !frame.dataUrl) return;
  frame._thumbPending = true;
  makeThumbnail(frame.dataUrl, THUMBNAIL_MAX_DIM).then((thumbUrl) => {
    frame.thumbUrl = thumbUrl;
    frame._thumbPending = false;
    if (el && el.isConnected) el.style.backgroundImage = `url(${thumbUrl})`;
  }).catch(() => { frame._thumbPending = false; });
}

// ---------- Subtitle helpers (shared by preview, playback, and export) ----------
function getTotalDurationMs() {
  let acc = 0;
  frames.forEach((f) => { acc += f.durationMs != null ? f.durationMs : Math.round(1000 / globalFps); });
  return acc;
}

function computeCumulativeStarts(resolvedFrames) {
  const starts = [];
  let acc = 0;
  resolvedFrames.forEach((f) => { starts.push(acc); acc += f.durationMs; });
  return starts;
}

function getActiveSubtitle(t) {
  return subtitles.find((s) => t >= s.startMs && t < s.startMs + s.durationMs) || null;
}

function wrapCanvasText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  words.forEach((word) => {
    const test = current ? current + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  });
  if (current) lines.push(current);
  return lines;
}

const SUBTITLE_SIZE_RATIO = { small: 0.045, medium: 0.065, large: 0.09 };

// Returns the portion of sub.text that should be visible at a given point
// (0\u20131) through the subtitle's own duration, per its reveal mode.
function computeRevealedText(sub, progress) {
  const mode = sub.revealMode || 'all';
  if (mode === 'all') return sub.text;
  const p = Math.min(1, Math.max(0, progress != null ? progress : 1));
  if (mode === 'words') {
    const words = sub.text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    return words.slice(0, Math.max(1, Math.ceil(words.length * p))).join(' ');
  }
  if (mode === 'letters') {
    return sub.text.slice(0, Math.max(1, Math.ceil(sub.text.length * p)));
  }
  return sub.text;
}

function drawSubtitleOverlay(ctx, W, H, sub, progress) {
  if (!sub || !sub.text) return;
  const displayText = computeRevealedText(sub, progress);
  if (!displayText) return;
  const fontSize = Math.max(12, Math.round(H * (SUBTITLE_SIZE_RATIO[sub.size] || SUBTITLE_SIZE_RATIO.medium)));
  ctx.font = `700 ${fontSize}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const maxWidth = W * 0.9;
  const lines = wrapCanvasText(ctx, displayText, maxWidth);
  const lineHeight = fontSize * 1.25;
  const anchorX = W * (sub.xFrac != null ? sub.xFrac : 0.5);
  const anchorY = H * (sub.yFrac != null ? sub.yFrac : 0.88);
  const startY = anchorY - ((lines.length - 1) * lineHeight) / 2;

  if (sub.style === 'dark-glow') {
    ctx.fillStyle = '#1B1D1F';
    ctx.shadowColor = 'rgba(255,255,255,0.95)';
    ctx.shadowBlur = fontSize * 0.5;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  } else {
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = fontSize * 0.25;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = fontSize * 0.06;
  }

  lines.forEach((line, i) => {
    ctx.fillText(line, anchorX, startY + i * lineHeight);
  });

  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function drawWatermarkOverlay(ctx, W, H, wm) {
  if (!wm || !wm.img) return;
  const maxW = W * 0.18;
  const scale = Math.min(1, maxW / wm.naturalWidth);
  const drawW = wm.naturalWidth * scale;
  const drawH = wm.naturalHeight * scale;
  const margin = W * 0.03;
  let x, y;
  switch (wm.position) {
    case 'top-left': x = margin; y = margin; break;
    case 'bottom-right': x = W - margin - drawW; y = H - margin - drawH; break;
    case 'bottom-left': x = margin; y = H - margin - drawH; break;
    case 'center': x = (W - drawW) / 2; y = (H - drawH) / 2; break;
    case 'top-right':
    default: x = W - margin - drawW; y = margin; break;
  }
  ctx.globalAlpha = wm.opacity != null ? wm.opacity : 1;
  ctx.drawImage(wm.img, x, y, drawW, drawH);
  ctx.globalAlpha = 1;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- Import images ----------
document.getElementById('btn-import-images').addEventListener('click', () => {
  document.getElementById('file-images').click();
});
document.getElementById('file-images').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    const dataUrl = await new Promise((res) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result);
      reader.readAsDataURL(file);
    });
    frames.push({ id: nextFrameId++, dataUrl, durationMs: null });
  }
  e.target.value = '';
  renderFrameTrack();
});

// ---------- Webcam capture ----------
document.getElementById('btn-toggle-capture').addEventListener('click', async () => {
  const btn = document.getElementById('btn-toggle-capture');
  const captureBtn = document.getElementById('btn-capture-frame');
  if (!captureStream) {
    try {
      captureStream = await navigator.mediaDevices.getUserMedia({ video: true });
      captureVideo.srcObject = captureStream;
      captureVideo.style.display = 'block';
      previewCanvas.style.display = 'none';
      btn.textContent = 'Stop capture';
      captureBtn.disabled = false;
    } catch (err) {
      alert('Could not access camera: ' + err.message);
    }
  } else {
    captureStream.getTracks().forEach((t) => t.stop());
    captureStream = null;
    captureVideo.style.display = 'none';
    previewCanvas.style.display = 'block';
    btn.textContent = 'Start capture';
    captureBtn.disabled = true;
  }
});

document.getElementById('btn-capture-frame').addEventListener('click', () => {
  if (!captureStream) return;
  const w = captureVideo.videoWidth || 1280;
  const h = captureVideo.videoHeight || 720;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  off.getContext('2d').drawImage(captureVideo, 0, 0, w, h);
  frames.push({ id: nextFrameId++, dataUrl: off.toDataURL('image/png'), durationMs: null });
  renderFrameTrack();
});

// ---------- Playback (preview, with audio) ----------
const btnPlay = document.getElementById('btn-play');
let playbackState = { playing: false, raf: null, audioCtx: null, source: null };

function stopCaptureIfActive() {
  if (!captureStream) return;
  captureStream.getTracks().forEach((t) => t.stop());
  captureStream = null;
  captureVideo.style.display = 'none';
  previewCanvas.style.display = 'block';
  document.getElementById('btn-toggle-capture').textContent = 'Start capture';
  document.getElementById('btn-capture-frame').disabled = true;
}

function stopPlayback() {
  playbackState.playing = false;
  if (playbackState.raf) cancelAnimationFrame(playbackState.raf);
  if (playbackState.source) { try { playbackState.source.stop(); } catch (e) {} }
  if (playbackState.audioCtx) { playbackState.audioCtx.close(); }
  playbackState = { playing: false, raf: null, audioCtx: null, source: null };
  btnPlay.textContent = 'Play sequence';
  document.getElementById('playback-timer').classList.add('hidden');
  if (document.fullscreenElement) document.exitFullscreen();

  const selected = frames.find((f) => f.id === selectedFrameId);
  if (selected) drawPreview(selected);
  else previewCaption.textContent = frames.length ? 'no frame selected' : 'no frame selected';
}

async function playSequence() {
  if (playbackState.playing) { stopPlayback(); return; }
  if (frames.length === 0) { alert('Import or capture at least one frame first.'); return; }

  stopCaptureIfActive();
  previewCanvas.style.display = 'block';

  // Mark as playing immediately so a click during the fullscreen/delay phase acts as Stop.
  playbackState.playing = true;
  btnPlay.textContent = 'Stop';

  const useFullscreen = document.getElementById('fullscreen-on-play-toggle').checked;
  if (useFullscreen && !document.fullscreenElement) {
    try {
      await previewArea.requestFullscreen();
    } catch (err) {
      // Fullscreen denied or unsupported \u2014 continue playback without it.
    }
  }
  if (!playbackState.playing) return; // stopped during the fullscreen prompt

  if (useFullscreen) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!playbackState.playing) return; // stopped during the 1s delay

  // Each entry keeps a reference to its source frame (not a decoded image)
  // so decoding can happen just-in-time, a couple of frames ahead of
  // playback, instead of decoding the entire sequence before playback
  // can even start.
  const resolved = frames.map((f) => ({
    frame: f,
    durationMs: f.durationMs != null ? f.durationMs : Math.round(1000 / globalFps),
  }));
  const durations = resolved.map((f) => f.durationMs);
  const cumulative = [];
  let acc = 0;
  durations.forEach((d) => { cumulative.push(acc); acc += d; });
  const total = acc;

  previewCanvas.width = 1280;
  previewCanvas.height = 720;

  if (audioClip) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createBufferSource();
    source.buffer = audioClip.buffer;
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = audioClip.volume;
    source.connect(gainNode).connect(audioCtx.destination);
    playbackState.audioCtx = audioCtx;
    playbackState.source = source;
    const trimDuration = Math.max(0, audioClip.trimEnd - audioClip.trimStart);
    source.start(audioCtx.currentTime + audioClip.offsetMs / 1000, audioClip.trimStart, trimDuration);
  }

  const startTime = performance.now();
  let currentIndex = -1;
  let drawnIndex = -1;
  let currentSubId = undefined;
  const timerEl = document.getElementById('playback-timer');
  timerEl.classList.remove('hidden');
  timerEl.textContent = `${formatTime(0)} / ${formatTime(total)}`;

  // Prime the first couple of frames so playback doesn't stall waiting on
  // the first decode.
  getFrameImage(resolved[0].frame);
  if (resolved[1]) getFrameImage(resolved[1].frame);

  function tick() {
    if (!playbackState.playing) return;
    const elapsed = performance.now() - startTime;
    if (elapsed >= total) { timerEl.textContent = `${formatTime(total)} / ${formatTime(total)}`; stopPlayback(); return; }
    let idx = cumulative.findIndex((c, i) => elapsed < c + durations[i]);
    if (idx === -1) idx = resolved.length - 1;
    const activeSub = getActiveSubtitle(elapsed);
    const subId = activeSub ? activeSub.id : null;
    const subProgress = activeSub ? (elapsed - activeSub.startMs) / activeSub.durationMs : 1;

    if (idx !== currentIndex) {
      currentIndex = idx;
      if (resolved[idx + 1]) getFrameImage(resolved[idx + 1].frame); // decode one frame ahead
      getFrameImage(resolved[idx].frame).then((img) => {
        if (currentIndex !== idx || !playbackState.playing) return; // superseded by a later frame
        drawContain(previewCtx, img, previewCanvas.width, previewCanvas.height);
        if (activeSub) drawSubtitleOverlay(previewCtx, previewCanvas.width, previewCanvas.height, activeSub, subProgress);
        if (watermark) drawWatermarkOverlay(previewCtx, previewCanvas.width, previewCanvas.height, watermark);
        previewCaption.textContent = `frame ${idx + 1} of ${resolved.length} (playing)`;
        drawnIndex = idx;
        currentSubId = subId;
      });
    } else if (subId !== currentSubId && drawnIndex === idx) {
      getFrameImage(resolved[idx].frame).then((img) => {
        drawContain(previewCtx, img, previewCanvas.width, previewCanvas.height);
        if (activeSub) drawSubtitleOverlay(previewCtx, previewCanvas.width, previewCanvas.height, activeSub, subProgress);
        if (watermark) drawWatermarkOverlay(previewCtx, previewCanvas.width, previewCanvas.height, watermark);
        currentSubId = subId;
      });
    }
    timerEl.textContent = `${formatTime(elapsed)} / ${formatTime(total)}`;
    playbackState.raf = requestAnimationFrame(tick);
  }
  playbackState.raf = requestAnimationFrame(tick);
}

btnPlay.addEventListener('click', playSequence);

const previewArea = document.getElementById('preview-area');

// ---------- Audio import + waveform ----------
document.getElementById('btn-pixabay').addEventListener('click', () => {
  window.open('https://pixabay.com/music/', '_blank', 'noopener');
});

document.getElementById('btn-import-audio').addEventListener('click', () => {
  document.getElementById('file-audio').click();
});
document.getElementById('file-audio').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const arrayBuffer = await file.arrayBuffer();
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  const dataUrl = await new Promise((res) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.readAsDataURL(file);
  });

  const channel = buffer.getChannelData(0);
  const samples = 200;
  const blockSize = Math.floor(channel.length / samples);
  const peaks = [];
  for (let i = 0; i < samples; i++) {
    let max = 0;
    const start = i * blockSize;
    for (let j = 0; j < blockSize; j++) {
      const abs = Math.abs(channel[start + j] || 0);
      if (abs > max) max = abs;
    }
    peaks.push(max);
  }

  audioClip = { name: file.name, dataUrl, buffer, peaks, trimStart: 0, trimEnd: buffer.duration, offsetMs: 0, volume: 1 };
  audioNameLabel.textContent = file.name;
  drawWaveform();
  populateAudioControls();
  expandAccordion('audio-header', 'audio-body');
});

function drawWaveform() {
  if (!audioClip) return;
  const ctx = audioCanvas.getContext('2d');
  audioCanvas.width = audioCanvas.clientWidth;
  const w = audioCanvas.width, h = audioCanvas.height;
  ctx.clearRect(0, 0, w, h);
  const trimStartFrac = audioClip.trimStart / audioClip.buffer.duration;
  const trimEndFrac = audioClip.trimEnd / audioClip.buffer.duration;
  const barWidth = w / audioClip.peaks.length;
  audioClip.peaks.forEach((peak, i) => {
    const frac = i / audioClip.peaks.length;
    const inTrim = frac >= trimStartFrac && frac <= trimEndFrac;
    ctx.fillStyle = inTrim ? '#B85C2E' : '#5A4235';
    const barHeight = Math.max(2, peak * h);
    ctx.fillRect(i * barWidth, (h - barHeight) / 2, Math.max(1, barWidth - 1), barHeight);
  });

  [trimStartFrac * w, trimEndFrac * w].forEach((x) => {
    ctx.fillStyle = '#EF9F27';
    ctx.fillRect(x - 1, 0, 2, h);
    ctx.beginPath();
    ctx.arc(x, h / 2, 5, 0, Math.PI * 2);
    ctx.fill();
  });

  const readout = document.getElementById('audio-selection-readout');
  if (readout) {
    const selected = (audioClip.trimEnd - audioClip.trimStart).toFixed(1);
    readout.textContent = `selected: ${selected}s of ${audioClip.buffer.duration.toFixed(1)}s`;
  }
}
window.addEventListener('resize', drawWaveform);

// ---------- Audio edit controls (always visible once audio exists; every field saves itself) ----------
const audioControls = document.getElementById('audio-controls');
const audioTrimStartInput = document.getElementById('audio-trim-start');
const audioTrimEndInput = document.getElementById('audio-trim-end');
const audioOffsetInput = document.getElementById('audio-offset');
const audioVolumeInput = document.getElementById('audio-volume');
const audioVolumeReadout = document.getElementById('audio-volume-readout');

function populateAudioControls() {
  if (!audioClip) { audioControls.classList.add('hidden'); renderAudioTabularView(); return; }
  audioTrimStartInput.value = audioClip.trimStart.toFixed(1);
  audioTrimStartInput.max = audioClip.buffer.duration.toFixed(1);
  audioTrimEndInput.value = audioClip.trimEnd.toFixed(1);
  audioTrimEndInput.max = audioClip.buffer.duration.toFixed(1);
  audioOffsetInput.value = (audioClip.offsetMs / 1000).toFixed(1);
  audioVolumeInput.value = Math.round(audioClip.volume * 100);
  audioVolumeReadout.textContent = `${Math.round(audioClip.volume * 100)}%`;
  audioControls.classList.remove('hidden');
  renderAudioTabularView();
}

// ---------- Audio Tabular View: same clip settings, shown as an editable property table ----------
function renderAudioTabularView() {
  const tbody = document.getElementById('audio-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  if (!audioClip) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.textContent = 'No audio imported yet \u2014 use Import audio above.';
    td.style.color = 'var(--text-muted)';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  function addRow(label, valueEl) {
    const tr = document.createElement('tr');
    const th = document.createElement('td');
    th.textContent = label;
    th.className = 'table-field-label';
    const td = document.createElement('td');
    td.appendChild(valueEl);
    tr.appendChild(th);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  const nameSpan = document.createElement('span');
  nameSpan.textContent = audioClip.name;
  addRow('file', nameSpan);

  const startInput = document.createElement('input');
  startInput.type = 'number'; startInput.step = '0.1'; startInput.min = '0'; startInput.className = 'table-input';
  startInput.value = audioClip.trimStart.toFixed(1);
  startInput.addEventListener('change', () => {
    const v = Math.max(0, Math.min(Number(startInput.value) || 0, audioClip.trimEnd - 0.1));
    audioClip.trimStart = v;
    startInput.value = v.toFixed(1);
    drawWaveform();
    audioTrimStartInput.value = v.toFixed(1);
  });
  addRow('trim start (s)', startInput);

  const endInput = document.createElement('input');
  endInput.type = 'number'; endInput.step = '0.1'; endInput.min = '0'; endInput.className = 'table-input';
  endInput.value = audioClip.trimEnd.toFixed(1);
  endInput.addEventListener('change', () => {
    const v = Math.min(audioClip.buffer.duration, Math.max(Number(endInput.value) || 0, audioClip.trimStart + 0.1));
    audioClip.trimEnd = v;
    endInput.value = v.toFixed(1);
    drawWaveform();
    audioTrimEndInput.value = v.toFixed(1);
  });
  addRow('trim end (s)', endInput);

  const offsetInput = document.createElement('input');
  offsetInput.type = 'number'; offsetInput.step = '0.1'; offsetInput.min = '0'; offsetInput.className = 'table-input';
  offsetInput.value = (audioClip.offsetMs / 1000).toFixed(1);
  offsetInput.addEventListener('change', () => {
    const v = Math.max(0, Number(offsetInput.value) || 0);
    audioClip.offsetMs = Math.round(v * 1000);
    offsetInput.value = v.toFixed(1);
    audioOffsetInput.value = v.toFixed(1);
  });
  addRow('start offset (s)', offsetInput);

  const volInput = document.createElement('input');
  volInput.type = 'number'; volInput.min = '0'; volInput.max = '100'; volInput.step = '1'; volInput.className = 'table-input';
  volInput.value = Math.round(audioClip.volume * 100);
  volInput.addEventListener('change', () => {
    const v = Math.max(0, Math.min(100, Number(volInput.value) || 0));
    audioClip.volume = v / 100;
    volInput.value = v;
    audioVolumeInput.value = v;
    audioVolumeReadout.textContent = `${v}%`;
  });
  addRow('volume (%)', volInput);
}

let audioDrag = null; // { handle: 'start' | 'end' }

audioCanvas.addEventListener('pointerdown', (e) => {
  if (!audioClip) { alert('Import audio first.'); return; }
  const rect = audioCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const startX = (audioClip.trimStart / audioClip.buffer.duration) * audioCanvas.width;
  const endX = (audioClip.trimEnd / audioClip.buffer.duration) * audioCanvas.width;
  const HANDLE_PX = 10;
  if (Math.abs(x - startX) <= HANDLE_PX) audioDrag = { handle: 'start' };
  else if (Math.abs(x - endX) <= HANDLE_PX) audioDrag = { handle: 'end' };
  else return;
  audioCanvas.setPointerCapture(e.pointerId);
});
audioCanvas.addEventListener('pointermove', (e) => {
  if (!audioDrag || !audioClip) return;
  const rect = audioCanvas.getBoundingClientRect();
  const t = Math.min(1, Math.max(0, (e.clientX - rect.left) / audioCanvas.width)) * audioClip.buffer.duration;
  if (audioDrag.handle === 'start') {
    audioClip.trimStart = Math.max(0, Math.min(t, audioClip.trimEnd - 0.1));
    audioTrimStartInput.value = audioClip.trimStart.toFixed(1);
  } else {
    audioClip.trimEnd = Math.min(audioClip.buffer.duration, Math.max(t, audioClip.trimStart + 0.1));
    audioTrimEndInput.value = audioClip.trimEnd.toFixed(1);
  }
  drawWaveform();
});
audioCanvas.addEventListener('pointerup', () => { audioDrag = null; });
audioCanvas.addEventListener('pointercancel', () => { audioDrag = null; });

audioTrimStartInput.addEventListener('change', () => {
  if (!audioClip) return;
  const v = Math.max(0, Math.min(Number(audioTrimStartInput.value) || 0, audioClip.trimEnd - 0.1));
  audioClip.trimStart = v;
  audioTrimStartInput.value = v.toFixed(1);
  drawWaveform();
});
audioTrimEndInput.addEventListener('change', () => {
  if (!audioClip) return;
  const v = Math.min(audioClip.buffer.duration, Math.max(Number(audioTrimEndInput.value) || 0, audioClip.trimStart + 0.1));
  audioClip.trimEnd = v;
  audioTrimEndInput.value = v.toFixed(1);
  drawWaveform();
});
audioOffsetInput.addEventListener('change', () => {
  if (!audioClip) return;
  const v = Math.max(0, Number(audioOffsetInput.value) || 0);
  audioClip.offsetMs = Math.round(v * 1000);
  audioOffsetInput.value = v.toFixed(1);
});
audioVolumeInput.addEventListener('input', () => {
  audioVolumeReadout.textContent = `${audioVolumeInput.value}%`;
  if (audioClip) audioClip.volume = Number(audioVolumeInput.value) / 100;
});

document.getElementById('btn-audio-remove').addEventListener('click', () => {
  audioClip = null;
  audioNameLabel.textContent = 'none';
  audioControls.classList.add('hidden');
  const ctx = audioCanvas.getContext('2d');
  ctx.clearRect(0, 0, audioCanvas.width, audioCanvas.height);
  renderAudioTabularView();
});

// ---------- Frame track (thumbnails, selection, drag reorder, bundles) ----------
function renderSingleFrameThumb(frame, index) {
  const el = document.createElement('div');
  el.className = 'frame-thumb' + (selectedFrameIds.has(frame.id) ? ' selected' : '');
  el.style.backgroundImage = `url(${frame.thumbUrl || frame.dataUrl})`;
  ensureThumbnail(frame, el);
  el.draggable = true;
  el.dataset.frameId = String(frame.id);

  const idx = document.createElement('span');
  idx.className = 'frame-index';
  idx.textContent = String(index + 1);
  el.appendChild(idx);

  el.addEventListener('click', (e) => {
    if (e.shiftKey && selectionAnchorId != null) { selectRange(selectionAnchorId, frame.id); return; }
    if (e.metaKey || e.ctrlKey) { toggleSelect(frame.id); selectionAnchorId = frame.id; return; }
    selectFrame(frame.id);
  });
  el.addEventListener('dragstart', (e) => {
    if (selectedFrameIds.size > 1 && selectedFrameIds.has(frame.id)) {
      e.dataTransfer.setData('application/x-frame-ids', JSON.stringify(Array.from(selectedFrameIds)));
    } else {
      e.dataTransfer.setData('text/plain', String(frame.id));
    }
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const draggedBundleId = e.dataTransfer.getData('application/x-bundle-id');
    if (draggedBundleId) { moveBundleTo(Number(draggedBundleId), frame.id); return; }
    const draggedIdsRaw = e.dataTransfer.getData('application/x-frame-ids');
    if (draggedIdsRaw) { try { moveFramesTo(JSON.parse(draggedIdsRaw), frame.id); } catch (err) {} return; }
    const draggedId = Number(e.dataTransfer.getData('text/plain'));
    reorderFrames(draggedId, frame.id);
  });

  return el;
}

function renderBundleTile(bundle, runFrames) {
  const el = document.createElement('div');
  const runIds = runFrames.map((f) => f.id);
  const isFullySelected = runIds.length > 0 && runIds.every((id) => selectedFrameIds.has(id)) && selectedFrameIds.size === runIds.length;
  el.className = 'frame-bundle' + (isFullySelected ? ' selected' : '');
  el.title = isFullySelected ? `${bundle.label} \u2014 tap again to expand` : `${bundle.label} \u2014 tap to select, tap again to expand`;
  el.draggable = true;
  el.dataset.bundleId = String(bundle.id);

  const thumb = document.createElement('div');
  thumb.className = 'frame-bundle-thumb';
  thumb.style.backgroundImage = `url(${runFrames[0].thumbUrl || runFrames[0].dataUrl})`;
  ensureThumbnail(runFrames[0], thumb);
  el.appendChild(thumb);

  const count = document.createElement('span');
  count.className = 'frame-bundle-count';
  count.textContent = String(runFrames.length);
  el.appendChild(count);

  el.addEventListener('click', (e) => {
    if (e.shiftKey && selectionAnchorId != null) { selectRange(selectionAnchorId, runFrames[0].id); return; }
    if (e.metaKey || e.ctrlKey) {
      runFrames.forEach((f) => selectedFrameIds.add(f.id));
      selectionAnchorId = runFrames[0].id;
      renderFrameTrack();
      updateDeleteButtonState();
      return;
    }
    if (isFullySelected) {
      bundle.collapsed = false;
      renderFrameTrack();
      return;
    }
    selectedFrameIds = new Set(runIds);
    selectionAnchorId = runFrames[0].id;
    renderFrameTrack();
    updateDeleteButtonState();
  });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('application/x-bundle-id', String(bundle.id));
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const draggedBundleId = e.dataTransfer.getData('application/x-bundle-id');
    if (draggedBundleId && Number(draggedBundleId) !== bundle.id) { moveBundleTo(Number(draggedBundleId), runFrames[0].id); return; }
    const draggedIdsRaw = e.dataTransfer.getData('application/x-frame-ids');
    if (draggedIdsRaw) { try { moveFramesTo(JSON.parse(draggedIdsRaw), runFrames[0].id); } catch (err) {} return; }
    const draggedFrameId = Number(e.dataTransfer.getData('text/plain'));
    if (draggedFrameId) reorderFrames(draggedFrameId, runFrames[0].id);
  });

  return el;
}

function renderExpandedBundleGroup(bundle, runFrames) {
  const wrap = document.createElement('div');
  wrap.className = 'frame-bundle-expanded';

  const header = document.createElement('div');
  header.className = 'frame-bundle-group-header';
  const labelSpan = document.createElement('span');
  labelSpan.textContent = bundle.label;
  header.appendChild(labelSpan);
  const rebundleBtn = document.createElement('button');
  rebundleBtn.type = 'button';
  rebundleBtn.textContent = 'rebundle';
  rebundleBtn.addEventListener('click', () => { bundle.collapsed = true; renderFrameTrack(); });
  header.appendChild(rebundleBtn);
  wrap.appendChild(header);

  const row = document.createElement('div');
  row.className = 'frame-bundle-expanded-row';
  const startIndex = frames.findIndex((f) => f.id === runFrames[0].id);
  runFrames.forEach((frame, k) => row.appendChild(renderSingleFrameThumb(frame, startIndex + k)));
  wrap.appendChild(row);

  return wrap;
}

// Relocates every frame whose id is in ids (order preserved) to just before
// beforeFrameId. Used for both multi-selection drags and bundle-tile drags.
function moveFramesTo(ids, beforeFrameId) {
  const idSet = new Set(ids);
  const moving = frames.filter((f) => idSet.has(f.id));
  if (!moving.length) return;
  frames = frames.filter((f) => !idSet.has(f.id));
  let idx = frames.findIndex((f) => f.id === beforeFrameId);
  if (idx === -1) idx = frames.length;
  frames.splice(idx, 0, ...moving);
  renderFrameTrack();
}

function moveBundleTo(bundleId, beforeFrameId) {
  moveFramesTo(frames.filter((f) => f.bundleId === bundleId).map((f) => f.id), beforeFrameId);
}

// ---------- Selection (multi-select for bulk move/delete) ----------
const deleteSelectedBtn = document.getElementById('btn-delete-selected');
const clearSelectionBtn = document.getElementById('btn-clear-selection');
const duplicateSelectedBtn = document.getElementById('btn-duplicate-selected');
const reverseSelectedBtn = document.getElementById('btn-reverse-selected');

function updateDeleteButtonState() {
  const n = selectedFrameIds.size;
  deleteSelectedBtn.disabled = n === 0;
  deleteSelectedBtn.textContent = n > 0 ? `delete selected (${n})` : 'delete selected';
  clearSelectionBtn.disabled = n === 0;
  duplicateSelectedBtn.disabled = n === 0;
  reverseSelectedBtn.disabled = n < 2;

  const delTab = document.getElementById('btn-delete-selected-tab');
  const clearTab = document.getElementById('btn-clear-selection-tab');
  const dupTab = document.getElementById('btn-duplicate-selected-tab');
  const revTab = document.getElementById('btn-reverse-selected-tab');
  if (delTab) { delTab.disabled = n === 0; delTab.textContent = n > 0 ? `delete selected (${n})` : 'delete selected'; }
  if (clearTab) clearTab.disabled = n === 0;
  if (dupTab) dupTab.disabled = n === 0;
  if (revTab) revTab.disabled = n < 2;
}

function clearSelection() {
  selectedFrameIds = new Set();
  selectionAnchorId = null;
  renderFrameTrack();
  updateDeleteButtonState();
}

function toggleSelect(id) {
  if (selectedFrameIds.has(id)) selectedFrameIds.delete(id);
  else selectedFrameIds.add(id);
  renderFrameTrack();
  updateDeleteButtonState();
}

function selectRange(fromId, toId) {
  const fromIdx = frames.findIndex((f) => f.id === fromId);
  const toIdx = frames.findIndex((f) => f.id === toId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
  selectedFrameIds = new Set(frames.slice(lo, hi + 1).map((f) => f.id));
  renderFrameTrack();
  updateDeleteButtonState();
}

// Duplicates carry over dataUrl/thumbUrl/recipe by reference (cheap \u2014 no
// pixel data is actually copied), get fresh ids, and land as one contiguous
// block right after the selection. A duplicated bundle becomes its own new
// bundle (same label, independently collapsible/deletable from the original).
function duplicateSelectedFrames() {
  if (selectedFrameIds.size === 0) return;
  const indices = [];
  frames.forEach((f, i) => { if (selectedFrameIds.has(f.id)) indices.push(i); });
  const insertAt = Math.max(...indices) + 1;
  const selectedInOrder = indices.map((i) => frames[i]);

  const bundleIdMap = new Map(); // old bundleId -> new bundleId
  const duplicates = selectedInOrder.map((f) => {
    let newBundleId = null;
    if (f.bundleId != null) {
      if (!bundleIdMap.has(f.bundleId)) {
        const newId = nextBundleId++;
        const orig = bundles[f.bundleId];
        bundles[newId] = { id: newId, label: orig ? orig.label : 'Bundle', collapsed: orig ? orig.collapsed : true };
        bundleIdMap.set(f.bundleId, newId);
      }
      newBundleId = bundleIdMap.get(f.bundleId);
    }
    return { ...f, id: nextFrameId++, bundleId: newBundleId };
  });

  frames.splice(insertAt, 0, ...duplicates);
  selectedFrameIds = new Set(duplicates.map((f) => f.id));
  selectionAnchorId = duplicates.length ? duplicates[0].id : null;
  renderFrameTrack();
  updateDeleteButtonState();
}

// Keeps every selected frame's position fixed, but flips which frame
// occupies each of those positions \u2014 the usual "reverse selection"
// behavior (a reversed bundle stays a bundle, just playing backwards).
function reverseSelectedFrames() {
  if (selectedFrameIds.size < 2) return;
  const indices = [];
  frames.forEach((f, i) => { if (selectedFrameIds.has(f.id)) indices.push(i); });
  const reversed = indices.map((i) => frames[i]).reverse();
  indices.forEach((idx, k) => { frames[idx] = reversed[k]; });
  // A collapsed bundle tile only shows one thumbnail, so reversing it would
  // otherwise be invisible \u2014 auto-expand any bundle the reversal touched.
  const touchedBundleIds = new Set(reversed.map((f) => f.bundleId).filter((id) => id != null));
  touchedBundleIds.forEach((id) => { if (bundles[id]) bundles[id].collapsed = false; });
  renderFrameTrack();
}

function deleteSelectedFrames() {
  if (selectedFrameIds.size === 0) return;
  frames = frames.filter((f) => !selectedFrameIds.has(f.id));
  if (selectedFrameId != null && selectedFrameIds.has(selectedFrameId)) {
    selectedFrameId = null;
    frameDurationInput.disabled = true;
    previewCaption.textContent = frames.length ? 'no frame selected' : 'no frame selected';
  }
  clearSelection();
}

deleteSelectedBtn.addEventListener('click', deleteSelectedFrames);
clearSelectionBtn.addEventListener('click', clearSelection);
duplicateSelectedBtn.addEventListener('click', duplicateSelectedFrames);
reverseSelectedBtn.addEventListener('click', reverseSelectedFrames);
document.getElementById('btn-select-all-frames-tab').addEventListener('click', () => document.getElementById('btn-select-all-frames').click());
document.getElementById('btn-clear-selection-tab').addEventListener('click', clearSelection);
document.getElementById('btn-duplicate-selected-tab').addEventListener('click', duplicateSelectedFrames);
document.getElementById('btn-reverse-selected-tab').addEventListener('click', reverseSelectedFrames);
document.getElementById('btn-delete-selected-tab').addEventListener('click', deleteSelectedFrames);
document.getElementById('btn-select-all-frames').addEventListener('click', () => {
  selectedFrameIds = new Set(frames.map((f) => f.id));
  selectionAnchorId = frames.length ? frames[frames.length - 1].id : null;
  renderFrameTrack();
  updateDeleteButtonState();
});
// Clicking empty track background (not a thumb/bundle) clears the selection
// too \u2014 the button exists because a track full of bundle tiles can leave
// no empty space to click.
frameTrack.addEventListener('click', (e) => {
  if (e.target !== frameTrack) return;
  clearSelection();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const active = document.activeElement;
  const tag = active && active.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (active && active.isContentEditable)) return;
  if (modeGeneratorEl.classList.contains('hidden')) return; // only act while movie generator mode is visible
  if (selectedFrameIds.size === 0) return;
  e.preventDefault();
  deleteSelectedFrames();
});

function addGroupAsBundle(group) {
  const bundleId = nextBundleId++;
  bundles[bundleId] = { id: bundleId, label: group.label, collapsed: true };
  group.frames.forEach((f) => frames.push({
    id: nextFrameId++,
    dataUrl: f.dataUrl,
    recipe: f.recipe || null,
    thumbUrl: f.thumbUrl,
    durationMs: null,
    bundleId,
  }));
  renderFrameTrack();
}

function renderFrameTrack() {
  const heavyCount = frames.filter((f) => f.dataUrl && !f.recipe).length;
  frameCountLabel.textContent = `${frames.length} frame${frames.length === 1 ? '' : 's'}`
    + (heavyCount > SOFT_WARN_SLICE_COUNT ? ` \u2014 ${heavyCount} full-res in memory` : '');
  frameTrack.innerHTML = '';

  let i = 0;
  while (i < frames.length) {
    const frame = frames[i];
    const bundle = frame.bundleId ? bundles[frame.bundleId] : null;
    if (bundle) {
      const run = [];
      let j = i;
      while (j < frames.length && frames[j].bundleId === bundle.id) { run.push(frames[j]); j++; }
      frameTrack.appendChild(bundle.collapsed ? renderBundleTile(bundle, run) : renderExpandedBundleGroup(bundle, run));
      i = j;
    } else {
      frameTrack.appendChild(renderSingleFrameThumb(frame, i));
      i += 1;
    }
  }
  renderSubtitleTrack();
  renderFrameTabularView();
}

// ---------- Frame Tabular View: same data as the timeline, spreadsheet-style ----------
function moveFrameByOffset(frameId, offset) {
  const idx = frames.findIndex((f) => f.id === frameId);
  if (idx === -1) return;
  const newIdx = idx + offset;
  if (newIdx < 0 || newIdx >= frames.length) return;
  const [item] = frames.splice(idx, 1);
  frames.splice(newIdx, 0, item);
  renderFrameTrack();
}

function renderFrameTabularView() {
  const tbody = document.getElementById('frame-table-body');
  if (!tbody) return;
  document.getElementById('frame-tabular-count').textContent = `${frames.length} frame${frames.length === 1 ? '' : 's'}`;
  tbody.innerHTML = '';

  frames.forEach((frame, index) => {
    const tr = document.createElement('tr');
    if (selectedFrameIds.has(frame.id)) tr.classList.add('selected-row');

    const tdCheck = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedFrameIds.has(frame.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedFrameIds.add(frame.id); else selectedFrameIds.delete(frame.id);
      selectionAnchorId = frame.id;
      updateDeleteButtonState();
      tr.classList.toggle('selected-row', cb.checked);
    });
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);

    const tdIndex = document.createElement('td');
    tdIndex.textContent = String(index + 1);
    tr.appendChild(tdIndex);

    const tdThumb = document.createElement('td');
    const thumbDiv = document.createElement('div');
    thumbDiv.className = 'table-thumb';
    thumbDiv.style.backgroundImage = `url(${frame.thumbUrl || frame.dataUrl})`;
    ensureThumbnail(frame, thumbDiv);
    tdThumb.appendChild(thumbDiv);
    tr.appendChild(tdThumb);

    const tdDuration = document.createElement('td');
    const durInput = document.createElement('input');
    durInput.type = 'number';
    durInput.min = '10';
    durInput.step = '1';
    durInput.className = 'table-input';
    durInput.value = frame.durationMs != null ? frame.durationMs : Math.round(1000 / globalFps);
    durInput.addEventListener('change', () => {
      const v = Math.max(10, Number(durInput.value) || Math.round(1000 / globalFps));
      frame.durationMs = v;
      durInput.value = v;
      renderSubtitleTrack(); // total duration may have changed
      refreshPreviewForSelectedFrame();
    });
    tdDuration.appendChild(durInput);
    tr.appendChild(tdDuration);

    const tdBundle = document.createElement('td');
    tdBundle.textContent = frame.bundleId != null && bundles[frame.bundleId] ? bundles[frame.bundleId].label : '\u2014';
    tr.appendChild(tdBundle);

    const tdActions = document.createElement('td');
    const upBtn = document.createElement('button');
    upBtn.type = 'button'; upBtn.className = 'small-btn'; upBtn.textContent = '\u25b2'; upBtn.title = 'move up';
    upBtn.disabled = index === 0;
    upBtn.addEventListener('click', () => moveFrameByOffset(frame.id, -1));
    const downBtn = document.createElement('button');
    downBtn.type = 'button'; downBtn.className = 'small-btn'; downBtn.textContent = '\u25bc'; downBtn.title = 'move down';
    downBtn.disabled = index === frames.length - 1;
    downBtn.addEventListener('click', () => moveFrameByOffset(frame.id, 1));
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'small-btn'; delBtn.textContent = 'delete';
    delBtn.addEventListener('click', () => {
      frames = frames.filter((f) => f.id !== frame.id);
      selectedFrameIds.delete(frame.id);
      updateDeleteButtonState();
      renderFrameTrack();
    });
    tdActions.appendChild(upBtn); tdActions.appendChild(downBtn); tdActions.appendChild(delBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

function reorderFrames(draggedId, targetId) {
  if (draggedId === targetId) return;
  const fromIndex = frames.findIndex((f) => f.id === draggedId);
  const toIndex = frames.findIndex((f) => f.id === targetId);
  if (fromIndex === -1 || toIndex === -1) return;
  const [moved] = frames.splice(fromIndex, 1);
  frames.splice(toIndex, 0, moved);
  renderFrameTrack();
}

function selectFrame(id) {
  selectedFrameId = id;
  selectedFrameIds = new Set([id]);
  selectionAnchorId = id;
  const frame = frames.find((f) => f.id === id);
  if (!frame) return;
  frameDurationInput.disabled = false;
  const ms = frame.durationMs != null ? frame.durationMs : Math.round(1000 / globalFps);
  frameDurationInput.value = durationUnit === 'ms' ? ms : Math.round(1000 / ms);
  drawPreview(frame);
  renderFrameTrack();
  updateDeleteButtonState();
}

function drawPreview(frame) {
  getFrameImage(frame).then((img) => {
    previewCanvas.width = img.width;
    previewCanvas.height = img.height;
    previewCtx.drawImage(img, 0, 0);

    const resolved = frames.map((f) => ({ durationMs: f.durationMs != null ? f.durationMs : Math.round(1000 / globalFps) }));
    const starts = computeCumulativeStarts(resolved);
    const idx = frames.findIndex((f) => f.id === frame.id);
    const active = getActiveSubtitle(starts[idx] || 0);
    if (active) drawSubtitleOverlay(previewCtx, previewCanvas.width, previewCanvas.height, active, (( (starts[idx] || 0) - active.startMs) / active.durationMs));
    if (watermark) drawWatermarkOverlay(previewCtx, previewCanvas.width, previewCanvas.height, watermark);
  });
  const index = frames.findIndex((f) => f.id === frame.id);
  previewCaption.textContent = `frame ${index + 1} of ${frames.length}`;
}

// ---------- Duration unit toggle (fps / ms) ----------
let durationUnit = 'fps';
const unitButtons = document.querySelectorAll('.unit-btn');
const rangeDurationInput = document.getElementById('range-duration-input');

function refreshLabelsAndBounds() {
  const isMs = durationUnit === 'ms';
  document.getElementById('label-global').textContent = isMs ? 'global frame duration (ms)' : 'global fps';
  document.getElementById('label-frame-duration').textContent = isMs ? 'selected frame duration (ms)' : 'selected frame rate (fps)';
  document.getElementById('label-range-duration').textContent = isMs ? 'duration (ms)' : 'rate (fps)';
  [globalFpsInput, frameDurationInput, rangeDurationInput].forEach((inp) => {
    inp.min = isMs ? 10 : 1;
    inp.max = isMs ? 5000 : 60;
    inp.step = isMs ? 10 : 1;
  });
}

function setUnit(newUnit) {
  if (newUnit === durationUnit) return;
  const oldUnit = durationUnit;

  const rawRange = Number(rangeDurationInput.value);
  let rangeMs = null;
  if (rawRange > 0) rangeMs = oldUnit === 'ms' ? rawRange : Math.round(1000 / rawRange);

  durationUnit = newUnit;
  unitButtons.forEach((b) => b.classList.toggle('active', b.dataset.unit === newUnit));
  refreshLabelsAndBounds();

  const isMs = newUnit === 'ms';
  globalFpsInput.value = isMs ? Math.round(1000 / globalFps) : globalFps;

  const selected = frames.find((f) => f.id === selectedFrameId);
  if (selected) {
    const ms = selected.durationMs != null ? selected.durationMs : Math.round(1000 / globalFps);
    frameDurationInput.value = isMs ? ms : Math.round(1000 / ms);
  }

  if (rangeMs != null) rangeDurationInput.value = isMs ? rangeMs : Math.round(1000 / rangeMs);
}

unitButtons.forEach((b) => b.addEventListener('click', () => setUnit(b.dataset.unit)));

// ---------- Global / per-frame duration ----------
document.getElementById('btn-apply-all').addEventListener('click', () => {
  const raw = Number(globalFpsInput.value);
  globalFps = durationUnit === 'ms'
    ? Math.max(1, Math.round(1000 / Math.max(10, raw || 83)))
    : Math.max(1, raw || 12);
  frames.forEach((f) => { f.durationMs = null; });
  if (selectedFrameId) {
    const ms = Math.round(1000 / globalFps);
    frameDurationInput.value = durationUnit === 'ms' ? ms : globalFps;
  }
  renderFrameTrack();
});
frameDurationInput.addEventListener('change', () => {
  const frame = frames.find((f) => f.id === selectedFrameId);
  if (!frame) return;
  const val = Number(frameDurationInput.value);
  const ms = durationUnit === 'ms' ? val : (val > 0 ? Math.round(1000 / val) : 0);
  frame.durationMs = ms > 0 ? ms : null;
});

// ---------- Apply duration to a custom set of frames ----------
function parseFrameRange(input, count) {
  const indices = new Set();
  input.split(',').forEach((rawPart) => {
    const part = rawPart.trim();
    if (!part) return;
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (rangeMatch) {
      let a = parseInt(rangeMatch[1], 10);
      let b = parseInt(rangeMatch[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let i = a; i <= b; i++) {
        if (i >= 1 && i <= count) indices.add(i - 1);
      }
    } else {
      const n = parseInt(part, 10);
      if (!isNaN(n) && n >= 1 && n <= count) indices.add(n - 1);
    }
  });
  return Array.from(indices).sort((a, b) => a - b);
}

document.getElementById('btn-apply-range').addEventListener('click', () => {
  const rangeInput = document.getElementById('frame-range-input');
  const indices = parseFrameRange(rangeInput.value, frames.length);

  if (indices.length === 0) {
    alert('No valid frame numbers found. Use a format like: 1-5, 22, 24, 37');
    return;
  }
  const raw = Number(rangeDurationInput.value);
  const ms = durationUnit === 'ms' ? raw : (raw > 0 ? Math.round(1000 / raw) : 0);
  if (!(ms > 0)) {
    alert(durationUnit === 'ms' ? 'Enter a duration in ms greater than 0.' : 'Enter an fps greater than 0.');
    return;
  }

  indices.forEach((i) => { frames[i].durationMs = ms; });

  if (selectedFrameId) {
    const selected = frames.find((f) => f.id === selectedFrameId);
    if (selected) frameDurationInput.value = durationUnit === 'ms' ? selected.durationMs : Math.round(1000 / selected.durationMs);
  }
  renderFrameTrack();
});

// ---------- Export modal ----------
document.getElementById('btn-export').addEventListener('click', () => {
  if (frames.length === 0) { alert('Import or capture at least one frame first.'); return; }
  exportModal.classList.remove('hidden');
  exportStatus.textContent = '';
});
document.getElementById('btn-export-cancel').addEventListener('click', () => exportModal.classList.add('hidden'));
exportPresetSelect.addEventListener('change', () => {
  customSizeRow.classList.toggle('hidden', exportPresetSelect.value !== 'custom');
});

document.getElementById('btn-export-confirm').addEventListener('click', runExport);

async function runExport() {
  const format = document.getElementById('export-format').value;
  const presetOption = exportPresetSelect.selectedOptions[0];
  let width, height;
  if (presetOption.value === 'custom') {
    width = Number(document.getElementById('custom-width').value) || 1080;
    height = Number(document.getElementById('custom-height').value) || 1920;
  } else {
    width = Number(presetOption.dataset.w);
    height = Number(presetOption.dataset.h);
  }

  const resolvedFrames = frames.map((f) => ({
    frame: f,
    durationMs: f.durationMs != null ? f.durationMs : Math.round(1000 / globalFps),
  }));

  const confirmBtn = document.getElementById('btn-export-confirm');
  confirmBtn.disabled = true;
  exportStatus.textContent = 'encoding\u2026';

  try {
    if (format === 'webm') {
      const blob = await recordWebm({ frames: resolvedFrames, audio: audioClip, width, height });
      downloadBlob(blob, 'sequence.webm');
      exportStatus.textContent = 'downloaded sequence.webm';
    } else if (format === 'mp4') {
      const webmBlob = await recordWebm({ frames: resolvedFrames, audio: audioClip, width, height });
      exportStatus.textContent = 'preparing MP4\u2026';
      const mp4Blob = await window.convertWebmToMp4(webmBlob, (msg) => {
        exportStatus.textContent = msg;
      });
      downloadBlob(mp4Blob, 'sequence.mp4');
      exportStatus.textContent = 'downloaded sequence.mp4';
    } else if (format === 'gif') {
      const blob = await exportGif({ frames: resolvedFrames, width, height });
      downloadBlob(blob, 'sequence.gif');
      exportStatus.textContent = 'downloaded sequence.gif';
    }
  } catch (err) {
    exportStatus.textContent = 'failed: ' + err.message;
  } finally {
    confirmBtn.disabled = false;
  }
}

// ---------- WebM recording (canvas + optional audio) ----------
async function recordWebm({ frames, audio, width, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  const durations = frames.map((f) => f.durationMs);
  const cumulative = [];
  let acc = 0;
  durations.forEach((d) => { cumulative.push(acc); acc += d; });
  const total = acc;

  const canvasStream = canvas.captureStream(30);
  let tracks = canvasStream.getVideoTracks();

  let audioCtx, source;
  if (audio) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createBufferSource();
    source.buffer = audio.buffer;
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = audio.volume;
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(gainNode).connect(dest);
    tracks = tracks.concat(dest.stream.getAudioTracks());
  }

  const combined = new MediaStream(tracks);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm';
  const recorder = new MediaRecorder(combined, { mimeType });
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

  recorder.start();
  if (source) {
    const trimDuration = Math.max(0, audio.trimEnd - audio.trimStart);
    source.start(audioCtx.currentTime + audio.offsetMs / 1000, audio.trimStart, trimDuration);
  }
  const startTime = performance.now();
  let currentIndex = -1;
  let drawnIndex = -1;
  let currentSubId = undefined;

  getFrameImage(frames[0].frame);
  if (frames[1]) getFrameImage(frames[1].frame);

  await new Promise((resolve) => {
    function tick() {
      const elapsed = performance.now() - startTime;
      if (elapsed >= total) { resolve(); return; }
      let idx = cumulative.findIndex((c, i) => elapsed < c + durations[i]);
      if (idx === -1) idx = frames.length - 1;
      const activeSub = getActiveSubtitle(elapsed);
      const subId = activeSub ? activeSub.id : null;
      const subProgress = activeSub ? (elapsed - activeSub.startMs) / activeSub.durationMs : 1;

      if (idx !== currentIndex) {
        currentIndex = idx;
        if (frames[idx + 1]) getFrameImage(frames[idx + 1].frame);
        getFrameImage(frames[idx].frame).then((img) => {
          if (currentIndex !== idx) return; // superseded by a later frame
          drawContain(ctx, img, width, height);
          if (activeSub) drawSubtitleOverlay(ctx, width, height, activeSub, subProgress);
          if (watermark) drawWatermarkOverlay(ctx, width, height, watermark);
          drawnIndex = idx;
          currentSubId = subId;
        });
      } else if (subId !== currentSubId && drawnIndex === idx) {
        getFrameImage(frames[idx].frame).then((img) => {
          drawContain(ctx, img, width, height);
          if (activeSub) drawSubtitleOverlay(ctx, width, height, activeSub, subProgress);
          if (watermark) drawWatermarkOverlay(ctx, width, height, watermark);
          currentSubId = subId;
        });
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });

  recorder.stop();
  if (source) source.stop();
  if (audioCtx) audioCtx.close();
  await stopped;
  return new Blob(chunks, { type: 'video/webm' });
}

// ---------- GIF export ----------
async function exportGif({ frames, width, height }) {
  const starts = computeCumulativeStarts(frames);
  const off = document.createElement('canvas');
  off.width = width; off.height = height;
  const octx = off.getContext('2d');

  const gif = new GIF({
    workers: 2,
    quality: 10,
    width, height,
    workerScript: 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js',
  });

  // Decode and add one frame at a time \u2014 never holds the whole sequence
  // decoded at once, regardless of how many frames are being exported.
  for (let i = 0; i < frames.length; i++) {
    const img = await getFrameImage(frames[i].frame);
    drawContain(octx, img, width, height);
    const active = getActiveSubtitle(starts[i]);
    if (active) drawSubtitleOverlay(octx, width, height, active, (starts[i] - active.startMs) / active.durationMs);
    if (watermark) drawWatermarkOverlay(octx, width, height, watermark);
    gif.addFrame(octx, { copy: true, delay: frames[i].durationMs });
  }

  return new Promise((resolve, reject) => {
    gif.on('finished', (blob) => resolve(blob));
    gif.on('abort', () => reject(new Error('GIF export aborted')));
    gif.render();
  });
}

// ---------- Subtitle track (add, drag to reposition/resize, style) ----------
const subtitleTrackEl = document.getElementById('subtitle-track');
const subtitleEditPanel = document.getElementById('subtitle-edit');

function renderSubtitleTrack() {
  document.getElementById('subtitle-count').textContent = String(subtitles.length);
  subtitleTrackEl.innerHTML = '';
  const total = Math.max(1, getTotalDurationMs());
  const trackWidth = subtitleTrackEl.clientWidth || 1;

  subtitles.forEach((sub) => {
    const left = (sub.startMs / total) * trackWidth;
    const width = Math.max(24, (sub.durationMs / total) * trackWidth);

    const el = document.createElement('div');
    el.className = 'subtitle-clip' + (sub.id === selectedSubtitleId ? ' selected' : '');
    el.style.left = `${left}px`;
    el.style.width = `${width}px`;
    el.textContent = sub.text || '(empty subtitle)';

    const leftHandle = document.createElement('div');
    leftHandle.className = 'subtitle-handle left';
    const rightHandle = document.createElement('div');
    rightHandle.className = 'subtitle-handle right';
    el.appendChild(leftHandle);
    el.appendChild(rightHandle);

    el.addEventListener('click', (e) => {
      if (e.target === leftHandle || e.target === rightHandle) return;
      selectSubtitle(sub.id);
    });
    el.addEventListener('mousedown', (e) => {
      if (e.target === leftHandle || e.target === rightHandle) return;
      startSubtitleDrag(e, sub, 'move');
    });
    leftHandle.addEventListener('mousedown', (e) => { e.stopPropagation(); startSubtitleDrag(e, sub, 'left'); });
    rightHandle.addEventListener('mousedown', (e) => { e.stopPropagation(); startSubtitleDrag(e, sub, 'right'); });

    subtitleTrackEl.appendChild(el);
  });
  renderSubtitleTabularView();
}

// ---------- Subtitle Tabular View: every subtitle as one editable row ----------
function addNewSubtitle() {
  const total = getTotalDurationMs();
  if (total <= 0) { alert('Import or capture frames first.'); return null; }
  const duration = Math.min(2000, total);
  const sub = { id: nextSubtitleId++, text: 'New subtitle', startMs: 0, durationMs: duration, size: 'medium', style: 'light-shadow', xFrac: 0.5, yFrac: 0.88, revealMode: 'all' };
  subtitles.push(sub);
  return sub;
}

function renderSubtitleTabularView() {
  const tbody = document.getElementById('subtitle-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  const sorted = subtitles.slice().sort((a, b) => a.startMs - b.startMs);

  sorted.forEach((sub, index) => {
    const tr = document.createElement('tr');

    const tdIdx = document.createElement('td');
    tdIdx.textContent = String(index + 1);
    tr.appendChild(tdIdx);

    const tdText = document.createElement('td');
    const textInput = document.createElement('input');
    textInput.type = 'text'; textInput.className = 'table-input table-input-wide'; textInput.value = sub.text;
    textInput.addEventListener('input', () => {
      sub.text = textInput.value || '';
      // Deliberately NOT calling renderSubtitleTrack()/renderSubtitleTabularView()
      // here \u2014 either would rebuild this very input mid-keystroke and steal
      // focus. Update the other live views directly instead; the timeline
      // clip's label catches up next time something else triggers a render.
      if (sub.id === selectedSubtitleId) {
        document.getElementById('subtitle-text-input').value = sub.text;
      }
      renderSubtitleStagePreview();
      refreshPreviewForSelectedFrame();
    });
    tdText.appendChild(textInput);
    tr.appendChild(tdText);

    const tdStart = document.createElement('td');
    const startInput = document.createElement('input');
    startInput.type = 'number'; startInput.step = '0.1'; startInput.min = '0'; startInput.className = 'table-input';
    startInput.value = (sub.startMs / 1000).toFixed(1);
    startInput.addEventListener('change', () => {
      const t = getTotalDurationMs();
      const maxStart = Math.max(0, t - sub.durationMs);
      const v = Math.max(0, Math.min(maxStart, Number(startInput.value) * 1000 || 0));
      sub.startMs = v;
      startInput.value = (v / 1000).toFixed(1);
      if (sub.id === selectedSubtitleId) populateSubtitleEditFields(sub);
      renderSubtitleTrack();
      renderSubtitleStagePreview();
      refreshPreviewForSelectedFrame();
    });
    tdStart.appendChild(startInput);
    tr.appendChild(tdStart);

    const tdDur = document.createElement('td');
    const durInput = document.createElement('input');
    durInput.type = 'number'; durInput.step = '0.1'; durInput.min = '0.15'; durInput.className = 'table-input';
    durInput.value = (sub.durationMs / 1000).toFixed(1);
    durInput.addEventListener('change', () => {
      const t = getTotalDurationMs();
      const v = Math.max(150, Math.min(t - sub.startMs, Number(durInput.value) * 1000 || 0));
      sub.durationMs = v;
      durInput.value = (v / 1000).toFixed(1);
      if (sub.id === selectedSubtitleId) populateSubtitleEditFields(sub);
      renderSubtitleTrack();
      renderSubtitleStagePreview();
      refreshPreviewForSelectedFrame();
    });
    tdDur.appendChild(durInput);
    tr.appendChild(tdDur);

    const tdSize = document.createElement('td');
    const sizeSelect = document.createElement('select'); sizeSelect.className = 'table-input';
    ['small', 'medium', 'large'].forEach((s) => {
      const opt = document.createElement('option'); opt.value = s; opt.textContent = s;
      if (s === sub.size) opt.selected = true;
      sizeSelect.appendChild(opt);
    });
    sizeSelect.addEventListener('change', () => {
      sub.size = sizeSelect.value;
      if (sub.id === selectedSubtitleId) populateSubtitleEditFields(sub);
      renderSubtitleStagePreview();
      refreshPreviewForSelectedFrame();
    });
    tdSize.appendChild(sizeSelect);
    tr.appendChild(tdSize);

    const tdStyle = document.createElement('td');
    const styleSelect = document.createElement('select'); styleSelect.className = 'table-input';
    [['light-shadow', 'light + dark shadow'], ['dark-glow', 'dark + light glow']].forEach(([v, label]) => {
      const opt = document.createElement('option'); opt.value = v; opt.textContent = label;
      if (v === sub.style) opt.selected = true;
      styleSelect.appendChild(opt);
    });
    styleSelect.addEventListener('change', () => {
      sub.style = styleSelect.value;
      if (sub.id === selectedSubtitleId) populateSubtitleEditFields(sub);
      renderSubtitleStagePreview();
      refreshPreviewForSelectedFrame();
    });
    tdStyle.appendChild(styleSelect);
    tr.appendChild(tdStyle);

    const tdReveal = document.createElement('td');
    const revealSelect = document.createElement('select'); revealSelect.className = 'table-input';
    [['all', 'all at once'], ['words', 'word by word'], ['letters', 'per letter']].forEach(([v, label]) => {
      const opt = document.createElement('option'); opt.value = v; opt.textContent = label;
      if (v === (sub.revealMode || 'all')) opt.selected = true;
      revealSelect.appendChild(opt);
    });
    revealSelect.addEventListener('change', () => {
      sub.revealMode = revealSelect.value;
      if (sub.id === selectedSubtitleId) populateSubtitleEditFields(sub);
      renderSubtitleStagePreview();
      refreshPreviewForSelectedFrame();
    });
    tdReveal.appendChild(revealSelect);
    tr.appendChild(tdReveal);

    const tdActions = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.className = 'small-btn'; delBtn.textContent = 'delete';
    delBtn.addEventListener('click', () => {
      subtitles = subtitles.filter((s) => s.id !== sub.id);
      if (selectedSubtitleId === sub.id) selectAdjacentSubtitleOrNone();
      else renderSubtitleTrack();
    });
    tdActions.appendChild(delBtn);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

function startSubtitleDrag(e, sub, mode) {
  e.preventDefault();
  const trackWidth = subtitleTrackEl.clientWidth || 1;
  const total = Math.max(1, getTotalDurationMs());
  const startX = e.clientX;
  const origStart = sub.startMs;
  const origDuration = sub.durationMs;
  const MIN_DURATION_MS = 150;

  function onMove(ev) {
    const deltaMs = ((ev.clientX - startX) / trackWidth) * total;
    if (mode === 'move') {
      sub.startMs = Math.max(0, Math.min(total - origDuration, origStart + deltaMs));
    } else if (mode === 'left') {
      const newStart = Math.max(0, Math.min(origStart + origDuration - MIN_DURATION_MS, origStart + deltaMs));
      sub.startMs = newStart;
      sub.durationMs = origStart + origDuration - newStart;
    } else if (mode === 'right') {
      sub.durationMs = Math.max(MIN_DURATION_MS, Math.min(total - origStart, origDuration + deltaMs));
    }
    renderSubtitleTrack();
    if (selectedSubtitleId === sub.id) populateSubtitleEditFields(sub);
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    refreshPreviewForSelectedFrame();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function refreshPreviewForSelectedFrame() {
  const selected = frames.find((f) => f.id === selectedFrameId);
  if (selected) drawPreview(selected);
}

function selectSubtitle(id) {
  selectedSubtitleId = id;
  const sub = subtitles.find((s) => s.id === id);
  if (!sub) return;
  subtitleEditPanel.classList.remove('hidden');
  populateSubtitleEditFields(sub);
  renderSubtitleTrack();
  renderSubtitleStagePreview();
}

function populateSubtitleEditFields(sub) {
  document.getElementById('subtitle-text-input').value = sub.text;
  document.getElementById('subtitle-start-input').value = (sub.startMs / 1000).toFixed(1);
  document.getElementById('subtitle-duration-input').value = (sub.durationMs / 1000).toFixed(1);
  document.querySelectorAll('.size-btn').forEach((b) => b.classList.toggle('active', b.dataset.size === sub.size));
  document.querySelectorAll('.style-btn').forEach((b) => b.classList.toggle('active', b.dataset.style === sub.style));
  document.querySelectorAll('.reveal-btn').forEach((b) => b.classList.toggle('active', b.dataset.reveal === (sub.revealMode || 'all')));
}

// ---------- Subtitle stage: live preview + draggable position box ----------
const subtitleStageEmpty = document.getElementById('subtitle-stage-empty');
const subtitlePreviewCanvas = document.getElementById('subtitle-preview-canvas');
const subtitleDragBox = document.getElementById('subtitle-drag-box');

// overrideSub/progress let the "preview reveal" button animate unsaved
// edits without touching the real subtitle object; omitted, this shows the
// currently-selected subtitle fully revealed at its stored position.
function renderSubtitleStagePreview(overrideSub, progress) {
  const sub = overrideSub || subtitles.find((s) => s.id === selectedSubtitleId);
  if (!sub || frames.length === 0) {
    subtitleStageEmpty.classList.remove('hidden');
    subtitlePreviewCanvas.classList.add('hidden');
    subtitleDragBox.classList.add('hidden');
    return;
  }
  subtitleStageEmpty.classList.add('hidden');
  subtitlePreviewCanvas.classList.remove('hidden');
  subtitleDragBox.classList.remove('hidden');

  const resolved = frames.map((f) => ({ durationMs: f.durationMs != null ? f.durationMs : Math.round(1000 / globalFps), frame: f }));
  const starts = computeCumulativeStarts(resolved);
  let idx = starts.findIndex((s, i) => sub.startMs < s + resolved[i].durationMs);
  if (idx === -1) idx = frames.length - 1;

  getFrameImage(resolved[idx].frame).then((img) => {
    subtitlePreviewCanvas.width = img.width;
    subtitlePreviewCanvas.height = img.height;
    const ctx = subtitlePreviewCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    drawSubtitleOverlay(ctx, subtitlePreviewCanvas.width, subtitlePreviewCanvas.height, sub, progress != null ? progress : 1);

    const dispW = subtitlePreviewCanvas.clientWidth, dispH = subtitlePreviewCanvas.clientHeight;
    const fontRatio = SUBTITLE_SIZE_RATIO[sub.size] || SUBTITLE_SIZE_RATIO.medium;
    subtitleDragBox.style.width = (dispW * 0.7) + 'px';
    subtitleDragBox.style.height = Math.max(30, dispH * fontRatio * 2.6) + 'px';
    subtitleDragBox.style.left = ((sub.xFrac != null ? sub.xFrac : 0.5) * dispW) + 'px';
    subtitleDragBox.style.top = ((sub.yFrac != null ? sub.yFrac : 0.88) * dispH) + 'px';
  });
}

let subtitleDrag = null;
subtitleDragBox.addEventListener('pointerdown', (e) => {
  subtitleDrag = { startX: e.clientX, startY: e.clientY };
  subtitleDragBox.setPointerCapture(e.pointerId);
  e.preventDefault();
});
subtitleDragBox.addEventListener('pointermove', (e) => {
  if (!subtitleDrag) return;
  const sub = subtitles.find((s) => s.id === selectedSubtitleId);
  if (!sub) return;
  const dispW = subtitlePreviewCanvas.clientWidth, dispH = subtitlePreviewCanvas.clientHeight;
  if (!dispW || !dispH) return;
  const dx = (e.clientX - subtitleDrag.startX) / dispW;
  const dy = (e.clientY - subtitleDrag.startY) / dispH;
  subtitleDrag.startX = e.clientX;
  subtitleDrag.startY = e.clientY;
  sub.xFrac = Math.min(1, Math.max(0, (sub.xFrac != null ? sub.xFrac : 0.5) + dx));
  sub.yFrac = Math.min(1, Math.max(0, (sub.yFrac != null ? sub.yFrac : 0.88) + dy));
  renderSubtitleStagePreview();
});
subtitleDragBox.addEventListener('pointerup', () => { subtitleDrag = null; refreshPreviewForSelectedFrame(); });
subtitleDragBox.addEventListener('pointercancel', () => { subtitleDrag = null; });

document.getElementById('btn-add-subtitle').addEventListener('click', () => {
  const sub = addNewSubtitle();
  if (!sub) return;
  selectSubtitle(sub.id);
  expandAccordion('subtitle-header', 'subtitle-body');
  const textInput = document.getElementById('subtitle-text-input');
  textInput.focus();
  textInput.select();
});
document.getElementById('btn-add-subtitle-tab').addEventListener('click', () => {
  const sub = addNewSubtitle();
  if (!sub) return;
  renderSubtitleTrack();
});

function commitSubtitleChip(field, value) {
  const sub = subtitles.find((s) => s.id === selectedSubtitleId);
  if (!sub) return;
  sub[field] = value;
  renderSubtitleTrack();
  renderSubtitleStagePreview();
  refreshPreviewForSelectedFrame();
}
document.querySelectorAll('.size-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.size-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  commitSubtitleChip('size', b.dataset.size);
}));
document.querySelectorAll('.style-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.style-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  commitSubtitleChip('style', b.dataset.style);
}));
document.querySelectorAll('.reveal-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.reveal-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  commitSubtitleChip('revealMode', b.dataset.reveal);
}));

// Text, start and duration all save as you go too \u2014 text live on every
// keystroke, start/duration on blur (so a mid-typing "1" of "15" doesn't
// briefly commit and get clamped).
document.getElementById('subtitle-text-input').addEventListener('input', (e) => {
  const sub = subtitles.find((s) => s.id === selectedSubtitleId);
  if (!sub) return;
  sub.text = e.target.value || '';
  renderSubtitleTrack();
  renderSubtitleStagePreview();
  refreshPreviewForSelectedFrame();
});
document.getElementById('subtitle-start-input').addEventListener('change', (e) => {
  const sub = subtitles.find((s) => s.id === selectedSubtitleId);
  if (!sub) return;
  const total = getTotalDurationMs();
  const maxStart = Math.max(0, total - sub.durationMs);
  const start = Math.max(0, Math.min(maxStart, Number(e.target.value) * 1000 || 0));
  sub.startMs = start;
  e.target.value = (start / 1000).toFixed(1);
  renderSubtitleTrack();
  renderSubtitleStagePreview();
  refreshPreviewForSelectedFrame();
});
document.getElementById('subtitle-duration-input').addEventListener('change', (e) => {
  const sub = subtitles.find((s) => s.id === selectedSubtitleId);
  if (!sub) return;
  const total = getTotalDurationMs();
  const duration = Math.max(150, Math.min(total - sub.startMs, Number(e.target.value) * 1000 || 0));
  sub.durationMs = duration;
  e.target.value = (duration / 1000).toFixed(1);
  renderSubtitleTrack();
  renderSubtitleStagePreview();
  refreshPreviewForSelectedFrame();
});

document.getElementById('btn-subtitle-preview-reveal').addEventListener('click', () => {
  const sub = subtitles.find((s) => s.id === selectedSubtitleId);
  if (!sub) return;
  const durationMs = Math.min(4000, Math.max(800, sub.durationMs || 2000));
  const start = performance.now();
  function tick() {
    const progress = Math.min(1, (performance.now() - start) / durationMs);
    renderSubtitleStagePreview(sub, progress);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
});

// Selects the next best subtitle to show after the current one goes away
// (deleted, or none was selected yet) \u2014 so the tab never sits on an empty
// "click something" state when there's actually something to show.
function selectAdjacentSubtitleOrNone() {
  if (subtitles.length === 0) {
    selectedSubtitleId = null;
    subtitleEditPanel.classList.add('hidden');
    renderSubtitleTrack();
    renderSubtitleStagePreview();
    return;
  }
  const earliest = subtitles.slice().sort((a, b) => a.startMs - b.startMs)[0];
  selectSubtitle(earliest.id);
}

document.getElementById('btn-subtitle-delete').addEventListener('click', () => {
  subtitles = subtitles.filter((s) => s.id !== selectedSubtitleId);
  refreshPreviewForSelectedFrame();
  selectAdjacentSubtitleOrNone();
});

window.addEventListener('resize', renderSubtitleTrack);

// ---------- Watermark (PNG with true alpha only) ----------
async function loadPngWithAlphaCheck(file) {
  if (file.type !== 'image/png') {
    throw new Error('Only PNG files are accepted for the watermark.');
  }
  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
  const img = await loadImage(dataUrl);

  const off = document.createElement('canvas');
  off.width = img.width;
  off.height = img.height;
  const octx = off.getContext('2d');
  octx.drawImage(img, 0, 0);
  const data = octx.getImageData(0, 0, img.width, img.height).data;

  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) { hasAlpha = true; break; }
  }
  if (!hasAlpha) {
    throw new Error('This PNG has no transparency (alpha channel). Use a PNG with a transparent background.');
  }

  return { dataUrl, img, naturalWidth: img.width, naturalHeight: img.height };
}

document.getElementById('btn-import-watermark').addEventListener('click', () => {
  document.getElementById('file-watermark').click();
});

document.getElementById('file-watermark').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const loaded = await loadPngWithAlphaCheck(file);
    const currentPosition = watermark ? watermark.position : 'top-right';
    const currentOpacity = watermark ? watermark.opacity : 1;
    watermark = { ...loaded, position: currentPosition, opacity: currentOpacity };
    document.getElementById('watermark-name').textContent = file.name;
    refreshPreviewForSelectedFrame();
  } catch (err) {
    alert(err.message);
  }
});

document.querySelectorAll('.wm-pos-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.wm-pos-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  if (watermark) {
    watermark.position = b.dataset.pos;
    refreshPreviewForSelectedFrame();
  }
}));

document.querySelectorAll('.wm-opacity-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.wm-opacity-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  if (watermark) {
    watermark.opacity = Number(b.dataset.opacity);
    refreshPreviewForSelectedFrame();
  }
}));

document.getElementById('btn-remove-watermark').addEventListener('click', () => {
  watermark = null;
  document.getElementById('watermark-name').textContent = 'none';
  refreshPreviewForSelectedFrame();
});

// ---------- Menu bar ----------
document.querySelectorAll('.menu-trigger').forEach((trigger) => {
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = trigger.closest('.menu');
    const isOpen = menu.classList.contains('open');
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
    if (!isOpen) menu.classList.add('open');
  });
});
document.addEventListener('click', () => {
  document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
});
document.querySelectorAll('.menu-dropdown button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  });
});

// ---------- Frame settings sidebar collapse ----------
const frameInspectorEl = document.getElementById('frame-inspector');
function toggleInspector() { frameInspectorEl.classList.toggle('collapsed'); }
document.getElementById('btn-toggle-inspector').addEventListener('click', toggleInspector);
document.getElementById('btn-toggle-inspector-menu').addEventListener('click', toggleInspector);

// ---------- Accordion sections (timeline / audio / subtitles) ----------
function wireAccordion(headerId, bodyId) {
  const header = document.getElementById(headerId);
  const body = document.getElementById(bodyId);
  header.addEventListener('click', (e) => {
    if (e.target.closest('.no-toggle')) return;
    const collapsed = body.classList.toggle('collapsed');
    header.classList.toggle('collapsed', collapsed);
  });
}
function expandAccordion(headerId, bodyId) {
  document.getElementById(headerId).classList.remove('collapsed');
  document.getElementById(bodyId).classList.remove('collapsed');
}
wireAccordion('timeline-header', 'frame-track');
wireAccordion('audio-header', 'audio-body');
wireAccordion('subtitle-header', 'subtitle-body');

// ---------- Watermark dialog open/close ----------
document.getElementById('btn-open-watermark-dialog').addEventListener('click', () => {
  document.getElementById('watermark-modal').classList.remove('hidden');
});
document.getElementById('btn-watermark-close').addEventListener('click', () => {
  document.getElementById('watermark-modal').classList.add('hidden');
});

// ---------- Save / Load project ----------
async function serializeProject(onProgress) {
  const resolvedFrames = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const dataUrl = f.dataUrl || await resolveFrameDataUrlFromRecipe(f.recipe);
    resolvedFrames.push({ dataUrl, durationMs: f.durationMs });
    if (onProgress) onProgress(i + 1, frames.length);
    // Resolve one lite frame at a time rather than all at once, so saving a
    // large lite-mode sequence doesn't reproduce the very memory spike this
    // storage mode exists to avoid.
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    globalFps,
    frames: resolvedFrames,
    subtitles: subtitles.map((s) => ({ ...s })),
    audio: audioClip ? {
      name: audioClip.name,
      dataUrl: audioClip.dataUrl,
      trimStart: audioClip.trimStart,
      trimEnd: audioClip.trimEnd,
      offsetMs: audioClip.offsetMs,
      volume: audioClip.volume,
    } : null,
    watermark: watermark ? {
      dataUrl: watermark.dataUrl,
      position: watermark.position,
      opacity: watermark.opacity,
    } : null,
  };
}

document.getElementById('btn-save-project').addEventListener('click', async () => {
  if (frames.length === 0) { alert('Nothing to save yet \u2014 import or capture at least one frame first.'); return; }
  const saveBtn = document.getElementById('btn-save-project');
  saveBtn.disabled = true;
  try {
    const data = await serializeProject();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    downloadBlob(blob, 'sequence-project.json');
  } finally {
    saveBtn.disabled = false;
  }
});

document.getElementById('btn-load-project').addEventListener('click', () => {
  document.getElementById('file-project').click();
});

document.getElementById('file-project').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    alert('Could not read this project file \u2014 it may be corrupted or not a project file.');
    return;
  }
  if (!data || !Array.isArray(data.frames)) {
    alert('This doesn\u2019t look like a valid project file.');
    return;
  }

  if (playbackState.playing) stopPlayback();
  stopCaptureIfActive();

  // Frames
  frames = data.frames.map((f) => ({ id: nextFrameId++, dataUrl: f.dataUrl, durationMs: f.durationMs != null ? f.durationMs : null }));
  globalFps = data.globalFps || 12;
  globalFpsInput.value = durationUnit === 'ms' ? Math.round(1000 / globalFps) : globalFps;

  // Subtitles
  subtitles = Array.isArray(data.subtitles) ? data.subtitles.map((s) => ({ ...s })) : [];
  nextSubtitleId = subtitles.reduce((max, s) => Math.max(max, s.id + 1), 1);
  selectedSubtitleId = null;
  subtitleEditPanel.classList.add('hidden');

  // Audio (re-decode from the embedded data URL)
  audioClip = null;
  audioNameLabel.textContent = 'none';
  if (data.audio && data.audio.dataUrl) {
    try {
      const res = await fetch(data.audio.dataUrl);
      const arrayBuffer = await res.arrayBuffer();
      const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = await tempCtx.decodeAudioData(arrayBuffer);
      const channel = buffer.getChannelData(0);
      const samples = 200;
      const blockSize = Math.floor(channel.length / samples);
      const peaks = [];
      for (let i = 0; i < samples; i++) {
        let max = 0;
        const start = i * blockSize;
        for (let j = 0; j < blockSize; j++) {
          const abs = Math.abs(channel[start + j] || 0);
          if (abs > max) max = abs;
        }
        peaks.push(max);
      }
      audioClip = {
        name: data.audio.name || 'audio',
        dataUrl: data.audio.dataUrl,
        buffer, peaks,
        trimStart: data.audio.trimStart || 0,
        trimEnd: data.audio.trimEnd || buffer.duration,
        offsetMs: data.audio.offsetMs || 0,
        volume: data.audio.volume != null ? data.audio.volume : 1,
      };
      audioNameLabel.textContent = audioClip.name;
      drawWaveform();
      populateAudioControls();
      expandAccordion('audio-header', 'audio-body');
    } catch (err) {
      alert('Loaded the project, but the saved audio could not be restored: ' + err.message);
    }
  }

  // Watermark
  watermark = null;
  document.getElementById('watermark-name').textContent = 'none';
  if (data.watermark && data.watermark.dataUrl) {
    try {
      const img = await loadImage(data.watermark.dataUrl);
      watermark = {
        dataUrl: data.watermark.dataUrl,
        img,
        naturalWidth: img.width,
        naturalHeight: img.height,
        position: data.watermark.position || 'top-right',
        opacity: data.watermark.opacity != null ? data.watermark.opacity : 1,
      };
      document.getElementById('watermark-name').textContent = 'restored watermark';
      document.querySelectorAll('.wm-pos-btn').forEach((b) => b.classList.toggle('active', b.dataset.pos === watermark.position));
      document.querySelectorAll('.wm-opacity-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.opacity) === watermark.opacity));
    } catch (err) {
      alert('Loaded the project, but the saved watermark could not be restored: ' + err.message);
    }
  }

  selectedFrameId = null;
  selectedFrameIds = new Set();
  selectionAnchorId = null;
  bundles = {};
  frameDurationInput.disabled = true;
  renderFrameTrack();
  if (frames.length) selectFrame(frames[0].id);
  else previewCaption.textContent = 'no frame selected';
});

renderFrameTrack();

// ---------- Image Extractor mode ----------
const PRESETS = [
  { key: 'tiktok', label: 'TikTok \u2014 1080\u00d71920 (9:16)', w: 1080, h: 1920 },
  { key: 'ig-reels', label: 'Instagram Reels / Story \u2014 1080\u00d71920 (9:16)', w: 1080, h: 1920 },
  { key: 'ig-feed', label: 'Instagram feed \u2014 1080\u00d71350 (4:5)', w: 1080, h: 1350 },
  { key: 'yt-shorts', label: 'YouTube Shorts \u2014 1080\u00d71920 (9:16)', w: 1080, h: 1920 },
  { key: 'fb-reels', label: 'Facebook Reels / Story \u2014 1080\u00d71920 (9:16)', w: 1080, h: 1920 },
  { key: 'fb-feed', label: 'Facebook feed \u2014 1080\u00d71080 (1:1)', w: 1080, h: 1080 },
  { key: 'landscape', label: 'Landscape \u2014 1920\u00d71080 (16:9)', w: 1920, h: 1080 },
  { key: 'custom', label: 'Custom size', w: null, h: null },
];
const EXTRACTOR_STORAGE_KEY = 'imageSequencer.extractorLastPositions.v1';

let extractorImg = null;          // loaded HTMLImageElement of the source image
let extractorPresetKey = 'tiktok';
let extractorBox = null;          // { originXFrac, originYFrac, endXFrac, endYFrac, wFrac } \u2014 hFrac is always derived
let extractorSliceCount = 24;
let extractorShowGrid = false;
let extractorShowThirds = false;
let extractorSmoothLock = false;
let extractorEffectMode = 'pan'; // 'pan' (locked equal size) | 'zoom' (independent origin/end size)
let extractedGroups = [];         // { id, label, frames: [{ id, dataUrl }] }
let nextGroupId = 1;
let extractorDrag = null;

const extractorStage = document.getElementById('extractor-stage');
const extractorImageEl = document.getElementById('extractor-image');
const extractorEmptyState = document.getElementById('extractor-empty-state');
const extractorPresetSelect = document.getElementById('extractor-preset');
const extractorCustomRow = document.getElementById('extractor-custom-size-row');
const extractorCustomWidth = document.getElementById('extractor-custom-width');
const extractorCustomHeight = document.getElementById('extractor-custom-height');
const extractorSliceInput = document.getElementById('extractor-slice-count');
const extractorGridOverlay = document.getElementById('extractor-grid-overlay');
const extractorConnector = document.getElementById('extractor-connector');
const extractorConnectorLine = document.getElementById('extractor-connector-line');
const extractorBoxOriginEl = document.getElementById('extractor-box-origin');
const extractorBoxEndEl = document.getElementById('extractor-box-end');
const extractedGroupsPanel = document.getElementById('extracted-groups-panel');
const extractedGroupsBody = document.getElementById('extracted-groups-body');
const extractedGroupsCount = document.getElementById('extracted-groups-count');
const sameAreaModal = document.getElementById('extractor-same-area-modal');
const extractorGenerateBtn = document.getElementById('btn-extractor-generate');
const extractorGenerateStatus = document.getElementById('extractor-generate-status');
const extractorThirdsEls = document.querySelectorAll('.extractor-box-thirds');
const extractorSmoothLockBtn = document.getElementById('btn-extractor-smooth-lock');
const extractorPaceHint = document.getElementById('extractor-pace-hint');

PRESETS.forEach((p) => {
  const opt = document.createElement('option');
  opt.value = p.key;
  opt.textContent = p.label;
  extractorPresetSelect.appendChild(opt);
});
extractorPresetSelect.value = extractorPresetKey;
extractorSliceCount = Number(extractorSliceInput.value) || 24;

function getExtractorPresetDims() {
  if (extractorPresetKey === 'custom') {
    return {
      w: Math.max(16, Number(extractorCustomWidth.value) || 1080),
      h: Math.max(16, Number(extractorCustomHeight.value) || 1920),
    };
  }
  const p = PRESETS.find((x) => x.key === extractorPresetKey);
  return { w: p.w, h: p.h };
}

function presetLabelFor(key) {
  if (key === 'custom') {
    const { w, h } = getExtractorPresetDims();
    return `custom ${w}\u00d7${h}`;
  }
  const p = PRESETS.find((x) => x.key === key);
  return p ? p.label.split(' \u2014 ')[0] : key;
}

// hFrac is derived from wFrac + the active preset's aspect ratio, rather than
// stored, so a box always keeps the correct aspect ratio no matter which
// image it's applied to (a stored hFrac from a differently-shaped image
// would otherwise skew off-ratio).
function hFracFromWFrac(wFrac) {
  const { w: pw, h: ph } = getExtractorPresetDims();
  const ar = pw / ph;
  const NW = extractorImg.naturalWidth, NH = extractorImg.naturalHeight;
  return (wFrac * NW / ar) / NH;
}

// Keeps the box within the image at a sane min/max size for the current
// preset + image combination \u2014 this is what makes a preset whose aspect
// ratio doesn't comfortably fit the image auto-shrink instead of erroring.
// The max is the true 100% of whichever dimension is the binding
// constraint (so the box can reach the actual image edge, not a margin
// short of it) \u2014 only the OTHER dimension necessarily falls short, which
// is geometry (a fixed-aspect-ratio box can't fill a differently-shaped
// image on both axes at once), not a deliberate limit.
function clampWFrac(wFrac) {
  if (!extractorImg) return wFrac;
  const { w: pw, h: ph } = getExtractorPresetDims();
  const ar = pw / ph;
  const NW = extractorImg.naturalWidth, NH = extractorImg.naturalHeight;
  let bw = wFrac * NW, bh = bw / ar;
  if (bw > NW) { bw = NW; bh = bw / ar; }
  if (bh > NH) { bh = NH; bw = bh * ar; }
  const minBw = Math.max(20, NW * 0.04);
  if (bw < minBw) { bw = minBw; bh = bw / ar; }
  return bw / NW;
}

function clampBoxPosition(box) {
  const originHFrac = hFracFromWFrac(box.originWFrac);
  const endHFrac = hFracFromWFrac(box.endWFrac);
  box.originXFrac = Math.min(Math.max(box.originXFrac, 0), Math.max(0, 1 - box.originWFrac));
  box.endXFrac = Math.min(Math.max(box.endXFrac, 0), Math.max(0, 1 - box.endWFrac));
  box.originYFrac = Math.min(Math.max(box.originYFrac, 0), Math.max(0, 1 - originHFrac));
  box.endYFrac = Math.min(Math.max(box.endYFrac, 0), Math.max(0, 1 - endHFrac));
  return box;
}

function defaultBoxForPreset() {
  const wFrac = clampWFrac(0.32);
  const hFrac = hFracFromWFrac(wFrac);
  const originXFrac = 0.06;
  const endXFrac = Math.max(0.06, 1 - 0.06 - wFrac);
  const yFrac = Math.min(Math.max((1 - hFrac) / 2, 0), Math.max(0, 1 - hFrac));
  return { originXFrac, originYFrac: yFrac, originWFrac: wFrac, endXFrac, endYFrac: yFrac, endWFrac: wFrac };
}

function loadLastPositions() {
  try { return JSON.parse(localStorage.getItem(EXTRACTOR_STORAGE_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveLastPosition() {
  if (!extractorBox) return;
  const all = loadLastPositions();
  all[extractorPresetKey] = { ...extractorBox };
  try { localStorage.setItem(EXTRACTOR_STORAGE_KEY, JSON.stringify(all)); } catch (e) {}
}

function applyPresetChange() {
  if (!extractorImg) return;
  const stored = loadLastPositions()[extractorPresetKey];
  // Accept both the current format (originWFrac/endWFrac) and the older
  // single-wFrac format from before the zoom effect existed.
  if (stored && (typeof stored.originWFrac === 'number' || typeof stored.wFrac === 'number')) {
    const originWFrac = clampWFrac(stored.originWFrac != null ? stored.originWFrac : stored.wFrac);
    const endWFrac = clampWFrac(stored.endWFrac != null ? stored.endWFrac : stored.wFrac);
    extractorBox = clampBoxPosition({
      originXFrac: stored.originXFrac, originYFrac: stored.originYFrac, originWFrac,
      endXFrac: stored.endXFrac, endYFrac: stored.endYFrac, endWFrac,
    });
  } else {
    extractorBox = defaultBoxForPreset();
  }
  layoutExtractorBoxes();
}

function layoutExtractorBoxes() {
  if (!extractorImg || !extractorBox) return;
  const dispW = extractorImageEl.clientWidth, dispH = extractorImageEl.clientHeight;
  if (!dispW || !dispH) return;
  const originHFrac = hFracFromWFrac(extractorBox.originWFrac);
  const endHFrac = hFracFromWFrac(extractorBox.endWFrac);

  function place(el, xFrac, yFrac, wFrac, hFrac) {
    el.style.left = (xFrac * dispW) + 'px';
    el.style.top = (yFrac * dispH) + 'px';
    el.style.width = (wFrac * dispW) + 'px';
    el.style.height = (hFrac * dispH) + 'px';
  }
  place(extractorBoxOriginEl, extractorBox.originXFrac, extractorBox.originYFrac, extractorBox.originWFrac, originHFrac);
  place(extractorBoxEndEl, extractorBox.endXFrac, extractorBox.endYFrac, extractorBox.endWFrac, endHFrac);

  const originCenterXFrac = extractorBox.originXFrac + extractorBox.originWFrac / 2;
  const originCenterYFrac = extractorBox.originYFrac + originHFrac / 2;
  const endCenterXFrac = extractorBox.endXFrac + extractorBox.endWFrac / 2;
  const endCenterYFrac = extractorBox.endYFrac + endHFrac / 2;

  const ALIGN_EPS = 0.01;
  const alignedHorizontal = Math.abs(originCenterYFrac - endCenterYFrac) < ALIGN_EPS;
  const alignedVertical = Math.abs(originCenterXFrac - endCenterXFrac) < ALIGN_EPS;
  extractorBoxEndEl.classList.toggle('aligned', alignedHorizontal || alignedVertical);

  extractorConnectorLine.setAttribute('x1', originCenterXFrac * dispW);
  extractorConnectorLine.setAttribute('y1', originCenterYFrac * dispH);
  extractorConnectorLine.setAttribute('x2', endCenterXFrac * dispW);
  extractorConnectorLine.setAttribute('y2', endCenterYFrac * dispH);

  updatePaceHint();
}

// ---------- Import source image ----------
document.getElementById('btn-extractor-import').addEventListener('click', () => {
  document.getElementById('file-extractor-image').click();
});
document.getElementById('file-extractor-image').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const dataUrl = await new Promise((res) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.readAsDataURL(file);
  });
  const img = await loadImage(dataUrl);
  extractorImg = img;
  extractorImageEl.src = dataUrl;
  extractorImageEl.classList.remove('hidden');
  extractorEmptyState.classList.add('hidden');
  extractorBoxOriginEl.classList.remove('hidden');
  extractorBoxEndEl.classList.remove('hidden');
  extractorConnector.classList.remove('hidden');
  applyPresetChange();
});
extractorImageEl.addEventListener('load', () => layoutExtractorBoxes());
window.addEventListener('resize', () => { if (extractorImg) layoutExtractorBoxes(); });

// ---------- Preset / custom size / slice count controls ----------
extractorPresetSelect.addEventListener('change', () => {
  extractorPresetKey = extractorPresetSelect.value;
  extractorCustomRow.classList.toggle('hidden', extractorPresetKey !== 'custom');
  applyPresetChange();
});
extractorCustomWidth.addEventListener('change', () => { if (extractorPresetKey === 'custom') applyPresetChange(); });
extractorCustomHeight.addEventListener('change', () => { if (extractorPresetKey === 'custom') applyPresetChange(); });

const extractorSliceHint = document.getElementById('extractor-slice-hint');
function updateSliceHint() {
  const v = Number(extractorSliceInput.value) || extractorSliceCount;
  let text = '', warn = false;
  if (v > HARD_CONFIRM_SLICE_COUNT) { text = 'large batch \u2014 confirmation required'; warn = true; }
  else if (v > SOFT_WARN_SLICE_COUNT) { text = 'large batch \u2014 stored efficiently (lite mode)'; warn = true; }
  else if (v > LITE_BUNDLE_THRESHOLD) { text = `lite mode (>${LITE_BUNDLE_THRESHOLD} slices)`; }
  extractorSliceHint.textContent = text;
  extractorSliceHint.classList.toggle('warn', warn);
}
extractorSliceInput.addEventListener('input', () => { updateSliceHint(); updatePaceHint(); });
extractorSliceInput.addEventListener('change', () => {
  let v = Math.round(Number(extractorSliceInput.value));
  if (!Number.isFinite(v) || v < 2) v = 2;
  extractorSliceInput.value = v;
  extractorSliceCount = v;
  updateSliceHint();
  updatePaceHint();
});
updateSliceHint();

document.getElementById('btn-extractor-grid').addEventListener('click', (e) => {
  extractorShowGrid = !extractorShowGrid;
  extractorGridOverlay.classList.toggle('hidden', !extractorShowGrid);
  e.currentTarget.classList.toggle('active', extractorShowGrid);
});

document.getElementById('btn-extractor-thirds').addEventListener('click', (e) => {
  extractorShowThirds = !extractorShowThirds;
  extractorThirdsEls.forEach((el) => el.classList.toggle('visible', extractorShowThirds));
  e.currentTarget.classList.toggle('active', extractorShowThirds);
});

document.querySelectorAll('#extractor-effect-toggle .effect-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.effect;
    if (mode === extractorEffectMode) return;
    extractorEffectMode = mode;
    document.querySelectorAll('#extractor-effect-toggle .effect-btn').forEach((b) => b.classList.toggle('active', b === btn));
    if (mode === 'pan' && extractorBox) {
      // Collapse back to one shared size \u2014 pure pan has no independent
      // origin/end size by definition.
      extractorBox.endWFrac = extractorBox.originWFrac;
      clampBoxPosition(extractorBox);
      saveLastPosition();
    }
    layoutExtractorBoxes();
  });
});

// ---------- Box drag / resize ----------
function setupBoxInteractions(boxEl, role) {
  boxEl.addEventListener('pointerdown', (e) => {
    if (!extractorBox) return;
    if (e.target.dataset.handle === 'resize') {
      extractorDrag = { mode: 'resize', role, startX: e.clientX, startWFrac: role === 'origin' ? extractorBox.originWFrac : extractorBox.endWFrac };
    } else {
      extractorDrag = {
        mode: 'move', role,
        startX: e.clientX, startY: e.clientY,
        startXFrac: role === 'origin' ? extractorBox.originXFrac : extractorBox.endXFrac,
        startYFrac: role === 'origin' ? extractorBox.originYFrac : extractorBox.endYFrac,
      };
    }
    boxEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  boxEl.addEventListener('pointermove', (e) => {
    if (!extractorDrag) return;
    const dispW = extractorImageEl.clientWidth, dispH = extractorImageEl.clientHeight;
    if (extractorDrag.mode === 'move') {
      const nx = extractorDrag.startXFrac + (e.clientX - extractorDrag.startX) / dispW;
      const ny = extractorDrag.startYFrac + (e.clientY - extractorDrag.startY) / dispH;
      if (extractorDrag.role === 'origin') { extractorBox.originXFrac = nx; extractorBox.originYFrac = ny; }
      else { extractorBox.endXFrac = nx; extractorBox.endYFrac = ny; }
    } else {
      const newW = clampWFrac(extractorDrag.startWFrac + (e.clientX - extractorDrag.startX) / dispW);
      if (extractorDrag.role === 'origin') {
        extractorBox.originWFrac = newW;
        if (extractorEffectMode === 'pan') extractorBox.endWFrac = newW;
      } else {
        extractorBox.endWFrac = newW;
        if (extractorEffectMode === 'pan') extractorBox.originWFrac = newW;
      }
    }
    clampBoxPosition(extractorBox);
    layoutExtractorBoxes();
  });
  boxEl.addEventListener('pointerup', () => { if (extractorDrag) { extractorDrag = null; saveLastPosition(); } });
  boxEl.addEventListener('pointercancel', () => { extractorDrag = null; });
}
setupBoxInteractions(extractorBoxOriginEl, 'origin');
setupBoxInteractions(extractorBoxEndEl, 'end');

// ---------- Generate slices ----------
// Distance is measured against the box's own diagonal (not the source
// image) because the same pixel distance is a much bigger jump for a
// tightly-zoomed box than a wide one \u2014 what matters is how much of the
// frame's own content shifts between slices, not how far it moved on the
// original photo.
function computePanPace() {
  if (!extractorImg || !extractorBox) return null;
  const NW = extractorImg.naturalWidth, NH = extractorImg.naturalHeight;
  const originHFrac = hFracFromWFrac(extractorBox.originWFrac);
  const endHFrac = hFracFromWFrac(extractorBox.endWFrac);
  const originCenterXFrac = extractorBox.originXFrac + extractorBox.originWFrac / 2;
  const originCenterYFrac = extractorBox.originYFrac + originHFrac / 2;
  const endCenterXFrac = extractorBox.endXFrac + extractorBox.endWFrac / 2;
  const endCenterYFrac = extractorBox.endYFrac + endHFrac / 2;

  const dxPx = (endCenterXFrac - originCenterXFrac) * NW;
  const dyPx = (endCenterYFrac - originCenterYFrac) * NH;
  const distancePx = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
  const originDiagPx = Math.sqrt((extractorBox.originWFrac * NW) ** 2 + (originHFrac * NH) ** 2);
  const endDiagPx = Math.sqrt((extractorBox.endWFrac * NW) ** 2 + (endHFrac * NH) ** 2);
  const avgDiagPx = (originDiagPx + endDiagPx) / 2;
  const travelRatio = avgDiagPx > 0 ? distancePx / avgDiagPx : 0;

  // How much the box itself grows/shrinks, as a fraction of its average
  // size \u2014 the zoom-effect counterpart to travelRatio.
  const avgWFrac = (extractorBox.originWFrac + extractorBox.endWFrac) / 2;
  const zoomRatio = avgWFrac > 0 ? Math.abs(extractorBox.endWFrac - extractorBox.originWFrac) / avgWFrac : 0;

  const paceRatio = Math.max(travelRatio, zoomRatio);
  const count = Math.max(2, extractorSliceCount);
  const stepRatio = paceRatio / (count - 1);
  const recommendedSlices = Math.max(2, Math.ceil(paceRatio / SMOOTH_PAN_TARGET_STEP_RATIO) + 1);
  return { stepRatio, recommendedSlices };
}

function updatePaceHint() {
  const pace = computePanPace();
  if (!pace) { extractorPaceHint.textContent = ''; return; }

  if (extractorSmoothLock && pace.recommendedSlices !== extractorSliceCount) {
    extractorSliceCount = pace.recommendedSlices;
    extractorSliceInput.value = extractorSliceCount;
    updateSliceHint();
    // The count just changed, so the step ratio the lock is now holding is
    // exactly the target \u2014 recompute once more for an accurate readout
    // rather than showing the stale pre-lock number.
    const relocked = computePanPace();
    renderPaceReadout(relocked);
    return;
  }
  renderPaceReadout(pace);
}

function renderPaceReadout(pace) {
  const pct = (pace.stepRatio * 100).toFixed(1);
  let label, cls;
  if (pace.stepRatio <= 0.03) { label = 'smooth'; cls = 'good'; }
  else if (pace.stepRatio <= 0.07) { label = 'noticeable'; cls = 'mid'; }
  else { label = `will look hard \u2014 try \u2265${pace.recommendedSlices} slices`; cls = 'bad'; }
  extractorPaceHint.textContent = `step ${pct}% \u00b7 ${label}`;
  extractorPaceHint.className = cls;
}

extractorSmoothLockBtn.addEventListener('click', (e) => {
  extractorSmoothLock = !extractorSmoothLock;
  extractorSliceInput.disabled = extractorSmoothLock;
  e.currentTarget.classList.toggle('active', extractorSmoothLock);
  updatePaceHint();
});

function isSameArea() {
  const eps = 0.005;
  return Math.abs(extractorBox.originXFrac - extractorBox.endXFrac) < eps &&
         Math.abs(extractorBox.originYFrac - extractorBox.endYFrac) < eps &&
         Math.abs(extractorBox.originWFrac - extractorBox.endWFrac) < eps;
}

const largeBatchModal = document.getElementById('extractor-large-batch-modal');
const largeBatchText = document.getElementById('extractor-large-batch-text');

function checkSameAreaThenGenerate() {
  if (isSameArea()) sameAreaModal.classList.remove('hidden');
  else runExtraction();
}

document.getElementById('btn-extractor-generate').addEventListener('click', () => {
  if (extractorGenerateBtn.disabled) return;
  if (!extractorImg) { alert('Import an image first.'); return; }
  if (extractorSliceCount > HARD_CONFIRM_SLICE_COUNT) {
    largeBatchText.textContent = `Generating ${extractorSliceCount} slices at once can take a while. They'll be stored efficiently (lite mode), but this is still a large batch \u2014 continue?`;
    largeBatchModal.classList.remove('hidden');
  } else {
    checkSameAreaThenGenerate();
  }
});
document.getElementById('btn-large-batch-cancel').addEventListener('click', () => {
  largeBatchModal.classList.add('hidden');
});
document.getElementById('btn-large-batch-confirm').addEventListener('click', () => {
  largeBatchModal.classList.add('hidden');
  checkSameAreaThenGenerate();
});
document.getElementById('btn-same-area-cancel').addEventListener('click', () => {
  sameAreaModal.classList.add('hidden');
});
document.getElementById('btn-same-area-confirm').addEventListener('click', () => {
  sameAreaModal.classList.add('hidden');
  runExtraction();
});

async function runExtraction() {
  const { w: outW, h: outH } = getExtractorPresetDims();
  const NW = extractorImg.naturalWidth, NH = extractorImg.naturalHeight;
  const count = extractorSliceCount;
  const lite = count > LITE_BUNDLE_THRESHOLD;
  const sourceDataUrl = extractorImageEl.src;

  // Interpolating the box's CENTER (rather than its top-left) is what makes
  // this work correctly for both effects: in Pan mode the size is constant
  // so it's equivalent to the old top-left interpolation, but in Zoom mode
  // (size changing over time) interpolating the center keeps the frame
  // growing/shrinking around a consistent focal point instead of drifting.
  const originHFrac = hFracFromWFrac(extractorBox.originWFrac);
  const endHFrac = hFracFromWFrac(extractorBox.endWFrac);
  const originCenterXFrac = extractorBox.originXFrac + extractorBox.originWFrac / 2;
  const originCenterYFrac = extractorBox.originYFrac + originHFrac / 2;
  const endCenterXFrac = extractorBox.endXFrac + extractorBox.endWFrac / 2;
  const endCenterYFrac = extractorBox.endYFrac + endHFrac / 2;

  const off = document.createElement('canvas');
  off.width = outW; off.height = outH;
  const octx = off.getContext('2d');

  const id = nextGroupId++;
  const effectSuffix = extractorEffectMode === 'zoom' ? ' \u2014 zoom' : '';
  const group = {
    id,
    label: `Extract ${id} \u2014 ${count} frames \u2014 ${presetLabelFor(extractorPresetKey)}${effectSuffix}${lite ? ' \u2014 lite' : ''}`,
    frames: [],
  };

  extractorGenerateBtn.disabled = true;
  extractorGenerateStatus.textContent = `generating 0 / ${count}\u2026`;

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const wFrac = extractorBox.originWFrac + (extractorBox.endWFrac - extractorBox.originWFrac) * t;
    const hFrac = hFracFromWFrac(wFrac);
    const centerXFrac = originCenterXFrac + (endCenterXFrac - originCenterXFrac) * t;
    const centerYFrac = originCenterYFrac + (endCenterYFrac - originCenterYFrac) * t;
    const sw = wFrac * NW, sh = hFrac * NH;
    // Re-clamped into the source image each frame as a safety net: two
    // in-bounds boxes with different sizes can, at some in-between t,
    // interpolate to a center/size combination that would otherwise poke
    // slightly outside the source image.
    const sx = Math.min(Math.max(centerXFrac * NW - sw / 2, 0), Math.max(0, NW - sw));
    const sy = Math.min(Math.max(centerYFrac * NH - sh / 2, 0), Math.max(0, NH - sh));
    octx.clearRect(0, 0, outW, outH);
    octx.drawImage(extractorImg, sx, sy, sw, sh, 0, 0, outW, outH);

    // The thumbnail is always generated from the canvas we already just
    // drew \u2014 no extra decode needed \u2014 so both lite and baked frames get
    // one immediately.
    const thumbUrl = makeThumbnailFromCanvas(off, THUMBNAIL_MAX_DIM);
    const frameId = nextFrameId++;
    if (lite) {
      // Recipe only: full-resolution pixels are regenerated on demand
      // (playback, export, expanding the bundle) rather than held now.
      group.frames.push({ id: frameId, thumbUrl, dataUrl: null, recipe: { sourceDataUrl, sx, sy, sw, sh, outW, outH } });
    } else {
      group.frames.push({ id: frameId, thumbUrl, dataUrl: off.toDataURL('image/png') });
    }

    extractorGenerateStatus.textContent = `generating ${i + 1} / ${count}\u2026`;
    // Yield to the browser each iteration so the progress text actually
    // paints, instead of the whole loop running as one blocking task.
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  extractedGroups.push(group);
  renderExtractedGroupsPanel();
  extractorGenerateBtn.disabled = false;
  const doneMsg = lite
    ? `done \u2014 ${count} slices added below (lite mode: stored efficiently, full-res generated on demand)`
    : `done \u2014 ${count} slices added below`;
  extractorGenerateStatus.textContent = doneMsg;
  setTimeout(() => {
    if (extractorGenerateStatus.textContent === doneMsg) extractorGenerateStatus.textContent = '';
  }, 4000);
}

// ---------- Extracted groups tray ----------
function renderExtractedGroupsPanel() {
  extractedGroupsPanel.classList.toggle('hidden', extractedGroups.length === 0);
  extractedGroupsCount.textContent = String(extractedGroups.length);
  extractedGroupsBody.innerHTML = '';
  extractedGroups.forEach((group) => {
    const row = document.createElement('div');
    row.className = 'extracted-group';

    const label = document.createElement('div');
    label.className = 'extracted-group-label';
    const labelText = document.createElement('span');
    labelText.textContent = group.label;
    label.appendChild(labelText);

    const addAllBtn = document.createElement('button');
    addAllBtn.textContent = 'add all \u2192 movie generator';
    addAllBtn.addEventListener('click', () => addGroupAsBundle(group));
    label.appendChild(addAllBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'remove';
    delBtn.addEventListener('click', () => {
      extractedGroups = extractedGroups.filter((g) => g.id !== group.id);
      renderExtractedGroupsPanel();
    });
    label.appendChild(delBtn);

    const strip = document.createElement('div');
    strip.className = 'extracted-group-strip';
    group.frames.forEach((frame, idx) => {
      const thumb = document.createElement('div');
      thumb.className = 'extracted-thumb';
      thumb.style.backgroundImage = `url(${frame.thumbUrl || frame.dataUrl})`;
      thumb.draggable = true;
      thumb.title = 'Drag into the movie generator timeline';
      thumb.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-extracted-frame', JSON.stringify({ groupId: group.id, frameId: frame.id }));
        e.dataTransfer.effectAllowed = 'copy';
      });
      const idxLabel = document.createElement('span');
      idxLabel.className = 'extracted-thumb-index';
      idxLabel.textContent = String(idx + 1);
      thumb.appendChild(idxLabel);
      strip.appendChild(thumb);
    });

    row.appendChild(label);
    row.appendChild(strip);
    extractedGroupsBody.appendChild(row);
  });
}

// Let the movie generator's frame timeline accept drops of extracted slices
// and relocated bundle tiles onto empty track space (append to the end).
frameTrack.addEventListener('dragover', (e) => {
  const types = Array.from(e.dataTransfer.types);
  if (types.includes('application/x-extracted-frame') || types.includes('application/x-bundle-id') || types.includes('application/x-frame-ids')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes('application/x-extracted-frame') ? 'copy' : 'move';
  }
});
frameTrack.addEventListener('drop', (e) => {
  if (e.target.closest('.frame-thumb') || e.target.closest('.frame-bundle')) return; // handled by the thumb/bundle's own drop handler

  const bundleRaw = e.dataTransfer.getData('application/x-bundle-id');
  if (bundleRaw) {
    e.preventDefault();
    const moving = frames.filter((f) => f.bundleId === Number(bundleRaw));
    if (!moving.length) return;
    frames = frames.filter((f) => f.bundleId !== Number(bundleRaw));
    frames.push(...moving);
    renderFrameTrack();
    return;
  }

  const idsRaw = e.dataTransfer.getData('application/x-frame-ids');
  if (idsRaw) {
    e.preventDefault();
    let ids;
    try { ids = JSON.parse(idsRaw); } catch (err) { return; }
    const idSet = new Set(ids);
    const moving = frames.filter((f) => idSet.has(f.id));
    if (!moving.length) return;
    frames = frames.filter((f) => !idSet.has(f.id));
    frames.push(...moving);
    renderFrameTrack();
    return;
  }

  const raw = e.dataTransfer.getData('application/x-extracted-frame');
  if (!raw) return;
  e.preventDefault();
  let payload;
  try { payload = JSON.parse(raw); } catch (err) { return; }
  const group = extractedGroups.find((g) => g.id === payload.groupId);
  if (!group) return;
  const srcFrame = group.frames.find((f) => f.id === payload.frameId);
  if (!srcFrame) return;
  frames.push({ id: nextFrameId++, dataUrl: srcFrame.dataUrl, recipe: srcFrame.recipe || null, thumbUrl: srcFrame.thumbUrl, durationMs: null });
  renderFrameTrack();
});

wireAccordion('extracted-groups-header', 'extracted-groups-body');

// ---------- Mode tab bar ----------
const modeGeneratorEl = document.getElementById('mode-generator');
const modeExtractorEl = document.getElementById('mode-extractor');
const modePanels = {
  extractor: modeExtractorEl,
  generator: modeGeneratorEl,
  audio: document.getElementById('mode-audio'),
  subtitles: document.getElementById('mode-subtitles'),
};
document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;
    document.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t === tab));
    Object.entries(modePanels).forEach(([key, el]) => { if (el) el.classList.toggle('hidden', key !== mode); });
    if (mode === 'extractor' && extractorImg) layoutExtractorBoxes();
    if (mode === 'subtitles') {
      if (selectedSubtitleId == null && subtitles.length > 0) selectAdjacentSubtitleOrNone();
      renderSubtitleTrack();
      renderSubtitleStagePreview(); // widths depend on layout, which only settles once the tab is visible
    }
    if (mode === 'audio') drawWaveform(); // canvas width is 0 while its tab is hidden, so redraw once it's actually visible
  });
});

// ---------- Master / Tabular view toggle (one global switch, all three data tabs) ----------
function applyViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('.view-master').forEach((el) => el.classList.toggle('hidden', viewMode !== 'master'));
  document.querySelectorAll('.view-tabular').forEach((el) => el.classList.toggle('hidden', viewMode !== 'tabular'));
  document.querySelectorAll('.view-mode-btn').forEach((b) => {
    const active = b.dataset.view === viewMode;
    b.classList.toggle('active-view', active);
    const check = b.querySelector('.view-check');
    if (check) check.textContent = active ? '\u2713' : '';
  });
  if (viewMode === 'tabular') {
    renderFrameTabularView();
    renderAudioTabularView();
    renderSubtitleTabularView();
  } else {
    // Coming back to Master View: layout-dependent bits (canvas widths,
    // box positions) need a fresh measure now that they're visible again.
    if (!modeExtractorEl.classList.contains('hidden') && extractorImg) layoutExtractorBoxes();
    if (!document.getElementById('mode-subtitles').classList.contains('hidden')) renderSubtitleStagePreview();
    if (!document.getElementById('mode-audio').classList.contains('hidden')) drawWaveform();
  }
}
document.querySelectorAll('.view-mode-btn').forEach((b) => {
  b.addEventListener('click', () => applyViewMode(b.dataset.view));
});
