import { NextRequest, NextResponse } from "next/server";
import { addItem } from "@/lib/data";
import type { Recommendation, ReleaseType } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/pool/add — admin-only "add a release to the pool by hand".
 *
 * Why:
 *   The daily syncs (iTunes + Discogs) cover monitored artists / labels, but
 *   sometimes a record lands outside that net — a friend's release, a label
 *   we don't yet track, a tip from a reader. Rather than push a new artist
 *   to monitoring and wait a day, the curator pastes a URL here and the
 *   record shows up in Pool immediately, fully enriched (cover, label,
 *   release date, tags, embed, Bandcamp fallback description).
 *
 * Input (one of):
 *   { url: "https://music.apple.com/..." }          — resolves via iTunes lookup
 *   { url: "https://<artist>.bandcamp.com/album/..." } — scrapes the Bandcamp page
 *   { artist: "X", title: "Y" }                    — runs an iTunes search for a best match
 *
 * Output:
 *   200 { item: Recommendation } on success.
 *   4xx with { error } when the URL / query doesn't resolve to a single
 *   unambiguous release, or a record with that slug already exists.
 *
 * Auth: behind /api/pool middleware prefix (admin only).
 *
 * Note: we don't attempt label-canon enrichment or AI description generation
 * here — the created record lands with everything iTunes/Bandcamp gave us,
 * and the curator can click the existing "Regenerate description" button in
 * the admin UI if they want fresh copy. Keeping this endpoint synchronous
 * and quick matters more than being maximally enriched up-front.
 */

const UA = "disquet-discover/1.0 +admin-add";

