/**
 * sitemap.xml - lists every publicly indexable URL. Generated on demand so
 * newly approved records show up in the sitemap the moment they're
 * published, without a separate build step.
 *
 * Included:
 *   - Home, /about
 *   - Every approved recommendation at /r/[id]
 *
 * Excluded:
 *   - /saved (user-specific, noindex)
 *   - /admin/** (auth-gated, noindex, robots-disallowed)
 *   - /api/** (not a page)
 */
import type { MetadataRoute } from "next";
import { getByStatus } from "@/lib/data";
import { SITE_URL } from "@/lib/site";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const approved = await getByStatus("approved");

  const staticEntries: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/`,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1.0,
    },
    {
      url: `${SITE_URL}/about`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.2,
    },
    {
      url: `${SITE_URL}/terms`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.2,
    },
  ];

  const recordEntries: MetadataRoute.Sitemap = approved.map((r) => ({
    url: `${SITE_URL}/r/${r.id}`,
    // Fall back to releaseDate when there's no approvedAt timestamp.
    lastModified: new Date(r.approvedAt || r.releaseDate),
    changeFrequency: "yearly",
    priority: 0.7,
  }));

  return [...staticEntries, ...recordEntries];
}
