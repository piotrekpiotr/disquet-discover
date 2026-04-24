#!/usr/bin/env node
/**
 * Pull recent releases per label from Discogs, extending the catalogue with
 * records the per-artist sync can't find because the artist isn't in our
 * pool yet. This is how we catch a new Modern Love / 3XL / West Mineral
 * release from an unknown name.
 *
 * For each label in scripts/monitoring.mjs:
 *   1. Search Discogs releases by label, sorted newest-first.
 *   2. Filter to year >= MIN_YEAR.
 *   3. For the top N results per label that have a primary image and aren't
 *      already in data/recommendations.json, fetch the release detail and
 *      append as status="pending" (so admin approves/rejects).
 *   4. Also collect new artist names into data/label-candidate-artists.json
 *      so you can decide which should graduate into monitoring.mjs ARTISTS.
 *
 * Rate limits: Discogs = 25 req/min anonymous, 60 with DISCOGS_TOKEN.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { LABELS as BASE_LABELS } from "./monitoring.mjs";
import { fetchMonitoringExtras, mergeUnique } from "./fetch-extras.mjs";

const FILE = path.resolve("data/recommendations.json");
const CANDIDATES_FILE = path.resolve("data/label-candidate-artists.json");
const MIN_YEAR = 2024;
// Per-label cap. Previously 2, which meant a label dropping three records
// in one week could only surface two of them that day. We now scan ALL
// of a label's recent releases — the curator already has status filters
// at /admin to manage throughput. An escape-hatch env var is kept for
// local debug runs where you might want to limit traffic to Discogs.
const PER_LABEL_LIMIT = Number(process.env.SYNC_LABELS_PER_LABEL_LIMIT || 20);
// Global cap removed (was MAX_NEW_TOTAL=25). The old cap + shuffle hack
// meant labels near the back of the shuffled list were systematically
// missed on a big release week. Now we scan every label in the pool
// every run; the cap-at-curator-level belongs in /admin's filters, not
// here. Env var retained for local debug only; defaults to Infinity.
const MAX_NEW_TOTAL = Number(process.env.SYNC_LABELS_MAX_NEW || Infinity);
const UA = "disquet-discover/1.0 +local";
const TOKEN = process.env.DISCOGS_TOKEN || "";

// Cross-reference source: The Quietus. When the site is writing about an
// artist, it's a signal the release is worth extra attention — we tag any
// matching record with `pressMentions: ["quietus"]` so the admin UI can
// highlight it. This is best-effort: if the feed can't be fetched we fall
// back to `""` (empty string) and no records get boosted that run.
const QUIETUS_RSS = "https://thequietus.com/feed";

async function fetchQuietusText() {
  try {
    const res = await fetch(QUIETUS_RSS, { headers: { "User-Agent": UA } });
    if (!res.ok) return "";
    const xml = await res.text();
    // Cheap parse: we only need substring containment, not proper XML. Strip
    // tags and CDATA markers, lower-case, collapse whitespace.
    return xml
      .replace(/<!\[CDATA\[|\]\]>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Returns an array of press sources that mention this artist/title, or [] if
 * none. Matching is deliberately loose (case-insensitive substring) because
 * press spells artists inconsistently. False positives here are harmless —
 * the admin still has final say.
 */
function pressMentionsFor(artist, title, quietusText) {
  const out = [];
  if (quietusText && artist && artist.length >= 3) {
    if (quietusText.includes(artist.toLowerCase())) out.push("quietus");
  }
  return out;
}

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function authQS() {
  return TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : "";
}

async function dg(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") || "5");
    await new Promise((r) => setTimeout(r, retry * 1000));
    return dg(url);
  }
  if (!res.ok) throw new Error(`Discogs ${res.status} on ${url}`);
  return res.json();
}

