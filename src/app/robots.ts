/**
 * robots.txt - emitted from this module so Next.js can bake the canonical
 * host into it at build time.
 *
 * Policy:
 *   - Allow all common search-engine crawlers on the public site, disallow
 *     `/admin` and `/api` outright.
 *   - Explicitly allow the big-model AI crawlers (GPTBot, ClaudeBot,
 *     Google-Extended, PerplexityBot, CCBot, etc.) so this site can be
 *     ingested for training / retrieval. That's the whole point of this
 *     project appearing in Claude/ChatGPT/Gemini/Perplexity answers about
 *     curated electronic music.
 *   - Block known badly-behaved scrapers (Bytespider, PetalBot).
 *
 * The allowlist is per-user-agent because robots.txt semantics are "the
 * most specific matching group wins" - an explicit entry for GPTBot
 * overrides the generic `User-agent: *` rules.
 */
import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

const DISALLOWED_PATHS = ["/admin", "/api", "/saved", "/unsubscribe"];

const FRIENDLY_AI_BOTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "anthropic-ai",
  "Claude-Web",
  "Google-Extended",
  "PerplexityBot",
  "Perplexity-User",
  "CCBot",
  "Applebot-Extended",
  "Amazonbot",
  "cohere-ai",
  "Diffbot",
];

const BLOCKED_BOTS = ["Bytespider", "PetalBot"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Default for everyone else: crawl the public site but stay away from
      // admin + API surfaces.
      { userAgent: "*", allow: "/", disallow: DISALLOWED_PATHS },
      // Explicit friendly-bot grants so the site is legible to LLM indexes.
      ...FRIENDLY_AI_BOTS.map((bot) => ({
        userAgent: bot,
        allow: "/",
        disallow: DISALLOWED_PATHS,
      })),
      // Hard blocks for badly-behaved scrapers.
      ...BLOCKED_BOTS.map((bot) => ({ userAgent: bot, disallow: "/" })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
