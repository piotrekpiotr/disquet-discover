#!/usr/bin/env node
/**
 * Enrichment pass - no AI, just reliable metadata lookups:
 *
 * 1. For every record with empty `label`, query Discogs to backfill it
 *    (iTunes Search doesn't return labels, Discogs does).
 * 2. For every record without `embed`, query iTunes Search for a matching
 *    album/single. If the iTunes `collectionId` is present, set
 *    embed.provider="apple" and embed.src to the Apple Music iframe embed URL.
 *    Apple Music embeds work without auth and render a theme-aware player.
 *    This also populates `links.apple` to the real collectionViewUrl so the
 *    "Apple Music" link stops being missing.
 *
 * Progressive save so a crash doesn't lose work.
 * Set DISCOGS_TOKEN to raise the Discogs rate limit from 25/min to 60/min.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/recommendations.json");
const UA = "disquet-discover/1.0 +local";
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || "";

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function dg(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") || "3");
    await new Promise((r) => setTimeout(r, retry * 1000));
    return dg(url);
  }
  if (!res.ok) throw new Error(`Discogs ${res.status}`);
  return res.json();
}

function discogsAuthQS() {
  return DISCOGS_TOKEN ? `&token=${encodeURIComponent(DISCOGS_TOKEN)}` : "";
}

async function findDiscogsLabel(item) {
  const q = encodeURIComponent(`${item.artist} ${item.title}`);
  const search = await dg(
    `https://api.discogs.com/database/search?q=${q}&type=release&per_page=25${discogsAuthQS()}`,
  );
  const nA = normalize(item.artist);
  const nT = normalize(item.title);
  const yr = Number((item.releaseDate || "").slice(0, 4));
  const candidates = (search.results || [])
    .map((r) => {
      const [a = "", t = ""] = (r.title || "").split(" - ");
      const nRa = normalize(a.replace(/\*+$/, ""));
      const nRt = normalize(t);
      const artistMatch = nRa === nA || nRa.startsWith(nA) || nA.startsWith(nRa);
      const titleOverlap = nT && nRt && (nRt.includes(nT) || nT.includes(nRt));
      const yearPenalty = yr && r.year ? Math.abs(r.year - yr) : 0;
      return { r, ok: artistMatch && titleOverlap, yearPenalty };
    })
    .filter((c) => c.ok)
    .sort((a, b) => a.yearPenalty - b.yearPenalty);

  for (const c of candidates.slice(0, 3)) {
    try {
      const detail = await dg(`${c.r.resource_url}?${discogsAuthQS().slice(1)}`);
      const label = (detail.labels || [])[0]?.name;
      if (label) return label;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Search iTunes for a release. Returns { collectionId, collectionViewUrl } or null.
 * We prefer an exact title match (case-insensitive, after normalization).
 */
async function findItunesAlbum(item) {
  const term = encodeURIComponent(`${item.artist} ${item.title}`);
  const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=album&limit=25`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const j = await res.json();
  const nA = normalize(item.artist);
  const nT = normalize(item.title);
  const hit = (j.results || []).find((r) => {
    const ra = normalize(r.artistName);
    const rt = normalize(r.collectionName);
    return (ra === nA || ra.startsWith(nA)) && (rt === nT || rt.includes(nT) || nT.includes(rt));
  });
  if (!hit || !hit.collectionId) return null;
  return {
    collectionId: hit.collectionId,
    collectionViewUrl: hit.collectionViewUrl || null,
  };
}

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  let labelled = 0;
  let embedded = 0;

  for (const item of items) {
    const needsLabel = !item.label || !item.label.trim();
    const needsEmbed = !item.embed;

    if (!needsLabel && !needsEmbed) continue;

    process.stdout.write(`${item.artist} - ${item.title}: `);
    const parts = [];

    if (needsLabel) {
      try {
        const lbl = await findDiscogsLabel(item);
        if (lbl) {
          item.label = lbl;
          labelled++;
          parts.push(`label=${lbl}`);
        } else {
          parts.push("label=not found");
        }
      } catch (e) {
        parts.push(`discogs err (${e.message})`);
      }
      // polite delay for Discogs
      await new Promise((r) => setTimeout(r, DISCOGS_TOKEN ? 1100 : 2500));
    }

    if (needsEmbed) {
      try {
        const it = await findItunesAlbum(item);
        if (it) {
          // Apple Music album embeds handle singles fine (album/{id} renders a
          // 1-track collection with play/pause visible), so use 450 uniformly -
          // it's Apple's recommended size and keeps the pause button on screen
          // without scrolling inside the iframe.
          item.embed = {
            provider: "apple",
            src: `https://embed.music.apple.com/us/album/${it.collectionId}?theme=light`,
            height: 450,
          };
          if (it.collectionViewUrl && (!item.links.apple || item.links.apple.includes("/search"))) {
            item.links = { ...item.links, apple: it.collectionViewUrl };
          }
          embedded++;
          parts.push(`embed=apple:${it.collectionId}`);
        } else {
          parts.push("embed=not found");
        }
      } catch (e) {
        parts.push(`itunes err (${e.message})`);
      }
      // polite delay for iTunes
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log(parts.join(", "));
    // Progressive save
    await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
  }

  console.log(`\nBackfilled ${labelled} labels, ${embedded} embeds.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
