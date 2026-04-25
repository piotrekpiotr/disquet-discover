/**
 * Last.fm as a RELEASE-discovery source.
 *
 * Why a third source on top of iTunes + Deezer:
 *   iTunes and Deezer sometimes miss niche electronic releases — a
 *   limited Bandcamp-only LP, a label that doesn't push to Apple, a
 *   record that takes a few weeks to reach the streaming services.
 *   Last.fm aggregates scrobble data and pulls release metadata from
 *   MusicBrainz, so its "Latest release" pointer often catches a
 *   release before iTunes/Deezer indexes it (and sometimes catches
 *   things they never index at all).
 *
 * What it can / can't do:
 *   ✓ Per-artist "what was their most recent release and when".
 *   ✓ The release title and a Last.fm-internal URL (which we DON'T
 *     deep-link to from the public site, but it's a useful identifier
 *     for de-duplication).
 *   ✗ External streaming URLs (Spotify, Apple Music, etc.) — Last.fm
 *     doesn't surface those.
 *   ✗ Multiple recent releases in one call — only the single newest one.
 *
 * Why we scrape HTML instead of the JSON API:
 *   The JSON API requires LASTFM_API_KEY and only exposes scrobble-
 *   centric fields ("top albums by listen count", not "newest by date").
 *   The "Latest release" pointer we want is rendered on the artist's
 *   public HTML page, sourced from MusicBrainz inside Last.fm's render
 *   layer. No key required; HTML structure has been stable since late
 *   2023.
 *
 * Contract:
 *   lookupArtist(artistName) → Promise<Release[]>
 *     Returns 0 or 1 releases (Last.fm only exposes one "latest").
 *     Same shape as itunes.mjs / deezer.mjs so sync-artists.mjs can
 *     consume it without special-casing. `externalUrl` is null because
 *     a Last.fm internal URL isn't useful for the public card; the
 *     orchestrator (sync-artists) has its own logic to enrich
 *     externalUrl from iTunes/Deezer afterwards.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Convert a Last.fm-rendered date ("24 October 2025", "4 December 2025")
 * into the YYYY-MM-DD shape the rest of the pipeline expects. Returns
 * "" on parse failure so the orchestrator can drop the entry without
 * propagating a bad date.
 */
function parseLastfmDate(s) {
  if (!s) return "";
  const trimmed = s.trim();
  // The Last.fm template renders dates as "<DD> <Month> <YYYY>" in
  // English. Date.parse handles that natively across all Node runtimes
  // we target, but its output is timezone-dependent — we want the
  // bare calendar date the page rendered, so we slice from the ISO.
  const ts = Date.parse(trimmed + " UTC");
  if (Number.isNaN(ts)) return "";
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Heuristic release-type classifier. Last.fm's "Latest release"
 * pointer can be an album, single, or remix; we don't have the kind
 * of structured fields iTunes gives us, so we fall back to
 * conservative defaults: "(remix)" / "(edit)" / "(version)" in the
 * title is almost always a single, otherwise treat as album. The
 * orchestrator has its own iTunes/Deezer pass that will typically
 * supersede this with a better-typed entry.
 */
function classifyType(title) {
  const t = (title || "").toLowerCase();
  if (/\b(remix|edit|version|rework|dub|mix)\)?\s*$/.test(t)) return "single";
  if (/\b- single\b/.test(t)) return "single";
  if (/\b- ep\b/.test(t)) return "ep";
  return "album";
}

/**
 * Strip the "- Single" / "- EP" suffix Last.fm sometimes echoes from
 * MusicBrainz — these are the same kind of strip iTunes does, kept
 * here so the title we yield matches sibling sources.
 */
function cleanTitle(raw) {
  return (raw || "")
    .replace(/\s*[-–]\s*Single\s*$/i, "")
    .replace(/\s*[-–]\s*EP\s*$/i, "")
    .trim();
}

/**
 * Public API: look up an artist's most recent release on Last.fm.
 *
 * Behaviour:
 *   - Returns [] if the artist's page doesn't have a "Latest release"
 *     section (some artists do, some don't — Last.fm only shows it
 *     when MusicBrainz has a confident-enough release matched).
 *   - Returns [] on a fetch error (404 / 5xx / network) — caller
 *     drops Last.fm for this artist and moves on. Never throws.
 *   - Caps the response to a single release; that's all the page
 *     surfaces.
 */
export async function lookupArtist(artistName) {
  if (!artistName || !artistName.trim()) return [];
  // Last.fm uses + as space and tolerates URL-encoded special chars.
  const slug = encodeURIComponent(artistName.trim()).replace(/%20/g, "+");
  const url = `https://www.last.fm/music/${slug}`;

  let html;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) return [];
    html = await res.text();
  } catch {
    return [];
  }

  // The "Latest release" panel renders consistently as:
  //   <h4 ...>Latest release</h4>
  //   <h3 class="artist-header-featured-items-item-name" itemprop="name">
  //     <a href="/music/<Artist>/<Slug>" ...>Title</a>
  //   <p class="...item-date">DD Month YYYY</p>
  // Anchor on the unique header text and walk forward; bounded `.{0,2000}`
  // to keep the backtracker honest if Last.fm ever inserts unexpected
  // markup between the title and the date. A miss returns [] — same
  // outcome as a 404, which is the right "no signal" behaviour.
  const re =
    /Latest release[\s\S]{0,500}?artist-header-featured-items-item-name[^>]*>[\s\S]{0,500}?<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]{0,2000}?artist-header-featured-items-item-date">\s*([^<]+?)\s*<\/p>/i;
  const m = html.match(re);
  if (!m) return [];

  const [, href, rawTitle, rawDate] = m;
  const title = cleanTitle(rawTitle);
  const releaseDate = parseLastfmDate(rawDate);
  if (!title || !releaseDate) return [];

  return [
    {
      source: "lastfm",
      // Last.fm doesn't expose a stable numeric ID; use the path slug
      // as the source identifier. Stable enough for dedup-by-source.
      sourceId: href.replace(/^\/music\//, ""),
      artist: artistName,
      title,
      releaseType: classifyType(rawTitle),
      releaseDate,
      // Last.fm doesn't host artwork directly on the artist page in a
      // shape we can extract reliably; leave null and let the
      // backfill-embeds pass populate it from iTunes/Deezer match.
      artworkUrl: null,
      // Internal Last.fm URL — not useful as a public deep link.
      // Keeping it null follows the same convention as other sources
      // when the URL isn't a streaming destination.
      externalUrl: null,
      label: "",
      tag: "",
    },
  ];
}
