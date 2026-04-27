#!/usr/bin/env node
/**
 * Media & press scan — the "what are the critics writing about this week"
 * pass. Runs alongside sync-artists and sync-labels on every daily job.
 *
 * Two jobs, from one pass over the same RSS feeds:
 *
 *   1. BOOST press signals on records we ALREADY track. If Pitchfork just
 *      reviewed a Purelink record that's in our pool, bump that record's
 *      `pressMentions` so the admin UI shows a badge. Works by matching
 *      the feed entry's artist name (case-insensitive) against every
 *      existing record; ties are broken by title similarity.
 *
 *   2. SURFACE candidate artists we DON'T track. If Pitchfork AND Resident
 *      Advisor both wrote about some artist in the last two weeks, and
 *      that artist isn't in monitoring.mjs ARTISTS or monitoring-extras,
 *      record them in data/media-candidates.json with:
 *        { sources: ["pitchfork","ra"], lastSeen, titleHints }
 *      A curator UI (/admin/candidates) then reviews and one-clicks
 *      promote → monitoring-extras, where tomorrow's sync-artists picks
 *      them up.
 *
 * Intentionally NOT autoamating: media-candidates → pool. A machine adding
 * pending records off a fuzzy RSS match would poison the pool with every
 * misattributed title. The curator's eye is the gate.
 *
 * Sources (all public, all RSS):
 *   - Pitchfork album reviews
 *   - The Quietus main feed (already pulled by sync-labels for pressMentions)
 *   - Resident Advisor reviews
 *   - Fact Magazine
 *
 * If a feed fails, we log and skip — NEVER abort. This is additive data;
 * missing a source one day doesn't break anything.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ARTISTS as BASE_ARTISTS } from "./monitoring.mjs";
import {
  fetchMonitoringExtras,
  mergeUnique,
  recordAutoExtra,
} from "./fetch-extras.mjs";
import {
  buildSimilarityIndex,
  scoreCandidate,
  AUTO_PROMOTE_MATCH_THRESHOLD,
  AUTO_PROMOTE_POOL_COUNT_THRESHOLD,
} from "./sources/lastfm.mjs";
import {
  buildFingerprint as buildLastfmTagFingerprint,
  findTagCandidates as findLastfmTagCandidates,
} from "./sources/lastfm-tags.mjs";

const RECS_FILE = path.resolve("data/recommendations.json");
const CANDIDATES_FILE = path.resolve("data/media-candidates.json");
const UA = "disquet-discover/1.0 +media";

// A candidate auto-promotes only when BOTH gates fire:
//   - Gate A (press signal): at least this many independent outlets have
//     mentioned the artist. One Pitchfork mention is a blip; two outlets in
//     the same fortnight is real pickup.
//   - Gate B (similarity signal): the artist is close enough to the existing
//     pool that they'd plausibly be picked by hand. Last.fm's match score is
//     the cheapest reliable proxy.
// Both gates together keep the pool on-rails without a curator's eye — a
// candidate with one blowup review but zero similarity (say, a pop-rap
// record) stays in review; a scene-adjacent artist covered by two outlets
// auto-promotes.
const AUTO_PROMOTE_MIN_SOURCES = 2;

const FEEDS = [
  {
    id: "pitchfork",
    name: "Pitchfork",
    // /rss/reviews/albums/ went 404 in early 2026 — Pitchfork
    // consolidated to a single /feed/rss endpoint that mixes news +
    // reviews. parseEntry() already detects "Artist: Album" titles
    // and falls through to "low confidence" on news posts, so the
    // mixed feed is fine for our purposes (we only candidate-promote
    // on high-confidence + multi-source matches anyway).
    url: "https://pitchfork.com/feed/rss",
  },
  {
    id: "quietus",
    name: "The Quietus",
    // The non-trailing-slash variant 301-redirects to /feed/ — but
    // their CDN sends a 301 with the wrong content-type and our
    // bare-bones fetch then sees a 403 from the next hop. Hard-code
    // the canonical trailing-slash URL.
    url: "https://thequietus.com/feed/",
  },
  {
    id: "ra",
    name: "Resident Advisor",
    // RA killed every /xml/rss-*.xml feed during their 2025 site
    // rebuild. There's no public RSS replacement. Instead we scrape
    // the HTML reviews index — it ships with the full review list
    // embedded in __NEXT_DATA__ JSON, which `fetchRaReviews` parses
    // out below. Idempotent and stable across the few site reflows
    // we've seen since.
    url: "https://ra.co/reviews/albums",
    custom: "ra-html",
  },
  {
    id: "fact",
    name: "Fact Magazine",
    url: "https://www.factmag.com/feed/",
  },
  {
    // Bandcamp Daily — editorial coverage of the Bandcamp catalogue.
    // Strong signal for our genre (lots of left-field electronic /
    // experimental coverage Pitchfork/Quietus skip). RSS works without
    // headers, JSON-LD inside is overkill — the regular RSS extracts
    // fine.
    id: "bandcamp_daily",
    name: "Bandcamp Daily",
    url: "https://daily.bandcamp.com/feed",
  },
  {
    // Stereogum — broader pop/indie coverage. "Album Of The Week" and
    // "Premature Evaluation" recurring columns give clean (artist,
    // title) tuples. Most of the rest is news that won't auto-promote
    // (single-source + Last.fm-similarity gate handles that).
    id: "stereogum",
    name: "Stereogum",
    url: "https://www.stereogum.com/feed",
  },
];

/**
 * Minimal RSS/Atom parser. Not a real XML parser; just pattern-extracts
 * what we need (<item> / <entry> blocks with <title>, <description>,
 * <pubDate>/<updated>, optional <dc:creator>). Good enough for the 4–5
 * well-behaved feeds we target; would fall over on a pathological XML
 * file, but then so would the rest of our day.
 */
