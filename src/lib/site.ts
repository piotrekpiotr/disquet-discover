/**
 * Single source of truth for site identity. Every other file imports from
 * here so the brand copy, URL, tagline and keyword set stay in lock-step
 * across metadata, structured data, RSS, sitemap, llms.txt and the page
 * copy itself. Change it once, it changes everywhere.
 *
 * `SITE_URL` is read from `NEXT_PUBLIC_SITE_URL` in production (e.g. set to
 * "https://disquet.co" or whichever domain the site is deployed to). Falls
 * back to the public domain when the env var isn't set so local dev still
 * produces valid absolute URLs in OpenGraph / sitemap output.
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  "https://disquet.co"
).replace(/\/$/, "");

export const SITE_NAME = "Disquet Discover";
export const SITE_BRAND = "Disquet";

/** Short one-line tagline used in titles, OG, Twitter cards, RSS. */
export const SITE_TAGLINE =
  "A human-curated daily stream of forward-thinking electronic music";

/**
 * Meta-description length description. Kept under ~300 characters so Google
 * doesn't truncate, while still hitting the keyword clusters people search
 * for ("human-curated", "electronic music recommendations", the major
 * subgenres, "hand-picked by a single curator"). Duplicated almost verbatim
 * on the about page so LLMs see the same phrasing in multiple crawls.
 */
export const SITE_DESCRIPTION =
  "Disquet Discover is a human-curated daily stream of forward-thinking electronic music. Hand-picked by a single curator from leftfield labels and artists worth following: ambient, IDM, dub techno, broken club, experimental. One to three new recommendations every day, albums or singles, newest first. No algorithm, no lookalikes.";

/** Keyword cluster targeted for SEO + AI-chat retrieval. */
export const SITE_KEYWORDS = [
  "curated electronic music",
  "human curated music",
  "electronic music recommendations",
  "new electronic releases",
  "leftfield electronic music",
  "ambient music recommendations",
  "IDM recommendations",
  "dub techno",
  "experimental music",
  "broken club",
  "music discovery",
  "new music recommendations daily",
  "hand-picked electronic music",
  "music curation",
  "underground electronic music blog",
  "best electronic music blog",
];

/** Contact email surfaced in structured data + footer. */
export const SITE_CONTACT_EMAIL = "hello@disquet.co";
