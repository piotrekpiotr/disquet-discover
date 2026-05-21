/**
 * Cycle pointer for the 30 background animations.
 *
 * Why this lives in `data/`:
 *   The pointer needs to survive deploys. `data/` is mounted on the
 *   Railway persistent volume; `data-seed/` overwrite logic in
 *   `seed-volume.mjs` only touches recommendations.json and media-
 *   candidates.json explicitly, so this file is safe from clobber.
 *
 * Shape: { nextIndex: 0..29 }. We store the NEXT index to use, not
 * the LAST used — so a brand-new volume defaults to 0 and the first
 * reel uses animation 01, exactly as the curator specified.
 *
 * Concurrency: the API route reads + writes under a small in-process
 * promise lock (writeQueue) so two simultaneous "Generate Reel"
 * clicks don't both pick the same index. Cross-process serialization
 * isn't strictly necessary on Railway's single-replica deployment
 * but the queue costs nothing.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.join(process.cwd(), "data", "reel-counter.json");
const ANIM_COUNT = 30;

interface CounterShape {
  nextIndex: number;
}

let writeQueue: Promise<unknown> = Promise.resolve();

async function read(): Promise<CounterShape> {
  try {
    const raw = await fs.readFile(FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CounterShape>;
    const n = Number(parsed.nextIndex);
    if (Number.isFinite(n) && n >= 0 && n < ANIM_COUNT) {
      return { nextIndex: Math.floor(n) };
    }
    return { nextIndex: 0 };
  } catch {
    // Missing file = fresh start at 0.
    return { nextIndex: 0 };
  }
}

async function write(c: CounterShape): Promise<void> {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(c, null, 2), "utf-8");
}

/**
 * Atomically read-and-advance: returns the index to use right now,
 * persists the next-pointer for the following call. Wraps at 30
 * (29 → 0) so the curator never runs out of animations.
 */
export async function takeNextAnimationIndex(): Promise<number> {
  const taken: Promise<number> = writeQueue.then(async () => {
    const state = await read();
    const use = state.nextIndex;
    const next = (use + 1) % ANIM_COUNT;
    await write({ nextIndex: next });
    return use;
  });
  writeQueue = taken.catch(() => undefined);
  return taken;
}

/**
 * Where animations are stored. Production (Railway) puts them on the
 * persistent volume under `/app/data/animations/`. Local dev can use
 * either that path OR the user-supplied `animation backgrounds/`
 * folder at the project root (which is what the curator originally
 * dropped them into). We check primary first, fall back to legacy —
 * whichever has the most `NN. name.mp4` files wins.
 */
export const ANIMATIONS_PRIMARY_DIR = path.join(
  process.cwd(),
  "data",
  "animations",
);
export const ANIMATIONS_LEGACY_DIR = path.join(
  process.cwd(),
  "animation backgrounds",
);

async function listAnimationsIn(dir: string): Promise<string[]> {
  try {
    const all = await fs.readdir(dir);
    return all.filter((f) => /\.mp4$/i.test(f) && /^\d{2}\.\s/.test(f)).sort();
  } catch {
    // Missing directory → empty list.
    return [];
  }
}

/**
 * Returns { dir, files }: the directory we'll use for this render and
 * the sorted list of animation filenames in it. Primary directory
 * wins UNLESS it's empty AND the legacy directory has files (this
 * keeps "drop files into `animation backgrounds/` then run dev" still
 * working for the curator's existing workflow, without requiring a
 * file move).
 */
export async function listAvailableAnimations(): Promise<{
  dir: string;
  files: string[];
}> {
  const primary = await listAnimationsIn(ANIMATIONS_PRIMARY_DIR);
  if (primary.length > 0) {
    return { dir: ANIMATIONS_PRIMARY_DIR, files: primary };
  }
  const legacy = await listAnimationsIn(ANIMATIONS_LEGACY_DIR);
  return { dir: ANIMATIONS_LEGACY_DIR, files: legacy };
}

/**
 * Look up the file path for a given animation index. The 30 files
 * are named `01. foo.mp4` … `30. bar.mp4`. If the listing returns
 * fewer than 30 files, we wrap modulo the count we found — this
 * keeps the feature alive even when the curator has only uploaded
 * a handful of animations yet.
 */
export async function pathForAnimationIndex(idx: number): Promise<string> {
  const { dir, files } = await listAvailableAnimations();
  if (files.length === 0) {
    throw new Error(
      `No animation backgrounds found in ${ANIMATIONS_PRIMARY_DIR} or ${ANIMATIONS_LEGACY_DIR}. Upload at /admin/animations.`,
    );
  }
  const real = files[idx % files.length];
  return path.join(dir, real);
}

export const ANIMATION_COUNT = ANIM_COUNT;