function parseRss(xml) {
  if (!xml) return [];

  // Try <item> blocks first (RSS 2.0). Fall back to <entry> blocks (Atom).
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  const entryRegex = /<entry\b[\s\S]*?<\/entry>/gi;
  let blocks = xml.match(itemRegex) || [];
  if (blocks.length === 0) blocks = xml.match(entryRegex) || [];

  const out = [];
  for (const block of blocks) {
    const title = extractTag(block, "title");
    const desc =
      extractTag(block, "description") ||
      extractTag(block, "summary") ||
      extractTag(block, "content:encoded") ||
      "";
    const creator =
      extractTag(block, "dc:creator") ||
      extractTag(block, "author") ||
      "";
    const pubDate =
      extractTag(block, "pubDate") ||
      extractTag(block, "updated") ||
      extractTag(block, "published") ||
      "";
    const link =
      extractTag(block, "link") ||
      extractAttr(block, "link", "href") ||
      "";
    if (!title) continue;
    out.push({
      title: decodeEntities(stripTags(title)),
      description: decodeEntities(stripTags(desc)).slice(0, 500),
      creator: decodeEntities(stripTags(creator)),
      pubDate: pubDate.trim(),
      link: link.trim(),
    });
  }
  return out;
}

function extractTag(block, tag) {
  // CDATA-aware; matches <tag>...</tag> or <tag><![CDATA[...]]></tag>.
  const re = new RegExp(
    `<${tag}\\b[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`,
    "i",
  );
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

function extractAttr(block, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]+)"`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

function stripTags(s) {
  return (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCharCode(parseInt(n, 16)),
    );
}

/**
 * Extract a best-guess (artist, releaseTitle) tuple from a feed entry.
 * Every publication formats differently, so we try a short list of
 * patterns and fall back to "use the whole title" if none match.
 *
 * Confidence: "high" when a pattern matched cleanly; "low" when we're
 * guessing. Low-confidence entries still surface a press-mention match
 * if the artist appears in an existing record, but they don't create
 * candidate entries (too noisy).
 */
