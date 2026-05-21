/**
 * Server-side Instagram-reel composer.
 *
 * Produces a 1080×1920 mp4 (H.264 + AAC stereo 44.1 kHz, 30 fps) that
 * layers a record's album art, track / artist / album text, and an
 * animated progress bar over one of 30 background animations, with
 * the Apple Music 30-second preview audio embedded.
 *
 * This is the *server* sibling of the browser-based mockup recipe in
 * `animation backgrounds/mockup recipe/MOCKUP_RECIPE.md`. The browser
 * recipe uses VideoEncoder + AudioEncoder + mp4-muxer; this module
 * shells out to ffmpeg (via ffmpeg-static) because:
 *
 *   - the curator clicks a single "Generate Reel" button in /admin
 *     and expects a download to drop into their Downloads folder; no
 *     browser-tab dance, no in-page MediaRecorder confetti.
 *   - the server already knows the record metadata, the cover URL,
 *     and the iTunes album ID. Composition decisions stay in one
 *     trusted place rather than spread across HTML/JS sent to a
 *     browser that may differ between curator workstations.
 *
 * Layout constants match the browser recipe so output dimensions are
 * pixel-equivalent (1080×1920, art at 119/193 sized 842, UI top 1246).
 *
 * Inputs:
 *   - record: { artist, title, label }
 *   - animationPath: absolute path to one of the 30 background mp4s
 *   - audioPath:     absolute path to the downloaded Apple preview m4a
 *   - coverPath:     absolute path to the downloaded cover image (jpg)
 *   - outputPath:    absolute path for the resulting mp4
 *
 * Output duration: min(audio_duration, animation_duration), clamped
 * to [30, 45] seconds. Apple previews are typically 30s, animations
 * are 45s, so the typical output is 30s.
 *
 * Side-effects: writes outputPath. Does not delete inputs. The caller
 * (the API route) handles temp-file lifecycle.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

// ----- Layout constants (must match MOCKUP_RECIPE.md) -----
export const REEL_WIDTH = 1080;
export const REEL_HEIGHT = 1920;
export const REEL_FPS = 30;

const ART_W = 842;
const ART_X = 119;
const ART_Y = 193;

const UI_X = ART_X;
const UI_W = ART_W;
const UI_TOP = 1246;

// Font weights (we keep two — Medium 500 and Light 300 — to match
// the recipe's "JetBrains Mono 500" track name vs "JetBrains Mono
// 300" artist/album/time labels distinction).
export const FONT_DIR = path.resolve(process.cwd(), "assets/fonts");
const FONT_MEDIUM = path.join(FONT_DIR, "JetBrainsMono-Medium.ttf");
const FONT_LIGHT = path.join(FONT_DIR, "JetBrainsMono-Light.ttf");

// Duration policy. Apple previews are 30s, animations are 45s, so the
// natural floor is 30 and the natural ceiling is 45.
export const MIN_DURATION = 30;
export const MAX_DURATION = 45;

export interface ReelInputs {
  artist: string;
  title: string;
  label?: string | null;
  animationPath: string;
  audioPath: string;
  coverPath: string;
  outputPath: string;
}

/**
 * Estimate how big a font size can be for a given monospace string
 * such that it fits inside `maxWidth` pixels. JetBrains Mono renders
 * each glyph at ~0.6 × font-size width, which is consistent enough
 * across weights to be useful as a one-pass auto-fit.
 *
 * `weight` is a hint that's currently unused — kept in the signature
 * so the auto-fit policy can become weight-aware later (Light glyphs
 * trend slightly narrower; the constant is conservative enough that
 * we don't need to differentiate today).
 */
function fitMonoFontSize(
  text: string,
  maxWidth: number,
  maxSize: number,
  minSize: number,
): number {
  const n = Math.max(1, text.length);
  for (let sz = maxSize; sz >= minSize; sz--) {
    if (sz * 0.6 * n <= maxWidth) return sz;
  }
  return minSize;
}

