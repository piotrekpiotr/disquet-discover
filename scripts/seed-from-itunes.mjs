#!/usr/bin/env node
/**
 * Rebuild data/recommendations.json from real iTunes Search API data.
 *
 *  - For each artist in ARTISTS, fetches that artist's albums + singles
 *  - Filters to releases on/after MIN_DATE (so the feed is "fresh")
 *  - Keeps up to 2 items per artist (1 album/EP + 1 single)
 *  - Every item gets: real title, real release date, real 600x600 artwork,
 *    real Apple Music collection URL, and genre as a tag
 *  - Bandcamp / Spotify / YouTube links default to search URLs
 *  - Sets `status: approved` on the 15 most recent items so the public feed
 *    is populated; the rest land in `pending` for admin review
 *  - Descriptions are LEFT BLANK on purpose. They'll be written by hand in
 *    the admin panel (or auto-generated from verified metadata in Phase 2).
 *    No more fabricated facts.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ARTISTS } from "./monitoring.mjs";

const FILE = path.resolve("data/recommendations.json");
const MIN_DATE = "2024-01-01";

// Legacy inline list kept only for reference, no longer read.
const _UNUSED_INLINE_ARTISTS = [
  "Skee Mask",
  "Djrum",
  "Four Tet",
  "Oneohtrix Point Never",
  "Andy Stott",
  "Nicolas Jaar",
  "Huerco S.",
  "Shinichi Atobe",
  "Floating Points",
  "Alva Noto",
  "Rival Consoles",
  "Mount Kimbie",
  "Space Afrika",
  "Demdike Stare",
  "Dean Blunt",
  "DJ Python",
  "Moin",
  "Purelink",
  "Upsammy",
  "Ulla",
  "Pendant",
  "Perila",
  "Stenny",
  "Andrea",
  "Loidis",
  "John Glacier",
  "Earl Sweatshirt",
  "Felicia Atkinson",
  "Aphex Twin",
  "Flying Lotus",
  "Pontiac Streator",
  "Ben Bondy",
  "exael",
  "Joanne Robertson",
  "Bianca Scout",
  "Mount XLR",
  "Deadbeat",
  "Basic Channel",
  "Pole",
  "Deepchord",
  "Bon Iver",
  "Susumu Yokota",
  "OK EG",
  "Vainqueur",
  "Substance",
  "LOG",
  // Added 2026-04
  "Fields of Mist",
  "Sampha",
  "shinetiac",
  "Yussef Dayes",
  "Eyedress",
  "Iglooghost",
  "Amnesia Scanner",
  "Durutti Column",
  "Lorenzo Senni",
  "DJ Shadow",
  "Jacques Greene",
  "Nosaj Thing",
  "Jpegmafia",
  "Vegyn",
  "Max Cooper",
  "Noon",
  "LSDXOXO",
  "Sammy Virji",
  "Kwabs",
  "Carrier",
  "Meitei",
  "Zebra Katz",
  "Rustie",
  "Boards of Canada",
];

function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

async function lookup(artist, entity /* "album" | "musicTrack" */) {
  const term = encodeURIComponent(artist);
  const url = `https://itunes.apple.com/search?term=${term}&entity=${entity}&limit=25&media=music&attribute=artistTerm`;
  const res = await fetch(url, { headers: { "User-Agent": "disquet-discover/1.0" } });
  if (!res.ok) return [];
  const json = await res.json();
  return Array.isArray(json.results) ? json.results : [];
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

function pickReleaseType(result) {
  const name = (result.collectionName || result.trackName || "").toLowerCase();
  if (/-\s*single$/i.test(result.collectionName || "")) return "single";
  if (/-\s*ep$/i.test(result.collectionName || "")) return "ep";
  if (result.trackCount && result.trackCount <= 3) return "single";
  if (result.trackCount && result.trackCount <= 6) return "ep";
  return "album";
}

function cleanTitle(raw) {
  return (raw || "")
    .replace(/\s*-\s*Single$/i, "")
    .replace(/\s*-\s*EP$/i, "")
    .trim();
}

async function main() {
  /** @type {any[]} */
  const items = [];
  for (const artist of ARTISTS) {
    process.stdout.write(`${artist}: `);
    let added = 0;
    for (const entity of ["album", "musicTrack"]) {
      const results = await lookup(artist, entity);
      // Strict: artist name must match (case-insensitive, trimmed)
      const mine = results.filter(
        (r) => (r.artistName || "").toLowerCase().trim() === artist.toLowerCase().trim(),
      );
      // Unique by collectionId (albums) or trackId (tracks)
      const seen = new Set();
      const unique = [];
      for (const r of mine) {
        const key = r.collectionId || r.trackId;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        unique.push(r);
      }
      unique.sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || ""));

      // Take the newest that passes the freshness filter
      const fresh = unique.filter((r) => (r.releaseDate || "").slice(0, 10) >= MIN_DATE);
      // entity=album returns both LPs and EPs/singles; we want LP/EP only on this pass
      const ofKind =
        entity === "album"
          ? fresh.filter((r) => pickReleaseType(r) !== "single")
          : fresh.filter((r) => pickReleaseType(r) === "single");
      const pick = ofKind[0];
      if (!pick) continue;

      const rawTitle = pick.collectionName || pick.trackName || "";
      const title = cleanTitle(rawTitle);
      const releaseDate = (pick.releaseDate || "").slice(0, 10);
      const art = artworkLarge(pick.artworkUrl100 || pick.artworkUrl60);
      const apple = (pick.collectionViewUrl || pick.trackViewUrl || "").split("?")[0];
      const type = pickReleaseType(pick);
      const tag = (pick.primaryGenreName || "").toLowerCase();
      const s = searchUrls(artist, title);
      const id = `${slugify(artist)}-${slugify(title)}`.slice(0, 80);

      items.push({
        id,
        type,
        artist,
        title,
        label: "",
        releaseDate,
        description: "",
        tags: tag ? [tag] : [],
        links: {
          apple,
          bandcamp: s.bandcamp,
          spotify: s.spotify,
          soundcloud: `https://soundcloud.com/search?q=${encodeURIComponent(`${artist} ${title}`)}`,
          youtube: s.youtube,
        },
        embed: null,
        musicVideoUrl: null,
        status: "pending",
        approvedAt: null,
        coverImageUrl: art || null,
        cover: { bg: "#111110", fg: "#f2efe8", motif: "disc" },
      });
      added++;
    }
    console.log(added ? `ok (${added})` : "skipped (no fresh release)");
    await new Promise((r) => setTimeout(r, 180)); // rate-limit politeness
  }

  // Global sort: newest releaseDate first
  items.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));

  // Deduplicate ids (multiple artists could collide on slug)
  const idCounts = new Map();
  for (const it of items) {
    const n = (idCounts.get(it.id) || 0) + 1;
    idCounts.set(it.id, n);
    if (n > 1) it.id = `${it.id}-${n}`;
  }

  // Approve the 15 most recent (balanced: ensure at least 2 singles and 3 long-form)
  const approvedBudget = { single: 0, long: 0, max: 15 };
  for (const it of items) {
    if (approvedBudget.single + approvedBudget.long >= approvedBudget.max) break;
    if (it.type === "single" && approvedBudget.single < 6) {
      it.status = "approved";
      it.approvedAt = new Date().toISOString();
      approvedBudget.single++;
    } else if (it.type !== "single" && approvedBudget.long < 9) {
      it.status = "approved";
      it.approvedAt = new Date().toISOString();
      approvedBudget.long++;
    }
  }

  await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
  console.log(
    `\nWrote ${items.length} items (${items.filter((i) => i.status === "approved").length} approved, ${items.filter((i) => i.type === "single").length} singles, ${items.filter((i) => i.type === "ep").length} EPs, ${items.filter((i) => i.type === "album").length} albums). Oldest: ${items[items.length - 1]?.releaseDate}, newest: ${items[0]?.releaseDate}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
