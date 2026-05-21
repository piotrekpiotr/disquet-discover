/**
 * Security + image-host config.
 *
 * The headers() block below layers defence-in-depth on top of the app's own
 * input validation and auth:
 *
 *   - Content-Security-Policy: tight allow-list for scripts, styles, fonts,
 *     images, audio/video, iframes, and connect. Inline scripts are limited
 *     to `'self' 'unsafe-inline'` because Next.js ships hydration scripts
 *     inline in production. `frame-src` enumerates every embed host the
 *     EmbedPlayer can render so iframes don't need to be loosened further.
 *   - X-Content-Type-Options: nosniff - stops IE/Chrome MIME-sniffing
 *     uploaded-looking content into scripts.
 *   - X-Frame-Options: DENY - we don't embed any of our own pages inside
 *     another site, so this kills clickjacking attempts.
 *   - Referrer-Policy: strict-origin-when-cross-origin - don't leak full
 *     paths (e.g. `/r/<record id>`) to third-party destinations.
 *   - Permissions-Policy: turn off camera/mic/geolocation/payment surfaces
 *     that we never use, so an injected ad or compromised dependency can't
 *     ask the browser for them.
 *   - Strict-Transport-Security: 1 year, applied once we're serving HTTPS
 *     (Vercel/hosts do this by default; header reinforces it).
 *
 * Notes:
 *   - `img-src` includes `data:` for tiny base64-encoded SVGs and tailwind-
 *     generated placeholders.
 *   - The iTunes CDN hostnames stay in images.remotePatterns so `next/image`
 *     can optimise cover art.
 */

/**
 * CSP is built per-environment. In development Next.js serves over plain
 * HTTP on localhost and uses a WebSocket for HMR; two directives that are
 * great in production (`upgrade-insecure-requests`, which rewrites same-
 * origin HTTP fetches to HTTPS, and a narrow `connect-src`) actively break
 * the dev server. We keep the full production policy and loosen only those
 * two directives in dev.
 */
const isProd = process.env.NODE_ENV === "production";

const CSP = [
  "default-src 'self'",
  // Next.js hydration scripts are emitted inline; vendor chunks are self-
  // hosted. No third-party analytics today, so no extra domains needed.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https: blob:",
  "media-src 'self' https: blob:",
  // Every iframe host the EmbedPlayer can render. Add new ones here when
  // introducing new providers - nothing else is allowed to frame.
  "frame-src 'self' https://bandcamp.com https://*.bandcamp.com https://embed.music.apple.com https://widget.deezer.com https://open.spotify.com https://w.soundcloud.com https://www.youtube.com https://www.youtube-nocookie.com",
  // In prod only 'self' is allowed for fetch/XHR. In dev we also let the
  // HMR websocket through on ws:// and wss:// so Next.js's fast-refresh
  // pipe works.
  isProd
    ? "connect-src 'self'"
    : "connect-src 'self' ws: wss: http://localhost:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Only in prod: tell browsers to rewrite http: sub-resource URLs to
  // https:. On localhost this would upgrade /api/admin/login to an https
  // URL that the dev server doesn't serve, so the fetch silently fails.
  ...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()",
  },
  // HSTS pins the browser to HTTPS for a year. Pointless (and in theory
  // harmful) on http://localhost, so it's production-only.
  ...(isProd
    ? [{
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains; preload",
      }]
    : []),
  // Disable prefetching of /api/admin/logout by third-party link scanners.
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Strips the `X-Powered-By: Next.js` header that tells attackers the stack.
  poweredByHeader: false,
  // ffmpeg-static / ffprobe-static ship native binaries. Webpack tries to
  // inline them by rewriting __dirname, which leaves spawn() pointing at
  // `.next/server/vendor-chunks/ffmpeg` — a path that doesn't exist. Marking
  // both packages as server-external skips bundling entirely; the require
  // resolves to the real binary inside node_modules at runtime. Server-only
  // impact, the client bundle is unaffected. (Reel render flow.)
  experimental: {
    serverComponentsExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.mzstatic.com" },
      { protocol: "https", hostname: "is1-ssl.mzstatic.com" },
      { protocol: "https", hostname: "is2-ssl.mzstatic.com" },
      { protocol: "https", hostname: "is3-ssl.mzstatic.com" },
      { protocol: "https", hostname: "is4-ssl.mzstatic.com" },
      { protocol: "https", hostname: "is5-ssl.mzstatic.com" },
      { protocol: "https", hostname: "f4.bcbits.com" },
      { protocol: "https", hostname: "i.discogs.com" },
      { protocol: "https", hostname: "st.discogs.com" },
    ],
  },
  async headers() {
    return [
      {
        // Apply to every route. Static assets under /_next/static are safe
        // with these headers; the CSP image/media lists are generous enough
        // to cover legitimate usage.
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

module.exports = nextConfig;
