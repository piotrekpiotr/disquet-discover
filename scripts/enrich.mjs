#!/usr/bin/env node
/**
 * One-shot enrichment of data/recommendations.json:
 * - Queries iTunes Search (no auth) for each item
 * - Adds coverImageUrl (600px artwork) when a confident match is found
 * - Rewrites `links.apple` to the real collection URL
 * - Rewrites `links.bandcamp` and `links.spotify` to search URLs so they
 *   never land on an empty artist page or a label home
 * - Leaves descriptions and all other fields alone
 *
 * Run: node scripts/enrich.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/recommendations.json");

function norm(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function overlap(a, b) {
  const A = new Set(norm(a).split(" ").filter((w) => w.length >= 3));
  const B = new Set(norm(b).split(" ").filter((w) => w.length >= 3));
  if (A.size === 0 || B.size === 0) return 0;
  let hits = 0;
  for (const w of A) if (B.has(w)) hits++;
  return hits / Math.max(A.size, B.size);
}

async function itunesLookup(artist, title, entity /* "album" | "musicTrack" */) {
  const term = encodeURIComponent(`${artist} ${title}`);
  const url = `https://itunes.apple.com/search?term=${term}&entity=${entity}&limit=10&media=music`;
  const res = await fetch(url, { headers: { "User-Agent": "disquet-discover/1.0" } });
  if (!res.ok) return null;
  const json = await res.json();
  return Array.isArray(json.results) ? json.results : [];
}

function pickMatch(results, artist, title, kind) {
  if (!results || results.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const r of results) {
    const resArtist = r.artistName || "";
    const resTitle = kind === "album" ? r.collectionName || "" : r.trackName || r.collectionName || "";
    if (!resArtist || !resTitle) continue;
    const aScore = overlap(resArtist, artist);
    const tScore = overlap(resTitle, title);
    const score = aScore * 2 + tScore * 3;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  // Require reasonable match: artist overlap >= 0.5 AND title overlap >= 0.5
  if (!best) return null;
  const aScore = overlap(best.artistName || "", artist);
  const tScore = overlap(
    kind === "album" ? best.collectionName || "" : best.trackName || best.collectionName || "",
    title,
  );
  if (aScore < 0.5 || tScore < 0.3) return null;
  return best;
}

function artworkLarge(url) {
  if (!url) return null;
  return url.replace(/\/\d+x\d+(bb)?\./, "/600x600bb.");
}

function searchUrls(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return {
    bandcamp: `https://bandcamp.com/search?q=${q}&item_type=a`,
    spotify: `https://open.spotify.com/search/${q}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
  };
}

async function main() {
  const raw = await fs.readFile(FILE, "utf8");
  const items = JSON.parse(raw);

  let matched = 0;
  let total = 0;
  for (const item of items) {
    total++;
    const entity = item.type === "single" ? "musicTrack" : "album";
    const results = await itunesLookup(item.artist, item.title, entity);
    const match = pickMatch(results, item.artist, item.title, entity === "album" ? "album" : "track");
    const surls = searchUrls(item.artist, item.title);

    // Always rewrite bandcamp/spotify to search URLs (they're currently pointing at label homes or empty artist pages)
    item.links = item.links || {};
    item.links.bandcamp = surls.bandcamp;
    item.links.spotify = surls.spotify;
    // Only overwrite youtube if it's not a real watch link
    if (!item.links.youtube || /results\?search_query=/.test(item.links.youtube)) {
      item.links.youtube = surls.youtube;
    }

    if (match) {
      matched++;
      const art = artworkLarge(match.artworkUrl100 || match.artworkUrl60);
      if (art) item.coverImageUrl = art;
      if (match.collectionViewUrl || match.trackViewUrl) {
        item.links.apple = (match.collectionViewUrl || match.trackViewUrl).split("?")[0];
      }
      if (match.releaseDate) {
        // Only update if the iTunes date is reasonable (non-empty)
        const d = match.releaseDate.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          item.releaseDate = d;
        }
      }
      console.log(`✓ ${item.artist} - ${item.title}  (${item.coverImageUrl ? "art" : "no-art"})`);
    } else {
      // No confident match: leave coverImageUrl null so motif fallback kicks in
      item.coverImageUrl = null;
      console.log(`· ${item.artist} - ${item.title}  (no match)`);
    }
    // Be polite to iTunes
    await new Promise((r) => setTimeout(r, 120));
  }

  await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
  console.log(`\nMatched ${matched}/${total}. Wrote ${FILE}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
