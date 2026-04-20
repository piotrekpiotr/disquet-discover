# Disquet Discover - Phase 1 (local)

A small, curated stream of new electronic releases. Public feed shows 5 at a
time (2 singles + 3 albums/EPs, newest release-date first). An admin panel
shows 15 at a time and lets you approve/reject items into the public pool.

## Run

```bash
npm install
npm run dev
```

Then open:

- <http://localhost:3000> - public feed
- <http://localhost:3000/admin> - admin curation panel
- <http://localhost:3000/about> - about

## What's here (Phase 1)

- Brand-faithful layout in Next.js 14 (App Router) + Tailwind 3
- ~40 hand-built seed recommendations spanning the labels and artists from
  the brief; ~15 are pre-approved so the public feed is alive immediately
- File-backed JSON store at `data/recommendations.json` (mutable from admin)
- Admin curation: approve / reject / reset, paginated 15 at a time, filter
  by Pool / Published / Rejected / All
- Favorites stored in browser `localStorage` (no account)
- About page

## What's not here yet (Phase 2)

- Real crawler - daily ingestion from label Bandcamp pages, Spotify API,
  YouTube Data API, RSS feeds (RA, NTS), label newsletters
- Auto-written editorial descriptions from verified metadata
- Real Bandcamp / Spotify / YouTube embeds (current items show a placeholder
  cover and link out; no inline player until real release IDs are wired in)
- Persistent backend (Supabase / Postgres) and real cron
- Account-based favorites (only if needed - localStorage is the default)

## Notes on the seed data

Releases are plausible but **not real** - they reference real artists and
labels in the user's brief but the catalog numbers, descriptions and tags are
written as placeholders to make the product testable end-to-end. Replace by
wiring the crawler in Phase 2.

## Files of note

- `data/recommendations.json` - the source of truth (mutable)
- `src/lib/data.ts` - JSON read/write + paging logic
- `src/app/api/feed/route.ts` - public feed (5/page, 2 singles + 3 long-form)
- `src/app/api/pool/route.ts` - admin pool (15/page, status-filtered)
- `src/app/api/curate/route.ts` - POST `{id, status}` to publish/reject
- `src/components/RecommendationCard.tsx` - public feed card
- `src/components/CoverArt.tsx` - deterministic placeholder covers
