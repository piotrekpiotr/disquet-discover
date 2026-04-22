#!/usr/bin/env node
/**
 * Generate short, original recommendations for every record, grounded in
 * verified Discogs metadata (label, styles, genres, tracklist, format).
 *
 *   1. For each record in data/recommendations.json without a description
 *      (or every record with a description, if --force is passed),
 *      look it up on Discogs (search + detail) to collect VERIFIED facts.
 *   2. Send those facts to the description LLM with a strict prompt: no
 *      invention, no copying of the Boomkat / Bleep / Juno / RA house voice,
 *      no unverifiable adjectives.
 *   3. Save the description back to the JSON.
 *
 * Flags:
 *   --force                Re-generate even for records that already have
 *                          a description. Use this when you want to refresh
 *                          copy after changing the prompt.
 *   --only-pending         Only process records whose status === "pending".
 *                          Handy for previewing what admin will see before
 *                          any publication.
 *   --limit N              Stop after writing N descriptions.
 *
 * Requires LLM_API_KEY in env.
 * Optional DISCOGS_TOKEN to avoid the 25-req/min Discogs limit.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/recommendations.json");
const UA = "disquet-discover/1.0 +local";
const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || "";
// Accept either name so existing shell setups keep working.
const LLM_KEY = process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.DISQUET_MODEL || "claude-sonnet-4-6";

if (!LLM_KEY) {
  console.error("LLM_API_KEY not set");
  process.exit(1);
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

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Find the best Discogs release match for an item.
 * Returns { styles, genres, label, tracklistLength, format, year, notes } or null.
 */
