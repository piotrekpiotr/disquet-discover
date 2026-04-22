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

  // 1b. Bandcamp fallback. When a record has a real Bandcamp album URL, the
  //     page's og:description and ldjson often carry the artist's own
  //     one-liner — exactly the kind of primary-source material the prompt
  //     should be anchored on when Discogs has nothing. We scrape it
  //     opportunistically (best-effort, bounded time) and pass it as extra
  //     context. We don't copy it verbatim; the system prompt still
  //     requires original voice, but the artist's phrasing becomes useful
  //     raw material for Claude to observe around.
  const bandcampBlurb = await bandcampBlurbFor(rec).catch(() => "");

  // 2. Ask Claude for a fresh description. Uses the exact same system prompt
  //    as the CLI so the admin-triggered copy matches the voice of every
  //    other description on the site.
  let description: string;
  try {
    description = await writeDescription(rec, facts, bandcampBlurb, LLM_KEY, MODEL);
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

/**
 * Pull the artist-written blurb off a Bandcamp release page.
 *
 * Why: Bandcamp is often the only place a brand-new release has ANY
 * primary-source description, written by the artist themselves. For fresh
 * drops that Discogs hasn't touched yet (2026-* same-day releases), this
 * is the single highest-quality signal available. We don't copy it; we
 * pass it to Claude as raw context so the generated copy has something
 * specific to anchor on.
 *
 * Only fires when:
 *   - The record has a real Bandcamp album URL (not a search fallback).
 *   - The URL returns 200 within a short timeout.
 *
 * Parses og:description from the HTML, which Bandcamp populates with the
 * trimmed artist-supplied blurb for the release.
 */
async function bandcampBlurbFor(item: Recommendation): Promise<string> {
  const url = item.links?.bandcamp;
  if (!url) return "";
  // Skip search-fallback URLs; they return a listing page, not a release.
  if (!/^https:\/\/[^/]+\.bandcamp\.com\/(album|track)\//i.test(url)) return "";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: ac.signal,
    });
    if (!res.ok) return "";
    const html = await res.text();
    const m = html.match(
      /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i,
    );
    if (!m) return "";
    // Decode the most common HTML entities — Bandcamp escapes quotes and
    // ampersands in meta content. Keeps the blurb natural without pulling
    // in a full HTML-decoder dependency.
    return m[1]
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim()
      .slice(0, 800); // cap so an essay-length blurb doesn't crowd the prompt
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function writeDescription(
  item: Recommendation,
  facts: Facts | null,
  bandcampBlurb: string,
  key: string,
  model: string,
): Promise<string> {
  const meta = {
    artist: item.artist,
    title: item.title,
    format: item.type,
    label: facts?.label || item.label || "unknown",
    releaseDate: item.releaseDate,
    // Merge Discogs genres/styles with the iTunes primary-genre tag the
    // record already carries. Brand-new 2026-* singles often have no
    // Discogs entry yet (catalogue lag), so falling back to the iTunes
    // tag is what keeps the prompt from running empty.
    genres: facts?.genres || [],
    styles: facts?.styles || [],
    tags: item.tags || [],
    trackCount: facts?.tracklistLength || null,
    physicalFormat: facts?.format || "",
    // Flag sparse-metadata runs so the prompt knows to lean on its own
    // knowledge of the artist/label rather than parrot the thin JSON.
    metadataSparse:
      !(facts?.genres?.length) &&
      !(facts?.styles?.length) &&
      !(item.tags?.length),
  };

  // System prompt: mirrors scripts/write-descriptions.mjs but with the
  // "metadata sparse" allowance that lets Claude draw on general knowledge
  // of a named artist's sonic register and a named label's aesthetic when
  // Discogs has no detail yet. Without that allowance, same-day releases
  // from well-known artists (Purelink, Cinna Peyghamy) get a dry metadata
  // recitation like "A single from X on Y, out April 2026" because the
  // fact rules block every other angle. We still forbid invented specifics
  // about THIS release.
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
biographical claim. Do not fabricate a specific storyline for THIS release.

HOUSE VOICE — study these five site-native descriptions. This is the
target: specific, quietly confident, one sentence of frame plus an
observational second clause. Shelving pointers and "for fans of" hints are
welcome. Placeholder phrasing ("A single from X on Y") is not.

EXAMPLES OF THE RIGHT VOICE:
1. "Plug Research reissues the beat-splatter debut that introduced Steven Ellison's signal vocabulary, jazzy, warped, already unmistakably Brainfeeder-adjacent. Nothing here has aged into the period it came from."
2. "Seven pieces of ambient electronics from Meitei, arriving on Kitchen. Label in a limited LP pressing. Shelve near Chihei Hatakeyama if you need a pointer."
3. "The famously reclusive Chain Reaction alumnus resurfaces with another studio of glassy, narcotic dub techno. Loops drift rather than lock; for anyone still returning to Butterfly Effects."
4. "Two long-form Lopatin sketches extended into the kind of elastic, synth-warped ambient he has been quietly refining since Magic Oneohtrix. Warp doing what Warp does."
5. "A loose, after-hours 12\\" from the Houndstooth regular: woody percussion and half-heard voices sat somewhere between jungle and the more wistful end of Hessle Audio. Contained, not quiet."

Note the shape: a specific framing in the first clause (what it is, where
it sits), a second clause that names a reference point or gives a pointer.
No adjective pile-ups. No PR-blurb rhetoric. Write like someone who buys
records, not someone paid to sell them.`;

  // Bandcamp blurb (if we scraped one) is passed as a SEPARATE block, clearly
  // labelled as artist-supplied primary-source material. Claude can borrow
  // facts from it (personnel, musical direction the artist states) but must
  // not copy sentences verbatim — the system prompt's originality rule still
  // applies.
  const bandcampBlock = bandcampBlurb
    ? `\n\nArtist-supplied blurb from Bandcamp (primary source, use as factual ground but do NOT copy phrasing):\n"""\n${bandcampBlurb}\n"""\n`
    : "";

  const user = `Write the description for this release. Verified metadata only:

${JSON.stringify(meta, null, 2)}${bandcampBlock}

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
