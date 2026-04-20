"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { Recommendation } from "@/lib/types";
import { useFavorites } from "@/components/FavoriteButton";
import { RecommendationCard } from "@/components/RecommendationCard";

/**
 * Client-side loader for the /saved page. Reads the user's favourite IDs
 * from localStorage, fetches the matching records, and renders them using
 * the same card component as the main feed.
 *
 * Three UI states:
 *   - loading : spinner-esque status line while the fetch is in flight
 *   - empty   : friendly pointer back to the feed
 *   - list    : the RecommendationCard stack, newest releaseDate first
 */
export function SavedClient() {
  const { favorites } = useFavorites();
  const [items, setItems] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (favorites.length === 0) {
      setItems([]);
      return;
    }
    setItems(null);
    setError(null);
    const qs = encodeURIComponent(favorites.join(","));
    fetch(`/api/saved?ids=${qs}`, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json: { items: Recommendation[] }) => {
        if (cancelled) return;
        // Sort newest releaseDate first, matching the main feed.
        const sorted = [...(json.items || [])].sort((a, b) =>
          b.releaseDate.localeCompare(a.releaseDate),
        );
        setItems(sorted);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load saved records");
        setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [favorites]);

  if (items === null) {
    return (
      <div className="px-6 sm:px-8 py-24 text-center font-mono text-[11px] uppercase tracking-widest text-mute">
        Loading your saved records…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="px-6 sm:px-8 py-24 flex flex-col items-center gap-4 text-center">
        <div className="font-mono text-[11px] uppercase tracking-widest text-mute">
          Nothing saved yet.
        </div>
        <p className="font-body text-[17px] sm:text-[19px] leading-[1.45] max-w-[48ch] text-ink">
          Hit <span className="font-mono text-[12px] uppercase tracking-widest">Save</span> on
          anything in the feed and it&apos;ll collect here for later.
        </p>
        <Link
          href="/"
          className="mt-2 font-mono text-[10px] uppercase tracking-widest border border-ink px-5 py-2 hover:bg-ink hover:text-paper transition-colors"
        >
          Back to the feed
        </Link>
        {error && (
          <div className="font-mono text-[10px] uppercase tracking-widest text-signal">
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {items.map((rec, i) => (
        <RecommendationCard key={rec.id} rec={rec} index={i} />
      ))}
      <div className="border-t border-ink px-6 sm:px-8 py-16 flex flex-col items-center gap-3">
        <div className="font-mono text-[11px] uppercase tracking-widest text-mute">
          End of your saved list.
        </div>
      </div>
    </>
  );
}
