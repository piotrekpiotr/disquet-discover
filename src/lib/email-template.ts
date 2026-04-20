/**
 * HTML + plain-text email templates for the newsletter.
 *
 * Design notes:
 *   - Tables-for-layout. Gmail, Outlook, Apple Mail all render table-based
 *     emails predictably; flexbox / grid are a coin toss across clients.
 *   - System font stack only. Google Fonts / custom web fonts get stripped
 *     or mis-rendered in Outlook; using the browser/OS default (Georgia for
 *     display, Helvetica/Arial for body) guarantees legibility everywhere.
 *   - Max width 600px, scaled cover image 120px. Deliberately smaller than
 *     the site card so the email reads as "digest" not "magazine".
 *   - Inline styles for EVERYTHING. <style> blocks work in ~90% of clients
 *     but are stripped by Gmail web and by several corporate gateways.
 *   - No tracking pixel, no "view in browser" link, no logo image. Lower
 *     spam score, faster render, more trustworthy.
 *   - Unsubscribe link is `{{unsubscribe_url}}` - Buttondown interpolates
 *     the real URL at send time (and also sets the List-Unsubscribe and
 *     List-Unsubscribe-Post headers, which lets Gmail/Apple Mail show the
 *     one-click unsubscribe button in their UI).
 *
 * Inputs are plain Recommendation objects from `data/recommendations.json`.
 * No embed players: iframes don't work in email clients, and `audio` tags
 * only work in Apple Mail. Streaming-service text links are the escape
 * hatch back to the record on whichever service the reader uses.
 */
import type { Links, Recommendation } from "./types";
import { SITE_BRAND, SITE_URL } from "./site";
import { supportEmail } from "./newsletter";

