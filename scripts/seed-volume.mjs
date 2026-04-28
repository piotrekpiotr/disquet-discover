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
 *   1. `recommendations.json` — FIELD-LEVEL MERGE by record id.
 *
 *      For records in the seed that don't exist on the volume: append.
 *
 *      For records that exist in both, the rule is "non-empty volume value
 *      wins, otherwise take seed". Concretely:
 *
 *        - `status` and `approvedAt` are ALWAYS taken from the volume.
 *          These are curator-set — daily syncs must never touch them.
 *        - Every other field (description, embed, coverImageUrl, links.*,
 *          tags, pressMentions, …) uses the seed's value only when the
 *          volume's value is empty / missing / null / "" / []. If the
 *          volume has a non-empty value, it's kept.
 *
 *      Why this shape:
 *
 *        - Enrichment scripts (backfill-embeds, write-descriptions, etc.)
 *          write into the repo → into the seed. With the old "volume
 *          wins wholesale" rule, those enrichments never reached records
 *          that had already been minted as pending. Curators saw empty
 *          descriptions / missing players forever.
 *        - The per-field "non-empty wins" rule lets enrichment flow into
 *          any field the curator hasn't customised, while still protecting
 *          any field the curator has actually edited. To force a refresh
 *          of an admin-edited description, the curator clears the field
 *          in the admin UI; the next deploy then picks up the seed value.
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
const MEDIA_CANDIDATES = "media-candidates.json";

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
 * "Empty" in merge terms: a field the curator has never filled in and a
 * script might legitimately backfill. We explicitly do NOT treat `false` or
 * `0` as empty, so boolean flags / numeric heights survive. See header
 * comment for the full merge policy.
 */
function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  return false;
}

/**
 * Field-level merge: volume value wins when it's non-empty, otherwise we
 * take seed. Applied to top-level fields AND individually to every key in
 * the `links` subobject so e.g. a real bandcamp URL can be upgraded while
 * a curator-edited spotify URL stays put.
 *
 * `status` and `approvedAt` are taken from the volume unconditionally —
 * curatorial state is never overwritten by a sync.
 */
function mergeRecord(volumeRec, seedRec) {
  const out = { ...seedRec, ...volumeRec };

  // Curator-only fields — volume always wins, even if (somehow) empty.
  out.status = volumeRec.status ?? seedRec.status;
  out.approvedAt = "approvedAt" in volumeRec ? volumeRec.approvedAt : seedRec.approvedAt;

  // For every other top-level key, prefer a non-empty volume value; else seed.
  const keys = new Set([...Object.keys(seedRec), ...Object.keys(volumeRec)]);
  for (const k of keys) {
    if (k === "status" || k === "approvedAt") continue;
    if (k === "links") continue; // handled below, per-sub-key
    const volumeVal = volumeRec[k];
    const seedVal = seedRec[k];
    if (isEmptyValue(volumeVal) && !isEmptyValue(seedVal)) {
      out[k] = seedVal;
    } else if (k in volumeRec) {
      out[k] = volumeVal;
    } else {
      out[k] = seedVal;
    }
  }

  // links: per-key merge so a backfilled real album URL can replace an
  // initial search URL, without wiping curator-set overrides on sibling keys.
  const seedLinks = seedRec.links || {};
  const volLinks = volumeRec.links || {};
  const mergedLinks = { ...seedLinks };
  for (const k of Object.keys(volLinks)) {
    if (!isEmptyValue(volLinks[k])) {
      mergedLinks[k] = volLinks[k];
    } else if (!(k in seedLinks)) {
      mergedLinks[k] = volLinks[k]; // preserve explicit null/"" if seed has no opinion
    }
  }
  out.links = mergedLinks;

  return out;
}