function parseEntry(entry, sourceId) {
  const title = (entry.title || "").trim();
  const desc = (entry.description || "").trim();

  // Pitchfork: their /feed/rss is a MIXED feed (news + reviews + lists)
  // since the late-2025 RSS consolidation. The "Artist: Album" colon
  // shape is how album reviews are titled, but news/list articles show
  // as "11 New Albums You Should Listen to Now: Kehlani, Loukeman, …"
  // — same colon shape, completely different meaning. Earlier versions
  // of this code blindly pulled the part before the colon as the
  // artist name, polluting media-candidates.json with junk like
  // "11 New Albums You Should Listen to Now". The reject list below
  // catches those, plus the "What Critics Are Saying About …" / "Pin
  // Drops" / "The Best New Music" ledes.
  if (sourceId === "pitchfork") {
    const NEWS_LEDE = /^(?:\d+\s+(?:new\s+)?(?:albums?|songs?|tracks?|releases?|things?)|the\s+(?:best|biggest)\s|what\s+(?:critics?|to)\s|pin\s+drops?|listen|watch|stream|read|album premiere|track premiere|q&a|interview|essay|feature|news|the week in music|tracking)/i;
    if (NEWS_LEDE.test(title)) {
      return { artist: "", releaseTitle: title, confidence: "low" };
    }
    const colon = title.match(/^([^:]+):\s*(.+)$/);
    if (colon) {
      const artist = colon[1].trim();
      // Even with the lede filter, sentences ending in a colon ("X
      // returns from hiatus: Y") are the news pattern; treat artists
      // longer than ~40 chars or containing a verb-ish whitespace
      // pattern as low-confidence. 40 is the cutoff because real
      // multi-artist credits ("Sam Gendel & Sam Wilkes & Philippe
      // Melanson") fit comfortably under that.
      if (artist.length > 40 || /\bnew\b|\bbest\b|\btop\b/i.test(artist)) {
        return { artist: "", releaseTitle: title, confidence: "low" };
      }
      return { artist, releaseTitle: colon[2].trim(), confidence: "high" };
    }
    // Fallback: pull artist from description's "Listen to X's new album" style
    const descMatch = desc.match(/^([A-Z][\w\s&.'-]+?)'s\s+(?:new\s+)?(?:album|EP|single|record)/i);
    if (descMatch) {
      return {
        artist: descMatch[1].trim(),
        releaseTitle: title,
        confidence: "low",
      };
    }
    return { artist: "", releaseTitle: title, confidence: "low" };
  }

  // Bandcamp Daily: their RSS is editorial-flavoured ("Artist's New
  // Album X Is …", "On Y's Latest Record …", "The Best New Z").
  // We treat the daily.bandcamp.com feed mostly as a press-boost
  // signal — match artist names that already exist in the pool — and
  // only rarely accept it as a candidate source (low-confidence
  // default). Daily often profiles 5–10 artists in a single article;
  // pulling a single canonical artist out of those is unreliable.
  if (sourceId === "bandcamp_daily") {
    // Skip the editorial-feature ledes that don't yield (artist, title)
    // tuples cleanly. "Various Artists" entries also skip — they're
    // VA comps, not single-artist releases, and adding "Various Artists"
    // to the candidate file would be useless noise.
    const FEATURE_LEDE =
      /^(?:essential releases|underground medicine|the merch table|read|listen|watch|stream|q&a|interview|the best new|big ups|hidden gems|how|why|where|when|tracking|retracing|the week in)/i;
    if (FEATURE_LEDE.test(title)) {
      return { artist: "", releaseTitle: title, confidence: "low" };
    }
    if (/^various artists\b/i.test(title)) {
      return { artist: "", releaseTitle: title, confidence: "low" };
    }
    // "Album of the Day: Artist - Title" — the explicit review column.
    const aotd = title.match(
      /^Album of the Day:\s*(.+?)\s+[-–—,]\s+["“]?(.+?)["”]?$/i,
    );
    if (aotd) {
      return {
        artist: aotd[1].trim(),
        releaseTitle: aotd[2].trim(),
        confidence: "high",
      };
    }
    // The recurring track/album-of-the-week column ships as
    //   `Artist, "Title"` (comma + smart-quoted title)
    // for both single tracks ("Carla dal Forno, "Confession"") and
    // albums. This is the most common high-signal shape on the feed.
    const commaQuoted = title.match(
      /^(.+?)[,]\s+[“"”'']([^“”"'']+)[“"”'']\s*$/,
    );
    if (commaQuoted) {
      const artist = commaQuoted[1].trim();
      // Reject obvious non-artist openers (rare but cheap to guard).
      if (artist.length < 80 && !FEATURE_LEDE.test(artist)) {
        return {
          artist,
          releaseTitle: commaQuoted[2].trim(),
          confidence: "high",
        };
      }
    }
    // "On Artist's New X" / "With Artist's New X" — pull artist, leave
    // title vague.
    const possessive = title.match(
      /^(?:On|With|For)\s+([A-Z][\w\s&.'-]+?)'s\s+(?:new\s+)?(?:album|EP|single|record|debut|LP)/i,
    );
    if (possessive) {
      return {
        artist: possessive[1].trim(),
        releaseTitle: "",
        confidence: "low",
      };
    }
    return { artist: "", releaseTitle: title, confidence: "low" };
  }

  // Stereogum: heavy on news/lists. Real review titles live as
  // "Album Of The Week: Artist – Title" or "Premature Evaluation:
  // Artist – Title". Both are clean signals when they fire. Most of
  // the rest is news that won't yield a useful artist tuple.
  if (sourceId === "stereogum") {
    const m = title.match(
      /^(?:Album Of The Week|Premature Evaluation|Heavy Rotation):\s*(.+?)\s+[-–—,]\s+["“]?(.+?)["”]?$/i,
    );
    if (m) {
      return {
        artist: m[1].trim(),
        releaseTitle: m[2].trim(),
        confidence: "high",
      };
    }
    // "Artist Drops/Shares/Releases X" style — same as Fact below.
    const verb = title.match(
      /^([A-Z][\w\s&.'-]+?)\s+(?:shares?|announces?|drops?|releases?|returns? with|unveils?|previews?)\s+(?:new\s+)?(?:album|EP|single|track|record|LP)?\s*["“'']?([^"”'']+?)["”'']?$/i,
    );
    if (verb) {
      return {
        artist: verb[1].trim(),
        releaseTitle: verb[2].trim(),
        confidence: "high",
      };
    }
    return { artist: "", releaseTitle: title, confidence: "low" };
  }

  // RA: "RA Reviews: Artist - Title" or "Artist - Title" directly
  if (sourceId === "ra") {
    const m =
      title.match(/^(?:RA\s+Reviews?:\s+)?(.+?)\s+[-–—]\s+(.+)$/i) ||
      title.match(/^(.+?):\s+(.+)$/);
    if (m) {
      return {
        artist: m[1].trim(),
        releaseTitle: m[2].trim(),
        confidence: "high",
      };
    }
    return { artist: "", releaseTitle: title, confidence: "low" };
  }

  // Quietus: highly variable. "A Quietus Interview: Artist" or feature
  // headlines. We pull the best-guess artist but default to low confidence
  // because the Quietus publishes essays/features as well as reviews.
  if (sourceId === "quietus") {
    const interview = title.match(/Interview:?\s+(.+?)(?:\s+[-–—]|$)/i);
    if (interview) {
      return {
        artist: interview[1].trim(),
        releaseTitle: "",
        confidence: "low",
      };
    }
    const review = title.match(/^(.+?)\s+[-–—]\s+(.+?)\s+(?:Reviewed|Review|review)/i);
    if (review) {
      return {
        artist: review[1].trim(),
        releaseTitle: review[2].trim(),
        confidence: "high",
      };
    }
    return { artist: "", releaseTitle: title, confidence: "low" };
  }

  // Fact: "Artist shares/announces/drops Title" is a common pattern
  if (sourceId === "fact") {
    const m = title.match(
      /^(.+?)\s+(?:shares?|announces?|drops?|releases?|returns? with|unveils?|previews?)\s+(?:new\s+)?(?:album|EP|single|track|record|LP)?\s*[""'']?(.+?)[""'']?$/i,
    );
    if (m) {
      return {
        artist: m[1].trim(),
        releaseTitle: m[2].trim().replace(/[""'']/g, ""),
        confidence: "high",
      };
    }
    return { artist: "", releaseTitle: title, confidence: "low" };
  }

  return { artist: "", releaseTitle: title, confidence: "low" };
}

function normalise(s) {
  return (s || "").toLowerCase().trim();
}

async function fetchFeed(feed) {
  try {
    if (feed.custom === "ra-html") {
      return await fetchRaReviews(feed);
    }

    const res = await fetch(feed.url, {
      headers: {
        // Some publications (Quietus on Cloudflare, Pitchfork) 403 our
        // old "compatible; disquet-sync/1.0" UA — they classify it as
        // a script and serve an interstitial page. A regular browser-
        // flavoured UA gets the actual feed. We follow Mozilla/5.0
        // dressing because it's the most-permitted everywhere; the
        // optional sync-id tag stays in a custom header that
        // analytics-friendly publications can grep for if they care.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/rss+xml, application/xml, text/xml, */*;q=0.1",
        "Accept-Language": "en-US,en;q=0.9",
        "X-Disquet-Bot": "sync-media/1.0",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      console.log(`[media:${feed.id}] GET ${feed.url} → ${res.status}`);
      return [];
    }
    const xml = await res.text();
    const items = parseRss(xml);
    console.log(`[media:${feed.id}] ${items.length} item(s) parsed`);
    return items;
  } catch (e) {
    console.log(`[media:${feed.id}] fetch failed: ${e.message}`);
    return [];
  }
}

/**
 * Resident Advisor stopped publishing RSS during their 2025 redesign,
 * but the public reviews HTML page still ships the full review list
 * inside the page's `__NEXT_DATA__` blob. We grep the JSON for the
 * Review nodes (each carries title="Artist - Album", date, blurb,
 * contentUrl) and reshape them into the same {title, description,
 * pubDate, link} envelope the RSS path produces — so parseEntry()
 * downstream can stay completely RA-agnostic.
 *
 * Failure modes: any change to RA's page HTML (different __typename,
 * a switch off Next.js) just yields zero items — same fallthrough
 * behaviour as a 404 on a missing RSS feed. No abort.
 */
async function fetchRaReviews(feed) {
  const res = await fetch(feed.url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    console.log(`[media:${feed.id}] GET ${feed.url} → ${res.status}`);
    return [];
  }
  const html = await res.text();
  // The hydration JSON contains many nodes; we only want Review entries.
  // Anchor the regex on `"__typename":"Review"` and grab the surrounding
  // record up to the next `}` that closes the title/date/contentUrl block.
  // The blurb field can contain nested escapes, so we limit greedy match
  // length to keep things bounded. Worst case we miss a few entries; a
  // partial run is still better than zero.
  const re =
    /"__typename":"Review","index":"REVIEW","title":"([^"\\]*(?:\\.[^"\\]*)*)","date":"([^"]+)","imageUrl":"[^"]*","contentUrl":"([^"]+)"(?:,"recommended":[^,]+)?,"blurb":"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, title, date, contentUrl, blurb] = m;
    if (seen.has(contentUrl)) continue;
    seen.add(contentUrl);
    out.push({
      title: title.replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
      description: blurb.replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
      creator: "",
      pubDate: date,
      link: contentUrl.startsWith("http") ? contentUrl : `https://ra.co${contentUrl}`,
    });
  }
  console.log(`[media:${feed.id}] ${out.length} item(s) parsed`);
  return out;
}

/**
 * Decide whether a candidate has earned auto-promotion. Two independent
 * gates must BOTH fire: press coverage and similarity to the pool. Either
 * alone is too noisy — a single Fact blog post does not justify adding an
 * artist, and a Last.fm "similar to Huerco S." entry with no press mention
 * is just a name on a list. Together, they approximate the curator's own
 * heuristic ("the usual outlets are writing about them AND they fit the
 * scene we cover").
 */
function shouldAutoPromote(candidate, similarityIndex) {
  const sources = Array.isArray(candidate.sources) ? candidate.sources : [];
  if (sources.length < AUTO_PROMOTE_MIN_SOURCES) {
    return { promote: false, reason: "not enough sources" };
  }
  // No similarity index available (no LASTFM_API_KEY) → never auto-promote.
  // Multi-source alone is suggestive but not sufficient; the curator stays
  // in the loop via /admin/candidates.
  if (similarityIndex.size === 0) {
    return { promote: false, reason: "no similarity index" };
  }
  const score = scoreCandidate(candidate.name, similarityIndex);
  if (score.topMatch >= AUTO_PROMOTE_MATCH_THRESHOLD) {
    return {
      promote: true,
      reason: `topMatch ${score.topMatch.toFixed(2)} ≥ ${AUTO_PROMOTE_MATCH_THRESHOLD}`,
      score,
    };
  }
  if (score.poolMatchCount >= AUTO_PROMOTE_POOL_COUNT_THRESHOLD) {
    return {
      promote: true,
      reason: `${score.poolMatchCount} pool artists list them as similar`,
      score,
    };
  }
  return {
    promote: false,
    reason: `topMatch ${score.topMatch.toFixed(2)} < ${AUTO_PROMOTE_MATCH_THRESHOLD} and poolMatchCount ${score.poolMatchCount} < ${AUTO_PROMOTE_POOL_COUNT_THRESHOLD}`,
    score,
  };
}

async function main() {
  const extras = await fetchMonitoringExtras();
  const POOL_ARTISTS = mergeUnique(BASE_ARTISTS, extras.artists);
  const pooledSet = new Set(POOL_ARTISTS.map(normalise));

  // Build (or load from cache) the Last.fm similarity index. This is what
  // lets us decide auto-promote vs. hold-for-manual-review on a candidate.
  // Empty Map if LASTFM_API_KEY is unset — every candidate then needs the
  // curator's eye, which is strictly a safe default.
  const similarityIndex = await buildSimilarityIndex(POOL_ARTISTS);

  // Read existing candidates so we accumulate across runs.
  /** @type {Record<string, {firstSeen: string, lastSeen: string, sources: string[], titleHints: string[], mentions: number, dismissed?: boolean, promoted?: boolean, autoPromoted?: boolean, autoPromoteScore?: {topMatch: number, poolMatchCount: number, bestPoolArtist?: string}}>} */
  let candidates = {};
  try {
    candidates = JSON.parse(await fs.readFile(CANDIDATES_FILE, "utf8"));
    if (!candidates || typeof candidates !== "object" || Array.isArray(candidates)) {
      candidates = {};
    }
  } catch {
    // first run
  }

  // Load recommendations for pressMention bumping.
  const recs = JSON.parse(await fs.readFile(RECS_FILE, "utf8"));
  const recsByArtist = new Map();
  for (const rec of recs) {
    const key = normalise(rec.artist);
    if (!recsByArtist.has(key)) recsByArtist.set(key, []);
    recsByArtist.get(key).push(rec);
  }

  let pressBoosts = 0;
  let candidateMentions = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const feed of FEEDS) {
    const entries = await fetchFeed(feed);
    for (const entry of entries) {
      const parsed = parseEntry(entry, feed.id);
      if (!parsed.artist) continue;
      // Universal artist-name reject. Cheap defenses against the most
      // common false-positives every parser produces: "Various
      // Artists" comp credits, suspiciously short tokens that are
      // usually article remnants ("USC"-style), and the residual
      // "N new albums…" lede that occasionally slips past a per-
      // source LEDE check. Cheap to add at the orchestrator so we
      // don't keep re-implementing it inside each source branch.
      const cleaned = parsed.artist.trim();
      if (
        /^various\s+artists?\b/i.test(cleaned) ||
        /^(va|v\.a\.)\s*$/i.test(cleaned) ||
        /^\d+\s+(?:new|best|top)\b/i.test(cleaned) ||
        cleaned.length < 2
      ) {
        continue;
      }
      const artistKey = normalise(parsed.artist);

      // Job 1: boost pressMentions on existing records for this artist.
      // Match on artist ONLY; title is an unreliable match against blog
      // copy ("Purelink's 'Signs'" vs our "Signs"). A blog writing about
      // the artist is itself useful signal — tag all their recent
      // pool records.
      if (recsByArtist.has(artistKey)) {
        for (const rec of recsByArtist.get(artistKey)) {
          const existing = Array.isArray(rec.pressMentions) ? rec.pressMentions : [];
          if (!existing.includes(feed.id)) {
            rec.pressMentions = [...existing, feed.id];
            pressBoosts++;
          }
        }
        continue; // don't also record as a candidate
      }

      // Job 2: accumulate candidate if artist isn't in the pool and
      // confidence is at least moderate.
      if (pooledSet.has(artistKey)) continue;
      if (parsed.confidence !== "high") continue;

      const displayName = parsed.artist;
      const cur = candidates[displayName] || {
        firstSeen: today,
        lastSeen: today,
        sources: [],
        titleHints: [],
        mentions: 0,
      };
      cur.lastSeen = today;
      cur.mentions++;
      if (!cur.sources.includes(feed.id)) cur.sources.push(feed.id);
      if (parsed.releaseTitle && cur.titleHints.length < 5) {
        if (!cur.titleHints.includes(parsed.releaseTitle)) {
          cur.titleHints.push(parsed.releaseTitle);
        }
      }
      candidates[displayName] = cur;
      candidateMentions++;
    }
  }

  // Last.fm tag-based discovery. Runs AFTER the press feeds so the
  // pool-tag fingerprint is built from the same POOL_ARTISTS the press
  // pass used (consistent excludeKeys). For every fingerprint tag
  // (top 20 most-frequent tags across the pool), Last.fm's
  // tag.getTopArtists returns ~50 names ranked by listen count; we
  // surface the non-pool ones with their tag-overlap count as the
  // score. A candidate appearing under N>=2 of our fingerprint tags
  // is a strong scene-fit signal — counts as ONE source ("lastfm-tags")
  // for the auto-promote gate but ALSO records the matching tags so
  // the curator sees the why on /admin/candidates.
  //
  // The fingerprint cache (data/lastfm-tag-fingerprint.json) has 7-day
  // TTL — pool composition changes slowly. The actual tag.getTopArtists
  // calls are made every run so candidate volume reflects whichever
  // artists Last.fm has been promoting recently.
  try {
    const fingerprint = await buildLastfmTagFingerprint(POOL_ARTISTS);
    if (fingerprint) {
      const tagRows = await findLastfmTagCandidates(fingerprint, pooledSet);
      for (const row of tagRows) {
        const cur = candidates[row.name] || {
          firstSeen: today,
          lastSeen: today,
          sources: [],
          titleHints: [],
          mentions: 0,
        };
        cur.lastSeen = today;
        cur.mentions++;
        if (!cur.sources.includes("lastfm-tags")) {
          cur.sources.push("lastfm-tags");
        }
        // Stash the matching pool tags so the candidates UI can show
        // "matched on: ambient · dub techno · idm" as the rationale.
        // Stored on a sibling field rather than titleHints so press-
        // candidate hints stay distinguishable from tag matches.
        cur.poolTags = Array.from(
          new Set([...(cur.poolTags || []), ...row.tags]),
        ).slice(0, 8);
        cur.poolTagOverlap = Math.max(cur.poolTagOverlap || 0, row.score);
        candidates[row.name] = cur;
        candidateMentions++;
      }
    }
  } catch (e) {
    console.log(`[lastfm-tags] failed: ${e.message}`);
  }

  // Auto-promotion pass. Runs AFTER all feeds are accumulated so a
  // candidate that Fact + Quietus both mention on the same day can fire
  // both sources into sources[] before we evaluate the gate. Only evaluates
  // candidates that aren't already promoted or dismissed — a curator's
  // dismiss is sticky even if the artist passes the similarity gate later.
  let autoPromotedCount = 0;
  const autoPromotedNames = [];
  for (const [name, cand] of Object.entries(candidates)) {
    if (cand.promoted || cand.dismissed) continue;
    const decision = shouldAutoPromote({ name, ...cand }, similarityIndex);
    if (!decision.promote) continue;
    // Persist the decision in-file so /admin/candidates shows WHY this
    // artist was auto-promoted (the score card is curator-reassuring
    // context when they spot an unexpected addition to monitoring-extras).
    cand.promoted = true;
    cand.autoPromoted = true;
    cand.autoPromoteScore = {
      topMatch: decision.score?.topMatch ?? 0,
      poolMatchCount: decision.score?.poolMatchCount ?? 0,
      bestPoolArtist: decision.score?.matches?.[0]?.poolArtist,
    };
    try {
      const res = await recordAutoExtra("artist", name);
      if (res.added) {
        console.log(
          `[sync-media] auto-promoted "${name}": ${decision.reason}` +
            (decision.score?.matches?.[0]
              ? ` (closest: ${decision.score.matches[0].poolArtist} @ ${decision.score.matches[0].match.toFixed(2)})`
              : ""),
        );
        autoPromotedCount++;
        autoPromotedNames.push(name);
      }
    } catch (e) {
      console.log(`[sync-media] recordAutoExtra failed for "${name}": ${e.message}`);
      // Undo the in-memory promoted flag so we retry next run.
      cand.promoted = false;
      cand.autoPromoted = false;
      delete cand.autoPromoteScore;
    }
  }

  // Persist both outputs. Sorted for human-friendly diffs.
  recs.sort((a, b) =>
    (b.releaseDate || "").localeCompare(a.releaseDate || ""),
  );
  await fs.writeFile(RECS_FILE, JSON.stringify(recs, null, 2), "utf8");

  const sortedCandidates = Object.fromEntries(
    Object.entries(candidates).sort((a, b) => {
      // More-covered first (multi-source before single-source),
      // then most-recent-mention.
      const sa = (a[1].sources || []).length;
      const sb = (b[1].sources || []).length;
      if (sb !== sa) return sb - sa;
      return (b[1].lastSeen || "").localeCompare(a[1].lastSeen || "");
    }),
  );
  await fs.writeFile(
    CANDIDATES_FILE,
    JSON.stringify(sortedCandidates, null, 2),
    "utf8",
  );

  const multiSourceCount = Object.values(candidates).filter(
    (c) => (c.sources || []).length >= 2 && !c.dismissed && !c.promoted,
  ).length;

  console.log(
    `[sync-media] done. Press boosts added: ${pressBoosts}. ` +
      `Candidate mentions: ${candidateMentions}. ` +
      `Candidates tracked: ${Object.keys(candidates).length} ` +
      `(${multiSourceCount} open multi-source, ${autoPromotedCount} auto-promoted this run).` +
      (autoPromotedCount > 0 ? ` Promoted: ${autoPromotedNames.join(", ")}` : ""),
  );
}

main().catch((e) => {
  console.error("[sync-media] failed:", e);
  // Never fail the job on a media scan hiccup — it's additive data.
  process.exit(0);
});
