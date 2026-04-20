"use client";
import { useEffect, useState } from "react";

const STORAGE_KEY = "disquet.favorites.v1";
// Custom event name for in-tab sync. The browser's `storage` event only
// fires in OTHER tabs - same-tab updates (Header + FavoriteButton living on
// the same page) must be broadcast manually.
const CHANGE_EVENT = "disquet:favorites-change";

function readFavorites(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function writeFavorites(next: string[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  // Broadcast to every `useFavorites()` subscriber on this page.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function useFavorites() {
  const [favs, setFavs] = useState<string[]>([]);
  useEffect(() => {
    setFavs(readFavorites());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setFavs(readFavorites());
    };
    const onLocal = () => setFavs(readFavorites());
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onLocal);
    };
  }, []);

  const toggle = (id: string) => {
    // Compute from the freshest localStorage value, not from stale state -
    // otherwise two near-simultaneous toggles on different components can
    // race and one gets overwritten.
    const current = readFavorites();
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id];
    writeFavorites(next);
    setFavs(next);
  };

  return { favorites: favs, toggle, isFav: (id: string) => favs.includes(id) };
}

export function FavoriteButton({ id }: { id: string }) {
  const { toggle, isFav } = useFavorites();
  const on = isFav(id);
  return (
    <button
      onClick={() => toggle(id)}
      aria-pressed={on}
      aria-label={on ? "Remove from saved" : "Save"}
      className={`font-mono text-[10px] uppercase tracking-widest border px-3 py-1.5 transition-colors ${
        on
          ? "bg-ink text-paper border-ink"
          : "bg-transparent text-ink border-ink hover:bg-ink hover:text-paper"
      }`}
    >
      {on ? "Saved ●" : "Save ○"}
    </button>
  );
}