function classifyType(release) {
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

function searchUrls(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return {
    bandcamp: `https://bandcamp.com/search?q=${q}&item_type=a`,
    spotify: `https://open.spotify.com/search/${q}`,
    soundcloud: `https://soundcloud.com/search?q=${encodeURIComponent(`${artist} ${title}`)}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
  };
}

/**
 * Pull the most recent N releases for a given label.
 */
async function releasesForLabel(labelName) {
  const qs = `label=${encodeURIComponent(
    labelName,
  )}&type=release&sort=year&sort_order=desc&per_page=30${authQS()}`;
  const j = await dg(`https://api.discogs.com/database/search?${qs}`);
  return (j.results || []).filter((r) => (r.year || 0) >= MIN_YEAR);
}

function parseArtistAndTitle(result) {
  // Search result titles are "Artist - Title", sometimes with multiple
  // artists joined by " & " or " / ".
  const [a = "", ...rest] = (result.title || "").split(" - ");
  const title = rest.join(" - ").trim();
  const artist = a.replace(/\*+$/, "").trim();
  return { artist, title };
}

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  const existingIds = new Set(items.map((it) => it.id));
  const existingKey = new Set(
    items.map((it) => `${it.artist.toLowerCase()}|${it.title.toLowerCase()}`),
  );

  // Fetch the press feed once, up front. If it fails we keep going with an
  // empty string; pressMentionsFor() will just return [] for every record.
  const quietusText = await fetchQuietusText();
  if (quietusText) {
    console.log(`Fetched Quietus feed (${quietusText.length} chars of text).`);
  } else {
    console.log("Quietus feed unavailable; continuing without press signal.");
  }

  /** @type {Record<string,{seenOn:string[], titleExamples:string[]}>} */
  const candidateArtists = {};
  // load existing candidates so we accumulate across runs
  try {
    const prev = JSON.parse(await fs.readFile(CANDIDATES_FILE, "utf8"));
    Object.assign(candidateArtists, prev);
  } catch {
    // first run, file doesn't exist yet
  }

  // Merge hardcoded LABELS with curator-added extras from the live site.
  // Same contract as sync-itunes: /api/monitoring-extras failure falls
  // back gracefully to the hardcoded base list.
  const extras = await fetchMonitoringExtras();
  const LABELS = mergeUnique(BASE_LABELS, extras.labels);
  if (LABELS.length > BASE_LABELS.length) {
    console.log(
      `Merged ${LABELS.length - BASE_LABELS.length} curator-added label(s) into run.`,
    );
  }

  // Historical note: we used to shuffle label order because the old
  // MAX_NEW_TOTAL=25 global cap meant ~6 labels per run would eat the
  // quota and everything after them got starved — shuffling gave each
  // label roughly equal odds over a week. With the cap removed we scan
  // every label every run, so shuffling isn't load-bearing anymore. We
  // keep it anyway so that when Discogs does throttle mid-run, the
  // labels that got cut off rotate each day instead of always being the
  // same ones at the bottom of the list.
  const shuffled = [...LABELS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  let addedTotal = 0;
  let hitCap = false;
  for (const label of shuffled) {
    if (hitCap) break; // global cap already reached
    process.stdout.write(`${label}: `);
    let addedForThisLabel = 0;
    try {
      const results = await releasesForLabel(label);
      for (const r of results) {
        if (addedForThisLabel >= PER_LABEL_LIMIT) break;
        const { artist, title } = parseArtistAndTitle(r);
        if (!artist || !title) continue;
        const key = `${artist.toLowerCase()}|${title.toLowerCase()}`;
        if (existingKey.has(key)) continue;

        // Fetch release detail to get cover + full date
        let detail;
        try {
          detail = await dg(`${r.resource_url}?${authQS().slice(1)}`);
        } catch {
          continue;
        }
        // accumulate candidate artist stats regardless of whether we add the record
        if (!candidateArtists[artist]) {
          candidateArtists[artist] = { seenOn: [], titleExamples: [] };
        }
        if (!candidateArtists[artist].seenOn.includes(label)) {
          candidateArtists[artist].seenOn.push(label);
        }
        if (candidateArtists[artist].titleExamples.length < 3) {
          candidateArtists[artist].titleExamples.push(title);
        }

        const primary =
          (detail.images || []).find((im) => im.type === "primary")?.uri ||
          (detail.images || [])[0]?.uri ||
          null;
        if (!primary) continue;

        const released = normalizeDate(detail.released || String(detail.year || ""));
        const type = classifyType(detail);
        const tag = (detail.genres || [])[0] || (detail.styles || [])[0] || "";
        const s = searchUrls(artist, title);
        let id = `${slugify(artist)}-${slugify(title)}`.slice(0, 80);
        if (existingIds.has(id)) id = `${id}-l`;
        if (existingIds.has(id)) continue;
        existingIds.add(id);
        existingKey.add(key);

        const mentions = pressMentionsFor(artist, title, quietusText);

        items.push({
          id,
          type,
          artist,
          title,
          label: (detail.labels || [])[0]?.name || label,
          releaseDate: released || `${MIN_YEAR}-01-01`,
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
          coverImageUrl: primary,
          cover: { bg: "#111110", fg: "#f2efe8", motif: "disc" },
          // Non-empty when another trusted source has also been writing about
          // the artist. Admin UI uses this to highlight high-signal records.
          pressMentions: mentions,
        });
        addedForThisLabel++;
        addedTotal++;

        if (addedTotal >= MAX_NEW_TOTAL) {
          hitCap = true;
          break; // stop processing this label's results
        }

        // polite delay between detail fetches
        await new Promise((r2) => setTimeout(r2, TOKEN ? 1100 : 2500));
      }
      console.log(addedForThisLabel ? `+${addedForThisLabel}` : "no new");
    } catch (e) {
      console.log(`err: ${e.message}`);
    }
    // polite delay between label searches
    await new Promise((r) => setTimeout(r, TOKEN ? 1100 : 2500));
    // progressive save so long runs aren't lost on crash
    items.sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || ""));
    await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
    await fs.writeFile(CANDIDATES_FILE, JSON.stringify(candidateArtists, null, 2), "utf8");
  }

  console.log(
    `\nAdded ${addedTotal} records across ${LABELS.length} labels` +
      (hitCap ? ` (capped at ${MAX_NEW_TOTAL}).` : "."),
  );
  console.log(
    `Candidate artists discovered: ${Object.keys(candidateArtists).length}. ` +
      `See data/label-candidate-artists.json - promote the good ones into monitoring.mjs.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
