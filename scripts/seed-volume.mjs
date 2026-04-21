#!/usr/bin/env node
/**
 * Seed the Railway persistent volume from the baked-in `data-seed/` snapshot.
 *
 * Why this exists:
 *   Railway mounts a persistent volume at `/app/data` so curator edits and the
 *   newsletter queue survive deploys. But a volume mount *shadows* whatever
 *   was baked into the image at that path — on first boot `/app/data` is an
 *   empty directory, and reading `data/recommendations.json` throws ENOENT.
 *
 * How it works:
 *   The `build` script copies `data/` to a sibling `data-seed/` directory.
 *   `data-seed/` lives at `/app/data-seed/` in the image and is NOT shadowed
 *   by the volume. On container start this script walks `data-seed/` and, for
 *   any file that does not yet exist in `data/`, copies it across. Files that
 *   already exist in the volume (because the curator edited them on a
 *   previous deploy) are left untouched — so this is idempotent and safe on
 *   every boot, not just the first one.
 *
 * Local dev:
 *   `data-seed/` is only produced by `next build` and is gitignored. In
 *   development this script is a no-op because `data-seed/` doesn't exist.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const SEED_DIR = path.resolve("data-seed");
const TARGET_DIR = path.resolve("data");

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(SEED_DIR))) {
    // No seed snapshot (local dev, or something went wrong at build time).
    // Don't fail the container start — just log and move on.
    console.log("[seed-volume] no data-seed/ directory, skipping");
    return;
  }

  await fs.mkdir(TARGET_DIR, { recursive: true });

  const entries = await fs.readdir(SEED_DIR, { withFileTypes: true });
  let copied = 0;
  let kept = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue; // only top-level files for now
    const src = path.join(SEED_DIR, entry.name);
    const dst = path.join(TARGET_DIR, entry.name);
    if (await exists(dst)) {
      kept++;
      continue;
    }
    await fs.copyFile(src, dst);
    copied++;
    console.log(`[seed-volume] seeded ${entry.name}`);
  }

  console.log(
    `[seed-volume] done: ${copied} file(s) seeded, ${kept} already present`,
  );
}

main().catch((err) => {
  // Don't crash the container — log loudly and let `next start` proceed. If
  // the missing file is truly required, Next will error on first request and
  // the logs will show both errors, making the cause obvious.
  console.error("[seed-volume] failed:", err);
});
