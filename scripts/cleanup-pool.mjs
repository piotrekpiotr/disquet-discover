#!/usr/bin/env node
/**
 * One-shot housekeeping for `data/recommendations.json`. Removes:
 *
 *   1. PENDING records whose `tags[0]` is on the TAG_BLACKLIST
 *      (off-genre per the curator's policy — reggae, french pop,
 *      classical, soundtrack, etc.). Approved records are NEVER
 *      touched here; curator intent wins for anything they've
 *      already published.
 *
 *   2. PENDING records whose artist is on the ARTIST_BLACKLIST.
 *
 *   3. PENDING records that duplicate another record by Apple
 *      Music album ID. Same release queried under different artist
 *      credits ("2K88, Lauren Duffus, Rainy Miller & Bianca Scout"
 *      vs. "Rainy Miller" vs. "Bianca Scout" — same Apple album
 *      ID 6766835671). The CANONICAL record is the one whose
 *      artist string contains the most commas/ampersands (the
 *      full collab credit); the partial-billing siblings are
 *      dropped. If no Apple URL is present, this layer can't
 *      dedupe — the (artist|title) key in sync-artists already
 *      caught exact-string dupes.
 *
 * Default: DRY RUN. Prints what would be removed, does NOT touch
 * the file. Add `--apply` to actually mutate the JSON. Always
 * makes a `.bak` copy first.
 *
 * Usage:
 *   node scripts/cleanup-pool.mjs           # dry run
 *   node scripts/cleanup-pool.mjs --apply   # really delete
 *
 * Safe to run repeatedly — idempotent once the bad records are gone.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  TAG_BLACKLIST_STRICT,
  ARTIST_BLACKLIST,
} from "./sources/candidate-filter.mjs";
import { extractAppleAlbumId } from "./lib/apple-url.mjs";
import { ARTISTS as BASE_ARTISTS } from "./monitoring.mjs";

const FILE = path.resolve("data/recommendations.json");
const BAK = path.resolve("data/recommendations.json.bak");
const APPLY = process.argv.includes("--apply");

/**
 * Crude "canonicalness" score: more collaborators in the artist
 * string = more canonical. A solo credit ("Bianca Scout") loses to
 * a four-way collab ("2K88, Lauren Duffus, Rainy Miller & Bianca
 * Scout") for the same album.
 */
function canonicalScore(artist) {
  if (!artist) return 0;
  const sepCount = (artist.match(/[,&/;·+]/g) || []).length;
  // Tiebreak by raw length so "X feat Y" beats "X" even with no comma.
  return sepCount * 100 + Math.min(artist.length, 200);
}

function tagIsBlacklisted(tags) {
  if (!Array.isArray(tags)) return false;
  for (const t of tags) {
    if (TAG_BLACKLIST_STRICT.has(String(t || "").toLowerCase().trim())) {
      return true;
    }
  }
  return false;
}

function artistIsBlacklisted(artist) {
  if (!artist) return false;
  return ARTIST_BLACKLIST.has(artist.toLowerCase().trim());
}

// Normalised set of monitored artist names — keyed the same way
// sync-artists does its dedup, so "Nídia" and "Nidia" both hit.
const MONITORED_SET = new Set(
  BASE_ARTISTS.map((a) =>
    a.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim(),
  ),
);

/**
 * Is the record a SOLO release by a monitored artist? Used to
 * whitelist tag-drops in the rare case the curator's chosen artist
 * does a one-off cross-genre piece (Felicia Atkinson scoring a
 * film, Ben Frost soundtrack, etc.) — monitoring decision wins.
 *
 * Crucially, COLLAB releases (multiple credits, even if one is
 * monitored) are NOT whitelisted: "Alee & NooN - Ton absence" with
 * NooN monitored is exactly the case the curator wants dropped — the
 * overall release is french pop, the monitored artist just guests.
 * The whole-string equality test below distinguishes solo from collab.
 */
