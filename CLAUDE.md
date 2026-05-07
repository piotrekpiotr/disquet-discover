# Disquet Discover — Project Memory

> Read this first at the start of every Claude Code session.
> It's the curator's accumulated decisions, conventions, and active
> work-in-progress, distilled so a fresh session doesn't waste the
> first hour rediscovering what we already know.

## What this site is

A human-curated daily stream of forward-thinking electronic music.
Single curator (the user). Public feed at `https://disquet.co`.
Hosted on **Railway** (NOT Vercel — confirmed by `vercel.json` only
existing as a schema marker; `package.json` start script is
`node scripts/seed-volume.mjs && next start -p 3000`). Cloudflare in
front of Railway as edge / CDN.

## Stack

- Next.js 14 App Router, TypeScript, React 18, Tailwind 3.
- Data layer: JSON files in `data/` (no DB). Persisted on Railway
  volume. Module-level cache in `src/lib/data.ts` invalidates on
  file mtime change.
- Newsletter: Buttondown (paid Premium tier on the curator's account).
  POST `/v1/emails` creates a DRAFT — curator publishes manually from
  buttondown.com. Documented in `src/lib/newsletter.ts`.
- LLM: Anthropic API. Model env: `DISQUET_MODEL` (defaults to
  `claude-sonnet-4-6`). Used for:
  - Daily description writing (`scripts/write-descriptions.mjs`)
  - On-demand regenerate (`/api/regenerate-description`)
  - Rewrite from curator's pasted notes (`/api/rewrite-description`)
- Scheduling: GitHub Actions (`daily-generate.yml`), 04:00 + 11:00 UTC.
  Push race fixed with retry-on-rejection logic.

## Daily-sync pipeline (CI-driven)

`.github/workflows/daily-generate.yml` runs:

1. **`scripts/sync-artists.mjs`** — 6-worker concurrent queue over
   `monitoring.mjs::ARTISTS`. Three sources per artist: iTunes (primary),
   Deezer (fallback when iTunes empty), Last.fm releases (always —
   scrapes artist page's "Latest release" pointer). 250ms intra-batch
   pacing.
2. **`scripts/sync-labels.mjs`** — Two passes:
   - Discogs label search (default `PER_LABEL_LIMIT=5`, 1050ms pacing
     with token).
   - **Bandcamp-label** pass (NEW 2026-04-30): for every label with a
     band_id in `LABEL_BANDCAMP_BAND_IDS`, queries Bandcamp's mobile
     API (`bandcamp.com/api/mobile/22/band_details?band_id=<id>`) for
     full discography including pre-orders. Catches digital releases
     Discogs hasn't catalogued yet.
3. **`scripts/sync-media.mjs`** — Press feeds (12 sources, parallel
   fetch via `Promise.all`):
   - Pitchfork: `feed-album-reviews/rss`, `feed-track-reviews/rss`,
     `reviews/best/albums/rss`, `reviews/best/tracks/rss` (URL-slug
     parser pulls artist out of `/reviews/<kind>/<artist-slug>-<title-slug>/`)
   - Resident Advisor: HTML scrape of `/reviews/albums` (no RSS
     since 2025 redesign — embedded `__NEXT_DATA__` JSON parsed)
   - Quietus: `/feed/` (with browser UA — Cloudflare 403s scripted
     UAs)
   - Fact, FADER, The Wire, XLR8R, Bandcamp Daily, Stereogum
   - Last.fm tag-discovery (uses `LASTFM_API_KEY`)
   - Bandcamp Discover (electronic genre + fingerprint tags)
   Plus enrichment passes (capped at 30/run each):
   - iTunes Apple-URL resolve (per candidate without `appleMusicUrl`)
   - Last.fm `artist.getTopTags` for press-only candidates without
     `poolTags`
   - Genre + artist blacklist filter (`scripts/sources/candidate-filter.mjs`)
4. **Backfill scripts**: `enrich-labels-and-embeds`, `backfill-embeds`,
   `backfill-bandcamp`, `upgrade-deezer-to-apple`,
   `backfill-spotify` (Songlink API, no Spotify auth).
5. **`scripts/write-descriptions.mjs`** — `--limit 15` per run.
6. **Commit + push** with retry-on-rejection (3 attempts, rebase, backoff).

## Data files (`data/`)

- `recommendations.json` — main pool. Pre-Nov-2025 pending records
  are pruned (see `scripts/sources/candidate-filter.mjs`'s cutoff).
- `media-candidates.json` — artists the press is writing about,
  awaiting curator promote/dismiss. Schema includes `sourceLinks`,
  `bandcampUrl`, `appleMusicUrl`, `primaryTitle`, `latestArticleDate`,
  `poolTags`, `poolTagOverlap`. **Key gotcha**: `seed-volume.mjs`
  merges this file on each Railway boot — preserves
  `dismissed`/`promoted` flags from volume, accepts new candidates
  from seed. Without that merge the volume's file goes stale forever.
- `lastfm-similarity-cache.json` — 7-day TTL, `LASTFM_API_KEY` builds it.
- `lastfm-tag-fingerprint.json` — 7-day TTL, top-20 tags across pool.
- `monitoring-extras-auto.json` — auto-promoted artists from sync-media.
- `label-candidate-artists.json` — non-pool artists seen on monitored labels.
- `newsletter-queue.json` — curator's queue + sent history.

## Critical conventions

- **Public feed sort: `releaseDate` desc** (not `approvedAt`). Reverted
  earlier when the curator pushed back — they want chronological-by-release.
- **Admin Pool tab** excludes future-dated records. **Future tab** shows
  `releaseDate > today` regardless of status. Auto-transition: when a
  date arrives, records slide from Future → Pool/Published automatically
  via the live filter; no migration job needed.
- **Spotify links**:
  - URI scheme `spotify:album:<id>` only emitted on **mobile**
    (`isMobile(platform)` check). Desktop returns null and lets the
    anchor's `target="_blank"` open the web URL. Reason: desktop
    `window.open("", "_blank")` is empty-URL-blocked in Safari, and
    setTimeout-fallback `window.open(webUrl)` is popup-blocked. The
    JS dance left users seeing "nothing happens" on desktop.
  - **Search URLs return null on every platform** — both desktop
    (popup-blocker) and mobile (Safari "Cannot open this page"
    alert) regressed when we tried URI scheme deep-links for search.
- **Apple Music links**: plain `https://music.apple.com/...` URLs.
  Universal Links route to app on iOS/macOS automatically. We do NOT
  use `itmss://` URI scheme — it has the same regression risk as
  Spotify. For candidates, sync-media's apple-resolve pass replaces
  search URLs with real album URLs via iTunes Search API (Universal
  Links route /album/ to the app's album page; /search/ opens the
  app to an empty page).
- **Email (newsletter) Apple Music**: same plain https URL —
  Universal Links handle deep-linking. Cannot use JS in email.
- **YouTube + Bandcamp**: never URI-deep-link, always plain https.
  Universal Links handle iOS/Android natively.
- **No em-dashes in description copy** — use commas/periods.
  Enforced in both system prompts (`/api/regenerate-description`,
  `/api/rewrite-description`) and the post-processing pass. The
  post-processing regex MUST be `\s*[—–]\s*` (em-dash + en-dash
  ONLY) — NOT `\s*[-–]\s*` which would also strip regular hyphens
  and produce "Milan-based" → "Milan, based" (fixed 2026-04-30
  after the curator caught it). Compound modifiers ("Milan-based",
  "self-titled", "six-track") MUST stay intact. The same regex
  appears in 5 places: `regenerate-description/route.ts`,
  `rewrite-description/route.ts`, `write-descriptions.mjs`,
  `preview-descriptions.mjs`, `rewrite-descriptions.mjs` — keep
  them in sync.
- **`updateItem` REPLACES `links` when patch.links is provided**
  (not merge). EditForm sends canonical state; clearing a link in
  admin actually clears it. `EditForm` includes ALL 7 link types
  (bandcamp, apple, spotify, youtube, soundcloud, tidal, deezer).
- **Diacritics**: pool-membership normalisers in `sync-media.mjs`
  (`normalise`) and `sync-artists.mjs` (`normaliseArtist`) strip
  diacritics via `.normalize("NFD").replace(/[̀-ͯ]/g, "")`. Without
  this, "Nídia" in the pool wouldn't match "Nidia" coming back from
  Pitchfork's URL slug or iTunes' inconsistent normalisation, and
  she'd surface as a candidate every time the press wrote about her.
  Apply the same pattern when adding new normalisers.

## Conflict resolution playbook (data files)

When GitHub Desktop shows "Resolve conflicts before merge" on
`data/recommendations.json` or `data/media-candidates.json`:

- **Default action: "Use modified from main"** (= take origin's
  version) for both files. CI is authoritative 95% of the time.
- **Exception**: when a session has just regenerated the file with
  new logic locally (Claude ran sync-media against new code, or
  applied a cleanup). I'll explicitly say "take ours" before push.
- **If the cleanup keeps reverting**: the pre-Nov-2025 cleanup must
  be re-applied after merging. The cleanup script lives in-line in
  `scripts/sources/candidate-filter.mjs` (`PRE_2026_CUTOFF`).

## Genre / artist blacklist

`scripts/sources/candidate-filter.mjs` — applied at-source in
sync-media AND ad-hoc cleanups. User-specified off-genre tags:
rock, alternative, indie, country, blues, reggae, pop, folk, EDM,
songwriter, noise (each expanded into Last.fm/Bandcamp variants).
Manual artist blacklist for high-profile mismatches (Avicii,
Foo Fighters, Vince Staples, etc.) — extend as new ones surface.

## Pending / known gaps

- **Spotify direct album URLs**: Songlink/Odesli has poor coverage for
  underground electronic. Most records still ship with search URLs.
  No fix without paid Spotify API.
- **Bandcamp band_id discovery**: only AD 93 is in
  `LABEL_BANDCAMP_BAND_IDS` so far. Run
  `node scripts/discover-bandcamp-band-ids.mjs` to auto-probe the
  other 78 labels (prints suggestions for curator to paste in).
- **The Wire parser**: low yield (mostly editorial / column titles).
  Acceptable as low-confidence noise.
- **iTunes 429 throttling**: reduces sync-artists hit rate by 5-10%
  on busy days. Second cron at 11:00 UTC (different runner IP) is
  the recovery mechanism. No further fix needed.

## Things the user has been clear about

- **Honest answers, not guesses.** When something can't be done
  reliably, say so. When code is shipped without testing, say so.
- **Test before claiming a fix works** — run sync-media live, hit
  the dev server, verify with grep, etc.
- **Don't introduce new abstractions or 3rd-party deps without good
  reason.** Bandcamp scraping was deliberately written from scratch
  rather than pulling in npm packages — supply-chain risk +
  maintenance lag.
- **Don't auto-resolve git conflicts the user might want to review.**
  Walk through them step by step.

## Files to read at session start (in order)

1. This file (`CLAUDE.md`) — top-of-mind context
2. `scripts/monitoring.mjs` — current artists / labels / band_ids
3. Recent commit history (`git log --oneline -20`) for what's
   shipped recently
4. `data/media-candidates.json` shape (don't dump contents — it's huge)

## File map

```
src/
  app/
    admin/                    Curator UI (auth-gated)
      AdminClient.tsx         Main pool view, filter tabs, search
      candidates/             Press / tag candidates (5 tabs by source)
      monitoring/             Curator-managed artist/label extras
    api/
      curate/                 Status changes
      edit/                   Field-level edits
      pool/                   List + manual add
      regenerate-description/ LLM rewrite from metadata
      rewrite-description/    LLM rewrite from curator's pasted text
      newsletter/             Queue + send (creates Buttondown draft)
      monitoring-extras/      Public read-only extras for CI
    api/feed/                 Public feed pagination
    page.tsx                  Public homepage / feed
  components/
    EmbedPlayer.tsx           Player + service chips, link order
    ServiceLink.tsx           JS deep-link-with-fallback for music URIs
    admin/EditForm.tsx        All editable fields, includes 7 link types
    admin/EmbedPicker.tsx     Paste iframe / type URL, normalise YouTube
  lib/
    data.ts                   File-backed pool, mtime-aware cache
    music-links.ts            Per-platform URI scheme builder
    media-candidates.ts       Candidates schema + sort + sanitise
    email-template.ts         Newsletter HTML/text templates
scripts/
  sources/
    itunes.mjs, deezer.mjs    Release sources
    lastfm.mjs                Similarity index
    lastfm-tags.mjs           Pool tag fingerprint + tag candidates
    lastfm-releases.mjs       Per-artist latest-release HTML scrape
    bandcamp-discover.mjs     Genre-tag fresh releases (Discover API)
    bandcamp-label.mjs        Label discography (mobile API) — NEW
    candidate-filter.mjs      Genre + artist blacklist + pre-2026 cutoff
  monitoring.mjs              ARTISTS, LABELS, LABEL_BANDCAMP_BAND_IDS
  sync-artists.mjs            6-worker concurrent
  sync-labels.mjs             Discogs + Bandcamp passes
  sync-media.mjs              Press + Last.fm + Bandcamp + filters
  write-descriptions.mjs      LLM description writer
  seed-volume.mjs             Railway boot: merge data into volume
  discover-bandcamp-band-ids.mjs  One-shot helper for the curator
.github/
  workflows/daily-generate.yml  Twice-daily cron + retry-on-rejection
data/                         All persisted JSON
```
