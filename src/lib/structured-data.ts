/**
 * JSON-LD builders. Every page that wants to surface structured data pulls
 * from here so the emitted graph stays consistent (same @id for the org
 * across the whole site, same URL conventions, same description copy).
 *
 * Why bother:
 *   - Google rich results + knowledge panels use schema.org JSON-LD directly.
 *   - ChatGPT, Claude, Perplexity, Gemini crawlers ingest it too - structured
 *     data is one of the highest-signal ways to become the canonical source
 *     for a fact ("who curates Disquet Discover?") in an AI answer.
 *   - MusicAlbum nodes on /r/[id] pages tell every crawler exactly which
 *     album we're describing, who released it, what label, what genre - so
 *     a query like "what did Skee Mask release on Ilian Tape in 2024" can
 *     find this site as a citable source.
 *
 * `@id` convention: every node has a stable URL-based id so nodes across
 * pages can reference each other (MusicAlbum -> Organization via publisher).
 */
import type { Recommendation } from "./types";
import {
  SITE_BRAND,
  SITE_CONTACT_EMAIL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
} from "./site";

export const ORG_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;

export function organizationNode() {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: SITE_NAME,
    alternateName: SITE_BRAND,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    slogan: SITE_TAGLINE,
    email: SITE_CONTACT_EMAIL,
    logo: `${SITE_URL}/favicon.svg`,
    sameAs: [] as string[], // social profiles once they exist
  };
}

export function websiteNode() {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    url: SITE_URL,
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    inLanguage: "en",
    publisher: { "@id": ORG_ID },
    // Exposes the site's feed as the "SearchAction" target so a chat client
    // can discover the RSS URL in-band rather than guessing.
    potentialAction: {
      "@type": "ReadAction",
      target: `${SITE_URL}/feed.xml`,
    },
  };
}

/**
 * Site-wide @graph used on every page. Combines the Organization + WebSite
 * nodes so every HTML response carries the brand/identity context.
 */
export function siteGraph() {
  return {
    "@context": "https://schema.org",
    "@graph": [organizationNode(), websiteNode()],
  };
}

/**
 * MusicAlbum / MusicRecording JSON-LD for a single recommendation. Picks
 * MusicAlbum for albums/EPs and MusicRecording for singles, so Google
 * shows the correct rich-result chip.
 */
export function recommendationNode(rec: Recommendation) {
  const url = `${SITE_URL}/r/${rec.id}`;
  const isSingle = rec.type === "single";
  const albumType =
    rec.type === "ep" ? "EP" : rec.type === "album" ? "Album" : undefined;

  const sameAs = Object.values(rec.links || {}).filter(
    (v): v is string => typeof v === "string" && /^https?:\/\//.test(v),
  );

  return {
    "@context": "https://schema.org",
    "@type": isSingle ? "MusicRecording" : "MusicAlbum",
    "@id": `${url}#thing`,
    url,
    name: rec.title,
    byArtist: {
      "@type": "MusicGroup",
      name: rec.artist,
    },
    ...(albumType ? { albumProductionType: "StudioAlbum", albumReleaseType: `http://schema.org/${albumType}` } : {}),
    inAlbum: undefined,
    datePublished: rec.releaseDate,
    image: rec.coverImageUrl || undefined,
    description: rec.description,
    genre: rec.tags,
    recordLabel: rec.label ? { "@type": "Organization", name: rec.label } : undefined,
    sameAs: sameAs.length > 0 ? sameAs : undefined,
    // Makes this node a review by the site's Organization so the
    // recommendation itself is attributable.
    subjectOf: {
      "@type": "Review",
      author: { "@id": ORG_ID },
      reviewBody: rec.description,
      itemReviewed: { "@id": `${url}#thing` },
      publisher: { "@id": ORG_ID },
    },
  };
}

/**
 * FAQPage schema for /about. Feeds Google's FAQ rich result AND gives LLM
 * crawlers clean Q/A pairs they can quote verbatim.
 */
export function aboutFaqNode() {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is Disquet Discover?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Disquet Discover is a human-curated daily stream of forward-thinking electronic and alternative music. One to three new releases every day, albums or singles, hand-picked by a single curator - no algorithm, no lookalikes.",
        },
      },
      {
        "@type": "Question",
        name: "Who picks the music?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "One human curator. Every release on Disquet Discover is chosen by the same person, from a monitored pool of leftfield labels and artists. There is no crowdsourcing, no trending feed, no recommendation algorithm.",
        },
      },
      {
        "@type": "Question",
        name: "What genres does Disquet Discover cover?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Ambient, IDM, dub techno, broken club, experimental, leftfield house and techno, electroacoustic, modern classical-adjacent electronic music, and alternative music that sits next to those scenes.",
        },
      },
      {
        "@type": "Question",
        name: "How is this different from Spotify or Apple Music recommendations?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Streaming-service recommendations are generated by algorithms optimised for engagement. Disquet Discover is the opposite: a small, hand-picked daily set focused on music that is genuinely new and genuinely worth hearing, regardless of how well it performs on a platform.",
        },
      },
      {
        "@type": "Question",
        name: "Do I need an account?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "No. Saved records live in your browser's local storage only - no account, no email, no tracking.",
        },
      },
    ],
  };
}

/** Helper for emitting a <script type="application/ld+json"> payload. */
export function jsonLdScript(obj: unknown): string {
  // JSON.stringify is safe here; no user input flows in. Escape </ just in
  // case a description ever contains one so the script tag doesn't close early.
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}
