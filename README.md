# Image Sequencer

A browser-based frame-by-frame image sequencer for stop-motion animation.
Import images or capture live from a webcam, reorder frames on a drag-and-drop
timeline, control timing per-frame or globally (in fps or ms), layer in an
audio track with trim/offset/volume, add subtitles and a watermark, then
save and reopen projects, then export to WebM, MP4, or GIF — all
client-side, with no server or build step.

## Running it

This is a static site — three files, no build tooling, no dependencies to
install.

**Locally**: open `index.html` directly in a browser, or serve the folder
with any static file server (e.g. `npx serve .` or Python's
`python3 -m http.server`). A local server is only needed if your browser
restricts some APIs (like `fetch`/module loading) under the `file://`
protocol — in testing, opening the file directly has generally been enough
for this app's features, but a static server is the safer default and is
required for GitHub Pages anyway.

**GitHub Pages**: push these files to a repo, then enable Pages for the
branch/root in the repo's Settings → Pages. No build step — it serves as-is.

## Files

- `index.html` — page structure and markup
- `styles.css` — the "Darkroom" visual theme
- `script.js` — all application logic (capture, timeline, audio, subtitles,
  watermark, playback, export)
- External dependencies loaded from CDNs in `index.html`: `gif.js` for GIF
  export and `ffmpeg.wasm` for MP4 transcoding

## Features

- **Frame sources**: import image files, or capture live from a webcam
- **Timeline**: drag to reorder frames; per-frame or global (fps/ms) duration
  control, plus a range field (`1-5, 22, 24`) to apply a duration to a
  specific set of frames at once
- **Audio track**: import a clip, trim start/end, delay its start relative
  to frame 1, adjust volume — click the waveform to reveal these controls
- **Subtitles**: add text clips on their own draggable/resizable track;
  three sizes, two styles (light text + dark shadow, or dark text + light
  glow) — burned directly into the picture, not a separate caption file
- **Watermark**: PNG only, and only PNGs with real transparency are
  accepted (checked by inspecting the actual pixel alpha data, not just the
  file extension) — five position presets, four opacity levels
- **Playback**: Play button previews the sequence with audio at real
  timing; optional "fullscreen upon play" (waits 1s after entering
  fullscreen before playback starts); fullscreen auto-exits when playback
  stops or finishes
- **Project files**: save the complete sequence—including frames, timing,
  audio, subtitles, and watermark—to JSON, then reopen it later
- **Export presets**: TikTok, Instagram Reels/Story, Instagram feed,
  YouTube Shorts, Facebook Reels/Story, Facebook feed, landscape, or a
  custom size — output as WebM or MP4 (video + audio), or GIF (no audio)

## Known limitations

- **MP4 requires internet on first use.** The browser downloads the
  `ffmpeg.wasm` engine (about 25MB) from a CDN, and MP4 transcoding is slower
  and more memory-intensive than direct WebM export.
- **Project files can be large.** Frames, audio, and watermark assets are
  embedded directly in the saved JSON file so projects remain self-contained.
- **In-memory frames**: frames are held as data URLs in the browser tab's
  memory. Fine for tens to a few hundred frames; a very long, high-resolution
  sequence may get slow or memory-heavy.
- Built without the ability to run/test it end-to-end in the environment
  that produced it — treat first use as a verification pass, not a
  guaranteed-working demo.

