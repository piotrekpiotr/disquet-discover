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

/**
 * STRICT tags: high-confidence off-genre signals that an iTunes /
 * Deezer / Last.fm record carries. Safe to apply at INGESTION time
 * (sync-artists) and in the cleanup script — these tags don't appear
 * on legitimate pool material.
 *
 * Excluded (intentionally) from STRICT but kept in the broader
 * TAG_BLACKLIST below: bare "alternative", "indie", "pop", "dance" —
 * iTunes uses these as catch-all categories. Real pool members ride
 * with them sometimes (James Blake → "alternative", Andrea → "pop",
 * DJ Koze remix → "dance"), so we cannot safely auto-drop on those
 * alone. Candidates pass through the BROAD list (we don't trust
 * their pool membership yet); pool ingestion does not.
 */
const TAG_BLACKLIST_STRICT = new Set(
  [
    // rock family — specific subgenres are reliable; bare "rock" too
    // (iTunes never tags an electronic pool member as plain "rock").
    "rock",
    "indie rock",
    "indie-rock",
    "alt rock",
    "alt-rock",
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
    // indie family — bare "indie" is too broad (pool dream-pop gets it).
    "indie pop",
    "indie-pop",
    "indie folk",
    "indie-folk",
    // specific-language pop / specific subgenre pop
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
    // acoustic / classical / orchestral. Some pool members brush
    // modern-composition territory (Kali Malone, Caterina Barbieri),
    // but they ride in tagged "electronic" / "drone" / "minimalism"
    // not "classical" — so blocking the plain "classical" tag is safe.
    "acoustic",
    "classical",
    "classical crossover",
    "neoclassical",
    "neoclassical new age",
    "modern classical",
    "orchestral",
    "chamber music",
    "chamber pop",
    "opera",
    // film / soundtrack — score albums are routinely tagged this way
    // and don't fit the curator's club-leaning remit.
    "film",
    "film score",
    "score",
    "soundtrack",
    "ost",
    "movie",
    "movie score",
    "video game music",
    // dance — specific subgenres only in STRICT. Bare "dance" lives
    // in the BROAD list (we have one approved "dance"-tagged record,
    // can't auto-drop).
    "dance pop",
    "dance-pop",
    "dance rock",
    "eurodance",
    // french / latin / italo pop variants that surfaced on real
    // pool releases via collab credits ("Alee & NooN").
    "french pop",
    "french-pop",
    "italo pop",
    "italian pop",
    "latin pop",
    "spanish pop",
    "j-rock",
    "jrock",
    "k-rock",
    "krock",
  ].map((s) => s.toLowerCase()),
);

/**
 * BROAD tags: catch-all genre buckets iTunes / Last.fm apply
 * inconsistently. Used by candidate filtering (where the artist
 * hasn't been curator-vetted yet, so we err on the side of dropping
 * borderline cases), NOT by sync-artists ingestion (where curator
 * intent to monitor wins).
 */
const TAG_BLACKLIST_BROAD = new Set(
  [
    "alternative",
    "indie",
    "pop",
    "dance",
  ].map((s) => s.toLowerCase()),
);

/**
 * Full blacklist = STRICT ∪ BROAD. Used by sync-media candidate
 * filtering. Sync-artists imports TAG_BLACKLIST_STRICT directly.
 */
const TAG_BLACKLIST = new Set([
  ...TAG_BLACKLIST_STRICT,
  ...TAG_BLACKLIST_BROAD,
]);

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
    // 2026-05-20: previously auto-promoted into monitoring-extras-auto
    // but off-genre. Removed from extras AND parked here so the
    // sync-media auto-promote pass can't re-introduce them. ("Aldous
    // Harding" and "Tara Clerkin Trio" already lived above too — Set
    // dedupes so the doubles are harmless.)
    "Kevin Morby",
    "Quiet Light",
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

