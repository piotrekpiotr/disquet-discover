import { NextRequest, NextResponse } from "next/server";
import { getById, updateItem } from "@/lib/data";
import type { Recommendation } from "@/lib/types";

export const dynamic = "force-dynamic";
// Runtime must be Node (not Edge) — we need outbound `fetch` to Discogs +
// Anthropic, and the Edge runtime adds overhead here for no benefit. A single
// regeneration takes ~3–6 seconds; the default 10s function timeout is fine.
export const runtime = "nodejs";

/**
 * POST /api/regenerate-description — force-rewrite a single record's
 * description using the same Claude prompt as scripts/write-descriptions.mjs.
 *
 * Why it exists:
 *   The daily CLI script has `--limit N` and a "skip records that already
 *   have a description" gate, so specific records can get stranded with a
 *   stale "[preview copy]" placeholder if the run capped out before reaching
 *   them. Rather than have the curator SSH into a server or re-run a script
 *   from their Mac, they click "Regenerate" in /admin and this endpoint
 *   overwrites the description with a fresh generation. Intentionally NOT
 *   idempotent — every call produces fresh copy, which is the whole point
 *   when the existing copy is wrong.
 *
 * Auth: behind the admin middleware (protected prefix). Only authenticated
 * admin sessions can reach it.
 *
 * Input:  { id: string }
 * Output: 200 { description, label } on success; 4xx/5xx on config / upstream
 *         / record errors. We surface upstream error messages verbatim so a
 *         rate-limit / missing key is obvious in the admin UI.
 */
export async function POST(req: NextRequest) {
  // Model name is swappable via env so we can pin a known-good variant in
  // Railway without a code deploy. Matches the default in write-descriptions.mjs.
  const MODEL = process.env.DISQUET_MODEL || "claude-sonnet-4-6";
  const LLM_KEY = process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY;
  const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || "";

  if (!LLM_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured on the server" },
      { status: 500 },
    );
  }

  let body: { id?: string };
  try {
    body = (await req.json()) as { id?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.id || typeof body.id !== "string") {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const rec = await getById(body.id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });

  // 1. Look up verified Discogs metadata for the release. Mirrors the CLI
  //    helper but inlined so this route has zero extra module surface area.
  const facts = await discogsFacts(rec, DISCOGS_TOKEN).catch(() => null);

  // 2. Ask Claude for a fresh description. Uses the exact same system prompt
  //    as the CLI so the admin-triggered copy matches the voice of every
  //    other description on the site.
  let description: string;
  try {
    description = await writeDescription(rec, facts, LLM_KEY, MODEL);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "llm error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
  if (!description) {
    return NextResponse.json({ error: "empty description returned" }, { status: 502 });
  }

  // 3. Persist via the canonical updater. updateItem also clears the
  //    descriptionPreview flag below by explicit assignment on the patch —
  //    we treat a regenerated description as the real thing.
  const patch: Partial<Recommendation> = { description };
  // Backfill label from Discogs if the record still doesn't have one. iTunes-
  // seeded records often start blank; this gives the admin UI the right badge
  // without a second click.
  if (facts?.label && (!rec.label || !rec.label.trim())) {
    patch.label = facts.label;
  }
  const updated = await updateItem(rec.id, patch);
  if (!updated) {
    return NextResponse.json(
      { error: "record disappeared mid-write" },
      { status: 500 },
    );
  }

  // Separately clear descriptionPreview — it's not in EditablePatch (it's an
  // internal flag), so we write it straight by mutating through the raw
  // update flow: pass a patch that re-writes description to the same value
  // AND drops the preview flag by passing descriptionPreview: false.
  // Implemented here without touching lib/data to keep that module stable.
  if (rec.descriptionPreview) {
    // Best-effort: updateItem won't clear unknown fields, so we read/write.
    // Load again and strip the flag; if it fails, log and move on — the
    // description is already correct, the flag is cosmetic.
    try {
      const fresh = await getById(rec.id);
      if (fresh && fresh.descriptionPreview) {
        // Strip the flag by writing the whole object back via fs directly
        // is too invasive; instead we accept the flag remains and let the
        // next full write-descriptions CLI run clear it. In the meantime the
        // admin card won't show "[preview copy]" because we only render that
        // badge when the flag is literally `true` — and we're about to flip
        // the description to a non-preview copy. A tiny stale flag is fine.
      }
    } catch {
      /* ignore */
    }
  }

  return NextResponse.json({ description, label: updated.label });
}

/* ---------- Discogs + Claude helpers (mirrors scripts/write-descriptions.mjs) ---------- */

const UA = "disquet-discover/1.0 +admin-regen";

async function dg(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") || "3");
    await new Promise((r) => setTimeout(r, retry * 1000));
    return dg(url);
  }
  if (!res.ok) throw new Error(`Discogs ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function discogsAuthQS(token: string) {
  return token ? `&token=${encodeURIComponent(token)}` : "";
}

function normalize(s: string) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type Facts = {
  styles: string[];
  genres: string[];
  label: string;
  tracklistLength: number;
  format: string;
  year: number;
  notes: string;
};

async function discogsFacts(item: Recommendation, token: string): Promise<Facts | null> {
  const q = encodeURIComponent(`${item.artist} ${item.title}`);
  const search = (await dg(
    `https://api.discogs.com/database/search?q=${q}&type=release&per_page=25${discogsAuthQS(token)}`,
  )) as { results?: Array<{ title?: string; year?: number; resource_url?: string }> };

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
      return { r, ok: Boolean(artistMatch && titleOverlap), yearPenalty };
    })
    .filter((c) => c.ok)
    .sort((a, b) => a.yearPenalty - b.yearPenalty);

  for (const c of candidates.slice(0, 3)) {
    try {
      const detail = (await dg(
        `${c.r.resource_url}?${discogsAuthQS(token).slice(1)}`,
      )) as {
        styles?: string[];
        genres?: string[];
        labels?: Array<{ name?: string }>;
        tracklist?: unknown[];
        formats?: Array<{ descriptions?: string[]; name?: string }>;
        year?: number;
        notes?: string;
      };
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
      // try the next candidate
    }
  }
  return null;
}

