/**
 * Newsletter provider client. Currently Buttondown-backed, but every call
 * goes through this module so a future switch (MailerLite, ConvertKit,
 * Resend Broadcasts) is one file of changes, not ten.
 *
 * Why Buttondown:
 *   - Free up to 100 subs, $9/mo past that. Matches the editorial tone.
 *   - JSON API with a simple "one send at a time" model.
 *   - Double opt-in via the API: create the subscriber with
 *     `type: "unactivated"` and Buttondown ships the confirmation email
 *     automatically. It flips the record to `regular` when the recipient
 *     clicks the link. (The account-level "require double opt-in" toggle
 *     only applies to Buttondown-hosted signup pages, NOT API calls, so
 *     we have to set the type explicitly or no confirmation ever goes
 *     out — this was the root cause of the "I never got an email" bug
 *     on launch.)
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
 *
 * `type: "unactivated"` is what triggers Buttondown to send the double
 * opt-in confirmation email. The subscriber stays unactivated (won't
 * receive any newsletter sends) until they click the confirmation link,
 * at which point Buttondown flips them to `regular`. If you set type to
 * `regular` directly, Buttondown treats the subscriber as already
 * confirmed and never mails them — which is what silently broke the
 * launch-day signup form.
 *
 * 400 responses from Buttondown often mean "already a subscriber" — we
 * surface those upstream as errors, but the API route treats them as a
 * generic upstream failure so we don't leak membership state.
 */
export async function subscribe(email: string): Promise<void> {
  const payload = {
    email_address: email,
    tags: [SUBSCRIBER_TAG],
    type: "unactivated",
    notes: `signup:${new Date().toISOString()}`,
  };
  if (!apiKey()) {
    await devEcho("subscribe", payload);
    return;
  }
  // Hand-rolled call (not `buttondown()`) so we can inspect the 400 body
  // and tell "already subscribed" apart from "real validation error".
  // Buttondown returns 400 with code "email_already_exists" (or a 201 with
  // the existing record on newer API versions) when the address is already
  // on file. We swallow that case so repeat submitters still see the
  // "check your inbox" state, keeping the endpoint non-enumerable.
  const res = await fetch(`${API_BASE}/subscribers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Token ${apiKey()}`,
    },
    body: JSON.stringify(payload),
  });
  if (res.ok) return;
  const text = await res.text();
  if (res.status === 400 && /already|exists|duplicate/i.test(text)) {
    // Treat "already on the list" as success; Buttondown won't resend a
    // confirmation email to an already-activated subscriber anyway.
    return;
  }
  throw new Error(`Buttondown ${res.status}: ${text.slice(0, 300)}`);
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
 * Create a Buttondown email DRAFT for the next mailing.
 *
 * IMPORTANT — this does NOT send to subscribers. POST /v1/emails with
 * the payload below creates the email in Buttondown's "Drafts" state;
 * the curator must then click "Publish" inside Buttondown's UI to
 * actually push it to subscribers. This is intentional: it gives the
 * curator a chance to preview the rendered email, tweak the subject /
 * intro text on Buttondown's side, and only then commit the send.
 *
 * Why we don't auto-publish:
 *   The Buttondown API supports an `about_to_send` status that would
 *   skip the draft and ship immediately. We deliberately don't use it —
 *   the curator wanted the preview-then-publish loop ("If that's the
 *   route - confirm it and I'll try sending manually"). If that
 *   preference ever flips, set `status: "about_to_send"` in the
 *   payload below; everything else stays the same.
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
    // Status omitted on purpose → Buttondown defaults to "draft".
    // See the function-level comment above for the rationale.
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