/**
 * Probe a media file for duration (seconds, float). Returns 0 if the
 * file lacks a duration or ffprobe failed.
 */
export async function probeDurationSec(file: string): Promise<number> {
  return new Promise((resolve) => {
    const args = [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ];
    const proc = spawn(ffprobeStatic.path, args);
    let out = "";
    proc.stdout.on("data", (b) => (out += b.toString()));
    proc.on("close", () => {
      const d = parseFloat(out.trim());
      resolve(Number.isFinite(d) ? d : 0);
    });
    proc.on("error", () => resolve(0));
  });
}

/**
 * Escape a string for use as a drawtext `text=...` value. ffmpeg's
 * drawtext parses ':' and '\\' and "'" specially; the doubled-backslash
 * dance below is the canonical, library-recommended escape sequence.
 */
function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\\\\\'")
    .replace(/%/g, "\\%");
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Build the ffmpeg filter_complex graph for one reel. Documented
 * step-by-step inline so the curator (and future me) can change
 * one piece (font color, bar height, …) without rebuilding the
 * mental model from scratch.
 */
function buildFilterGraph(opts: {
  duration: number;
  trackText: string;
  artistAlbumText: string;
  bgY_for_progressBar: number;
  trackFontSize: number;
  artistFontSize: number;
}): string {
  const { duration, trackText, artistAlbumText, bgY_for_progressBar } = opts;

  // Layout maths for stacked UI block. Track name baseline sits at
  // UI_TOP; artist line 16px under it; progress bar 36px under that
  // (recipe's vertical rhythm). These numbers should stay in sync
  // with the browser mockup.
  const TRACK_Y = UI_TOP;
  const ARTIST_Y = UI_TOP + opts.trackFontSize + 16;
  const BAR_Y = ARTIST_Y + opts.artistFontSize + 36;
  const BAR_H = 3;
  const TIME_Y = BAR_Y + 18;

  // Colors: bright "paper" #f2efe8 for the track name + bar fill;
  // muted #9a9690 for artist/album/time labels. Match the on-site
  // palette so the reel reads as a Disquet artifact.
  const COLOR_PAPER = "0xf2efe8";
  const COLOR_MUTE = "0x9a9690";
  // Each background animation has its own dominant color — some are
  // black with paper accents (01. grid-breathe), some are paper with
  // black accents (02. moire), some are mid-tone (06. signal). Single
  // text color can't read universally. A semi-transparent dark "ink"
  // stroke around the text (borderw=2:bordercolor=ink@0.55) keeps
  // paper text crisp on light backgrounds without making it heavy on
  // dark ones — the border just disappears into the dark bg there.
  const COLOR_INK = "0x111110";
  const BORDER_W = 2;

  // The progress bar is one drawbox (full-width track) on top of
  // which we layer a SECOND drawbox whose width is `t/DUR * UI_W`.
  // Both expressions are evaluated per frame by ffmpeg.
  const trackBarW = UI_W;
  const fillExpr = `min(t/${duration.toFixed(3)},1)*${UI_W}`;

  // Cover overlay: scale to ART_W square, place at (ART_X, ART_Y).
  // For Apple cover URLs (.jpg from is1-ssl.mzstatic.com) the source
  // is square already; scale = enlarge to crisp at the reel res.
  const filters: string[] = [];

  // [0:v] = animation, [1:v] = cover image.
  // Animation: trim to duration, set fps to 30, scale to 1080x1920
  // (a defensive resize — animations are already 1080x1920 but
  // pinning the canvas avoids surprises if a future animation is
  // off-spec).
  filters.push(
    `[0:v]trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,fps=${REEL_FPS},scale=${REEL_WIDTH}:${REEL_HEIGHT},setsar=1[bg]`,
  );
  // Cover: scale to ART_W × ART_W exact. force_original_aspect_ratio
  // is intentionally NOT set — covers from mzstatic are square; if a
  // non-square slips in we'd rather see a slight stretch than
  // letterboxing inside the album-art slot.
  filters.push(`[1:v]scale=${ART_W}:${ART_W}[cover]`);
  filters.push(`[bg][cover]overlay=${ART_X}:${ART_Y}[vovr]`);

  // UI SCRIM. A semi-transparent dark rectangle behind the entire
  // text + progress-bar block so the UI reads on every animation —
  // including the cream / pastel backgrounds (02. moire, 17. breath
  // moss, etc.) where paper-colored text alone would vanish. The
  // scrim is bigger than the strict UI bbox to give the text some
  // breathing room and avoid a hard edge under the larger letters.
  const SCRIM_X = UI_X - 24;
  const SCRIM_Y = UI_TOP - 28;
  const SCRIM_W = UI_W + 48;
  const SCRIM_H = TIME_Y + 38 - SCRIM_Y;
  filters.push(
    `[vovr]drawbox=x=${SCRIM_X}:y=${SCRIM_Y}:w=${SCRIM_W}:h=${SCRIM_H}:color=${COLOR_INK}@0.55:t=fill[v0]`,
  );

  // Track name (Medium 500, paper color, auto-fit size, ink stroke).
  filters.push(
    `[v0]drawtext=fontfile='${FONT_MEDIUM}':text='${escapeDrawtext(trackText)}':x=${UI_X}:y=${TRACK_Y}:fontcolor=${COLOR_PAPER}:fontsize=${opts.trackFontSize}:bordercolor=${COLOR_INK}@0.55:borderw=${BORDER_W}[v1]`,
  );
  // Artist · Album (Light 300, mute color, ink stroke).
  filters.push(
    `[v1]drawtext=fontfile='${FONT_LIGHT}':text='${escapeDrawtext(artistAlbumText)}':x=${UI_X}:y=${ARTIST_Y}:fontcolor=${COLOR_PAPER}:fontsize=${opts.artistFontSize}:bordercolor=${COLOR_INK}@0.55:borderw=${BORDER_W}[v2]`,
  );

  // Progress-bar TRACK and FILL.
  //
  // To read on both dark AND light animations, we layer:
  //   1. A dark "shadow" rectangle (full bar width, alpha 0.5) under
  //      everything — gives contrast against light backgrounds.
  //   2. The dim mute-colored track on top of that (alpha 0.85).
  //   3. The fill, which is paper-colored and expression-driven.
  // The shadow ends up invisible on dark animations because the
  // background is already dark; on light animations it does the
  // legibility work.
  filters.push(
    `[v2]drawbox=x=${UI_X - 4}:y=${BAR_Y - 4}:w=${trackBarW + 8}:h=${BAR_H + 8}:color=${COLOR_INK}@0.35:t=fill[v2a]`,
  );
  filters.push(
    `[v2a]drawbox=x=${UI_X}:y=${BAR_Y}:w=${trackBarW}:h=${BAR_H}:color=${COLOR_MUTE}@0.85:t=fill[v3]`,
  );
  // Expression-driven fill width. drawbox evaluates `t` (current
  // frame time, seconds) per frame so this single filter animates.
  filters.push(
    `[v3]drawbox=x=${UI_X}:y=${BAR_Y}:w='${fillExpr}':h=${BAR_H}:color=${COLOR_PAPER}@1:t=fill[v4]`,
  );

  // Time labels.
  // LEFT: dynamic current time via drawtext's pts variable.
  //   `%{pts\\:hms}` formats as "0:00:00.000" — too verbose; we
  //   instead compute a custom format by mod-ing pts. The math:
  //     minutes = floor(pts/60)
  //     seconds = mod(floor(pts),60), zero-padded
  //   drawtext's expression mini-language supports both via the
  //   `expansion=normal/strftime/none` modes — `text=%{eif:...}`
  //   gives evaluated integer formatting.
  //
  //   eif inserts an integer with a width and base. Combined with two
  //   string-literal pieces we get "M:SS". The middle `:` between
  //   the two `%{...}` blocks MUST be escaped — drawtext treats an
  //   unescaped `:` in the text value as the next-arg delimiter
  //   (silently truncating to "0" was a debugging dead-end here).
  const ptsCurrentTime =
    `%{eif\\:floor(t/60)\\:d}\\:%{eif\\:mod(floor(t)\\,60)\\:d\\:2}`;
  filters.push(
    `[v4]drawtext=fontfile='${FONT_LIGHT}':text='${ptsCurrentTime}':x=${UI_X}:y=${TIME_Y}:fontcolor=${COLOR_PAPER}:fontsize=22:bordercolor=${COLOR_INK}@0.55:borderw=${BORDER_W}[v5]`,
  );
  // RIGHT: static total duration. Right-edge alignment via tw (text
  // width) expression — `x=UI_X+UI_W-tw` puts the right edge of the
  // text at the right edge of the progress bar.
  const totalText = fmtTime(duration);
  filters.push(
    `[v5]drawtext=fontfile='${FONT_LIGHT}':text='${escapeDrawtext(totalText)}':x=${UI_X}+${UI_W}-tw:y=${TIME_Y}:fontcolor=${COLOR_PAPER}:fontsize=22:bordercolor=${COLOR_INK}@0.55:borderw=${BORDER_W}[vout]`,
  );

  return filters.join(";");
}

