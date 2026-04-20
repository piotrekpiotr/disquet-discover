/**
 * In-memory per-key rate limiter. Good enough for a single-instance site
 * to stop commodity brute-force / scraping; NOT a substitute for a real
 * distributed limiter once the site runs on multiple instances.
 *
 * When we move to Vercel / multi-instance, swap this module's implementation
 * for Upstash Redis' `@upstash/ratelimit` without changing callers. The
 * exported API (`take(key, opts)` returning a verdict) stays the same.
 *
 * Keying rules are the caller's responsibility. Typical choices:
 *   - `ip:<x-forwarded-for-first-hop>` for public endpoints
 *   - `email:<lowered>` for subscribe (so the same address can't be spammed
 *     through multiple IPs)
 *   - `login:<ip>` for admin brute-force
 *
 * Algorithm: fixed-window counter. Simpler than a token bucket, and for
 * our target throughputs the boundary effect (a burst across two windows)
 * is fine.
 */

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/** Periodic sweep to keep the Map from ballooning on long-lived instances. */
let lastSweep = 0;
function maybeSweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, w] of windows) {
    if (w.resetAt <= now) windows.delete(k);
  }
}

export type Verdict = {
  allowed: boolean;
  /** Seconds remaining in the current window. */
  resetInSec: number;
  /** How many hits we've counted in the current window. */
  current: number;
  /** The window's configured cap. */
  limit: number;
};

/**
 * Record a hit against `key` and return a verdict. The caller decides
 * what to do when `allowed === false` (usually 429 + Retry-After).
 */
export function take(
  key: string,
  opts: { limit: number; windowMs: number },
): Verdict {
  const now = Date.now();
  maybeSweep(now);
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    const next: Window = { count: 1, resetAt: now + opts.windowMs };
    windows.set(key, next);
    return {
      allowed: true,
      current: 1,
      limit: opts.limit,
      resetInSec: Math.ceil(opts.windowMs / 1000),
    };
  }
  existing.count += 1;
  return {
    allowed: existing.count <= opts.limit,
    current: existing.count,
    limit: opts.limit,
    resetInSec: Math.max(0, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

/**
 * Best-effort client IP extractor. X-Forwarded-For is set by every major
 * hosting provider's edge; the first hop is the originating client. Falls
 * back to a constant so at least one in-memory slot catches upstream
 * misconfiguration rather than leaving the endpoint wide open.
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
