# Why a Dockerfile (and not just nixpacks.toml):
#
# We tried both `aptPkgs = ["ffmpeg"]` and `nixPkgs = ["ffmpeg-full"]`
# in nixpacks.toml. Neither produced a Railway image with a system
# ffmpeg on PATH — the runtime kept resolving to the npm
# `ffmpeg-static` binary (John Van Sickle's Linux build, which is
# missing the `drawtext` filter despite advertising it in its
# configure line). Reel renders blew up with
#   [AVFilterGraph] No such filter: 'drawtext'
# at filter-graph parse time, ffmpeg exit code 8.
#
# Railway honors a Dockerfile in preference to nixpacks, and a
# Debian-based Node image installs ffmpeg with a fully featured
# libavfilter (drawtext included). One layer of `apt-get install
# ffmpeg` and the composer's `which ffmpeg` lookup finds
# /usr/bin/ffmpeg ahead of the ffmpeg-static fallback.
#
# Node version pinned to 22 to match the GitHub Actions workflow
# (`.github/workflows/daily-generate.yml` sets node-version: 22).
# Keeping Railway and CI on the same major-minor avoids "works on CI
# fails in prod" cliff edges around Node 22's TypeScript-strip and
# fetch-internals changes.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# package.json + lock first so `npm ci` is cached unless they change.
COPY package.json package-lock.json ./
# `npm ci` over `npm install` for deterministic builds. We keep
# devDependencies here because `next build` (the next step) needs
# next + typescript + tailwind which sit in devDependencies — same
# trade-off the GH Actions workflow makes by NOT using --omit=dev
# in the build step (only the cron scripts use --omit=dev).
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `npm run build` does `next build && rm -rf data-seed && cp -r data
# data-seed` — same script seed-volume.mjs expects on container boot.
# `npm prune --production` strips devDependencies from node_modules
# after the Next.js build is done so the runtime stage doesn't ship
# tailwind / typescript / @types/* (~50 MB+ of unneeded code).
# ffmpeg-static + ffprobe-static stay (in regular dependencies) as
# local-dev / fallback binaries.
RUN npm run build && npm prune --production

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# System ffmpeg with full filter set (drawtext + everything else).
# --no-install-recommends keeps the layer minimal (~80 MB ffmpeg
# instead of ~350 MB with all recommended GUI tooling pulled in).
# rm -rf cleans up apt's package lists so they don't bloat the image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Carry over the built app + node_modules + assets. The Railway
# volume mounts at /app/data at runtime, shadowing whatever sits
# there at image-build time (so data-seed/ matters but data/ doesn't).
COPY --from=build /app /app

# Railway sets PORT in the env, but our package.json `start` script
# hard-codes `-p 3000` and Railway respects this when wired through
# its proxy. EXPOSE is metadata only; the actual port comes from the
# start script.
EXPOSE 3000

# Same start sequence as Railway's nixpacks default — runs the
# seed-volume merge then boots Next. `npm start` keeps the script in
# package.json as the single source of truth for how production
# launches.
CMD ["npm", "start"]