/**
 * Run ffmpeg to compose the reel. Resolves when the file is written;
 * rejects with the tail of ffmpeg's stderr on non-zero exit. The
 * tail (not the full log) keeps Node's heap small and the API
 * error response readable.
 */
export async function composeReel(inputs: ReelInputs): Promise<void> {
  // Probe both inputs to know the true playable length.
  const [animDur, audioDur] = await Promise.all([
    probeDurationSec(inputs.animationPath),
    probeDurationSec(inputs.audioPath),
  ]);
  const naturalDur = Math.min(animDur || MAX_DURATION, audioDur || MIN_DURATION);
  const duration = Math.max(MIN_DURATION, Math.min(MAX_DURATION, naturalDur));

  // Auto-fit font sizes for the two text lines.
  const trackFontSize = fitMonoFontSize(inputs.title, UI_W, 56, 28);
  const artistAlbum = inputs.label
    ? `${inputs.artist} · ${inputs.label}`
    : inputs.artist;
  const artistFontSize = fitMonoFontSize(artistAlbum, UI_W, 34, 20);

  const filterGraph = buildFilterGraph({
    duration,
    trackText: inputs.title.toUpperCase(),
    artistAlbumText: artistAlbum,
    bgY_for_progressBar: 0, // unused, kept for clarity
    trackFontSize,
    artistFontSize,
  });

  const args = [
    "-y",
    "-i",
    inputs.animationPath,
    "-i",
    inputs.coverPath,
    "-i",
    inputs.audioPath,
    "-filter_complex",
    filterGraph,
    "-map",
    "[vout]",
    "-map",
    "2:a:0",
    "-t",
    duration.toFixed(3),
    "-r",
    String(REEL_FPS),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    inputs.outputPath,
  ];

  if (!ffmpegPath) {
    throw new Error("ffmpeg-static binary path is missing");
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, args, { stdio: ["ignore", "ignore", "pipe"] });
    const tail: string[] = [];
    proc.stderr.on("data", (b) => {
      tail.push(b.toString());
      // Keep only the last ~40 KB of stderr so we don't OOM on long runs.
      const joined = tail.join("");
      if (joined.length > 40000) {
        tail.splice(0, tail.length, joined.slice(-40000));
      }
    });
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `ffmpeg exited with code ${code}. Tail:\n${tail.join("").slice(-4000)}`,
        ),
      );
    });
  });
}