/** HTML-escape helper. Keeps descriptions safe even if they ever get HTML. */
function esc(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function typeLabel(t: Recommendation["type"]) {
  return t === "single" ? "Single" : t === "ep" ? "EP" : "Album";
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

const BODY_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const DISPLAY_STACK = "Georgia, 'Times New Roman', Times, serif";

/** Render the per-service link row for a single record. */
function linkRow(links: Links): string {
  const ORDER: Array<keyof Links> = [
    "bandcamp",
    "spotify",
    "apple",
    "deezer",
    "soundcloud",
    "tidal",
    "youtube",
  ];
  const LABELS: Record<keyof Links, string> = {
    bandcamp: "Bandcamp",
    spotify: "Spotify",
    apple: "Apple Music",
    deezer: "Deezer",
    soundcloud: "SoundCloud",
    tidal: "Tidal",
    youtube: "YouTube",
  };
  const active = ORDER.filter((k) => links[k]);
  if (active.length === 0) return "";
  return active
    .map(
      (k) =>
        `<a href="${esc(links[k]!)}" style="color:#1a1a1a; text-decoration:underline; margin-right:12px; font-size:12px;">${LABELS[k]}</a>`,
    )
    .join("");
}

/** Single record block: 2-col table (cover + text). */
function recordBlock(rec: Recommendation): string {
  const href = `${SITE_URL}/r/${rec.id}`;
  const cover = rec.coverImageUrl
    ? `<img src="${esc(rec.coverImageUrl)}" alt="${esc(rec.artist + " - " + rec.title)}" width="120" height="120" style="display:block; border:0; width:120px; height:120px; object-fit:cover;" />`
    : `<div style="width:120px; height:120px; background:#eceae2; border:1px solid #1a1a1a;"></div>`;

  const tags =
    rec.tags && rec.tags.length > 0
      ? `<div style="font-family:${BODY_STACK}; font-size:11px; color:#7a7a74; margin-top:6px;">${rec.tags.slice(0, 4).map(esc).join(" · ")}</div>`
      : "";

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px; border-collapse:collapse;">
  <tr>
    <td width="140" valign="top" style="padding:0 16px 0 0;">
      <a href="${esc(href)}" style="display:block; text-decoration:none;">${cover}</a>
    </td>
    <td valign="top">
      <div style="font-family:${BODY_STACK}; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#7a7a74;">
        ${esc(typeLabel(rec.type))} · ${esc(formatDate(rec.releaseDate))}${rec.label ? " · " + esc(rec.label) : ""}
      </div>
      <div style="font-family:${BODY_STACK}; font-weight:700; font-size:18px; line-height:1.2; color:#1a1a1a; margin:4px 0 2px;">
        <a href="${esc(href)}" style="color:#1a1a1a; text-decoration:none;">${esc(rec.artist)}</a>
      </div>
      <div style="font-family:${DISPLAY_STACK}; font-style:italic; font-size:16px; color:#7a7a74; line-height:1.25; margin-bottom:8px;">
        <a href="${esc(href)}" style="color:#7a7a74; text-decoration:none;">${esc(rec.title)}</a>
      </div>
      ${rec.description ? `<div style="font-family:${BODY_STACK}; font-size:13px; line-height:1.5; color:#2a2a2a; margin-bottom:10px;">${esc(rec.description)}</div>` : ""}
      <div style="font-family:${BODY_STACK};">${linkRow(rec.links)}</div>
      ${tags}
    </td>
  </tr>
</table>`;
}

/**
 * Full HTML email.
 *
 * `{{unsubscribe_url}}` is a Buttondown template variable, substituted
 * per-recipient at send time. DO NOT replace it here.
 */
export function renderHtml(opts: {
  title: string;
  intro: string;
  records: Recommendation[];
}): string {
  const { title, intro, records } = opts;
  const blocks = records.map(recordBlock).join("\n");
  const supportHref = `mailto:${supportEmail()}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${esc(title)}</title>
</head>
<body style="margin:0; padding:0; background:#fafaf5; color:#1a1a1a;">
  <!-- Pre-header: preview text in the inbox list. Hidden in the actual email body. -->
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent; mso-hide:all;">
    ${esc(intro)}
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fafaf5">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:600px; background:#fafaf5;">

          <!-- Masthead -->
          <tr>
            <td style="padding:8px 24px 16px; border-bottom:1px solid #1a1a1a;">
              <a href="${esc(SITE_URL)}" style="text-decoration:none; color:#1a1a1a;">
                <span style="font-family:${BODY_STACK}; font-weight:900; font-size:22px; letter-spacing:-0.02em;">${esc(SITE_BRAND)}</span>
                <span style="font-family:${DISPLAY_STACK}; font-style:italic; color:#7a7a74; font-size:16px; margin-left:8px;">discover</span>
              </a>
            </td>
          </tr>

          <!-- Title -->
          <tr>
            <td style="padding:24px 24px 4px;">
              <div style="font-family:${BODY_STACK}; font-weight:900; font-size:28px; line-height:1.05; letter-spacing:-0.02em; color:#1a1a1a;">${esc(title)}</div>
              <div style="font-family:${DISPLAY_STACK}; font-style:italic; font-size:16px; color:#7a7a74; margin-top:6px; line-height:1.3;">${esc(intro)}</div>
            </td>
          </tr>

          <!-- Records -->
          <tr>
            <td style="padding:24px 24px 8px;">
              ${blocks}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 24px 32px; border-top:1px solid #1a1a1a;">
              <div style="font-family:${BODY_STACK}; font-size:11px; line-height:1.6; color:#7a7a74;">
                You are receiving this because you subscribed at
                <a href="${esc(SITE_URL)}" style="color:#1a1a1a;">${esc(SITE_URL.replace(/^https?:\/\//, ""))}</a>.
                <br />
                Questions or a release to submit, reply to this email or write to
                <a href="${esc(supportHref)}" style="color:#1a1a1a;">${esc(supportEmail())}</a>.
                <br />
                <a href="{{unsubscribe_url}}" style="color:#1a1a1a; text-decoration:underline;">Unsubscribe</a>
                &nbsp;·&nbsp;
                <a href="${esc(SITE_URL)}/about" style="color:#1a1a1a;">About</a>
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Plain-text alternate, used by email clients that prefer text/plain.
 * Also lifts deliverability: a text/plain alternative is an anti-spam
 * signal ("this sender bothered to format for low-tech clients").
 */
export function renderText(opts: {
  title: string;
  intro: string;
  records: Recommendation[];
}): string {
  const { title, intro, records } = opts;
  const lines: string[] = [];
  lines.push(title);
  lines.push(intro);
  lines.push("");
  lines.push("--");
  for (const rec of records) {
    const meta = [typeLabel(rec.type), formatDate(rec.releaseDate), rec.label]
      .filter(Boolean)
      .join(" · ");
    lines.push(`${rec.artist} - ${rec.title}`);
    lines.push(meta);
    if (rec.description) lines.push(rec.description);
    const serviceLinks = (
      ["bandcamp", "spotify", "apple", "deezer", "soundcloud", "youtube"] as Array<
        keyof Links
      >
    )
      .filter((k) => rec.links[k])
      .map((k) => `${k}: ${rec.links[k]}`)
      .join("  |  ");
    if (serviceLinks) lines.push(serviceLinks);
    lines.push(`${SITE_URL}/r/${rec.id}`);
    lines.push("");
  }
  lines.push("--");
  lines.push(`Support: ${supportEmail()}`);
  lines.push(`Unsubscribe: {{unsubscribe_url}}`);
  lines.push(`About: ${SITE_URL}/about`);
  return lines.join("\n");
}
