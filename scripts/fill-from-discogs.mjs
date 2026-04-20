#!/usr/bin/env node
/**
 * Second-pass seeding: for artists who didn't produce an entry via iTunes,
 * query the Discogs public database. Discogs has far deeper coverage of niche
 * electronic labels (Ilian Tape, 3XL, Motion Ward, West Mineral, Modern Love,
 * etc.) than iTunes does.
 *
 * Rate limits:
 *   - Unauthenticated: 25 requests/minute per IP.
 *   - Set DISCOGS_TOKEN (personal access token) env var to raise to 60/min.
 *
 * We:
 *  1. Read data/recommendations.json, collect artists already present.
 *  2. For each WANTED artist not already present, search Discogs for releases,
 *     filter to year >= MIN_YEAR, pick the most recent that has cover art.
 *  3. Fetch that release's detail to get clean title, label, released date,
 *     and primary cover image.
 *  4. Append a new record with status "pending" (admin will approve/edit).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ARTISTS as WANTED_FROM_MONITORING } from "./monitoring.mjs";

const FILE = path.resolve("data/recommendations.json");
const MIN_YEAR = 2024;
const UA = "disquet-discover/1.0 +local";
const TOKEN = process.env.DISCOGS_TOKEN || "";

const WANTED = WANTED_FROM_MONITORING;
// Legacy inline list kept for reference.
const _UNUSED_WANTED = [
  "Andy Stott",
  "Ulla",
  "Demdike Stare",
  "Dean Blunt",
  "Earl Sweatshirt",
  "Pole",
  "Ben Bondy",
  "exael",
  "Ulla Straus",
  "Huerco S.",
  "Pendant",
  "Andrea",
  "Pontiac Streator",
  "Joanne Robertson",
  "Bianca Scout",
  "Deadbeat",
  "Basic Channel",
  "Susumu Yokota",
  "Vainqueur",
  "Substance",
  "LOG",
  "Bon Iver",
  "H.LLS",
  "Lauren Duffus",
  "Helen Island",
  "Mount XLR",
  "Aloisius",
  "2k88",
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

function classifyType(release) {
  const formats = (release.formats || []).flatMap(
    (f) => [f.name, ...(f.descriptions || [])].map((s) => (s || "").toLowerCase()),
  );
  if (formats.some((f) => /single/.test(f))) return "single";
  if (formats.some((f) => /\bep\b/.test(f))) return "ep";
  const trackCount = (release.tracklist || []).length;
  if (trackCount && trackCount <= 3) return "single";
  if (trackCount && trackCount <= 6) return "ep";
  return "album";
}

function searchUrls(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return {
    bandcamp: `https://bandcamp.com/search?q=${q}&item_type=a`,
    spotify: `https://open.spotify.com/search/${q}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    soundcloud: `https://soundcloud.com/search?q=${encodeURIComponent(`${artist} ${title}`)}`,
  };
}

function authQS() {
  return TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : "";
}

async function dg(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") || "5");
    console.log(`  · rate-limited, sleeping ${retry}s`);
    await new Promise((r) => setTimeout(r, retry * 1000));
    return dg(url);
  }
  if (!res.ok) throw new Error(`Discogs ${res.status} on ${url}`);
  return res.json();
}

function nameMatches(artist, result) {
  const title = (result.title || "").toLowerCase();
  const a = artist.toLowerCase();
  // Discogs search results format "Artist - Title" (possibly "Artist*" for disambiguation).
  // Strict-ish match: artist must appear before the " - " separator.
  const before = title.split(" - ")[0].replace(/\*+$/, "").trim();
  return before === a;
}

async function findRelease(artist) {
  // Search albums first, then singles/EPs
  const qs = `q=${encodeURIComponent(artist)}&type=release&sort=year&sort_order=desc&per_page=50${authQS()}`;
  const j = await dg(`https://api.discogs.com/database/search?${qs}`);
  const results = (j.results || []).filter(
    (r) => nameMatches(artist, r) && (r.year || 0) >= MIN_YEAR,
  );
  if (results.length === 0) return null;
  // Prefer results that already have a cover_image thumbnail (suggests images exist)
  results.sort((a, b) => {
    const ay = a.year || 0, by = b.year || 0;
    if (by !== ay) return by - ay;
    const aHasArt = a.cover_image && !a.cover_image.endsWith("/spacer.gif") ? 1 : 0;
    const bHasArt = b.cover_image && !b.cover_image.endsWith("/spacer.gif") ? 1 : 0;
    return bHasArt - aHasArt;
  });
  // Fetch release detail for the top candidate to get cover + full date + label
  for (const r of results.slice(0, 5)) {
    try {
      const detail = await dg(`${r.resource_url}?${authQS().slice(1)}`);
      const primaryImage =
        (detail.images || []).find((im) => im.type === "primary")?.uri ||
        (detail.images || [])[0]?.uri ||
        null;
      if (!primaryImage) continue; // skip if no cover art
      return { search: r, detail, primaryImage };
    } catch (e) {
      console.log(`  · detail fetch failed for ${r.id}: ${e.message}`);
    }
  }
  return null;
}

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  const have = new Set(items.map((it) => it.artist.toLowerCase()));
  const missing = WANTED.filter((a) => !have.has(a.toLowerCase()));
  console.log(`Already have ${items.length} items. Missing ${missing.length} artists.`);
  console.log(`Discogs auth: ${TOKEN ? "token" : "anonymous (25/min limit)"}`);

  const existingIds = new Set(items.map((it) => it.id));
  let added = 0;

  for (const artist of missing) {
    process.stdout.write(`${artist}: `);
    try {
      const hit = await findRelease(artist);
      if (!hit) {
        console.log("skipped (no 2024+ release with cover)");
        await new Promise((r) => setTimeout(r, TOKEN ? 1100 : 2500));
        continue;
      }
      const { detail, primaryImage } = hit;
      const title = detail.title || "";
      const released = detail.released || (detail.year ? `${detail.year}-01-01` : "");
      const labelName = (detail.labels || [])[0]?.name || "";
      const type = classifyType(detail);
      const tag = (detail.genres || [])[0] || (detail.styles || [])[0] || "";
      const s = searchUrls(artist, title);
      let id = `${slugify(artist)}-${slugify(title)}`.slice(0, 80);
      if (existingIds.has(id)) id = `${id}-d`;
      existingIds.add(id);
      const rec = {
        id,
        type,
        artist,
        title,
        label: labelName,
        releaseDate: released.slice(0, 10) || `${MIN_YEAR}-01-01`,
        description: "",
        tags: tag ? [tag.toLowerCase()] : [],
        links: {
          bandcamp: s.bandcamp,
          spotify: s.spotify,
          soundcloud: s.soundcloud,
          youtube: s.youtube,
        },
        embed: null,
        musicVideoUrl: null,
        status: "pending",
        approvedAt: null,
        coverImageUrl: primaryImage,
        cover: { bg: "#111110", fg: "#f2efe8", motif: "disc" },
      };
      items.push(rec);
      added++;
      console.log(`ok - ${title} (${released.slice(0, 10)}, ${labelName || "no label"})`);
    } catch (e) {
      console.log(`error: ${e.message}`);
    }
    // Politeness: Discogs ~25 req/min without token = 2.5s between iterations
    await new Promise((r) => setTimeout(r, TOKEN ? 1100 : 2500));
  }

  items.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
  console.log(`\nAdded ${added} records. Total: ${items.length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