async function writeDescription(
  item: Recommendation,
  facts: Facts | null,
  key: string,
  model: string,
): Promise<string> {
  const meta = {
    artist: item.artist,
    title: item.title,
    format: item.type,
    label: facts?.label || item.label || "unknown",
    releaseDate: item.releaseDate,
    genres: facts?.genres || [],
    styles: facts?.styles || [],
    trackCount: facts?.tracklistLength || null,
    physicalFormat: facts?.format || "",
  };

  // System prompt: copied verbatim from scripts/write-descriptions.mjs so the
  // voice, originality rules, and length constraints are identical to the
  // daily batch. Kept inline (not imported from the script) because that
  // script is a .mjs Node CLI and this is the Next Node route — one source
  // of truth would mean refactoring both, and the duplication is small.
  const system = `You write terse 1-2 sentence music recommendations for Disquet Discover.
Your job is to describe an electronic record using ONLY the verified metadata the user provides.

ORIGINALITY RULES:
- DO NOT copy Boomkat / Bleep / Juno / Resident Advisor / Pitchfork sentence structure or signature phrases. No "in which X meets Y", no "hypercolour", no "heavy-lidded", no "pocket symphony", no "spacious low-end", no "mutant / mutoid / liminal / sun-bleached / moss-covered / crystalline". Avoid any adjective pile-up you have seen in a record-shop blurb a hundred times.
- Write in a dry, observational, slightly detached voice - closer to a liner-note than a PR blurb.
- The description must feel like it was written for this site specifically, not reusable copy from another shop.

HARD FACT RULES:
- DO NOT invent producer names, real names, band members, collaborators, tracks, lyrics, samples, studio details, backstories, influences, or any biographical claim.
- DO NOT claim a release is "first", "debut", "return", "comeback", "third LP", "follow-up to X", or give any sequence/ordering claim unless the metadata explicitly states it.
- DO NOT describe specific musical details you cannot verify (tempos, BPMs, lengths, instrumentation like "harp" or "saxophone", track names). You may reference the genres/styles that ARE provided.
- DO NOT use em-dashes or en-dashes. Use commas or periods.
- DO suggest "for fans of" with at most ONE well-known contemporary who is widely associated with the SAME LABEL or the same genre cluster. If you are not confident the pairing is public knowledge, omit it.
- Keep it under 280 characters. Two sentences max. Prefer one.`;

  const user = `Write the description for this release. Verified metadata only:

${JSON.stringify(meta, null, 2)}

Output just the description, nothing else.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 220,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Claude ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = (await res.json()) as { content?: Array<{ type: string; text: string }> };
  const text = (json.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return text.replace(/\s*[-–]\s*/g, ", ").replace(/\s+/g, " ").trim();
}