async function discogsFacts(item) {
  const q = encodeURIComponent(`${item.artist} ${item.title}`);
  const search = await dg(
    `https://api.discogs.com/database/search?q=${q}&type=release&per_page=25${discogsAuthQS()}`,
  );
  const nA = normalize(item.artist);
  const nT = normalize(item.title);
  const yr = Number((item.releaseDate || "").slice(0, 4));
  const candidates = (search.results || [])
    .map((r) => {
      // Discogs search titles are "Artist - Title"
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
      return {
        styles: detail.styles || [],
        genres: detail.genres || [],
        label: (detail.labels || [])[0]?.name || item.label || "",
        tracklistLength: (detail.tracklist || []).length,
        format:
          ((detail.formats || [])[0]?.descriptions || []).join(", ") ||
          (detail.formats || [])[0]?.name ||
          "",
        year: detail.year || yr,
        notes: (detail.notes || "").slice(0, 500),
      };
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Call the description LLM to write a Boomkat-style description from verified
 * metadata. The prompt is strict about not inventing personnel, track names,
 * or claims.
 */
async function writeDescription(item, facts) {
  const meta = {
    artist: item.artist,
    title: item.title,
    format: item.type, // album | ep | single
    label: facts?.label || item.label || "unknown",
    releaseDate: item.releaseDate,
    // iTunes primary-genre tags live on the record from sync-itunes; the
    // write-descriptions run didn't use to surface them, which meant
    // same-day releases with zero Discogs detail also had zero signal
    // for the LLM to anchor on.
    genres: facts?.genres || [],
    styles: facts?.styles || [],
    tags: item.tags || [],
    trackCount: facts?.tracklistLength || null,
    physicalFormat: facts?.format || "",
    // Sparse-metadata flag so the prompt branch that allows leaning on
    // general knowledge of the named artist/label fires for brand-new
    // releases not yet in Discogs. Kept here (and not implicit) so the
    // model sees the explicit permission — fact rules otherwise force a
    // dry "A single from X on Y, out April 2026" recitation.
    metadataSparse:
      !(facts?.genres?.length) &&
      !(facts?.styles?.length) &&
      !(item.tags?.length),
  };

  const system = `You write terse 1-2 sentence music recommendations for Disquet Discover.
Your job is to describe an electronic record for an editorial site. Use the
verified metadata the user provides, and — ONLY for facts that are not
specific to this particular release — you MAY lean on general knowledge of
the named artist's established sonic register and the named label's known
aesthetic. Treat everything about this specific release (tracks, personnel,
tempos, sequence claims) as unverified.

ORIGINALITY RULES:
- DO NOT copy Boomkat / Bleep / Juno / Resident Advisor / Pitchfork sentence structure or signature phrases. No "in which X meets Y", no "hypercolour", no "heavy-lidded", no "pocket symphony", no "spacious low-end", no "mutant / mutoid / liminal / sun-bleached / moss-covered / crystalline". Avoid any adjective pile-up you have seen in a record-shop blurb a hundred times.
- Write in a dry, observational, slightly detached voice - closer to a liner-note than a PR blurb.
- The description must feel like it was written for this site specifically, not reusable copy from another shop.

HARD FACT RULES:
- DO NOT invent producer names, real names, band members, collaborators, tracks, lyrics, samples, studio details, backstories, or specific biographical claims about THIS release.
- DO NOT claim a release is "first", "debut", "return", "comeback", "third LP", "follow-up to X", or give any sequence/ordering claim unless the metadata explicitly states it.
- DO NOT describe specific musical details of THIS release that you cannot verify (exact tempos/BPMs, track names, lyrics, individual track durations, or instrumentation specific to a particular track). You MAY reference the genres/styles/tags that ARE provided OR the sonic register the artist is widely known for (e.g. Purelink's ambient dub, Cinna Peyghamy's tombak-and-synth work).
- DO NOT use em-dashes or en-dashes. Use commas or periods.
- DO NOT start with "A single from X" or "An album from X" — too close to placeholder copy.
- DO suggest "for fans of" with at most ONE well-known contemporary who is widely associated with the SAME LABEL or the same genre cluster. If you are not confident the pairing is public knowledge, omit it.
- Keep it under 280 characters. Two sentences max. Prefer one.

IF METADATA IS SPARSE (no genres, no styles, no tags — common for same-day
releases not yet in Discogs) the user will set metadataSparse: true. In that
case, anchor the description in what is widely known about the artist and
label in public musical discourse, written as observation rather than as a
biographical claim. Do not fabricate a specific storyline for THIS release.`;

  const user = `Write the description for this release. Verified metadata only:

${JSON.stringify(meta, null, 2)}

Output just the description, nothing else.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": LLM_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 220,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`LLM ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = (json.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return text.replace(/\s*[-–]\s*/g, ", ").replace(/\s+/g, " ").trim();
}

/** CLI flag parsing. Keep it tiny; no need for yargs. */
function parseFlags() {
  const args = process.argv.slice(2);
  const flags = { force: false, onlyPending: false, limit: Infinity };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") flags.force = true;
    else if (a === "--only-pending") flags.onlyPending = true;
    else if (a === "--limit") flags.limit = Number(args[++i]) || Infinity;
  }
  return flags;
}

async function main() {
  const flags = parseFlags();
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  let updated = 0;
  for (const item of items) {
    if (updated >= flags.limit) break;
    if (flags.onlyPending && item.status !== "pending") continue;
    // Skip real descriptions unless --force. Previews (from
    // preview-descriptions.mjs) are explicitly considered overwriteable.
    const isPreview = item.descriptionPreview === true;
    if (!flags.force && !isPreview && item.description && item.description.trim().length > 0) continue;
    process.stdout.write(`${item.artist} - ${item.title}: `);
    let facts = null;
    try {
      facts = await discogsFacts(item);
    } catch (e) {
      console.log(`discogs error (${e.message})`);
    }
    // Polite pause for Discogs (anonymous rate limit)
    await new Promise((r) => setTimeout(r, DISCOGS_TOKEN ? 1100 : 2500));
    // Backfill label from Discogs if it's missing (iTunes seed doesn't return labels)
    if (facts?.label && (!item.label || !item.label.trim())) {
      item.label = facts.label;
    }
    try {
      const desc = await writeDescription(item, facts);
      if (desc) {
        item.description = desc;
        // Clear the preview flag once the LLM has written the real copy.
        if (item.descriptionPreview) delete item.descriptionPreview;
        updated++;
        console.log(`ok (${desc.length}ch)`);
      } else {
        console.log("empty");
      }
    } catch (e) {
      console.log(`llm error (${e.message})`);
    }
    // Save progressively so a mid-run crash isn't lost
    await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
  }
  console.log(`\nWrote descriptions for ${updated} records.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