function recordIsSoloByMonitoredArtist(rec) {
  if (!rec.artist) return false;
  const whole = rec.artist
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
  return MONITORED_SET.has(whole);
}

async function main() {
  const raw = await fs.readFile(FILE, "utf8");
  const items = JSON.parse(raw);
  const drop = new Set(); // indices to remove

  // Pass 1: blacklist filters (pending only — never touch approved).
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.status !== "pending") continue;
    if (tagIsBlacklisted(it.tags)) {
      // Whitelist applies ONLY to solo releases by a monitored
      // artist — the curator's monitoring decision absorbs the
      // mismatched tag (Felicia Atkinson - one-off soundtrack).
      // Collab releases where a monitored artist guests on an
      // off-genre track ("Alee & NooN - Ton absence", french pop)
      // still drop — the OVERALL release is what the curator
      // doesn't want, not the monitored guest credit.
      if (recordIsSoloByMonitoredArtist(it)) {
        console.log(
          `  [tag-keep] ${it.artist} - ${it.title} (tags=${JSON.stringify(it.tags)}) — solo by monitored artist, kept`,
        );
      } else {
        drop.add(i);
        console.log(
          `  [tag] ${it.artist} - ${it.title} (tags=${JSON.stringify(it.tags)})`,
        );
      }
      continue;
    }
    if (artistIsBlacklisted(it.artist)) {
      drop.add(i);
      console.log(`  [artist] ${it.artist} - ${it.title}`);
      continue;
    }
  }

  // Pass 2: Apple-ID duplicates among pending records (plus check
  // against approved siblings — if curator already approved one
  // variant, drop the pending duplicates so they don't clutter).
  const byAppleId = new Map(); // appleId -> array of { idx, isPending, score }
  for (let i = 0; i < items.length; i++) {
    if (drop.has(i)) continue;
    const it = items[i];
    const apple = it.links?.apple;
    const aid = extractAppleAlbumId(apple);
    if (!aid) continue;
    if (!byAppleId.has(aid)) byAppleId.set(aid, []);
    byAppleId.get(aid).push({
      idx: i,
      isPending: it.status === "pending",
      score: canonicalScore(it.artist),
      artist: it.artist,
      title: it.title,
    });
  }

  for (const [aid, group] of byAppleId.entries()) {
    if (group.length < 2) continue;
    // If at least one is approved, keep the approved (curator already
    // chose). All pending siblings drop.
    const approved = group.filter((g) => !g.isPending);
    let keeper;
    if (approved.length > 0) {
      // Approved wins. Pick the best-canonical among approved if
      // multiple (rare). Pending siblings all drop.
      keeper = approved.sort((a, b) => b.score - a.score)[0];
    } else {
      // All pending. Keep the highest canonicalScore (most-credited
      // artist string). Tie → lowest idx (oldest-added).
      keeper = group.sort(
        (a, b) => b.score - a.score || a.idx - b.idx,
      )[0];
    }
    for (const g of group) {
      if (g.idx === keeper.idx) continue;
      if (g.isPending) {
        drop.add(g.idx);
        console.log(
          `  [apple-dup ${aid}] drop "${g.artist} - ${g.title}" (keeping "${keeper.artist}")`,
        );
      } else {
        // Non-keeper approved record at same Apple ID is highly
        // suspicious — log but DO NOT touch.
        console.log(
          `  [apple-dup ${aid}] WARN: approved sibling of keeper kept verbatim: "${g.artist} - ${g.title}"`,
        );
      }
    }
  }

  const kept = items.filter((_, i) => !drop.has(i));
  console.log("");
  console.log(
    `Total: ${items.length} → ${kept.length} (drop ${items.length - kept.length})`,
  );
  console.log(APPLY ? "APPLY mode — writing changes." : "DRY RUN — pass --apply to write.");

  if (!APPLY) return;
  await fs.copyFile(FILE, BAK);
  console.log(`Backup written to ${BAK}.`);
  await fs.writeFile(FILE, JSON.stringify(kept, null, 2), "utf8");
  console.log(`Wrote ${FILE}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
