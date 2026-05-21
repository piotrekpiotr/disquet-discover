# Disquet Mockup — Technical Reference

## What works (confirmed by user, April 25 2026)

### Architecture: 3 HTML layers + 1 hidden composite canvas

```
z-index 1 — .layer-bg  — <canvas id="bg">  — background animation
z-index 2 — .layer-art — <img>             — album cover
z-index 3 — .layer-ui  — HTML div          — player UI
z-index 20 — #tap      — tap-to-start dot
```

CSS for centering layers:
```css
.layer-art { transform: translateY(-18%); }  /* shift cover up */
.layer-ui  { transform: translateY(18%);  }  /* shift UI down  */
```

### Audio preparation (on page load)
1. `fetch()` the MP3
2. `AudioContext.decodeAudioData()` → full AudioBuffer
3. Slice samples: `startSample = FRAG_START * sampleRate` (30s → 75s)
4. Copy sliced channels into new AudioBuffer
5. `encodeWAV()` → WAV Blob stored as `slicedAudioBlob`
6. Show tap-to-start dot once ready

### Playback (on tap)
```js
playAudio = new Audio(URL.createObjectURL(slicedAudioBlob));
playAudio.play();
// Progress bar via RAF loop reading playAudio.currentTime (no delay)
```

### Recording — VideoEncoder + AudioEncoder + mp4-muxer (NO MediaRecorder)
This is the only approach that reliably embeds audio in the output file.

```js
// Load mp4-muxer
await loadScript('https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.min.js');
const { Muxer, ArrayBufferTarget } = window.Mp4Muxer;

const target = new ArrayBufferTarget();
const muxer = new Muxer({
  target,
  video: { codec: 'avc', width: 1080, height: 1920 },
  audio: { codec: 'aac', sampleRate: SR, numberOfChannels: numCh },
  fastStart: 'in-memory'
});

// VideoEncoder
const venc = new VideoEncoder({ output: (c,m) => muxer.addVideoChunk(c,m), error: ... });
venc.configure({ codec: 'avc1.4d0034', width: 1080, height: 1920, bitrate: 8_000_000, framerate: 30 });

// AudioEncoder
const aenc = new AudioEncoder({ output: (c,m) => muxer.addAudioChunk(c,m), error: ... });
aenc.configure({ codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: numCh, bitrate: 128_000 });

// Decode WAV blob → AudioBuffer for raw samples
const audioBuf = await new AudioContext().decodeAudioData(await slicedAudioBlob.arrayBuffer());

// RAF loop: encode one video frame + corresponding audio samples per iteration
const FPS = 30;
const totalFrames = 45 * FPS;
// Per frame: audioStart = Math.round(vn * SR / FPS), audioEnd = Math.round((vn+1) * SR / FPS)
// Audio format: 'f32-planar' — all ch0 samples then all ch1 samples in one Float32Array

// After loop:
await venc.flush();
await aenc.flush();
muxer.finalize();
const mp4Blob = new Blob([target.buffer], { type: 'video/mp4' });
```

### Composite canvas (for recording)
Hidden canvas at `position:fixed;left:-2200px` (NOT display:none — that breaks captureStream).
Each frame: `rctx.drawImage(bgCanvas, 0, 0)` then draw cover image then draw UI text/shapes.

### Layout constants (1080×1920 canvas px)
```js
const ART_W = Math.round(1080 * 0.78); // 842
const ART_X = Math.round((1080 - ART_W) / 2); // 119
const ART_Y = 193;   // cover top
const UI_TOP = 1246; // player UI top (18% shift down from center)
const UI_X = ART_X, UI_W = ART_W;
```

### Trigger from hub
```js
// Hub sends postMessage to iframe:
frame.contentWindow.postMessage({ type: 'START_RECORD' }, '*');

// Mockup listens:
window.addEventListener('message', e => {
  if (e.data && e.data.type === 'START_RECORD') startRecording();
});
```

### UI Layout — stacked, auto-fit font size

Track name stacks above artist · album on separate lines. Use `fitText()` to auto-shrink if text is long:

```js
function fitText(ctx, text, maxWidth, maxSize, minSize, weight){
  for(let sz=maxSize; sz>=minSize; sz--){
    ctx.font = `${weight} ${sz}px 'JetBrains Mono',monospace`;
    if(ctx.measureText(text).width <= maxWidth) return sz;
  }
  return minSize;
}

// Usage in drawComposite():
const trackSize = fitText(rctx, trackStr, UI_W, 42, 24, '500');
rctx.font = `500 ${trackSize}px 'JetBrains Mono',monospace`;
rctx.fillText(trackStr, UI_X, UI_TOP);

const artistSize = fitText(rctx, artistStr, UI_W, 30, 18, '300');
rctx.font = `300 ${artistSize}px 'JetBrains Mono',monospace`;
rctx.fillText(artistStr, UI_X, UI_TOP + trackSize + 16);

const pY = UI_TOP + trackSize + 16 + artistSize + 36; // dynamic progress bar Y
```

HTML layer uses `white-space:nowrap; overflow:hidden; text-overflow:ellipsis` as safety net.
CSS layout: track name div + artist div stacked, no side-by-side flex row.
```js
const FRAG_START = 30;  // start at 00:30 in original MP3
const FRAG_DUR   = 45;  // play for 45 seconds
const SAMPLE_RATE = 44100;
```

## What does NOT work (do not use)
- `audio.captureStream()` → audio never ends up in recorded file
- `AudioContext.createMediaElementSource()` → same, MediaRecorder doesn't capture it
- `display:none` on composite canvas → captureStream stops delivering frames → blank video
- `ffmpeg.wasm` via dynamic ES module import → blocked by CORS in this environment
- Opening a new tab for recording (`?rec=auto`) → blocked by preview token requirement

## File: reels/mockup-skeemask.html
Assets used:
- `../uploads/skee mask pool cover.jpg`
- `../uploads/Skee Mask - LFO.mp3`

## To create a new mockup for a different artist:
1. Copy `reels/mockup-skeemask.html`
2. Change MP3 path + FRAG_START + FRAG_DUR
3. Change cover image path
4. Change track name / artist / album text (HTML layer-ui + drawComposite() canvas text)
5. Change background animation in drawBG() function
6. Change output filename in `a.download = 'artist-track.mp4'`
