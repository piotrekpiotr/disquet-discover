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
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

/**
 * Resolve the ffmpeg / ffprobe binary paths at module load.
 *
 * Why this exists: the npm `ffmpeg-static` binary on Linux (John
 * Van Sickle's static build) is missing the `drawtext` filter
 * despite its configure line saying otherwise — production reels
 * blow up with `[AVFilterGraph] No such filter: 'drawtext'`. The
 * Debian / Nix-installed ffmpeg has a proper build, so on Railway
 * we install it via `nixpacks.toml` and pick it up here.
 *
 * Lookup order:
 *   1. $REEL_FFMPEG_PATH — explicit override (escape hatch).
 *   2. `which ffmpeg` — anywhere on PATH. Catches both Debian's
 *      /usr/bin/ffmpeg and Nix's /nix/store/<hash>/bin/ffmpeg
 *      (which is symlinked onto PATH).
 *   3. Common hard-coded paths (defence in depth).
 *   4. ffmpeg-static — last-resort fallback (works on local dev).
 *
 * The picked path is exposed via `getResolvedBinaries()` so the
 * API route can include it in error responses — turns "ffmpeg
 * exited with code 8" into "ffmpeg @ /path exited…" which makes
 * "wrong binary" failures debuggable from the browser without
 * SSHing into the container.
 */
function whichOnPath(name: string): string | null {
  const r = spawnSync("which", [name], { encoding: "utf8" });
  if (r.status === 0 && typeof r.stdout === "string") {
    const p = r.stdout.trim();
    if (p && p.length > 0) return p;
  }
  return null;
}