/**
 * Merge seed records into target by id, with per-field policy. Appends
 * records that don't exist on the volume. Returns { merged, addedCount,
 * updatedCount } so the caller can log what actually changed.
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

  const seedById = new Map(
    seed.filter((r) => r && r.id).map((r) => [r.id, r]),
  );
  const merged = [];
  let added = 0;
  let updated = 0;

  // Walk every volume record first, merging it with any matching seed entry.
  const seenSeedIds = new Set();
  for (const vol of current) {
    if (!vol || !vol.id) {
      merged.push(vol);
      continue;
    }
    const seedRec = seedById.get(vol.id);
    if (!seedRec) {
      merged.push(vol);
      continue;
    }
    seenSeedIds.add(vol.id);
    const mergedRec = mergeRecord(vol, seedRec);
    // Cheap change detection: serialize both; if they differ, we "updated".
    if (JSON.stringify(mergedRec) !== JSON.stringify(vol)) updated++;
    merged.push(mergedRec);
  }

  // Append any seed records that had no volume counterpart.
  for (const [id, seedRec] of seedById) {
    if (seenSeedIds.has(id)) continue;
    merged.push(seedRec);
    added++;
  }

  if (added === 0 && updated === 0) {
    console.log(
      `[seed-volume] ${RECOMMENDATIONS}: nothing to change (volume has ${current.length} record(s))`,
    );
    return;
  }

  // Keep the same newest-first ordering the app expects.
  merged.sort((a, b) =>
    (b.releaseDate || "").localeCompare(a.releaseDate || ""),
  );
  await writeJson(targetPath, merged);
  console.log(
    `[seed-volume] ${RECOMMENDATIONS}: ${added} new record(s), ` +
      `${updated} updated record(s) (volume now ${merged.length} total)`,
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

  // 1) Merge recommendations.json (field-level, "non-empty volume wins").
  const seedRec = path.join(SEED_DIR, RECOMMENDATIONS);
  if (await exists(seedRec)) {
    try {
      await mergeRecommendations(seedRec, path.join(TARGET_DIR, RECOMMENDATIONS));
    } catch (err) {
      console.error(`[seed-volume] merge failed for ${RECOMMENDATIONS}:`, err);
    }
  }

  // 2) Merge media-candidates.json (preserve dismissed/promoted, accept
  //    new candidates from each CI sync). Without this, the volume's
  //    candidates file is frozen at first-deploy state and the
  //    /admin/candidates page never refreshes — exactly the "section
  //    is empty" complaint that surfaced this whole rewrite.
  const seedCands = path.join(SEED_DIR, MEDIA_CANDIDATES);
  if (await exists(seedCands)) {
    try {
      await mergeMediaCandidates(
        seedCands,
        path.join(TARGET_DIR, MEDIA_CANDIDATES),
      );
    } catch (err) {
      console.error(`[seed-volume] merge failed for ${MEDIA_CANDIDATES}:`, err);
    }
  }

  // 3) Seed-once for every other top-level file in data-seed/.
  const entries = await fs.readdir(SEED_DIR, { withFileTypes: true });
  let copied = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === RECOMMENDATIONS) continue; // handled above
    if (entry.name === MEDIA_CANDIDATES) continue; // handled above
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

/**
 * Merge media-candidates.json the same way we merge
 * recommendations.json: NEW candidates from the seed get appended,
 * but the volume's curator-only fields (`dismissed`, `promoted`) win
 * unconditionally so a "not interested" decision is not silently
 * forgotten on the next deploy.
 *
 * Why this exists:
 *   The previous behaviour was "seed once" — the volume's
 *   media-candidates.json was written on first boot and never
 *   touched again. Every subsequent CI sync-media commit was
 *   invisible to production because Railway's volume mount shadows
 *   the image's data/. The curator opens /admin/candidates, sees
 *   whatever shipped on day-one (often empty/junk), and concludes
 *   the candidate pipeline is broken. It wasn't — it was just being
 *   silently ignored at deploy time.
 *
 * Merge policy per candidate (keyed by artist name):
 *   - Volume has it AND curator marked dismissed/promoted → keep
 *     volume's full record. Counts and lastSeen don't matter once
 *     the curator has decided.
 *   - Volume has it, no decision → take seed's lastSeen, mentions,
 *     sources, titleHints, poolTags etc. (the freshest data) but
 *     keep volume's firstSeen so we know when this candidate first
 *     surfaced.
 *   - Seed only → append.
 *   - Volume only (e.g. a candidate that fell out of the seed feed
 *     window but wasn't dismissed) → keep, untouched. We never
 *     hard-delete; the dismissed/promoted ledger is forever.
 */
async function mergeMediaCandidates(seedPath, targetPath) {
  let seed = {};
  try {
    seed = await readJson(seedPath);
  } catch {
    return; // no seed, nothing to merge
  }
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) return;

  let volume = {};
  if (await exists(targetPath)) {
    try {
      volume = await readJson(targetPath);
      if (!volume || typeof volume !== "object" || Array.isArray(volume)) {
        volume = {};
      }
    } catch {
      volume = {};
    }
  }

  const merged = { ...volume };
  let added = 0;
  let updated = 0;

  for (const [name, seedRec] of Object.entries(seed)) {
    const cur = volume[name];
    if (!cur) {
      merged[name] = seedRec;
      added++;
      continue;
    }
    if (cur.dismissed || cur.promoted) {
      // Curator decided. Don't refresh anything from the seed —
      // promoted candidates are already in monitoring-extras and
      // bringing them back into surface view would re-list them.
      continue;
    }
    // Update everything except firstSeen (preserve original
    // discovery date). Take seed's mentions count as the
    // accumulator-of-record so a CI sync that ran AFTER the volume
    // last saw this candidate gets credit.
    merged[name] = {
      ...seedRec,
      firstSeen: cur.firstSeen || seedRec.firstSeen,
    };
    if (JSON.stringify(merged[name]) !== JSON.stringify(cur)) updated++;
  }

  await writeJson(targetPath, merged);
  console.log(
    `[seed-volume] ${MEDIA_CANDIDATES}: ${added} new, ${updated} updated, ${
      Object.keys(merged).length
    } total`,
  );
}

main().catch((err) => {
  // Don't crash the container — log loudly and let `next start` proceed. If
  // the missing file is truly required, Next will error on first request and
  // the logs will show both errors, making the cause obvious.
  console.error("[seed-volume] failed:", err);
});
