// ---------- State ----------
let frames = [];            // { id, dataUrl, durationMs: number|null }
let selectedFrameId = null;
let globalFps = 12;
let audioClip = null;       // { name, dataUrl, buffer: AudioBuffer, peaks: number[], trimStart, trimEnd, offsetMs, volume } | null
let captureStream = null;
let nextFrameId = 1;
let subtitles = [];         // { id, text, startMs, durationMs, size: 'small'|'medium'|'large', style: 'light-shadow'|'dark-glow' }
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

function drawSubtitleOverlay(ctx, W, H, sub) {
  if (!sub || !sub.text) return;
  const fontSize = Math.max(12, Math.round(H * (SUBTITLE_SIZE_RATIO[sub.size] || SUBTITLE_SIZE_RATIO.medium)));
  ctx.font = `700 ${fontSize}px -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const maxWidth = W * 0.9;
  const lines = wrapCanvasText(ctx, sub.text, maxWidth);
  const lineHeight = fontSize * 1.25;
  const bottomMargin = H * 0.08;
  const startY = H - bottomMargin - (lines.length - 1) * lineHeight;

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
    ctx.fillText(line, W / 2, startY + i * lineHeight);
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

  const resolved = frames.map((f) => ({
    dataUrl: f.dataUrl,
    durationMs: f.durationMs != null ? f.durationMs : Math.round(1000 / globalFps),
  }));
  const imgs = await Promise.all(resolved.map((f) => loadImage(f.dataUrl)));
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
  let currentSubId = undefined;
  const timerEl = document.getElementById('playback-timer');
  timerEl.classList.remove('hidden');
  timerEl.textContent = `${formatTime(0)} / ${formatTime(total)}`;

  function tick() {
    if (!playbackState.playing) return;
    const elapsed = performance.now() - startTime;
    if (elapsed >= total) { timerEl.textContent = `${formatTime(total)} / ${formatTime(total)}`; stopPlayback(); return; }
    let idx = cumulative.findIndex((c, i) => elapsed < c + durations[i]);
    if (idx === -1) idx = imgs.length - 1;
    const activeSub = getActiveSubtitle(elapsed);
    const subId = activeSub ? activeSub.id : null;
    if (idx !== currentIndex || subId !== currentSubId) {
      drawContain(previewCtx, imgs[idx], previewCanvas.width, previewCanvas.height);
      if (activeSub) drawSubtitleOverlay(previewCtx, previewCanvas.width, previewCanvas.height, activeSub);
      if (watermark) drawWatermarkOverlay(previewCtx, previewCanvas.width, previewCanvas.height, watermark);
      previewCaption.textContent = `frame ${idx + 1} of ${imgs.length} (playing)`;
      currentIndex = idx;
      currentSubId = subId;
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

  audioClip = { name: file.name, buffer, peaks, trimStart: 0, trimEnd: buffer.duration, offsetMs: 0, volume: 1 };
  audioNameLabel.textContent = file.name;
  drawWaveform();
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
}
window.addEventListener('resize', drawWaveform);

// ---------- Audio edit controls (click waveform to reveal) ----------
const audioControls = document.getElementById('audio-controls');
const audioTrimStartInput = document.getElementById('audio-trim-start');
const audioTrimEndInput = document.getElementById('audio-trim-end');
const audioOffsetInput = document.getElementById('audio-offset');
const audioVolumeInput = document.getElementById('audio-volume');
const audioVolumeReadout = document.getElementById('audio-volume-readout');

audioCanvas.addEventListener('click', () => {
  if (!audioClip) { alert('Import audio first.'); return; }
  const opening = audioControls.classList.contains('hidden');
  if (opening) {
    audioTrimStartInput.value = audioClip.trimStart.toFixed(1);
    audioTrimStartInput.max = audioClip.buffer.duration.toFixed(1);
    audioTrimEndInput.value = audioClip.trimEnd.toFixed(1);
    audioTrimEndInput.max = audioClip.buffer.duration.toFixed(1);
    audioOffsetInput.value = (audioClip.offsetMs / 1000).toFixed(1);
    audioVolumeInput.value = Math.round(audioClip.volume * 100);
    audioVolumeReadout.textContent = `${Math.round(audioClip.volume * 100)}%`;
  }
  audioControls.classList.toggle('hidden');
});

audioVolumeInput.addEventListener('input', () => {
  audioVolumeReadout.textContent = `${audioVolumeInput.value}%`;
});

document.getElementById('btn-audio-apply').addEventListener('click', () => {
  if (!audioClip) return;
  const maxDur = audioClip.buffer.duration;
  let start = Number(audioTrimStartInput.value);
  let end = Number(audioTrimEndInput.value);
  const offsetSec = Number(audioOffsetInput.value);

  if (!(start >= 0) || !(end > start) || end > maxDur + 0.001 || !(offsetSec >= 0)) {
    alert(`Enter a valid trim range within 0\u2013${maxDur.toFixed(1)}s (end must be after start) and a non-negative offset.`);
    return;
  }

  audioClip.trimStart = start;
  audioClip.trimEnd = Math.min(end, maxDur);
  audioClip.offsetMs = Math.round(offsetSec * 1000);
  audioClip.volume = Math.max(0, Math.min(100, Number(audioVolumeInput.value))) / 100;
  drawWaveform();
});

document.getElementById('btn-audio-remove').addEventListener('click', () => {
  audioClip = null;
  audioNameLabel.textContent = 'none';
  audioControls.classList.add('hidden');
  const ctx = audioCanvas.getContext('2d');
  ctx.clearRect(0, 0, audioCanvas.width, audioCanvas.height);
});

// ---------- Frame track (thumbnails, selection, drag reorder) ----------
function renderFrameTrack() {
  frameCountLabel.textContent = `${frames.length} frame${frames.length === 1 ? '' : 's'}`;
  frameTrack.innerHTML = '';
  frames.forEach((frame, index) => {
    const el = document.createElement('div');
    el.className = 'frame-thumb' + (frame.id === selectedFrameId ? ' selected' : '');
    el.style.backgroundImage = `url(${frame.dataUrl})`;
    el.draggable = true;
    el.dataset.frameId = String(frame.id);

    const idx = document.createElement('span');
    idx.className = 'frame-index';
    idx.textContent = String(index + 1);
    el.appendChild(idx);

    el.addEventListener('click', () => selectFrame(frame.id));
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(frame.id));
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const draggedId = Number(e.dataTransfer.getData('text/plain'));
      reorderFrames(draggedId, frame.id);
    });

    frameTrack.appendChild(el);
  });
  renderSubtitleTrack();
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
  const frame = frames.find((f) => f.id === id);
  if (!frame) return;
  frameDurationInput.disabled = false;
  const ms = frame.durationMs != null ? frame.durationMs : Math.round(1000 / globalFps);
  frameDurationInput.value = durationUnit === 'ms' ? ms : Math.round(1000 / ms);
  drawPreview(frame);
  renderFrameTrack();
}

function drawPreview(frame) {
  loadImage(frame.dataUrl).then((img) => {
    previewCanvas.width = img.width;
    previewCanvas.height = img.height;
    previewCtx.drawImage(img, 0, 0);

    const resolved = frames.map((f) => ({ durationMs: f.durationMs != null ? f.durationMs : Math.round(1000 / globalFps) }));
    const starts = computeCumulativeStarts(resolved);
    const idx = frames.findIndex((f) => f.id === frame.id);
    const active = getActiveSubtitle(starts[idx] || 0);
    if (active) drawSubtitleOverlay(previewCtx, previewCanvas.width, previewCanvas.height, active);
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
    dataUrl: f.dataUrl,
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

  const imgs = await Promise.all(frames.map((f) => loadImage(f.dataUrl)));
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
  let currentSubId = undefined;

  await new Promise((resolve) => {
    function tick() {
      const elapsed = performance.now() - startTime;
      if (elapsed >= total) { resolve(); return; }
      let idx = cumulative.findIndex((c, i) => elapsed < c + durations[i]);
      if (idx === -1) idx = frames.length - 1;
      const activeSub = getActiveSubtitle(elapsed);
      const subId = activeSub ? activeSub.id : null;
      if (idx !== currentIndex || subId !== currentSubId) {
        drawContain(ctx, imgs[idx], width, height);
        if (activeSub) drawSubtitleOverlay(ctx, width, height, activeSub);
        if (watermark) drawWatermarkOverlay(ctx, width, height, watermark);
        currentIndex = idx;
        currentSubId = subId;
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
  const imgs = await Promise.all(frames.map((f) => loadImage(f.dataUrl)));
  const starts = computeCumulativeStarts(frames);
  const off = document.createElement('canvas');
  off.width = width; off.height = height;
  const octx = off.getContext('2d');

  return new Promise((resolve, reject) => {
    const gif = new GIF({
      workers: 2,
      quality: 10,
      width, height,
      workerScript: 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/gif.worker.js',
    });
    frames.forEach((f, i) => {
      drawContain(octx, imgs[i], width, height);
      const active = getActiveSubtitle(starts[i]);
      if (active) drawSubtitleOverlay(octx, width, height, active);
      if (watermark) drawWatermarkOverlay(octx, width, height, watermark);
      gif.addFrame(octx, { copy: true, delay: f.durationMs });
    });
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
}

function populateSubtitleEditFields(sub) {
  document.getElementById('subtitle-text-input').value = sub.text;
  document.getElementById('subtitle-start-input').value = (sub.startMs / 1000).toFixed(1);
  document.getElementById('subtitle-duration-input').value = (sub.durationMs / 1000).toFixed(1);
  document.querySelectorAll('.size-btn').forEach((b) => b.classList.toggle('active', b.dataset.size === sub.size));
  document.querySelectorAll('.style-btn').forEach((b) => b.classList.toggle('active', b.dataset.style === sub.style));
}

document.getElementById('btn-add-subtitle').addEventListener('click', () => {
  const total = getTotalDurationMs();
  if (total <= 0) { alert('Import or capture frames first.'); return; }
  const duration = Math.min(2000, total);
  const sub = { id: nextSubtitleId++, text: 'New subtitle', startMs: 0, durationMs: duration, size: 'medium', style: 'light-shadow' };
  subtitles.push(sub);
  selectSubtitle(sub.id);
  expandAccordion('subtitle-header', 'subtitle-body');
});

document.querySelectorAll('.size-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.size-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
}));
document.querySelectorAll('.style-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.style-btn').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
}));

document.getElementById('btn-subtitle-apply').addEventListener('click', () => {
  const sub = subtitles.find((s) => s.id === selectedSubtitleId);
  if (!sub) return;

  const total = getTotalDurationMs();
  let start = Number(document.getElementById('subtitle-start-input').value) * 1000;
  let duration = Number(document.getElementById('subtitle-duration-input').value) * 1000;
  if (!(start >= 0) || !(duration > 0)) {
    alert('Enter a valid start time and duration.');
    return;
  }
  start = Math.max(0, Math.min(total, start));
  duration = Math.max(150, Math.min(total - start, duration));

  sub.text = document.getElementById('subtitle-text-input').value || '';
  sub.startMs = start;
  sub.durationMs = duration;
  const activeSizeBtn = document.querySelector('.size-btn.active');
  sub.size = activeSizeBtn ? activeSizeBtn.dataset.size : 'medium';
  const activeStyleBtn = document.querySelector('.style-btn.active');
  sub.style = activeStyleBtn ? activeStyleBtn.dataset.style : 'light-shadow';

  renderSubtitleTrack();
  refreshPreviewForSelectedFrame();
});

document.getElementById('btn-subtitle-delete').addEventListener('click', () => {
  subtitles = subtitles.filter((s) => s.id !== selectedSubtitleId);
  selectedSubtitleId = null;
  subtitleEditPanel.classList.add('hidden');
  renderSubtitleTrack();
  refreshPreviewForSelectedFrame();
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

renderFrameTrack();