function isExecutable(p: string | null | undefined): boolean {
  if (!p) return false;
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pickFfmpeg(): string {
  const fromPath = whichOnPath("ffmpeg");
  const candidates: Array<string | null | undefined> = [
    process.env.REEL_FFMPEG_PATH,
    fromPath,
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/nix/var/nix/profiles/default/bin/ffmpeg",
    ffmpegStaticPath as string | null,
  ];
  for (const p of candidates) {
    if (isExecutable(p)) return p as string;
  }
  throw new Error(
    "No ffmpeg binary found. Set REEL_FFMPEG_PATH or install ffmpeg via nixpacks.toml.",
  );
}

function pickFfprobe(): string {
  const fromPath = whichOnPath("ffprobe");
  const candidates: Array<string | null | undefined> = [
    process.env.REEL_FFPROBE_PATH,
    fromPath,
    "/usr/bin/ffprobe",
    "/usr/local/bin/ffprobe",
    "/nix/var/nix/profiles/default/bin/ffprobe",
    ffprobeStatic.path,
  ];
  for (const p of candidates) {
    if (isExecutable(p)) return p as string;
  }
  throw new Error("No ffprobe binary found.");
}

const FFMPEG_PATH = pickFfmpeg();
const FFPROBE_PATH = pickFfprobe();

/**
 * Expose the resolved binary paths so the API route can mention
 * them in error responses (useful when a render fails: the curator
 * sees "ffmpeg @ /app/node_modules/ffmpeg-static/ffmpeg" and knows
 * the static-binary fallback was picked — that's the wrong-binary
 * signature for the drawtext issue).
 */
export function getResolvedBinaries(): { ffmpeg: string; ffprobe: string } {
  return { ffmpeg: FFMPEG_PATH, ffprobe: FFPROBE_PATH };
}

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

// Every animation in the pool fades up from a solid blank frame over
// the first ~1.5 seconds. Without skipping it the reel opens with a
// black flash before the pattern is visible. We seek 1.5s into the
// animation at composition time so playback starts on already-revealed
// content. The animations are 45s total, so we still have 43.5s of
// usable material — plenty above the 30s output cap.
const ANIMATION_LEAD_SKIP_SEC = 1.5;

/**
 * Per-animation theme: "dark" = mostly-dark background (paper-coloured
 * text reads well), "light" = mostly-light background (ink-coloured
 * text reads well). Indexed by the two-digit prefix of the filename
 * — animations are uploaded as `NN. slug.mp4`, so the prefix is the
 * authoritative ordinal.
 *
 * Source: curator's classification, 2026-05-22. Adjust here when
 * adding / replacing animations; the reel renderer reads this map at
 * compose time to pick the text + progress-bar colour palette.
 */
type AnimationTheme = "dark" | "light";
const ANIMATION_THEMES: Record<string, AnimationTheme> = {
  "01": "dark",
  "02": "light",
  "03": "dark",
  "04": "light",
  "05": "dark",
  "06": "dark",
  "07": "dark",
  "08": "light",
  "09": "dark",
  "10": "dark",
  "11": "dark",
  "12": "light",
  "13": "dark",
  "14": "dark",
  "15": "light",
  "16": "dark",
  "17": "light",
  "18": "light",
  "19": "dark",
  "20": "light",
  "21": "dark",
  "22": "light",
  "23": "dark",
  "24": "dark",
  "25": "light",
  "26": "dark",
  "27": "light",
  "28": "light",
  "29": "dark",
  "30": "dark",
};

/** Resolve the theme for an animation file. Defaults to `dark` for
 * any unknown prefix (the safer fallback — paper text on a paper bg
 * is invisible; paper text on dark or paper bg is at worst muted).
 */
function themeForAnimation(animationPath: string): AnimationTheme {
  const base = path.basename(animationPath);
  const m = base.match(/^(\d{2})\./);
  if (!m) return "dark";
  return ANIMATION_THEMES[m[1]] ?? "dark";
}

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
    const proc = spawn(FFPROBE_PATH, args);
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
  trackFontSize: number;
  artistFontSize: number;
  theme: AnimationTheme;
}): string {
  const { duration, trackText, artistAlbumText, theme } = opts;

  // Layout maths for stacked UI block. Track name baseline sits at
  // UI_TOP; artist line 16px under it; progress bar 36px under that
  // (recipe's vertical rhythm). These numbers should stay in sync
  // with the browser mockup.
  const TRACK_Y = UI_TOP;
  const ARTIST_Y = UI_TOP + opts.trackFontSize + 16;
  const BAR_Y = ARTIST_Y + opts.artistFontSize + 36;
  const BAR_H = 3;
  const TIME_Y = BAR_Y + 18;

  // Per-theme colour palette. We swap the dominant text/bar colour
  // (paper on dark, ink on light) and the "muted" tone (the dim bar
  // track + artist/album line). Border colour is the opposite of
  // the text colour — a subtle 1px contrast halo that protects
  // legibility when the animation has high-frequency detail under
  // the text (moire patterns, signal grids, etc.).
  //
  // Removing the previous semi-opaque scrim block is intentional —
  // the curator wants the text to sit on the animation itself, not
  // on a "card". The 1px border is the entire defence against
  // background noise.
  const COLOR_PAPER = "0xf2efe8";
  const COLOR_INK = "0x111110";
  const COLOR_MUTE_DARK_BG = "0x9a9690"; // mid-grey, reads on dark
  const COLOR_MUTE_LIGHT_BG = "0x4a4843"; // dark-grey, reads on cream

  const isLight = theme === "light";
  const textColor = isLight ? COLOR_INK : COLOR_PAPER;
  const borderColor = isLight ? COLOR_PAPER : COLOR_INK;
  const muteColor = isLight ? COLOR_MUTE_LIGHT_BG : COLOR_MUTE_DARK_BG;
  // Bar fill = same as the text colour (max contrast against bg).
  // Bar track = the dimmer same-family tone (so the unfilled portion
  // doesn't fight the filled portion visually).
  const barFillColor = textColor;
  const barTrackColor = muteColor;
  // Borders are very subtle — 1 px is enough to differentiate text
  // from a busy background without looking outlined / cartoon-y.
  const BORDER_W = 1;
  const BORDER_ALPHA = "@0.45";

  // The progress bar is one drawbox (full-width track) on top of
  // which we layer a SECOND drawbox whose width is `t/DUR * UI_W`.
  // Both expressions are evaluated per frame by ffmpeg.
  const trackBarW = UI_W;
  const fillExpr = `min(t/${duration.toFixed(3)},1)*${UI_W}`;

  const filters: string[] = [];

  // [0:v] = animation, [1:v] = cover image.
  //
  // Animation: trim to duration, set fps to 30, scale to 1080x1920
  // (a defensive resize — animations are already 1080x1920 but
  // pinning the canvas avoids surprises if a future animation is
  // off-spec).
  //
  // Note: the actual fade-in skip is done with `-ss
  // ANIMATION_LEAD_SKIP_SEC` BEFORE `-i animation.mp4` in
  // composeReel(), not here. By the time the animation reaches this
  // filter the first 1.5s of blank frames are already gone, so
  // `setpts=PTS-STARTPTS` makes our local clock start at zero from
  // the first useful frame.
  filters.push(
    `[0:v]trim=duration=${duration.toFixed(3)},setpts=PTS-STARTPTS,fps=${REEL_FPS},scale=${REEL_WIDTH}:${REEL_HEIGHT},setsar=1[bg]`,
  );
  // Cover: scale to ART_W × ART_W exact. force_original_aspect_ratio
  // is intentionally NOT set — covers from mzstatic are square; if a
  // non-square slips in we'd rather see a slight stretch than
  // letterboxing inside the album-art slot.
  filters.push(`[1:v]scale=${ART_W}:${ART_W}[cover]`);
  filters.push(`[bg][cover]overlay=${ART_X}:${ART_Y}[v0]`);

  // Track name (Medium 500, theme text colour).
  filters.push(
    `[v0]drawtext=fontfile='${FONT_MEDIUM}':text='${escapeDrawtext(trackText)}':x=${UI_X}:y=${TRACK_Y}:fontcolor=${textColor}:fontsize=${opts.trackFontSize}:bordercolor=${borderColor}${BORDER_ALPHA}:borderw=${BORDER_W}[v1]`,
  );
  // Artist · Album (Light 300, mute tone of the same theme family).
  filters.push(
    `[v1]drawtext=fontfile='${FONT_LIGHT}':text='${escapeDrawtext(artistAlbumText)}':x=${UI_X}:y=${ARTIST_Y}:fontcolor=${muteColor}:fontsize=${opts.artistFontSize}:bordercolor=${borderColor}${BORDER_ALPHA}:borderw=${BORDER_W}[v2]`,
  );

  // Progress-bar TRACK (dim full-width line at alpha 0.55 so it
  // reads as a divider, not a solid bar).
  filters.push(
    `[v2]drawbox=x=${UI_X}:y=${BAR_Y}:w=${trackBarW}:h=${BAR_H}:color=${barTrackColor}@0.55:t=fill[v3]`,
  );
  // Expression-driven fill width. drawbox evaluates `t` (current
  // frame time, seconds) per frame so this single filter animates.
  filters.push(
    `[v3]drawbox=x=${UI_X}:y=${BAR_Y}:w='${fillExpr}':h=${BAR_H}:color=${barFillColor}@1:t=fill[v4]`,
  );

  // Time labels — current (left) + total (right).
  //
  //   eif inserts an integer with a width and base. Combined with two
  //   string-literal pieces we get "M:SS". The middle `:` between
  //   the two `%{...}` blocks MUST be escaped — drawtext treats an
  //   unescaped `:` in the text value as the next-arg delimiter
  //   (silently truncating to "0" was a debugging dead-end here).
  const ptsCurrentTime =
    `%{eif\\:floor(t/60)\\:d}\\:%{eif\\:mod(floor(t)\\,60)\\:d\\:2}`;
  filters.push(
    `[v4]drawtext=fontfile='${FONT_LIGHT}':text='${ptsCurrentTime}':x=${UI_X}:y=${TIME_Y}:fontcolor=${muteColor}:fontsize=22:bordercolor=${borderColor}${BORDER_ALPHA}:borderw=${BORDER_W}[v5]`,
  );
  // RIGHT: static total duration. Right-edge alignment via tw (text
  // width) expression — `x=UI_X+UI_W-tw` puts the right edge of the
  // text at the right edge of the progress bar.
  const totalText = fmtTime(duration);
  filters.push(
    `[v5]drawtext=fontfile='${FONT_LIGHT}':text='${escapeDrawtext(totalText)}':x=${UI_X}+${UI_W}-tw:y=${TIME_Y}:fontcolor=${muteColor}:fontsize=22:bordercolor=${borderColor}${BORDER_ALPHA}:borderw=${BORDER_W}[vout]`,
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
  // Probe both inputs to know the true playable length. The animation
  // length we compare against is its full 45s — we'll skip the first
  // 1.5s via `-ss` below, but the audio doesn't have a corresponding
  // skip, so duration policy still operates on the full animation
  // length minus the lead skip (43.5s usable).
  const [animDur, audioDur] = await Promise.all([
    probeDurationSec(inputs.animationPath),
    probeDurationSec(inputs.audioPath),
  ]);
  const usableAnim = (animDur || MAX_DURATION) - ANIMATION_LEAD_SKIP_SEC;
  const naturalDur = Math.min(usableAnim, audioDur || MIN_DURATION);
  const duration = Math.max(MIN_DURATION, Math.min(MAX_DURATION, naturalDur));

  // Auto-fit font sizes for the two text lines.
  const trackFontSize = fitMonoFontSize(inputs.title, UI_W, 56, 28);
  const artistAlbum = inputs.label
    ? `${inputs.artist} · ${inputs.label}`
    : inputs.artist;
  const artistFontSize = fitMonoFontSize(artistAlbum, UI_W, 34, 20);

  const theme = themeForAnimation(inputs.animationPath);

  const filterGraph = buildFilterGraph({
    duration,
    trackText: inputs.title.toUpperCase(),
    artistAlbumText: artistAlbum,
    trackFontSize,
    artistFontSize,
    theme,
  });

  const args = [
    "-y",
    // Per-input seek: skip the animation's lead-in fade. `-ss` BEFORE
    // `-i` is the fast input-side seek; ffmpeg jumps to the nearest
    // keyframe before the requested timestamp, which for our 30fps
    // animations with default x264 GOPs lands at or very near 1.5s.
    // Frame-perfect accuracy isn't required — we just want the first
    // visible frame to be non-blank.
    "-ss",
    ANIMATION_LEAD_SKIP_SEC.toFixed(2),
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

  // FFMPEG_PATH was resolved at module load (system ffmpeg preferred
  // because ffmpeg-static's Linux binary lacks drawtext).
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "ignore", "pipe"] });
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
