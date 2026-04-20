#!/usr/bin/env node
/**
 * Festival roster scraper. For each festival in scripts/monitoring.mjs,
 * fetches the lineup page HTML, extracts candidate artist names, and
 * cross-references against the current ARTISTS monitoring list.
 *
 * Anything unknown is written to data/festival-suggestions.json with context
 * (which festival, which page). Nothing is auto-added to the site; this is
 * a suggestion feed for you to review and promote into monitoring.mjs.
 *
 * Heuristic: lineup pages are usually flat lists of artist names. We extract
 * text from <li>, <h1>-<h6>, and anchor tags, then filter to strings that
 * look like artist names (reasonable length, alphanumeric, not full
 * sentences). It's not perfect - use the output as a starting point, not
 * ground truth.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { FESTIVALS, ARTISTS } from "./monitoring.mjs";

const OUT = path.resolve("data/festival-suggestions.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36 disquet-discover/1.0";

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const KNOWN = new Set(ARTISTS.map((a) => normalize(a)));

/**
 * Very loose HTML → text extractor. Strips tags and keeps the raw text
 * content inside list items, headings, and anchors. Good enough for a
 * suggestion feed; falls over gracefully on exotic markup.
 */
function extractCandidates(html) {
  const out = new Set();
  const patterns = [
    /<(?:li|h[1-6]|a|p|span)\b[^>]*>([^<]{2,80})<\/(?:li|h[1-6]|a|p|span)>/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      let t = (m[1] || "")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/g, " ")
        .replace(/&[a-z]+;/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!t) continue;
      // Filter: looks like an artist name, not a sentence.
      if (t.length < 2 || t.length > 60) continue;
      if (/[.!?](?:\s|$)/.test(t)) continue; // contains sentence punctuation
      if (/\b(the|and|or|with|of)\b.*\b(the|and|or|with|of)\b/i.test(t)) continue; // sentence-y
      if (/\d{4}/.test(t) && !/^[A-Za-z0-9\s&'.,()\-/]+$/.test(t)) continue;
      if (/(cookie|privacy|terms|subscribe|newsletter|menu|login|search)/i.test(t)) continue;
      if (/^[\d\s.,:-]+$/.test(t)) continue; // pure numeric
      out.add(t);
    }
  }
  return [...out];
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function main() {
  /** @type {Record<string, { festival: string, location: string, url: string, seenAt: string, candidates: string[] }>} */
  const suggestions = {};
  try {
    Object.assign(suggestions, JSON.parse(await fs.readFile(OUT, "utf8")));
  } catch {
    // first run
  }

  for (const fest of FESTIVALS) {
    process.stdout.write(`${fest.name} (${fest.url}): `);
    try {
      const html = await fetchPage(fest.url);
      const all = extractCandidates(html);
      const unknown = all.filter((c) => !KNOWN.has(normalize(c)));
      // Dedupe within this festival run, keep original casing.
      const seen = new Set();
      const unique = [];
      for (const c of unknown) {
        const k = normalize(c);
        if (seen.has(k)) continue;
        seen.add(k);
        unique.push(c);
      }
      suggestions[fest.name] = {
        festival: fest.name,
        location: fest.location,
        url: fest.url,
        seenAt: new Date().toISOString(),
        candidates: unique.slice(0, 200), // cap noise
      };
      console.log(`${unique.length} candidate strings (capped to 200)`);
    } catch (e) {
      console.log(`failed: ${e.message}`);
      suggestions[fest.name] = {
        festival: fest.name,
        location: fest.location,
        url: fest.url,
        seenAt: new Date().toISOString(),
        candidates: [],
        error: e.message,
      };
    }
  }

  await fs.writeFile(OUT, JSON.stringify(suggestions, null, 2), "utf8");
  console.log(
    `\nWrote ${OUT}. Review the lists; promote real artists into monitoring.mjs ARTISTS.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
