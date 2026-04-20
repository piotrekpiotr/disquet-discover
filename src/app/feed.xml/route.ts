/**
 * RSS feed at /feed.xml. Covers the full approved record list in reverse
 * chronological order by approval date (or release date as fallback).
 *
 * Why RSS in 2026:
 *   - Still the de facto protocol for LLM / news aggregators to pull a
 *     canonical, structured copy of the content.
 *   - Newsletter senders (Substack, Buttondown) can import from RSS.
 *   - Classic feed-readers (Feedbin, Inoreader, NetNewsWire) use it.
 *
 * XML generation is done by hand - the feed is small, the payload is
 * predictable, and pulling in a feed library just to concatenate strings
 * is more risk than benefit.
 */
import { getByStatus } from "@/lib/data";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";

/** XML-escape user-supplied strings. */
function xml(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET() {
  const approved = await getByStatus("approved");

  // Sort: newest approved first, fallback to releaseDate.
  const sorted = [...approved].sort((a, b) => {
    const aT = Date.parse(a.approvedAt || a.releaseDate);
    const bT = Date.parse(b.approvedAt || b.releaseDate);
    return bT - aT;
  });

  // Cap to the latest 100 so /feed.xml is small and predictable. Older
  // records remain reachable via sitemap + site navigation.
  const items = sorted.slice(0, 100);

  const now = new Date().toUTCString();

  const entries = items
    .map((r) => {
      const link = `${SITE_URL}/r/${r.id}`;
      const pub = new Date(r.approvedAt || r.releaseDate).toUTCString();
      const type = r.type === "single" ? "Single" : r.type === "ep" ? "EP" : "Album";
      return `
    <item>
      <title>${xml(`${r.artist} - ${r.title}`)}</title>
      <link>${xml(link)}</link>
      <guid isPermaLink="true">${xml(link)}</guid>
      <pubDate>${xml(pub)}</pubDate>
      <category>${xml(type)}</category>
      ${r.label ? `<category>${xml(r.label)}</category>` : ""}
      <description>${xml(r.description || `${r.artist} - ${r.title} (${type})`)}</description>
    </item>`;
    })
    .join("");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(SITE_NAME)}</title>
    <link>${xml(SITE_URL)}</link>
    <description>${xml(SITE_DESCRIPTION)}</description>
    <language>en</language>
    <lastBuildDate>${now}</lastBuildDate>
    <atom:link href="${xml(`${SITE_URL}/feed.xml`)}" rel="self" type="application/rss+xml" />
    ${entries}
  </channel>
</rss>`;

  return new Response(body, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      // Short cache: the feed is cheap to regenerate and needs to reflect
      // new approvals quickly.
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}

export const dynamic = "force-dynamic";
