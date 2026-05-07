import { NextRequest, NextResponse } from "next/server";
import { getById, updateItem } from "@/lib/data";
import type { Recommendation } from "@/lib/types";

export const dynamic = "force-dynamic";
// Same runtime + reasoning as /api/regenerate-description: Node not Edge
// because we need outbound fetch to Anthropic, single call ~3-6 seconds,
// fits well inside the function-timeout default.
export const runtime = "nodejs";

/**
 * POST /api/rewrite-description — rewrite a record's description using
 * curator-supplied source text (Bandcamp blurb, Wikipedia paragraph,
 * label one-pager, anything they paste in) as the primary input.
 *
 * Sister to /api/regenerate-description: same voice, same originality
 * rules, same writeDescription Claude call shape — but this one ANCHORS
 * the prompt on the curator's pasted text rather than the metadata
 * + Bandcamp scrape the regular regenerator uses. The regular path
 * suits "the daily CLI didn't get to this record"; this path suits "I
 * have a press release / Bandcamp blurb in front of me, paraphrase it
 * for me in the house voice."
 *
 * The prompt is explicit about paraphrase: don't copy sentences from
 * the input, extract the load-bearing facts and re-state them in our
 * voice. Length target is widened slightly to 2-4 sentences (vs the
 * regenerator's 1-2) because there's usually more substance in the
 * curator's source material than in dry Discogs metadata.
 *
 * Auth: covered by the /api/rewrite-description matcher in middleware.
 *
 * Input:  { id: string, input: string }
 * Output: 200 { description } on success; 4xx/5xx on validation /
 *         upstream error.
 */
