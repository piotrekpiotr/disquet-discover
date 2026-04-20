/**
 * Newsletter provider client. Currently Buttondown-backed, but every call
 * goes through this module so a future switch (MailerLite, ConvertKit,
 * Resend Broadcasts) is one file of changes, not ten.
 *
 * Why Buttondown:
 *   - Free up to 100 subs, $9/mo past that. Matches the editorial tone.
 *   - JSON API with a simple "one send at a time" model.
 *   - Double opt-in is opt-in at the account level; when enabled the API
 *     send on create auto-sends the confirmation mail.
 *   - Appends the `List-Unsubscribe` + `List-Unsubscribe-Post` headers
 *     automatically and provides `{{unsubscribe_url}}` as a template var,
 *     so the emails we build only need to interpolate that string.
 *
 * Cadence model: single weekly newsletter only. Sends are manual, triggered
 * by the curator from the admin panel. No daily/weekly tag split anymore.
 *
 * Environment:
 *   BUTTONDOWN_API_KEY          required in production
 *   NEWSLETTER_FROM_NAME        optional, default "Disquet Discover"
 *   NEWSLETTER_SUPPORT_EMAIL    optional, default hello@disquet.co
 *
 * In dev we accept a missing API key and print what WOULD be sent, so the
 * signup form still renders / works end-to-end without an account.
 */
import { SITE_CONTACT_EMAIL, SITE_NAME } from "./site";

const API_BASE = "https://api.buttondown.email/v1";

/** Single tag used for every subscriber — room for future segmentation. */
const SUBSCRIBER_TAG = "subscriber";

function apiKey(): string | null {
  return process.env.BUTTONDOWN_API_KEY || null;
}

export function supportEmail(): string {
  return process.env.NEWSLETTER_SUPPORT_EMAIL || SITE_CONTACT_EMAIL;
}

export function fromName(): string {
  return process.env.NEWSLETTER_FROM_NAME || SITE_NAME;
}

/** Strip anything that's not clearly an email. Kept deliberately strict. */
export function isProbableEmail(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.length < 5 || s.length > 254) return false;
  // RFC-simplified: local@host.tld. We don't need to be fully RFC 5321 correct;
  // we just want to reject garbage before it hits the ESP API.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Log-only shim used when BUTTONDOWN_API_KEY isn't set (local dev). */
async function devEcho(kind: string, payload: unknown) {
  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.log(`[newsletter:dev] ${kind}`, JSON.stringify(payload));
  }
}

async function buttondown<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error("BUTTONDOWN_API_KEY not set");
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      Authorization: `Token ${key}`,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Buttondown ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/**
 * Add a subscriber. Buttondown's `POST /subscribers` returns 201 on new,
 * 200 on idempotent re-add. We set `notes` to a timestamp so the admin can
 * see when each subscription started when reviewing on Buttondown's UI.
 */
export async function subscribe(email: string): Promise<void> {
  const payload = {
    email_address: email,
    tags: [SUBSCRIBER_TAG],
    // "regular" is the default; stated explicitly here for clarity.
    type: "regular",
    notes: `signup:${new Date().toISOString()}`,
  };
  if (!apiKey()) {
    await devEcho("subscribe", payload);
    return;
  }
  await buttondown("/subscribers", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Remove a subscriber outright. Used by our /unsubscribe endpoint.
 * Buttondown treats the email as the id, URL-encoded.
 *
 * We tolerate 404 from the ESP - if the email was never subscribed (or was
 * already removed) we still want to show the "you're unsubscribed" page.
 */
export async function unsubscribe(email: string): Promise<void> {
  if (!apiKey()) {
    await devEcho("unsubscribe", { email });
    return;
  }
  const res = await fetch(
    `${API_BASE}/subscribers/${encodeURIComponent(email)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Token ${apiKey()}` },
    },
  );
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`Buttondown unsubscribe ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Send a one-off email to every subscriber tagged with the standard
 * subscriber tag. `subject`, `html`, `text` are the three payloads Buttondown
 * understands.
 *
 * `email_type: "public"` means the send is archived on the
 * buttondown.email/<slug> page (free public archive - we want it: helps SEO
 * and gives LLM crawlers another ingestion source). Switch to "private" if
 * you'd rather keep issues subscriber-only.
 */
export async function sendBroadcast(opts: {
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const payload = {
    subject: opts.subject,
    body: opts.html,
    // Buttondown uses "absolute_body" as the exact HTML (no markdown parse).
    absolute_body: opts.html,
    body_text: opts.text,
    email_type: "public",
    tags_included: [SUBSCRIBER_TAG],
  };
  if (!apiKey()) {
    await devEcho("send", {
      ...payload,
      html: `<${opts.html.length} chars>`,
      text: `<${opts.text.length} chars>`,
    });
    return;
  }
  await buttondown("/emails", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
