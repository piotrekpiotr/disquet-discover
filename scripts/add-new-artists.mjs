#!/usr/bin/env node
/**
 * Additive pass: fetch one fresh release per NEW artist from iTunes first
 * (great cover art + embed-ready Apple Music IDs), falling back to Discogs
 * for artists iTunes can't find (niche labels: 3XL, West Mineral, Motion Ward,
 * Ilian Tape).
 *
 * Reads data/recommendations.json, figures out which artists from the
 * ARTISTS_TO_ADD list are not yet present, fetches one release per missing
 * artist, appends it with status="pending" so the admin flow stays intact.
 *
 * Sources:
 *  - iTunes Search API (free, no auth, best images)
 *  - Discogs database API (free; set DISCOGS_TOKEN to raise rate limit)
 *
 * No AI, no external secrets required.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ARTISTS as ARTISTS_TO_ADD } from "./monitoring.mjs";

const FILE = path.resolve("data/recommendations.json");
const MIN_DATE = "2024-01-01";
const UA = "disquet-discover/1.0 +local";
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || "";

function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
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

function pickType(r) {
  const raw = r.collectionName || r.trackName || "";
  if (/-\s*Single$/i.test(raw)) return "single";
  if (/-\s*EP$/i.test(raw)) return "ep";
  if (r.trackCount && r.trackCount <= 3) return "single";
  if (r.trackCount && r.trackCount <= 6) return "ep";
  return "album";
}

function cleanTitle(raw) {
  return (raw || "")
    .replace(/\s*-\s*Single$/i, "")
    .replace(/\s*-\s*EP$/i, "")
    .trim();
}

function artworkLarge(url) {
  if (!url) return null;
  return url.replace(/\/\d+x\d+(bb)?\./, "/600x600bb.");
}

async function itunesFreshest(artist) {
  // Get albums (including EPs and singles as subset) and tracks
  const buckets = [];
  for (const entity of ["album", "musicTrack"]) {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
      artist,
    )}&entity=${entity}&limit=25&media=music&attribute=artistTerm`;
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) continue;
    const json = await res.json();
    const mine = (json.results || []).filter(
      (r) => (r.artistName || "").toLowerCase().trim() === artist.toLowerCase().trim(),
    );
    buckets.push(...mine);
  }
  const seen = new Set();
  const unique = [];
  for (const r of buckets) {
    const key = r.collectionId || r.trackId;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  const fresh = unique
    .filter((r) => (r.releaseDate || "").slice(0, 10) >= MIN_DATE)
    .sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || ""));
  return fresh[0] || null;
}

async function dg(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") || "5");
    await new Promise((r) => setTimeout(r, retry * 1000));
    return dg(url);
  }
  if (!res.ok) throw new Error(`Discogs ${res.status}`);
  return res.json();
}

function discogsAuthQS() {
  return DISCOGS_TOKEN ? `&token=${encodeURIComponent(DISCOGS_TOKEN)}` : "";
}

function nameMatches(artist, result) {
  const before = (result.title || "").split(" - ")[0].replace(/\*+$/, "").trim().toLowerCase();
  return before === artist.toLowerCase();
}

async function discogsFreshest(artist) {
  const qs = `q=${encodeURIComponent(
    artist,
  )}&type=release&sort=year&sort_order=desc&per_page=50${discogsAuthQS()}`;
  const j = await dg(`https://api.discogs.com/database/search?${qs}`);
  const results = (j.results || []).filter(
    (r) => nameMatches(artist, r) && (r.year || 0) >= Number(MIN_DATE.slice(0, 4)),
  );
  if (!results.length) return null;
  results.sort((a, b) => {
    const ay = a.year || 0;
    const by = b.year || 0;
    if (by !== ay) return by - ay;
    const aa = a.cover_image && !a.cover_image.endsWith("/spacer.gif") ? 1 : 0;
    const bb = b.cover_image && !b.cover_image.endsWith("/spacer.gif") ? 1 : 0;
    return bb - aa;
  });
  for (const r of results.slice(0, 5)) {
    try {
      const detail = await dg(`${r.resource_url}?${discogsAuthQS().slice(1)}`);
      const primary =
        (detail.images || []).find((im) => im.type === "primary")?.uri ||
        (detail.images || [])[0]?.uri ||
        null;
      if (!primary) continue;
      return { detail, primaryImage: primary };
    } catch {
      // try next
    }
  }
  return null;
}

function classifyDiscogs(release) {
  const formats = (release.formats || []).flatMap((f) =>
    [f.name, ...(f.descriptions || [])].map((s) => (s || "").toLowerCase()),
  );
  if (formats.some((f) => /single/.test(f))) return "single";
  if (formats.some((f) => /\bep\b/.test(f))) return "ep";
  const tc = (release.tracklist || []).length;
  if (tc && tc <= 3) return "single";
  if (tc && tc <= 6) return "ep";
  return "album";
}

function normalizeDate(s) {
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replace(/-00$/, "-01");
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  return s.slice(0, 10).replace(/-00$/, "-01");
}

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  const have = new Set(items.map((it) => it.artist.toLowerCase()));
  const existingIds = new Set(items.map((it) => it.id));
  const missing = ARTISTS_TO_ADD.filter((a) => !have.has(a.toLowerCase()));
  console.log(`Adding ${missing.length} of ${ARTISTS_TO_ADD.length} artists (skipping already-present).`);

  let added = 0;
  for (const artist of missing) {
    process.stdout.write(`${artist}: `);
    let rec = null;
    // 1) iTunes first
    try {
      const hit = await itunesFreshest(artist);
      if (hit) {
        const rawTitle = hit.collectionName || hit.trackName || "";
        const title = cleanTitle(rawTitle);
        const type = pickType(hit);
        const art = artworkLarge(hit.artworkUrl100 || hit.artworkUrl60);
        const apple = (hit.collectionViewUrl || hit.trackViewUrl || "").split("?")[0];
        const collectionId = hit.collectionId;
        const s = searchUrls(artist, title);
        let id = `${slugify(artist)}-${slugify(title)}`.slice(0, 80);
        if (existingIds.has(id)) id = `${id}-n`;
        existingIds.add(id);
        rec = {
          id,
          type,
          artist,
          title,
          label: "",
          releaseDate: (hit.releaseDate || "").slice(0, 10),
          description: "",
          tags: hit.primaryGenreName ? [hit.primaryGenreName.toLowerCase()] : [],
          links: {
            apple,
            bandcamp: s.bandcamp,
            spotify: s.spotify,
            soundcloud: s.soundcloud,
            youtube: s.youtube,
          },
          embed: collectionId
            ? {
                provider: "apple",
                src: `https://embed.music.apple.com/us/album/${collectionId}?theme=light`,
                height: 450,
              }
            : null,
          musicVideoUrl: null,
          status: "pending",
          approvedAt: null,
          coverImageUrl: art || null,
          cover: { bg: "#111110", fg: "#f2efe8", motif: "disc" },
        };
        console.log(`itunes ok - ${title}`);
      }
    } catch (e) {
      console.log(`itunes err: ${e.message}`);
    }

    // 2) Discogs fallback if iTunes didn't find it
    if (!rec) {
      try {
        const hit = await discogsFreshest(artist);
        if (hit) {
          const { detail, primaryImage } = hit;
          const title = detail.title || "";
          const type = classifyDiscogs(detail);
          const labelName = (detail.labels || [])[0]?.name || "";
          const tag = (detail.genres || [])[0] || (detail.styles || [])[0] || "";
          const s = searchUrls(artist, title);
          let id = `${slugify(artist)}-${slugify(title)}`.slice(0, 80);
          if (existingIds.has(id)) id = `${id}-d`;
          existingIds.add(id);
          rec = {
            id,
            type,
            artist,
            title,
            label: labelName,
            releaseDate: normalizeDate(detail.released || String(detail.year || "")) || `${MIN_DATE}`,
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
          console.log(`discogs ok - ${title}`);
        } else {
          console.log("skipped (no 2024+ release with cover)");
        }
      } catch (e) {
        console.log(`discogs err: ${e.message}`);
      }
      // polite delay for Discogs
      await new Promise((r) => setTimeout(r, DISCOGS_TOKEN ? 1100 : 2500));
    } else {
      // iTunes pass - quick politeness delay
      await new Promise((r) => setTimeout(r, 250));
    }

    if (rec) {
      items.push(rec);
      added++;
      // progressive save
      items.sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || ""));
      await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
    }
  }

  console.log(`\nAdded ${added} records. Total now: ${items.length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