export async function POST(req: NextRequest) {
  const MODEL = process.env.DISQUET_MODEL || "claude-sonnet-4-6";
  const LLM_KEY = process.env.ANTHROPIC_API_KEY || process.env.LLM_API_KEY;

  if (!LLM_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not configured on the server" },
      { status: 500 },
    );
  }

  let body: { id?: string; input?: string };
  try {
    body = (await req.json()) as { id?: string; input?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.id || typeof body.id !== "string") {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const input = (body.input || "").trim();
  if (!input) {
    return NextResponse.json({ error: "input text required" }, { status: 400 });
  }
  // Hard upper bound on the pasted blob — 5KB is plenty for any
  // sensible Bandcamp / Wikipedia / press-release excerpt and prevents
  // someone pasting an entire interview into the prompt window.
  if (input.length > 5000) {
    return NextResponse.json(
      { error: "input too long — keep it under 5000 characters" },
      { status: 413 },
    );
  }

  const rec = await getById(body.id);
  if (!rec) return NextResponse.json({ error: "not found" }, { status: 404 });

  let description: string;
  try {
    description = await rewriteFromInput(rec, input, LLM_KEY, MODEL);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "llm error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
  if (!description) {
    return NextResponse.json(
      { error: "empty description returned" },
      { status: 502 },
    );
  }

  const updated = await updateItem(rec.id, { description });
  if (!updated) {
    return NextResponse.json(
      { error: "record disappeared mid-write" },
      { status: 500 },
    );
  }

  return NextResponse.json({ description });
}

/**
 * Voice-and-rules system prompt. Mirrors the regenerator's prompt
 * verbatim where it matters (originality, hard-fact rules, no em-
 * dashes, house voice examples) but reframes the task as "paraphrase
 * and tighten the supplied source text" rather than "write from
 * metadata". The length target is 2-4 sentences instead of 1-2 because
 * the curator's input typically carries more substance than the bare
 * metadata path's facts list — but we still want to shrink whatever
 * they pasted to digest length, not dump it whole.
 */
const SYSTEM_PROMPT = `You write terse music recommendations for Disquet Discover.
The user will give you (a) basic metadata about a release, and (b) a block
of source text the curator pasted in (Bandcamp blurb, Wikipedia paragraph,
press release, etc.). Your job: rewrite that source text into a 2-4 sentence
description in the Disquet house voice, paraphrasing thoroughly.

PARAPHRASE RULES:
- DO NOT copy sentences or distinctive phrases from the source verbatim.
  Restate every load-bearing claim in your own words.
- DO keep load-bearing factual claims that the source makes specific
  (label, personnel, instrument family, sonic register, scene context).
- DO NOT introduce facts that are not in the source. If the source is
  silent on personnel / tracklist / tempo / lyrics, do not invent any.
- Trim aggressively. The target length is 2 to 4 sentences; if the source
  runs long, drop secondary detail rather than packing everything in.

ORIGINALITY RULES:
- DO NOT copy Boomkat / Bleep / Juno / Resident Advisor / Pitchfork
  sentence structure or signature phrases. No "in which X meets Y", no
  "hypercolour", no "heavy-lidded", no "pocket symphony", no "spacious
  low-end", no "mutant / mutoid / liminal / sun-bleached / moss-covered
  / crystalline". Avoid any adjective pile-up you have seen in a
  record-shop blurb a hundred times.
- Write in a dry, observational, slightly detached voice — closer to a
  liner-note than a PR blurb.
- The description must feel like it was written for this site
  specifically, not reusable copy from another shop.

HARD FACT RULES:
- DO NOT use em-dashes or en-dashes. Use commas or periods.
- DO NOT start with "A single from X" or "An album from X" — too close
  to placeholder copy.
- Keep individual sentences punchy. Two short sentences beat one long one.
- Total length target: 2 to 4 sentences, ideally under 500 characters.

HOUSE VOICE — five site-native descriptions, same shape we want:
1. "Plug Research reissues the beat-splatter debut that introduced Steven Ellison's signal vocabulary, jazzy, warped, already unmistakably Brainfeeder-adjacent. Nothing here has aged into the period it came from."
2. "Seven pieces of ambient electronics from Meitei, arriving on Kitchen. Label in a limited LP pressing. Shelve near Chihei Hatakeyama if you need a pointer."
3. "The famously reclusive Chain Reaction alumnus resurfaces with another studio of glassy, narcotic dub techno. Loops drift rather than lock; for anyone still returning to Butterfly Effects."
4. "Two long-form Lopatin sketches extended into the kind of elastic, synth-warped ambient he has been quietly refining since Magic Oneohtrix. Warp doing what Warp does."
5. "A loose, after-hours 12\\" from the Houndstooth regular: woody percussion and half-heard voices sat somewhere between jungle and the more wistful end of Hessle Audio. Contained, not quiet."

Write like someone who buys records, not someone paid to sell them.`;

async function rewriteFromInput(
  rec: Recommendation,
  input: string,
  key: string,
  model: string,
): Promise<string> {
  const meta = {
    artist: rec.artist,
    title: rec.title,
    format: rec.type,
    label: rec.label || "unknown",
    releaseDate: rec.releaseDate,
    tags: rec.tags || [],
  };

  const user = `Release metadata:

${JSON.stringify(meta, null, 2)}

Source text the curator pasted (paraphrase thoroughly, do NOT copy phrases verbatim):
"""
${input}
"""

Output ONLY the new description (2-4 sentences). No preamble, no quotes around it.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      // 360 tokens is generous for 4 sentences (~80 words = ~110
      // tokens) and leaves slack for slightly longer output without
      // bumping into the cap. Same model + budget shape as the
      // regular regenerator, just slightly higher max for the longer
      // target length.
      max_tokens: 360,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Claude ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    content?: Array<{ type: string; text: string }>;
  };
  const text = (json.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  // Strip any accidental wrapping quotes Claude sometimes adds when the
  // user prompt asks for "just the description". Mirror the
  // regenerator's em-dash → comma normalisation for in-house consistency.
  // Em/en-dash → ", ". Regular hyphens (-) are PRESERVED because
  // they're the right glue for compound modifiers ("Milan-based")
  // and stripping them produced the "Milan, based" bug.
  return text
    .replace(/^["“]+|["”]+$/g, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}
