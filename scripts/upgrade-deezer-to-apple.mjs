#!/usr/bin/env node
/**
 * Promote Deezer-embed records to Apple Music when iTunes can match them.
 *
 * Backstory: backfill-embeds.mjs picks Apple first, then falls back to
 * Deezer when iTunes returned nothing. The "nothing" case was sometimes
 * iTunes throttling the runner, not a genuine miss — those records ended
 * up with a Deezer player permanently, even though Apple had the album
 * all along. Curator-side, Deezer is the least-loved player ("only as a
 * very last resort"), so this script revisits every Deezer-embedded
 * record on a fresh runner / IP and tries iTunes again.
 *
 * Behaviour:
 *   - For every record whose embed.provider === "deezer", run the same
 *     iTunes loose-match used by backfill-embeds.mjs.
 *   - On a confident hit, replace the embed with the Apple equivalent
 *     and upgrade links.apple to the real collectionViewUrl when the
 *     stored value is still a /search URL.
 *   - On a miss, leave the Deezer embed alone — Deezer beats no player.
 *
 * Progressive save per record so a crash partway through is cheap.
 *
 * Idempotent: only touches deezer-provider records. Re-running after a
 * successful pass is a no-op for everything that got upgraded.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/recommendations.json");
const UA = "disquet-discover/1.0 +deezer-to-apple";

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s) {
  return normalize(s).split(/\s+/).filter(Boolean);
}

function stripDiscogsSuffix(name) {
  return (name || "").replace(/\s*\(\d+\)\s*$/, "").trim();
}

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

/**
 * Same loose-match as backfill-embeds.mjs. Kept inline (rather than
 * imported) so this script stays a self-contained one-shot we can also
 * wire into the daily workflow without changing module shapes.
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
        a.yearPenalty - b.yearPenalty || b.aSim + b.tSim - (a.aSim + a.tSim),
    );
  const hit = candidates[0]?.r;
  if (!hit || !hit.collectionId) return null;
  return {
    collectionId: hit.collectionId,
    collectionViewUrl: hit.collectionViewUrl || null,
  };
}

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  let upgraded = 0;
  let kept = 0;
  let scanned = 0;

  for (const item of items) {
    if (!item.embed || item.embed.provider !== "deezer") continue;
    scanned++;

    process.stdout.write(`${item.artist} - ${item.title}: `);
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
        upgraded++;
        console.log(`apple:${it.collectionId}`);
        await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
      } else {
        kept++;
        console.log("kept deezer");
      }
    } catch (e) {
      kept++;
      console.log(`itunes err(${e.message}) - kept deezer`);
    }
    // Polite delay — iTunes 403s when bursted.
    await polite(400);
  }

  console.log(
    `\nScanned ${scanned} deezer embeds. Upgraded to apple: ${upgraded}. Kept on deezer: ${kept}.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
