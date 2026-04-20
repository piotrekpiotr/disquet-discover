"use client";
import { useState, useTransition } from "react";
import type { FeedPage, Recommendation } from "@/lib/types";
import { RecommendationCard } from "@/components/RecommendationCard";

export function FeedClient({ initial }: { initial: FeedPage }) {
  const [items, setItems] = useState<Recommendation[]>(initial.items);
  const [cursor, setCursor] = useState<string | null>(initial.nextCursor);
  const [hasMore, setHasMore] = useState(initial.hasMore);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const loadMore = () => {
    setError(null);
    startTransition(async () => {
      try {
        const url = `/api/feed${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to load");
        const page = (await res.json()) as FeedPage;
        if (page.items.length === 0) {
          setHasMore(false);
          return;
        }
        setItems((prev) => [...prev, ...page.items]);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  };

  if (items.length === 0) {
    return (
      <div className="px-6 sm:px-8 py-24 text-center font-mono text-[11px] uppercase tracking-widest text-mute">
        No published recommendations yet - the curator hasn&apos;t pushed any to
        the feed.
      </div>
    );
  }

  return (
    <>
      {items.map((rec, i) => (
        <RecommendationCard key={rec.id} rec={rec} index={i} />
      ))}

      <div className="border-t border-ink px-6 sm:px-8 py-16 flex flex-col items-center gap-3">
        {hasMore ? (
          <button
            onClick={loadMore}
            disabled={isPending}
            className="font-display font-black text-[40px] sm:text-[64px] leading-none tracking-tightest border border-ink px-10 sm:px-14 py-6 sm:py-8 hover:bg-ink hover:text-paper transition-colors disabled:opacity-50"
          >
            {isPending ? "Loading…" : "Recommend more"}
          </button>
        ) : (
          <div className="font-mono text-[11px] uppercase tracking-widest text-mute">
            That&apos;s the bottom of the feed for now. Check back tomorrow.
          </div>
        )}
        {error && (
          <div className="font-mono text-[10px] uppercase tracking-widest text-signal">
            {error}
          </div>
        )}
      </div>
    </>
  );
}
