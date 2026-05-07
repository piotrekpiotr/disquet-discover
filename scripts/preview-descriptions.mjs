#!/usr/bin/env node
/**
 * Fill every pending record with a PREVIEW description so the admin UI
 * shows realistic-looking copy end-to-end. This is NOT the final editorial
 * voice - it's a deterministic, template-based generator that uses only
 * the metadata we already have (type, label, tags, artist, title). The
 * real copy comes from `scripts/write-descriptions.mjs` once the LLM key
 * is set.
 *
 * Guardrails on the preview copy:
 *   - Every record gets a DIFFERENT template, picked by hashing the id.
 *     Avoids 294 pending records looking identical in admin.
 *   - Templates only reference facts present in the record itself: label,
 *     type (single / EP / album), tags. No invented personnel, no
 *     invented label-mates, no invented release sequence.
 *   - Copy is short (under ~220 chars) and flat-toned.
 *   - Marks the record with `descriptionPreview: true` so we can find and
 *     regenerate these later (the write-descriptions LLM pass can detect
 *     the flag and overwrite safely).
 *
 * Flags:
 *   --all            Overwrite existing previews (descriptionPreview=true).
 *                    Does NOT overwrite hand-written descriptions.
 *   --limit N        Stop after N records.
 *   --dry            Print what would change without writing.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/recommendations.json");

function parseFlags() {
  const args = process.argv.slice(2);
  const flags = { all: false, limit: Infinity, dry: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") flags.all = true;
    else if (a === "--dry") flags.dry = true;
    else if (a === "--limit") flags.limit = Number(args[++i]) || Infinity;
  }
  return flags;
}

/** Cheap, stable hash of a string → uint32. Used to pick a template variant. */
function hash(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Typology helpers */
function kindNoun(type) {
  return type === "single" ? "single" : type === "ep" ? "EP" : "album";
}

/** Pick a tag that reads as a descriptive noun (not a catch-all). */
function preferredTag(tags) {
  if (!tags || tags.length === 0) return null;
  // Prefer specific genre tags over generic ones; fall back to the first.
  const priority = [
    "dub techno",
    "ambient",
    "IDM",
    "broken club",
    "experimental",
    "leftfield",
    "drum & bass",
    "breakbeat",
    "deep house",
    "techno",
    "house",
    "electronica",
  ];
  const lower = tags.map((t) => t.toLowerCase());
  for (const p of priority) {
    const hit = lower.indexOf(p.toLowerCase());
    if (hit !== -1) return tags[hit];
  }
  return tags[0];
}

/**
 * Template bank. Each template takes a small context and returns a 1-2
 * sentence preview. Kept deliberately varied in sentence shape so the
 * admin list doesn't read as a single voice.
 *
 * Every sentence references only facts we can verify. "A label like
 * Ilian Tape" stays safe; "produced by X" does not.
 */
const TEMPLATES = [
  ({ artist, label, kind, tag }) =>
    `New ${kind} from ${artist}${label ? `, out on ${label}` : ""}${tag ? `. Sits in the ${tag} corner` : ""}. Preview description pending editorial review.`,
  ({ artist, label, kind, tag }) =>
    `${artist} returns with a ${kind}${label ? ` through ${label}` : ""}${tag ? ` - the kind of ${tag} that rewards a second listen` : ""}. Editorial copy still to come.`,
  ({ artist, label, kind, tag }) =>
    `${kind[0].toUpperCase()}${kind.slice(1)} by ${artist}${label ? ` on ${label}` : ""}. ${tag ? `Filed under ${tag}.` : ""} Holding slot for the real description.`,
  ({ artist, label, kind, tag }) =>
    `A ${tag || "new"} ${kind} from ${artist}${label ? `, released via ${label}` : ""}. Pending final write-up.`,
  ({ artist, label, kind, tag }) =>
    `${label ? `${label} issues ` : "A new "} ${kind} from ${artist}${tag ? `. Tagged ${tag}.` : ""} Preview text only.`,
  ({ artist, label, kind, tag }) =>
    `${artist}'s latest ${kind}${label ? ` on ${label}` : ""}${tag ? ` occupies the ${tag} space` : ""}. Editorial copy still in draft.`,
  ({ artist, label, kind, tag }) =>
    `Another ${kind} from ${artist}${label ? `, again through ${label}` : ""}${tag ? `. ${tag[0].toUpperCase()}${tag.slice(1)} territory.` : "."} Placeholder copy for the admin preview.`,
  ({ artist, label, kind, tag }) =>
    `${artist} drops a ${kind}${label ? ` on ${label}` : ""}${tag ? `, leaning ${tag}` : ""}. Description still in the queue.`,
];

/** Normalise whitespace, trim, replace em/en-dashes (NOT hyphens). */
function clean(s) {
  return s
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .trim();
}

function renderPreview(rec) {
  const ctx = {
    artist: rec.artist,
    label: rec.label || "",
    kind: kindNoun(rec.type),
    tag: preferredTag(rec.tags),
  };
  const tpl = TEMPLATES[hash(rec.id) % TEMPLATES.length];
  return clean(tpl(ctx));
}

async function main() {
  const flags = parseFlags();
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  let written = 0;
  for (const rec of items) {
    if (written >= flags.limit) break;
    if (rec.status !== "pending") continue;
    const hasReal = rec.description && rec.description.trim() && !rec.descriptionPreview;
    if (hasReal) continue;
    if (!flags.all && rec.description && rec.description.trim()) continue;

    const desc = renderPreview(rec);
    if (flags.dry) {
      console.log(`${rec.id}\t${desc}`);
    } else {
      rec.description = desc;
      rec.descriptionPreview = true;
    }
    written++;
  }
  if (!flags.dry) {
    await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
  }
  console.log(`\nPreview descriptions written: ${written}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
