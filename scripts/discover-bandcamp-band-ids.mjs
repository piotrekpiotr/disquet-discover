#!/usr/bin/env node
/**
 * One-shot helper: auto-discover Bandcamp band_id for every label in
 * monitoring.mjs that doesn't already have one in LABEL_BANDCAMP_BAND_IDS.
 *
 * Why: the bandcamp-label source needs each label's numeric band_id
 * to query Bandcamp's mobile-app API. Looking those up manually for
 * 80 labels is tedious. This script tries common slug variants for
 * each label, extracts the band_id from any subdomain that resolves,
 * and prints map-entry suggestions the curator can paste into
 * LABEL_BANDCAMP_BAND_IDS.
 *
 * Strategy per label:
 *   1. Build candidate slugs:
 *        - lowercase + alphanumerics only ("AD 93" → "ad93")
 *        - lowercase + dashes ("AD 93" → "ad-93")
 *        - the alphanumeric form + "records" suffix
 *        - lowercase first-word only (drops ", The")
 *   2. For each candidate, GET https://<slug>.bandcamp.com/?action=2
 *      (action=2 redirects label homepages to /music; for non-labels
 *      it just shows the homepage).
 *   3. If 200, search the HTML for the label's own band_id. Bandcamp
 *      embeds it in a few places — `data-band-id` on the wrapper,
 *      and various JSON blobs. We anchor on `band_id":<digits>` near
 *      the page's `BandData` block.
 *   4. Print one line per discovered label.
 *
 * Usage:
 *   node scripts/discover-bandcamp-band-ids.mjs
 *
 * Output is plain text — copy any lines you trust into the map in
 * monitoring.mjs. The script does NOT auto-modify monitoring.mjs;
 * curator review is intentional because slug collisions can produce
 * wrong matches (e.g. "youth" could resolve to a non-label band).
 */
import {
  LABELS as BASE_LABELS,
  LABEL_BANDCAMP_BAND_IDS,
} from "./monitoring.mjs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PER_REQ_MS = 400; // polite spacing across attempts

function candidateSlugsFor(name) {
  const lower = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const alnum = lower.replace(/[^a-z0-9]/g, "");
  const dashed = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const firstWord = (lower.split(/\s+/)[0] || "").replace(/[^a-z0-9]/g, "");
  const candidates = new Set([alnum, dashed, alnum + "records", firstWord]);
  // Drop empties and 1-char slugs that Bandcamp definitely doesn't use.
  return [...candidates].filter((s) => s && s.length >= 2);
}

async function probe(slug) {
  try {
    const res = await fetch(`https://${slug}.bandcamp.com/`, {
      headers: { "User-Agent": UA },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Look for the page's primary band_id. Three patterns Bandcamp
    // uses, in priority order:
    //
    //   1. `?label=<id>` URL parameter — appears on label pages on
    //      release-card hrefs and in band_data JSON
    //   2. `BandData` JSON blob: `"band_id":<digits>` — present on
    //      the homepage
    //   3. `data-band-id="<id>"` attribute on the page wrapper
    const labelParam = html.match(/[?&]label=(\d+)/);
    if (labelParam) return Number(labelParam[1]);
    const bandData = html.match(/"band_id"\s*:\s*(\d+)/);
    if (bandData) return Number(bandData[1]);
    const dataAttr = html.match(/\bdata-band-id="(\d+)"/);
    if (dataAttr) return Number(dataAttr[1]);
    return null;
  } catch {
    return null;
  }
}

async function main() {
  const todo = BASE_LABELS.filter((name) => !LABEL_BANDCAMP_BAND_IDS[name]);
  console.log(
    `Discovering band_ids for ${todo.length} labels not yet in map ` +
      `(${BASE_LABELS.length - todo.length} already configured).\n`,
  );

  const found = [];
  const missed = [];
  for (const name of todo) {
    const slugs = candidateSlugsFor(name);
    let hit = null;
    let hitSlug = "";
    for (const slug of slugs) {
      const id = await probe(slug);
      if (id) {
        hit = id;
        hitSlug = slug;
        break;
      }
      await new Promise((r) => setTimeout(r, PER_REQ_MS));
    }
    if (hit) {
      console.log(`  "${name}": ${hit}, // ${hitSlug}.bandcamp.com`);
      found.push({ name, id: hit, slug: hitSlug });
    } else {
      console.log(`  // "${name}": <no match — tried ${slugs.join(", ")}>`);
      missed.push(name);
    }
    await new Promise((r) => setTimeout(r, PER_REQ_MS));
  }

  console.log(
    `\nFound ${found.length}/${todo.length}. Paste the lines above into ` +
      `LABEL_BANDCAMP_BAND_IDS in scripts/monitoring.mjs (review each — ` +
      `slug-name collisions can match an unrelated band). Missed labels (${missed.length}) ` +
      `are listed as commented-out lines for reference.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
