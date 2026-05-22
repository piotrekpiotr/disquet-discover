# Disquet Reel Recipe — server-side composer

The companion to `animation backgrounds/mockup recipe/MOCKUP_RECIPE.md`
(which documents the BROWSER-side approach the original mockup used).
This file documents the SERVER-side approach the live admin panel uses
to render Instagram reels on demand.

## Goal

One-click "Generate Reel ↓" button on every published record in
`/admin` produces a downloadable 1080×1920 mp4 (30 fps, H.264 +
AAC stereo 44.1 kHz, 30 seconds). The video layers:

1. One of 30 background animations (cycled by counter).
2. Album cover (842×842 px, positioned at x=119 y=193).
3. Track name (uppercase, JetBrains Mono Medium, paper #f2efe8).
4. Artist · Label (JetBrains Mono Light, mute #9a9690).
5. Progress bar that fills with the audio playback (3px line).
6. Time labels (current / total) at the bar's edges.

The audio layer is the iTunes/Apple Music 30-second preview MP4 (AAC
44.1 kHz stereo) — Apple's standard preview length, fetched via the
iTunes Lookup API at render time.

## Architecture

```
/admin record card
  └── [Generate Reel ↓] anchor
        └── GET /api/admin/reel/[id]
              ├── data/recommendations.json   (record + cover URL + apple URL)
              ├── iTunes lookup API           (track previewUrl)
              ├── data/reel-counter.json      (next animation index, 0..29)
              ├── animation backgrounds/NN. *.mp4
              └── src/lib/reel-composer.ts    (ffmpeg shell-out)
                  └── ffmpeg-static binary
```

Each render:

1. Reads next animation index from `data/reel-counter.json`, advances to (i+1)%30.
2. Downloads the album cover (mzstatic JPG, upscaled to 1500×1500 in URL).
3. Calls iTunes Lookup `?id=<albumId>&entity=song`, picks the first track with a `previewUrl`.
4. Downloads the preview m4a to `os.tmpdir()/disquet-reel-XXXX/preview.m4a`.
5. Spawns ffmpeg with one filter_complex graph that does everything in one pass.
6. Reads the resulting mp4 into memory, returns as `Content-Disposition: attachment` body.
7. `finally` block deletes the temp dir regardless of success/failure.

## Per-animation theme

Each of the 30 animations is classified as `dark` (mostly-dark
background) or `light` (mostly-light background) in
`ANIMATION_THEMES` inside `reel-composer.ts`. The renderer reads
the file's two-digit prefix and picks a palette:

- **dark** → paper (#f2efe8) text + paper bar fill + mid-grey
  mute tone (#9a9690), 1px ink-coloured border at α 0.45.
- **light** → ink (#111110) text + ink bar fill + dark-grey mute
  tone (#4a4843), 1px paper-coloured border at α 0.45.

No scrim. Text sits directly on the animation, with the thin
border as the only legibility defence against busy bgs. This
matches the curator's reference reels.

Current classification (2026-05-22): 01,03,05–07,09–11,13,14,16,
19,21,23,24,26,29,30 = dark; 02,04,08,12,15,17,18,20,22,25,27,
28 = light. Edit the map when adding / replacing animations.

## Fade-in skip

Every animation in the curator's set fades up from a blank frame
over ~1.5 seconds. The composer passes `-ss 1.5` BEFORE `-i <anim>`
so the reel opens on already-revealed pattern. Animations are 45s
long; after the skip we still have 43.5s of usable material above
the 30s output cap.

## Layout constants (must match MOCKUP_RECIPE.md)

```ts
W = 1080, H = 1920, FPS = 30
ART_W = 842, ART_X = 119, ART_Y = 193        // cover slot
UI_X = ART_X, UI_W = ART_W, UI_TOP = 1246    // text + bar slot
```

Vertical rhythm in the UI block:

```
y = UI_TOP                            track name
y = UI_TOP + trackFs + 16             artist · label
y = artistY + artistFs + 36           progress bar (3px tall)
y = barY + 18                         time labels
```

Font sizes auto-fit (`fitMonoFontSize`) within UI_W, falling back to a
minimum if the string is long. Monospace glyph width ≈ 0.6 × font-size
so we estimate fit one pass without measuring glyph metrics.

## ffmpeg filter graph

```
[0:v] = animation background mp4
[1:v] = cover image (jpg)
[2:a] = preview audio m4a

[0:v] trim=duration=DUR, setpts=PTS-STARTPTS, fps=30, scale=1080:1920 → [bg]
[1:v] scale=842:842                                                   → [cover]
[bg][cover] overlay=119:193                                            → [v0]
[v0] drawtext (track name, Medium TTF, paper)                          → [v1]
[v1] drawtext (artist · label, Light TTF, mute)                        → [v2]
[v2] drawbox (full-width dim bar)                                       → [v3]
[v3] drawbox (paper fill, width = 't/DUR*UI_W' expression)              → [v4]
[v4] drawtext (current time, eif expression)                            → [v5]
[v5] drawtext (total time, static M:SS)                                 → [vout]

map [vout] + map [2:a]
output: H.264 / AAC / 30 fps / yuv420p / +faststart
```

### drawtext escape rules (subtle, easy to get wrong)

- Wrap text in single quotes: `text='...'`.
- Inside the value, escape `:` (which would otherwise close the
  filter argument) as `\:`.
- Inside `%{eif:...}` blocks, the `:` separators between expr / format /
  width also need escaping (the filter-graph tokenizer is one pass, doesn't
  know about `%{}` nesting).
- Escape `,` inside expressions as `\,` (else ffmpeg reads them as
  argument separators in expressions).
- Escape `%` in literal text as `\%` (else drawtext tries to expand).
- Escape `'` in literal text as `\\\'`.

The `escapeDrawtext()` helper in `reel-composer.ts` handles the static
text fields; the dynamic time expression is hand-escaped inline.

### Animated progress bar

Uses `drawbox` with width expression evaluated per frame:

```
drawbox=x=119:y=BAR_Y:w='min(t/30,1)*842':h=3:color=0xf2efe8@1:t=fill
```

`t` is current playback time in seconds. `min(t/30,1)` clamps so a
short-trimmed clip doesn't overshoot. ffmpeg evaluates this expression
once per output frame — no setup work required, no overlay image
needed.

### Duration policy

```
duration = clamp(min(animation_duration, audio_duration), 30, 45)
```

- Apple previews are 30s → typical output is 30s.
- Animations are 45s → trimmed to match audio.
- Floor is 30s (Instagram reels min runtime feels reasonable for music).
- Ceiling is 45s (animation length cap; longer would loop animation
  which we deliberately don't do).

## Audio fetch — iTunes Lookup API

The records store `links.apple = "https://music.apple.com/.../album/.../<id>"`.
We strip the numeric `<id>` and hit:

```
GET https://itunes.apple.com/lookup?id=<albumId>&entity=song
```

Returns an array starting with the `collection` (album) row followed
by N `track` rows. Each track row carries `previewUrl` pointing at a
30-second AAC m4a (`audio-ssl.itunes.apple.com/.../mzaf_*.plus.aac.p.m4a`).
We pick the lowest `trackNumber` that has a `previewUrl`.

Not every track has a preview (region locks, future releases) — we
fall back through the list. If no track has one, the route returns
422 with a human-readable message; the curator can paste a different
Apple URL in admin Edit or add one if absent.

## Animation cycling

`data/reel-counter.json` holds `{ "nextIndex": N }` where N ∈ [0, 29].
Each render reads N, advances to (N+1)%30, persists. The file is on
the Railway persistent volume so cycles survive deploys.

In-process write queue (`writeQueue` promise chain in
`reel-counter.ts`) serialises concurrent requests so two clicks never
land on the same index.

## ffmpeg binary — Dockerfile-installed, NOT ffmpeg-static

The npm `ffmpeg-static` package ships John Van Sickle's static
Linux build. That build advertises `--enable-libfreetype` in its
configure line but the `drawtext` filter is silently absent —
production reels fail at filter-graph parse time with `[AVFilterGraph]
No such filter: 'drawtext'` (ffmpeg exit code 8).

The fix: a `Dockerfile` at project root installs system ffmpeg
(`apt-get install ffmpeg`) on top of `node:22-bookworm-slim`.
Debian's ffmpeg has drawtext (and a full filter set generally).
Railway auto-detects the Dockerfile and builds with it in preference
to nixpacks.

The composer's `pickFfmpeg()` resolver checks, in order:

1. `$REEL_FFMPEG_PATH` — explicit escape-hatch env var.
2. `which ffmpeg` — anywhere on PATH (catches Debian's
   `/usr/bin/ffmpeg` and Nix-store paths alike).
3. Hard-coded common paths (`/usr/bin/ffmpeg`, `/usr/local/bin/ffmpeg`,
   `/nix/var/nix/profiles/default/bin/ffmpeg`).
4. ffmpeg-static — last-resort fallback so local dev (macOS,
   Windows) without a system ffmpeg still works.

`getResolvedBinaries()` is exposed for the API route to mention the
picked path in error responses — wrong-binary failures (the
ffmpeg-static fallback being selected on Linux) are visible from
the browser without inspecting Railway logs.

We tried `nixpacks.toml` first with both `aptPkgs = ["ffmpeg"]`
and `nixPkgs = ["...", "ffmpeg-full"]`. Neither produced a runtime
image with system ffmpeg on PATH. Dockerfile is deterministic.

## Fonts

Bundled in `assets/fonts/`:

- `JetBrainsMono-Medium.ttf` — track name (paper color).
- `JetBrainsMono-Light.ttf` — artist · label, time labels (mute color).

Both files are JetBrains Mono v2.304 from the JetBrains GitHub
repository, OFL-licensed. ~270 KB each, committed to git as project
assets (they're text-rendering ammo, not data).

Passed directly to drawtext via `fontfile='/abs/path.ttf'` —
no fontconfig dependency at runtime.

## Temp file lifecycle

The route creates `os.tmpdir()/disquet-reel-XXXXXX/` per request,
writes cover.jpg + preview.m4a + out.mp4 into it, then `fs.rm`s the
whole directory in the `finally` block. The mp4 bytes are read into a
Buffer and returned as the response body — at no point does the
finished reel sit at a stable filesystem path.

On Railway, `os.tmpdir()` is the container's `/tmp`, NOT the
persistent volume. Tmp is wiped between deploys and on container
restart, so even if a `finally` block fails the file can't accumulate
across deploys.

## Storage of the 30 animations

The 30 background mp4s total ~660 MB. They are deliberately
**NOT** committed to git (see `.gitignore`) — GitHub recommends
keeping individual files under 50 MB and 660 MB of binary blobs
would slow every clone / push / CI run forever.

### Where they live in production

On the Railway persistent volume at `<project>/data/animations/`.
This piggy-backs on the SAME volume that already holds
`data/recommendations.json` etc., so no Railway dashboard changes
are needed — the existing `/app/data` mount covers it. Railway's
Hobby plan ships with 5 GB of volume storage, so 660 MB leaves
plenty of headroom.

### Where they live in local dev

Either path works; the composer checks both:

1. `data/animations/` — preferred, same path as production.
2. `animation backgrounds/` — the original folder the curator
   dropped them into at project root.

If both directories have files, the `data/animations/` set wins.

### Bootstrapping a fresh Railway deploy

The 30 files have to be uploaded ONCE to populate the volume.
After that they persist forever (the volume survives deploys,
restarts, and even the seed-volume script — which only seeds
`data-seed/` contents on first boot and never touches non-seed
subdirs).

Use the admin upload UI:

1. Log into `/admin`.
2. Click "Animations →" in the top-right nav row.
3. Drag all 30 mp4 files into the drop zone (or click to pick).
4. They upload sequentially. ~2–5 minutes total on a residential
   uplink, depending on your connection.

That's it — the cycle counter starts at 0 and walks 01 → 02 → … →
30 → 01 on each Generate Reel click. The "On server" list at the
bottom of the page shows what's currently uploaded, with a
per-file Delete button.

### Filename rule

`NN. <slug>.mp4` — two-digit zero-padded prefix, dot, space, slug,
`.mp4`. The cycler sorts by filename so the prefix controls cycle
order. The upload endpoint rejects anything that doesn't match.

### Why no object storage (R2, S3, etc.)

Considered and rejected:

- One more vendor to manage (account, billing, keys, CORS).
- Cost is negligible there too (<$1/mo at our volume) but
  Railway's volume is already free under the Hobby plan we pay for.
- ffmpeg accepts HTTP inputs, so the codepath could switch later
  if storage needs change — no architectural lock-in here.

## Local development

```
npm install                        # pulls ffmpeg-static + ffprobe-static
# (animation backgrounds folder already populated locally)
npm run dev
open http://localhost:3000/admin/login
```

Click "Generate Reel ↓" on any published record with an Apple URL.
A 30-second mp4 downloads to your Downloads folder named
`<artist-slug>-<title-slug>.mp4`.

## When things go wrong

- **422 "No Apple Music album link"** — record doesn't have one; add
  in EditForm.
- **422 "iTunes returned no playable preview"** — preview is region-
  locked or the album hasn't shipped yet. Wait or pick a different
  release.
- **500 "reel render failed"** — response body contains the tail of
  ffmpeg's stderr. Most common cause is a malformed `links.apple`
  URL that survived extraction; second most common is the animation
  file being absent on the server (see deployment notes above).
