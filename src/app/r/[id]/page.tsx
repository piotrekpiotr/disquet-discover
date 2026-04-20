/**
 * Per-record detail page at /r/[id]. These are the bread and butter of the
 * site's SEO / AI-retrieval surface: every approved album or single gets
 * its own indexable, citable URL with full structured data.
 *
 * Each page emits:
 *   - A <title> and <meta description> built from the record copy.
 *   - OpenGraph tags with the cover image so shared links preview well.
 *   - A MusicAlbum / MusicRecording JSON-LD node, linked back to the
 *     site-wide Organization node emitted in layout.tsx.
 *
 * Records that aren't approved (pending / rejected) return 404 so the
 * moderation queue can't be enumerated by ID guessing.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getById, getByStatus } from "@/lib/data";
import { CoverArt } from "@/components/CoverArt";
import { EmbedPlayer } from "@/components/EmbedPlayer";
import { FavoriteButton } from "@/components/FavoriteButton";
import { SITE_URL } from "@/lib/site";
import { recommendationNode, jsonLdScript } from "@/lib/structured-data";

export const dynamic = "force-dynamic";

function typeLabel(t: "single" | "album" | "ep") {
  return t === "single" ? "Single" : t === "ep" ? "EP" : "Album";
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const rec = await getById(params.id, true);
  if (!rec) return { title: "Not found", robots: { index: false, follow: false } };

  const kind = typeLabel(rec.type).toLowerCase();
  const year = (rec.releaseDate || "").slice(0, 4);
  const title = `${rec.artist} - ${rec.title} (${rec.label || kind}${year ? `, ${year}` : ""})`;
  const description =
    rec.description ||
    `${rec.artist} - ${rec.title}. A curator's pick on Disquet Discover, the human-curated daily stream of forward-thinking electronic music.`;

  return {
    title,
    description,
    alternates: { canonical: `/r/${rec.id}` },
    openGraph: {
      type: "article",
      title,
      description,
      url: `${SITE_URL}/r/${rec.id}`,
      ...(rec.coverImageUrl ? { images: [{ url: rec.coverImageUrl }] } : {}),
    },
    twitter: {
      card: rec.coverImageUrl ? "summary_large_image" : "summary",
      title,
      description,
      ...(rec.coverImageUrl ? { images: [rec.coverImageUrl] } : {}),
    },
    keywords: [rec.artist, rec.title, rec.label, ...(rec.tags || [])].filter(
      Boolean,
    ) as string[],
  };
}

/**
 * Limit pre-rendering to the first N approved records at build time - the
 * rest render on demand the first time they're visited (and get cached by
 * the Next.js runtime). Avoids a slow build when the catalog grows.
 */
export async function generateStaticParams() {
  const approved = await getByStatus("approved");
  return approved.slice(0, 50).map((r) => ({ id: r.id }));
}

export default async function RecordPage({ params }: { params: { id: string } }) {
  const rec = await getById(params.id, true);
  if (!rec) notFound();

  const jsonLd = recommendationNode(rec);

  return (
    <article className="px-6 sm:px-8 pt-12 sm:pt-20 pb-24 max-w-6xl">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />

      <nav className="font-mono text-[10px] uppercase tracking-widest text-mute mb-8 flex gap-3">
        <Link href="/" className="hover:text-ink border-b border-transparent hover:border-ink">
          Feed
        </Link>
        <span>/</span>
        <span className="text-ink">{typeLabel(rec.type)}</span>
      </nav>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-10">
        <div className="md:col-span-5">
          <div className="max-w-[520px]">
            <CoverArt rec={rec} />
          </div>
        </div>

        <div className="md:col-span-7 flex flex-col gap-6">
          <header className="flex flex-col gap-3">
            <div className="font-mono text-[10px] uppercase tracking-widest text-mute flex gap-3 flex-wrap">
              <span>{typeLabel(rec.type)}</span>
              <span>·</span>
              <span>{formatDate(rec.releaseDate)}</span>
              {rec.label && (
                <>
                  <span>·</span>
                  <span>{rec.label}</span>
                </>
              )}
            </div>
            <h1
              className="font-display font-black text-[44px] sm:text-[72px] leading-[0.95] mt-[-0.1em]"
              style={{ letterSpacing: "-0.035em" }}
            >
              {rec.artist}
              <span
                className="font-serif italic font-normal text-mute text-[0.55em] block leading-[1.15] mt-2"
                style={{ letterSpacing: "0.005em" }}
              >
                {rec.title}
              </span>
            </h1>
          </header>

          {rec.description && (
            <p className="font-body text-[18px] sm:text-[20px] leading-[1.5] max-w-[58ch]">
              {rec.description}
            </p>
          )}

          {rec.tags.length > 0 && (
            <ul className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-mute">
              {rec.tags.map((t) => (
                <li key={t}>- {t}</li>
              ))}
            </ul>
          )}

          <EmbedPlayer
            embed={rec.embed}
            musicVideoUrl={rec.type === "single" ? rec.musicVideoUrl : null}
            links={rec.links}
            searchQuery={`${rec.artist} ${rec.title}`}
          />

          <div className="pt-2">
            <FavoriteButton id={rec.id} />
          </div>
        </div>
      </div>
    </article>
  );
}
