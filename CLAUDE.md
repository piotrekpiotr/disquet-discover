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
- **Tidal links**: populated by `scripts/backfill-spotify.mjs` (yes,
  the filename's a misnomer — it now resolves both Spotify and
  Tidal in one Songlink call). Tidal coverage via Songlink is
  materially better than Spotify's for our genre (~30-50% hit rate
  vs. ~0% for Spotify on niche electronic). Songlink returns
  `listen.tidal.com/album/<id>` URLs; the script normalises to
  `tidal.com/album/<id>` before writing. `tidalAppUrl` in
  `music-links.ts` accepts both hosts. The Tidal URI scheme
  `tidal://album/<id>` is mobile-only (per the standard
  isMobile-gate pattern).
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
sync-media AND sync-artists (since 2026-05-20) AND ad-hoc cleanups.
Three exports now:

- `TAG_BLACKLIST_STRICT` — high-confidence off-genre tags (reggae,
  french pop, soundtrack, classical, country, blues, folk, rock,
  k-pop, j-pop, EDM festival variants, noise, songwriter, etc.).
  Used by sync-artists ingestion and `scripts/cleanup-pool.mjs`.
  Bare "alternative" / "indie" / "pop" / "dance" are EXCLUDED from
  STRICT — iTunes uses these too broadly, real pool members get
  tagged with them (James Blake, Andrea, DJ Koze remixes).
- `TAG_BLACKLIST_BROAD` — adds those broad terms.
- `TAG_BLACKLIST` — STRICT ∪ BROAD. Used by sync-media candidate
  filtering (artist not yet curator-vetted, so we err strict).

**Sync-artists tag filter (since 2026-05-20)**: only fires on COLLAB
releases (releaseArtist ≠ searchedArtist after normalise). Solo
releases by monitored artists pass regardless of tag — the curator's
monitoring decision wins over a misleading iTunes catch-all. Catches
the original bug shape "monitored Noon guesting on French Pop Alee
& NooN's release" without losing one-off cross-genre work by pool
members (Felicia Atkinson scoring a film, Ben Frost soundtrack, etc.).

**Apple album-ID dedup (since 2026-05-20)**: sync-artists now also
dedupes by Apple `/album/<id>` numeric ID across credit variants. iTunes
returns the same release under "X & Y" full collab credit AND each
solo "X" / "Y" query with the same album ID — we keep one record per
Apple ID, preferring the most-credited canonical version. Shared
helper: `scripts/lib/apple-url.mjs::extractAppleAlbumId`.

**Article-text genre detection (since 2026-05-20)**: sync-media's
press-feed loop scans `entry.title + entry.description` for compound
off-genre phrases ("reggae album", "classical pianist", "soundtrack
to …", k-pop / metal / americana / country singer / etc.) via
regex patterns in `articleTextSignalsOffGenre`. A hit skips the
mention for that entry only — the candidate never accumulates that
article's evidence. Patterns require word-boundary multi-word
context to avoid over-matching common prose ("rock bottom", "country
roads" geo). Designed so a legit electronic artist mentioned in a
reggae review just doesn't gain that one mention — they'll surface
via other articles. An off-genre artist whose every mention is in
off-genre prose never accumulates enough to auto-promote.

**Cleanup script** (`scripts/cleanup-pool.mjs`): dry-run by default
(`--apply` to write, makes a `.bak` first). Removes pending records
with blacklisted tags / blacklisted artists / Apple-ID duplicates.
Whitelists solo releases by monitored artists. Safe to re-run; backs
up `data/recommendations.json` → `.bak`.

Manual artist blacklist for high-profile mismatches (Avicii, Foo
Fighters, Vince Staples, etc.) — extend as new ones surface. Off-
genre auto-promotions caught 2026-05-20 (Quiet Light, Aldous Harding,
Kevin Morby, Tara Clerkin Trio) parked here so sync-media can't
re-promote them.

**Known unfixed**: short common-name false matches ("Lone" matches
both Matt Cutler's project and an unrelated hip-hop artist named
Lone; same with "ear", "LOG", etc.). Fix requires per-artist
Apple/Spotify ID disambiguation — significant data migration.
Currently the curator dismisses manually from /admin.

## GitHub Actions cost / minutes

Repo is **private**, on the GitHub Free plan: 2,000 Linux-runner
minutes/month at no cost, $0.008/min thereafter (1× multiplier).

**As of 2026-05-13** the workflow uses a two-job structure:
- `check` job (~30-60s) runs on every trigger. Decides whether to
  run the heavy job:
  - `workflow_dispatch` → always run
  - 04:00 UTC cron → always run (primary slot)
  - 11:00 UTC cron → run ONLY if no `daily pool: new pending batch`
    commit landed today (i.e. the 04:00 cron failed / crashed /
    was rate-limited)
- `generate` job (~75-85 min observed in production — sync-artists
  alone is ~50 min over ~270 artists × 3 sources with rate-pacing).
  Gated on the check's `should_run` output.

This pattern saves the 11:00 retry slot on most days (~75 min × ~80%
of days = ~1,800 min/month avoided vs. always-twice-daily). Steady-
state usage with the conditional retry: ~80 min × 30 days + a few
retry days ≈ ~2,500-2,700 min/month. That's **over the 2,000 free
tier** by ~500-700 min/month = ~$4-6/month at $0.008/min if the
spending limit is raised. Without the conditional retry it would be
double that.

**2026-05-15 incident:** an earlier 50-min `timeout-minutes` cap was
based on a wrong estimate of typical runtime; both runs on 2026-05-14
hit the cap and produced no commit / no Railway deploy. Cap is now
110 min. Document observed runtime here, not the wished-for one.

**Tradeoff to know about:** the previous twice-daily cron caught
releases that dropped between 04:00 and 11:00 UTC same-day. With
the conditional retry, those releases are caught at the next 04:00
instead — max ~18 hour delay. No records are permanently missed.
If the curator wants to catch a same-day mid-day release, they can
manually trigger the workflow from the Actions tab.

Also applied: `npm ci --omit=dev` (CI scripts use only Node
built-ins, so devDeps like Tailwind/TypeScript are dead weight in
CI), `timeout-minutes: 110` on the generate job (runaway-job
guardrail, well above the observed ~80-min ceiling).

Spending limit is at github.com/settings/billing/spending_limit —
default $0 means Actions just stop running once free quota hits;
no surprise bill. The curator decides when to raise this.

**If we hit the limit again** (e.g. artists+labels pool doubles):
1. Flip the repo public for unlimited free Actions minutes (only
   `data/` becomes visible — secrets stay encrypted in GitHub
   Secrets).
2. Drop the 11:00 cron entirely (currently conditional, would
   become not-scheduled). Saves ~5-20 min/month from check-job
   overhead. Loses the morning-failure recovery.
3. Skip backfill scripts when sync produced 0 new records (NOT
   currently done because backfills also catch up records stuck
   without embeds from earlier days — would lose that catch-up
   coverage).

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