/**
 * Article-text genre signals.
 *
 * Used by sync-media to filter press-feed entries before they
 * accumulate into a candidate. A Pitchfork review headline like
 * "<artist>: <album> - reggae record reviewed" reliably points at
 * a release the curator doesn't want. We scan the article's title +
 * description for compound off-genre phrases (multi-word patterns
 * with word boundaries — bare "rock" or "pop" would over-match
 * common prose) and skip the mention if any pattern fires.
 *
 * Skipping a single article-level mention is safer than dropping
 * the candidate outright: a legit electronic artist who happens to
 * appear in a reggae-review article will get other mentions in
 * other articles and surface normally. An artist who ONLY appears
 * in off-genre articles never accumulates enough on-genre evidence
 * to auto-promote — which is the desired outcome.
 *
 * Patterns are tuned for press-prose, not for poolTags / iTunes
 * tags. Those are handled by TAG_BLACKLIST above.
 */
const TEXT_GENRE_REJECT_PATTERNS = [
  // reggae family
  /\breggae\b/i,
  /\bdancehall\b/i,
  /\broots\s+(?:reggae|rock\s+reggae)\b/i,
  /\bska\s+(?:band|revival|punk|record|album)\b/i,
  // country / americana / bluegrass
  /\bcountry\s+(?:music|singer|album|band|musician|star|record|guitarist|legend)\b/i,
  /\bamericana\b/i,
  /\bbluegrass\b/i,
  // blues
  /\bblues\s+(?:musician|singer|album|band|guitarist|harmonica|legend|record)\b/i,
  /\bdelta\s+blues\b/i,
  // folk
  /\bfolk\s+(?:singer|musician|album|band|record|guitarist|tradition|revival)\b/i,
  /\bsinger[-\s]?songwriter\b/i,
  /\bcontemporary\s+folk\b/i,
  /\bneofolk\b/i,
  // rock — only multi-word forms (bare "rock" would catch "post-rock"
  // pool members or "rock-solid" non-genre prose).
  /\brock\s+(?:band|album|record|guitarist|legend|star|drummer|outfit|veteran|act)\b/i,
  /\bclassic\s+rock\b/i,
  /\bgarage\s+rock\b/i,
  /\bpsychedelic\s+rock\b/i,
  /\bprogressive\s+rock\b/i,
  /\bhard\s+rock\b/i,
  /\barena\s+rock\b/i,
  /\bsouthern\s+rock\b/i,
  // metal
  /\b(?:heavy|death|black|doom|thrash|nu|glam)\s+metal\b/i,
  /\bmetal\s+(?:band|album|record)\b/i,
  // punk — bare "punk" can show up around no-wave / industrial talk;
  // require a band/album/genre qualifier.
  /\bpunk\s+(?:band|rock|album|record|revival|scene)\b/i,
  /\bhardcore\s+(?:punk|band|scene|revival)\b/i,
  // classical / orchestral / opera
  /\bclassical\s+(?:pianist|composer|music|musician|guitarist|piece)\b/i,
  /\borchestral\b/i,
  /\bsymphony\s+(?:orchestra|hall|no\.)/i,
  /\bopera(?:tic)?\s+(?:singer|composer|production|company|company)\b/i,
  /\bchamber\s+music\b/i,
  /\bneoclassical\b/i,
  // film / soundtrack
  /\bsoundtrack\b/i,
  /\bfilm\s+score\b/i,
  /\boriginal\s+score\b/i,
  /\bost\s+(?:album|release)\b/i,
  /\bscored\s+the\s+film\b/i,
  /\bmovie\s+(?:score|soundtrack)\b/i,
  // k-pop / j-pop / specific-language pop
  /\bk[-\s]?pop\b/i,
  /\bj[-\s]?pop\b/i,
  /\bj[-\s]?rock\b/i,
  /\bk[-\s]?rock\b/i,
  /\bfrench\s+pop\b/i,
  /\bitalo\s+pop\b/i,
  /\blatin\s+pop\b/i,
];

/**
 * Returns the first matched off-genre signal (for logging) or null
 * if the article text reads as on-genre / neutral.
 */
export function articleTextSignalsOffGenre(text) {
  if (!text || typeof text !== "string") return null;
  for (const pat of TEXT_GENRE_REJECT_PATTERNS) {
    const m = text.match(pat);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

export {
  TAG_BLACKLIST,
  TAG_BLACKLIST_STRICT,
  TAG_BLACKLIST_BROAD,
  ARTIST_BLACKLIST,
  PRE_2026_CUTOFF,
  TEXT_GENRE_REJECT_PATTERNS,
};
