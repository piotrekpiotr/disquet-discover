#!/usr/bin/env node
/**
 * Pass over every description:
 *  - replaces every em-dash / en-dash with a comma (or period where appropriate)
 *  - fixes the Djrum/Fenton factual error (Djrum is Felix Manuel)
 *  - trims trailing whitespace
 *  - decodes leftover HTML entities (&amp;)
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/recommendations.json");

function clean(desc) {
  let d = desc;
  // HTML entity leftovers from earlier seed
  d = d.replace(/&amp;/g, "&");
  // Replace em-dash / en-dash: if between two clauses → ", "; if inline parenthetical → ", "
  d = d.replace(/\s*[-–]\s*/g, ", ");
  // Collapse double commas
  d = d.replace(/, ,/g, ", ").replace(/,,/g, ",");
  // Avoid comma-right-before-period artifacts
  d = d.replace(/,\s*\./g, ".");
  return d.trim();
}

function fixSpecific(item) {
  if (item.id === "djrum-portrait") {
    item.description =
      "Felix Manuel's first single of the year stretches a piano motif over rolling 160bpm percussion, the kind of track that sounds different at every BPM you re-pitch it to. For fans of Loraine James and Pessimist.";
  }
  return item;
}

async function main() {
  const raw = await fs.readFile(FILE, "utf8");
  const items = JSON.parse(raw);
  for (const it of items) {
    if (it.description) it.description = clean(it.description);
    fixSpecific(it);
  }
  await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
  console.log(`Rewrote descriptions for ${items.length} items.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
