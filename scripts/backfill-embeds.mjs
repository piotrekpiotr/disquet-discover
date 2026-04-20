#!/usr/bin/env node
/**
 * Fallback embed backfill. Runs after enrich-labels-and-embeds.mjs to cover
 * the long tail of records where the strict iTunes lookup came up empty.
 *
 * Pipeline per record (skipped entirely if `embed` already set):
 *
 *   1. Strip Discogs-style disambiguation suffixes ("Tycho (3)" -> "Tycho",
 *      "Who Cares? (20)" -> "Who Cares?"). These are unique-ID-in-Discogs
 *      markers and break any cross-service lookup.
 *   2. iTunes Search with looser matching (token overlap instead of
 *      prefix-only), scoped to same release year when possible. Apple Music
 *      embed stays the primary choice because it has the most usable free
 *      player.
 *   3. Deezer search as the fallback. Free, no auth, great coverage of the
 *      obscure leftfield catalog iTunes doesn't index well. Embed URL:
 *        https://widget.deezer.com/widget/light/album/{id}    (default 300px)
 *   4. If both fail, the record stays embed-less and the app falls back to
 *      the new FallbackCard with search CTAs - nothing silently broken.
 *
 * Also backfills links.apple (when iTunes hit) and links.deezer (when Deezer
 * hit) with the real album URL, upgrading stale search-URL links in place.
 *
 * Progressive save on every record so a crash is cheap to recover from.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/recommendations.json");
const UA = "disquet-discover/1.0 +local";

// ---------- utilities ----------

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s) {
  return normalize(s).split(/\s+/).filter(Boolean);
}

/**
 * Strip Discogs disambiguation suffix. Discogs uniquifies artist names with
 * a trailing "(N)" when there's more than one artist of that name in their
 * database. That token is a Discogs-only artifact; it breaks cross-service
 * search. Only strip when the suffix is bare digits surrounded by parens.
 */
function stripDiscogsSuffix(name) {
  return (name || "").replace(/\s*\(\d+\)\s*$/, "").trim();
}

/** Jaccard similarity between two token sets. 1.0 = identical, 0 = disjoint. */
function tokenOverlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let hits = 0;
  for (const t of A) if (B.has(t)) hits++;
  return hits / Math.min(A.size, B.size);
}

async function polite(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------- iTunes (loose match) ----------

/**
 * Re-query iTunes with a looser match: drop the Discogs suffix, accept any
 * hit whose artist tokens overlap >=0.6 AND title tokens overlap >=0.6.
 * Prefer the closest release year when multiple hits survive.
 */
async function findItunesAlbumLoose(item) {
  const artist = stripDiscogsSuffix(item.artist);
  const title = item.title;
  const term = encodeURIComponent(`${artist} ${title}`);
  const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=album&limit=25`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const j = await res.json();
  const yr = Number((item.releaseDate || "").slice(0, 4));
  const candidates = (j.results || [])
    .map((r) => {
      const aSim = tokenOverlap(artist, r.artistName);
      const tSim = tokenOverlap(title, r.collectionName);
      const rYear = Number(String(r.releaseDate || "").slice(0, 4)) || 0;
      const yearPenalty = yr && rYear ? Math.abs(rYear - yr) : 0;
      return { r, aSim, tSim, yearPenalty };
    })
    .filter((c) => c.aSim >= 0.6 && c.tSim >= 0.6)
    .sort(
      (a, b) =>
        // closest year first, then strongest combined token match
        a.yearPenalty - b.yearPenalty || b.aSim + b.tSim - (a.aSim + a.tSim),
    );
  const hit = candidates[0]?.r;
  if (!hit || !hit.collectionId) return null;
  return {
    collectionId: hit.collectionId,
    collectionViewUrl: hit.collectionViewUrl || null,
  };
}

// ---------- Deezer ----------

/**
 * Deezer album search. The "artist:"..." album:"..."" query works but is
 * strict; we fall back to free-form q if the scoped query returns nothing.
 */
async function findDeezerAlbum(item) {
  const artist = stripDiscogsSuffix(item.artist);
  const title = item.title;

  async function hit(q) {
    const url = `https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=25`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const j = await res.json();
    return j.data || [];
  }

  const results = [
    ...(await hit(`artist:"${artist}" album:"${title}"`)),
    ...(await hit(`${artist} ${title}`)),
  ];
  if (results.length === 0) return null;

  const yr = Number((item.releaseDate || "").slice(0, 4));

  // De-dupe by id, then score
  const seen = new Set();
  const scored = [];
  for (const r of results) {
    if (!r || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    const aSim = tokenOverlap(artist, r.artist && r.artist.name);
    const tSim = tokenOverlap(title, r.title);
    const rYear = Number(String(r.release_date || "").slice(0, 4)) || 0;
    const yearPenalty = yr && rYear ? Math.abs(rYear - yr) : 0;
    if (aSim < 0.5 || tSim < 0.5) continue;
    scored.push({ r, aSim, tSim, yearPenalty });
  }
  scored.sort(
    (a, b) =>
      a.yearPenalty - b.yearPenalty ||
      b.aSim + b.tSim - (a.aSim + a.tSim),
  );
  const pick = scored[0]?.r;
  if (!pick) return null;
  return {
    albumId: pick.id,
    link: pick.link || `https://www.deezer.com/album/${pick.id}`,
  };
}

// ---------- main ----------

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  let appleFound = 0;
  let deezerFound = 0;
  let stillMissing = 0;

  for (const item of items) {
    if (item.embed) continue;

    process.stdout.write(`${item.artist} - ${item.title}: `);

    // Tier 1: iTunes, loose match
    try {
      const it = await findItunesAlbumLoose(item);
      if (it) {
        item.embed = {
          provider: "apple",
          src: `https://embed.music.apple.com/us/album/${it.collectionId}?theme=light`,
          height: 450,
        };
        if (
          it.collectionViewUrl &&
          (!item.links.apple || item.links.apple.includes("/search"))
        ) {
          item.links = { ...item.links, apple: it.collectionViewUrl };
        }
        appleFound++;
        console.log(`apple:${it.collectionId}`);
        await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
        await polite(400);
        continue;
      }
    } catch (e) {
      process.stdout.write(`itunes err(${e.message}) `);
    }
    await polite(400);

    // Tier 2: Deezer
    try {
      const dz = await findDeezerAlbum(item);
      if (dz) {
        item.embed = {
          provider: "deezer",
          src: `https://widget.deezer.com/widget/light/album/${dz.albumId}`,
          height: 300,
        };
        if (!item.links.deezer || item.links.deezer.includes("/search")) {
          item.links = { ...item.links, deezer: dz.link };
        }
        deezerFound++;
        console.log(`deezer:${dz.albumId}`);
        await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
        await polite(300);
        continue;
      }
    } catch (e) {
      process.stdout.write(`deezer err(${e.message}) `);
    }

    stillMissing++;
    console.log("still no embed");
    await polite(300);
  }

  console.log(
    `\nFound apple=${appleFound}, deezer=${deezerFound}, still_missing=${stillMissing}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
