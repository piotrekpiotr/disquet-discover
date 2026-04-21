#!/usr/bin/env node
/**
 * Sync the Railway persistent volume with the baked-in `data-seed/` snapshot.
 *
 * Why this exists:
 *   Railway mounts a persistent volume at `/app/data` so curator edits and the
 *   newsletter queue survive deploys. But a volume mount *shadows* whatever
 *   was baked into the image at that path — on first boot `/app/data` is an
 *   empty directory, and reading `data/recommendations.json` throws ENOENT.
 *
 *   There is a second complication: the daily GitHub Actions workflow commits
 *   new `pending` records to the REPO's `data/recommendations.json`. Railway
 *   then redeploys. Those new records are baked into the image's `data-seed/`
 *   directory, but the volume's `data/recommendations.json` is untouched by
 *   the deploy. So a dumb "seed once" script would never surface the daily
 *   batch on the live site — and a dumb "always overwrite" script would wipe
 *   every curator approval / rejection.
 *
 *   Hence: merge, don't replace.
 *
 * How it works:
 *   The `build` script copies `data/` → `data-seed/`. At container start:
 *
 *   1. `recommendations.json` — MERGE by record id. For every record in the
 *      seed that is NOT already in the volume, append it (pending). Records
 *      that exist in the volume are left exactly as-is, preserving curator
 *      status changes, description edits, cover tweaks, etc. This is the
 *      daily-pool bridge: new seed records flow in, admin state survives.
 *
 *   2. Everything else (`newsletter-queue.json`, `label-candidate-artists.json`,
 *      backup files) — SEED ONCE. If the file is missing on the volume, copy
 *      it from the seed. If it exists, leave it alone.
 *
 *   All three modes are idempotent: running this script twice in a row on a
 *   synced volume produces zero changes.
 *
 * Local dev:
 *   `data-seed/` is only produced by `next build` and is gitignored. In
 *   development this script is a no-op because `data-seed/` doesn't exist.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const SEED_DIR = path.resolve("data-seed");
const TARGET_DIR = path.resolve("data");
const RECOMMENDATIONS = "recommendations.json";

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw);
}

async function writeJson(p, value) {
  await fs.writeFile(p, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

/**
 * Merge any new records from the seed file into the target file, keyed by id.
 * The volume's version of each record wins — we only append records whose id
 * is absent on the volume. This is what lets the daily GitHub Actions pool
 * reach production without clobbering curator edits.
 */
async function mergeRecommendations(seedPath, targetPath) {
  const seed = await readJson(seedPath);
  if (!Array.isArray(seed)) {
    console.log(`[seed-volume] ${RECOMMENDATIONS} seed is not an array, skipping merge`);
    return;
  }

  if (!(await exists(targetPath))) {
    // First boot: no volume copy yet. Just copy the whole seed across.
    await writeJson(targetPath, seed);
    console.log(
      `[seed-volume] ${RECOMMENDATIONS}: first-boot seed of ${seed.length} record(s)`,
    );
    return;
  }

  const current = await readJson(targetPath);
  if (!Array.isArray(current)) {
    // Volume file is corrupt/unexpected shape. Back it up and replace with seed
    // rather than crashing — the operator can restore manually if needed.
    const backup = `${targetPath}.malformed-${Date.now()}`;
    await fs.rename(targetPath, backup);
    await writeJson(targetPath, seed);
    console.log(
      `[seed-volume] ${RECOMMENDATIONS} on volume was not an array; backed up to ${path.basename(
        backup,
      )} and reseeded`,
    );
    return;
  }

  const currentIds = new Set(current.map((r) => r && r.id).filter(Boolean));
  const additions = seed.filter((r) => r && r.id && !currentIds.has(r.id));

  if (additions.length === 0) {
    console.log(
      `[seed-volume] ${RECOMMENDATIONS}: nothing new to merge (volume has ${current.length} record(s))`,
    );
    return;
  }

  const merged = [...current, ...additions];
  // Keep the same newest-first ordering the app expects.
  merged.sort((a, b) =>
    (b.releaseDate || "").localeCompare(a.releaseDate || ""),
  );
  await writeJson(targetPath, merged);
  console.log(
    `[seed-volume] ${RECOMMENDATIONS}: merged ${additions.length} new record(s) ` +
      `(volume now ${merged.length} total)`,
  );
}

async function main() {
  if (!(await exists(SEED_DIR))) {
    // No seed snapshot (local dev, or something went wrong at build time).
    // Don't fail the container start — just log and move on.
    console.log("[seed-volume] no data-seed/ directory, skipping");
    return;
  }

  await fs.mkdir(TARGET_DIR, { recursive: true });

  // 1) Merge recommendations.json (id-keyed union; volume wins).
  const seedRec = path.join(SEED_DIR, RECOMMENDATIONS);
  if (await exists(seedRec)) {
    try {
      await mergeRecommendations(seedRec, path.join(TARGET_DIR, RECOMMENDATIONS));
    } catch (err) {
      console.error(`[seed-volume] merge failed for ${RECOMMENDATIONS}:`, err);
    }
  }

  // 2) Seed-once for every other top-level file in data-seed/.
  const entries = await fs.readdir(SEED_DIR, { withFileTypes: true });
  let copied = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === RECOMMENDATIONS) continue; // handled above
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
    `[seed-volume] aux files: ${copied} seeded, ${kept} already present`,
  );
}

main().catch((err) => {
  // Don't crash the container — log loudly and let `next start` proceed. If
  // the missing file is truly required, Next will error on first request and
  // the logs will show both errors, making the cause obvious.
  console.error("[seed-volume] failed:", err);
});
