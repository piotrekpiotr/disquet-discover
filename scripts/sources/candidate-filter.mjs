/**
 * Curator-side genre / artist blacklist for media-candidates.json.
 *
 * Two filters:
 *
 *   1. TAG BLACKLIST — anything the candidate has been tagged with on
 *      Last.fm or Bandcamp Discover that signals off-genre.
 *   2. ARTIST BLACKLIST — exact-match artist names that obviously
 *      don't fit the pool's leftfield-electronic remit (Foo Fighters,
 *      Avicii, etc.). Used as a safety net for cases where the tag
 *      filter misses (artists with no poolTags populated yet, edge
 *      cases where an artist legitimately overlaps with a kept tag).
 *
 * The user-supplied off-genre list as of 2026-04-30:
 *   rock, alternative, indie, country, blues, reggae, pop, folk, EDM,
 *   songwriter, noise.
 *
 * We expand each into the variants Last.fm / Bandcamp actually use so
 * matching is tolerant of formatting ("indie-rock" vs "indie rock" vs
 * "Indie Rock" all hit). The blacklist is intentionally conservative
 * — when a tag is ambiguous between pool fit and off-genre (e.g.
 * "house" can fit deep-house pool members or cover EDM festival
 * house), we DON'T include it. Better to over-include and let the
 * curator dismiss than over-exclude and lose Four Tet to "house".
 */

const TAG_BLACKLIST = new Set(
  [
    // rock family
    "rock",
    "indie rock",
    "indie-rock",
    "alt rock",
    "alt-rock",
    "alternative",
    "alternative rock",
    "alternative-rock",
    "classic rock",
    "post-rock",
    "post rock",
    "math rock",
    "garage rock",
    "punk rock",
    "hard rock",
    "progressive rock",
    "psychedelic rock",
    "rock and roll",
    // indie family
    "indie",
    "indie pop",
    "indie-pop",
    "indie folk",
    "indie-folk",
    // pop family (note: dream-pop sits in our scene sometimes; not blocked)
    "pop",
    "pop rock",
    "art pop",
    "k-pop",
    "kpop",
    "j-pop",
    "jpop",
    "synth-pop",
    "synthpop",
    // country
    "country",
    "country rock",
    "country-rock",
    "americana",
    "alt-country",
    "alt country",
    "bluegrass",
    // blues
    "blues",
    "blues rock",
    "rhythm and blues",
    "delta blues",
    // reggae
    "reggae",
    "dancehall",
    "ska",
    "rocksteady",
    "roots reggae",
    // folk family
    "folk",
    "folk rock",
    "folk-rock",
    "contemporary folk",
    "neofolk",
    "freak folk",
    "anti-folk",
    // EDM family — explicit user request
    "edm",
    "electronic dance music",
    "big room",
    "festival",
    "festival house",
    "mainstage",
    "tropical house",
    "future house",
    "complextro",
    "electro house",
    // songwriter
    "songwriter",
    "singer-songwriter",
    "singer/songwriter",
    "singer songwriter",
    // noise (per user — note our pool has some experimental-noise
    // overlap, but the user explicitly listed "noise" as off-genre).
    "noise",
    "noise rock",
    "noise-rock",
    "harsh noise",
    "japanese noise",
    "power noise",
    "noise pop",
  ].map((s) => s.toLowerCase()),
);

/**
 * Manual artist blacklist — high-profile names that surfaced as
 * candidates but obviously don't fit the curator's remit. Expanded
 * over time as new false-positives are spotted. Comparison is
 * case-insensitive, exact-match, no fuzzy logic — keep it tight to
 * avoid accidentally killing a similarly-named pool artist.
 */
const ARTIST_BLACKLIST = new Set(
  [
    "Avicii",
    "Basement Jaxx",
    "Foo Fighters",
    "Vince Staples",
    "Kacey Musgraves",
    "Lady Gaga",
    "Madonna",
    "Adele",
    "Hayley Williams",
    "Paramore",
    "Olivia Rodrigo",
    "Taylor Swift",
    "Travis Scott",
    "Lizzo",
    "Morrissey",
    "Hunter Biden",
    "Queens Of The Stone Age",
    "Iceage",
    "Foo Fighters",
    "Rocketship",
    "Wednesday",
    "Aldous Harding",
    "Friko",
    "Makthaverskan",
    "Scissor Fits",
    "Prism Shores",
    "Hannah Lew",
    "Eve Maret",
    "Juni Habel",
    "Jimmy Scott",
    "Teen Suicide",
    "Lero Lero",
    "Rosa Pistola",
    "Gelli Haha",
    "Tara Clerkin Trio",
    "Book of Love",
    "White Fence",
    "Plug",
    "Emma Swift",
    "Ruth Garbus",
    "Mikaela Davis",
    "Doechii",
    "Bjarki",
    "John Summit",
    "Charlotte de Witte",
    "USC",
    "Orphan Donor",
    "Fivio Foreign",
    // Add more here as they come up
  ].map((s) => s.toLowerCase()),
);

const PRE_2026_CUTOFF = "2026-01-01";

/**
 * Return the reason a candidate should be filtered out, or null if
 * it should stay. Used by both the at-source filter (skip writing)
 * and the cleanup pass (remove from existing data).
 */
export function reasonToReject({ name, poolTags, latestArticleDate }) {
  if (!name) return "missing artist name";
  if (ARTIST_BLACKLIST.has(name.toLowerCase())) {
    return `artist on manual blacklist`;
  }
  // Pre-Jan-2026 cutoff — only fires when we have a date. Candidates
  // without latestArticleDate stay; the next sync that re-mentions
  // them populates the date and the cleanup runs naturally then.
  if (
    latestArticleDate &&
    typeof latestArticleDate === "string" &&
    latestArticleDate < PRE_2026_CUTOFF
  ) {
    return `latestArticleDate ${latestArticleDate} < ${PRE_2026_CUTOFF}`;
  }
  if (Array.isArray(poolTags) && poolTags.length > 0) {
    for (const tag of poolTags) {
      if (TAG_BLACKLIST.has(String(tag).toLowerCase())) {
        return `pool tag "${tag}" is blacklisted`;
      }
    }
  }
  return null;
}

/**
 * Filter a complete media-candidates.json shape, returning
 * { kept, removed }. `removed` is an array of { name, reason } so
 * a one-shot cleanup run can log what disappeared.
 */
export function filterCandidatesObject(candidates) {
  const kept = {};
  const removed = [];
  for (const [name, v] of Object.entries(candidates || {})) {
    const reason = reasonToReject({ name, ...v });
    if (reason) {
      removed.push({ name, reason });
    } else {
      kept[name] = v;
    }
  }
  return { kept, removed };
}

export { TAG_BLACKLIST, ARTIST_BLACKLIST, PRE_2026_CUTOFF };