export async function POST(req: NextRequest) {
  let body: { url?: string; artist?: string; title?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const url = (body.url || "").trim();
  const artist = (body.artist || "").trim();
  const title = (body.title || "").trim();

  if (!url && !(artist && title)) {
    return NextResponse.json(
      { error: "Provide a URL, or both artist and title." },
      { status: 400 },
    );
  }

  let rec: Recommendation | null = null;
  try {
    if (/^https?:\/\/music\.apple\.com\//i.test(url)) {
      rec = await fromAppleUrl(url);
    } else if (/^https?:\/\/[^/]+\.bandcamp\.com\/(album|track)\//i.test(url)) {
      rec = await fromBandcampUrl(url);
    } else if (artist && title) {
      rec = await fromArtistTitle(artist, title);
    } else {
      return NextResponse.json(
        { error: "URL must be Apple Music or Bandcamp, or supply artist + title." },
        { status: 400 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "resolution failed" },
      { status: 502 },
    );
  }

  if (!rec) {
    return NextResponse.json(
      { error: "Couldn't resolve a release from that input." },
      { status: 404 },
    );
  }

  const saved = await addItem(rec);
  if (!saved) {
    return NextResponse.json(
      { error: `A record with id '${rec.id}' already exists in the pool.` },
      { status: 409 },
    );
  }
  return NextResponse.json({ item: saved });
}

/* ---------- Apple Music URL path ---------- */

/**
 * Apple Music URLs end with `/id<number>`. We pull the numeric id and hit
 * the `lookup` endpoint which returns exactly the release + its tracks.
 * Using lookup (not search) avoids having to fuzzy-match names — the id IS
 * the canonical pointer.
 */
async function fromAppleUrl(url: string): Promise<Recommendation | null> {
  const m = url.match(/\/id(\d+)/);
  if (!m) throw new Error("Apple URL doesn't contain a release id (…/id<number>)");
  const collectionId = m[1];
  const res = await fetch(
    `https://itunes.apple.com/lookup?id=${collectionId}&entity=album`,
    { headers: { "User-Agent": UA } },
  );
  if (!res.ok) throw new Error(`iTunes lookup ${res.status}`);
  const json = (await res.json()) as {
    resultCount: number;
    results: Array<Record<string, unknown>>;
  };
  // The lookup response is [collection, track1, track2...]. The first result
  // with wrapperType === "collection" is what we want.
  const col =
    json.results.find((r) => r.wrapperType === "collection") ||
    json.results[0];
  if (!col) throw new Error("Apple lookup returned no collection");
  return appleCollectionToRecord(col, url);
}

/* ---------- iTunes search path ---------- */

async function fromArtistTitle(
  artist: string,
  title: string,
): Promise<Recommendation | null> {
  const term = encodeURIComponent(`${artist} ${title}`);
  const res = await fetch(
    `https://itunes.apple.com/search?term=${term}&entity=album&limit=20&media=music`,
    { headers: { "User-Agent": UA } },
  );
  if (!res.ok) throw new Error(`iTunes search ${res.status}`);
  const json = (await res.json()) as {
    results: Array<Record<string, unknown>>;
  };
  const normA = norm(artist);
  const normT = norm(title);
  const hit = json.results.find((r) => {
    const a = norm(String(r.artistName || ""));
    const t = norm(String(r.collectionName || r.trackName || ""));
    return a.includes(normA) && (t.includes(normT) || normT.includes(t));
  });
  if (!hit) return null;
  return appleCollectionToRecord(hit);
}

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function appleCollectionToRecord(
  col: Record<string, unknown>,
  originalUrl = "",
): Recommendation {
  const artist = String(col.artistName || "");
  const rawTitle = String(col.collectionName || col.trackName || "");
  const title = rawTitle
    .replace(/\s*-\s*Single$/i, "")
    .replace(/\s*-\s*EP$/i, "")
    .trim();
  const apple = (
    (col.collectionViewUrl as string) ||
    (col.trackViewUrl as string) ||
    originalUrl ||
    ""
  ).split("?")[0];
  const releaseDate = String(col.releaseDate || "").slice(0, 10) || isoToday();
  const tag = String(col.primaryGenreName || "").toLowerCase();
  const trackCount = Number(col.trackCount) || 0;
  const type: ReleaseType = /-\s*single$/i.test(rawTitle)
    ? "single"
    : /-\s*ep$/i.test(rawTitle)
      ? "ep"
      : trackCount > 0 && trackCount <= 3
        ? "single"
        : trackCount > 0 && trackCount <= 6
          ? "ep"
          : "album";
  const art = (col.artworkUrl100 as string | undefined)?.replace(
    /\/\d+x\d+(bb)?\./,
    "/600x600bb.",
  );
  const id = slugify(`${artist}-${title}`).slice(0, 80);
  const search = searchUrls(artist, title);
  return {
    id,
    type,
    artist,
    title,
    label: labelFromCopyright(String(col.copyright || "")),
    releaseDate,
    description: "",
    tags: tag ? [tag] : [],
    links: {
      apple: apple || undefined,
      bandcamp: search.bandcamp,
      spotify: search.spotify,
      soundcloud: search.soundcloud,
      youtube: search.youtube,
    },
    embed: null,
    musicVideoUrl: null,
    status: "pending",
    approvedAt: null,
    coverImageUrl: art || null,
    cover: { bg: "#111110", fg: "#f2efe8", motif: "disc" },
    pressMentions: [],
  };
}

/* ---------- Bandcamp URL path ---------- */

/**
 * Bandcamp pages expose a JSON-LD <script> with the release's structured
 * data — title, artist, label (publisher), releaseDate, cover image. We
 * parse that rather than a dozen regexes across the HTML; JSON-LD on
 * Bandcamp is stable and has been for years.
 */
async function fromBandcampUrl(url: string): Promise<Recommendation | null> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) throw new Error(`Bandcamp ${res.status}`);
  const html = await res.text();

  const ld = extractJsonLd(html);
  const og = extractOg(html);

  const title = cleanTitle(
    (typeof ld?.name === "string" ? ld.name : "") || og.title || "",
  );
  const artist =
    (ld?.byArtist && typeof ld.byArtist === "object"
      ? String((ld.byArtist as { name?: string }).name || "")
      : "") || og.artist;
  if (!artist || !title)
    throw new Error("Couldn't read artist/title from Bandcamp page");

  const label =
    ld?.publisher && typeof ld.publisher === "object"
      ? String((ld.publisher as { name?: string }).name || "")
      : "";
  const releaseDate = (ld?.datePublished as string | undefined)?.slice(0, 10) ||
    (ld?.albumRelease as Array<{ datePublished?: string }> | undefined)?.[0]
      ?.datePublished?.slice(0, 10) ||
    og.date ||
    isoToday();
  const image = (ld?.image as string | string[] | undefined);
  const coverImageUrl = Array.isArray(image) ? image[0] : image || og.image || null;
  const description = (ld?.description as string | undefined) || og.description || "";

  const type: ReleaseType = /\/track\//.test(url) ? "single" : "album";
  const id = slugify(`${artist}-${title}`).slice(0, 80);
  const search = searchUrls(artist, title);
  return {
    id,
    type,
    artist,
    title,
    label,
    releaseDate,
    // Pre-fill with Bandcamp's own blurb. Curator can click Regenerate for
    // a Claude-written version in the site's voice; the raw text is still
    // a decent first-pass and makes the record scannable immediately.
    description: (description || "").slice(0, 500),
    descriptionPreview: Boolean(description),
    tags: [],
    links: {
      bandcamp: url.split("?")[0],
      spotify: search.spotify,
      apple: search.apple,
      soundcloud: search.soundcloud,
      youtube: search.youtube,
    },
    embed: null,
    musicVideoUrl: null,
    status: "pending",
    approvedAt: null,
    coverImageUrl: coverImageUrl || null,
    cover: { bg: "#111110", fg: "#f2efe8", motif: "disc" },
    pressMentions: [],
  };
}

