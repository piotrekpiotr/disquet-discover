import { AnimationsClient } from "./AnimationsClient";

export const dynamic = "force-dynamic";

/**
 * /admin/animations — upload + manage the 30 reel background mp4s.
 *
 * Auth: falls under /admin/:path* matcher in src/middleware.ts.
 *
 * The actual file listing is fetched client-side via the
 * /api/admin/animations endpoint; the page itself only renders the
 * Client component so the curator gets a live view after each
 * upload completes (no per-upload SSR refresh).
 */
export default function AnimationsPage() {
  return <AnimationsClient />;
}
