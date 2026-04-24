/**
 * Fetch curator-added monitoring extras from the live site AND merge in any
 * auto-promoted artists recorded by sync-media on previous runs.
 *
 * Two sources, both additive:
 *
 *   1. Live-site extras (/api/monitoring-extras). The admin panel at
 *      /admin/monitoring writes to a persistent-volume JSON file served
 *      publicly at this endpoint. Curator additions take effect on the
 *      next daily run without a code change.
 *
 *   2. Auto-promoted extras (data/monitoring-extras-auto.json, git-committed).
 *      sync-media writes here when a press candidate passes BOTH gates
 *      (≥2 independent outlets AND Last.fm similarity to the pool). Because
 *      this file lives in the repo, it survives across Railway deploys and
 *      is visible to every workflow run without an HTTP round trip.
 *
 * Behaviour:
 *   - Reads DISQUET_SITE_URL (or SITE_URL, or defaults to https://disquet.co).
 *   - Fetches /api/monitoring-extras with a 10s timeout.
 *   - Reads data/monitoring-extras-auto.json (optional, no-op if missing).
 *   - Returns { artists: [...], labels: [...] } arrays, deduplicated.
 *   - On any error fetching the live site, returns whatever the local auto
 *     file has and logs a warning. The sync scripts must keep working off
 *     their hardcoded base list so a flaky site endpoint doesn't kill the
 *     daily run.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const SITE_URL = (
  process.env.DISQUET_SITE_URL ||
  process.env.SITE_URL ||
  "https://disquet.co"
).replace(/\/$/, "");

const AUTO_FILE = path.resolve("data/monitoring-extras-auto.json");

async function readAutoExtras() {
  try {
    const raw = await fs.readFile(AUTO_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const artists = Array.isArray(parsed?.artists)
      ? parsed.artists.filter((x) => typeof x === "string" && x.trim())
      : [];
    const labels = Array.isArray(parsed?.labels)
      ? parsed.labels.filter((x) => typeof x === "string" && x.trim())
      : [];
    return { artists, labels };
  } catch {
    // missing file or unreadable — treat as empty
    return { artists: [], labels: [] };
  }
}

export async function fetchMonitoringExtras() {
  const url = `${SITE_URL}/api/monitoring-extras`;
  const auto = await readAutoExtras();
  if (auto.artists.length || auto.labels.length) {
    console.log(
      `[extras] loaded ${auto.artists.length} auto-promoted artist(s) / ${auto.labels.length} label(s) from ${AUTO_FILE}`,
    );
  }
  try {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetch(url, {
      headers: { "User-Agent": "disquet-sync/1.0 +extras" },
      signal: ctl.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.log(`[extras] GET ${url} → ${res.status}, using auto file + hardcoded list only`);
      return auto;
    }
    const json = await res.json();
    const artists = Array.isArray(json.artists)
      ? json.artists.filter((x) => typeof x === "string" && x.trim())
      : [];
    const labels = Array.isArray(json.labels)
      ? json.labels.filter((x) => typeof x === "string" && x.trim())
      : [];
    if (artists.length || labels.length) {
      console.log(
        `[extras] merged from ${url}: ${artists.length} artists, ${labels.length} labels`,
      );
    }
    return {
      artists: mergeUnique(artists, auto.artists),
      labels: mergeUnique(labels, auto.labels),
    };
  } catch (e) {
    console.log(`[extras] fetch failed (${e.message}); using auto file + hardcoded list only`);
    return auto;
  }
}

/**
 * Record an auto-promoted artist in the local git-committed file so it's
 * picked up by the next sync-artists run. Idempotent — adding a name that's
 * already present (case-insensitive) is a no-op.
 *
 * Why write to a git file instead of POSTing to the site's API? Because
 * the API writes to the Railway persistent volume which GitHub Actions
 * can't see (no shared filesystem, would need auth + network round trip).
 * A git-committed ledger is simpler and more auditable: every auto-promote
 * shows up as a diff in the daily commit.
 */
export async function recordAutoExtra(kind, name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return { added: false };
  if (kind !== "artist" && kind !== "label") {
    throw new Error(`recordAutoExtra: kind must be artist|label, got ${kind}`);
  }
  const current = await readAutoExtras();
  const list = kind === "artist" ? current.artists : current.labels;
  const lower = trimmed.toLowerCase();
  if (list.some((x) => x.toLowerCase() === lower)) {
    return { added: false };
  }
  const next = {
    artists: kind === "artist" ? [...current.artists, trimmed].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : current.artists,
    labels: kind === "label" ? [...current.labels, trimmed].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : current.labels,
  };
  await fs.writeFile(AUTO_FILE, JSON.stringify(next, null, 2), "utf8");
  return { added: true };
}

/** Merge extras into a base list, de-duplicating case-insensitively. */
export function mergeUnique(base, extras) {
  const seen = new Set(base.map((x) => x.toLowerCase()));
  const out = [...base];
  for (const x of extras) {
    const k = x.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