function extractJsonLd(html: string): Record<string, unknown> | null {
  // Grab every ld+json block; the release one has @type MusicAlbum / MusicRecording.
  const blocks = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  for (const m of blocks) {
    try {
      const parsed = JSON.parse(m[1]);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        if (!c || typeof c !== "object") continue;
        const t = (c as { "@type"?: string | string[] })["@type"];
        const types = Array.isArray(t) ? t : [t];
        if (types.some((x) => typeof x === "string" && /music/i.test(x))) {
          return c as Record<string, unknown>;
        }
      }
    } catch {
      /* ignore unparseable block */
    }
  }
  return null;
}

function extractOg(html: string) {
  const pick = (prop: string) =>
    html.match(
      new RegExp(
        `<meta\\s+property=["']${prop}["']\\s+content=["']([^"']+)["']`,
        "i",
      ),
    )?.[1] || "";
  const rawTitle = pick("og:title");
  // Bandcamp uses "Title, by Artist" in og:title.
  let artist = "";
  let title = rawTitle;
  const byMatch = rawTitle.match(/^(.*),\s*by\s+(.*)$/i);
  if (byMatch) {
    title = byMatch[1].trim();
    artist = byMatch[2].trim();
  }
  return {
    title,
    artist,
    image: pick("og:image"),
    description: pick("og:description"),
    date:
      html
        .match(/released\s+([A-Z][a-z]+ \d{1,2},\s*\d{4})/)?.[1]
        ?.replace(/,/g, "") || "",
  };
}

/* ---------- shared helpers ---------- */

function slugify(s: string) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function labelFromCopyright(c: string) {
  if (!c) return "";
  return c
    .replace(/[℗©]/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitle(s: string) {
  return (s || "")
    .replace(/\s*-\s*Single$/i, "")
    .replace(/\s*-\s*EP$/i, "")
    .trim();
}

function searchUrls(artist: string, title: string) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return {
    apple: `https://music.apple.com/search?term=${q}`,
    bandcamp: `https://bandcamp.com/search?q=${q}&item_type=a`,
    spotify: `https://open.spotify.com/search/${q}`,
    soundcloud: `https://soundcloud.com/search?q=${q}`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
  };
}

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
