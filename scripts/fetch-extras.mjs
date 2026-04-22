/**
 * Fetch curator-added monitoring extras from the live site.
 *
 * Why: the ARTISTS / LABELS arrays in monitoring.mjs are hand-edited code
 * and require a deploy to update. The admin panel at /admin/monitoring
 * writes to a persistent-volume JSON file served publicly at
 * /api/monitoring-extras, so curator additions can take effect on the
 * next daily run without a code change.
 *
 * Behaviour:
 *   - Reads DISQUET_SITE_URL (or SITE_URL, or defaults to https://disquet.co).
 *   - Fetches /api/monitoring-extras with a 10s timeout.
 *   - Returns { artists: [...], labels: [...] } arrays.
 *   - On any error (network, non-200, parse fail, site down), returns
 *     empty arrays and logs a warning. The sync scripts must keep working
 *     off their hardcoded base list so a flaky site endpoint doesn't kill
 *     the daily run.
 */

const SITE_URL = (
  process.env.DISQUET_SITE_URL ||
  process.env.SITE_URL ||
  "https://disquet.co"
).replace(/\/$/, "");

export async function fetchMonitoringExtras() {
  const url = `${SITE_URL}/api/monitoring-extras`;
  try {
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetch(url, {
      headers: { "User-Agent": "disquet-sync/1.0 +extras" },
      signal: ctl.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.log(`[extras] GET ${url} → ${res.status}, using hardcoded list only`);
      return { artists: [], labels: [] };
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
    return { artists, labels };
  } catch (e) {
    console.log(`[extras] fetch failed (${e.message}); using hardcoded list only`);
    return { artists: [], labels: [] };
  }
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
