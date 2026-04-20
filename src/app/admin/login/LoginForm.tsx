"use client";
import { useState } from "react";

/**
 * Client-side login form. Posts JSON to /api/admin/login; on success the
 * server sets the signed session cookie and we navigate to `next` (which the
 * middleware set when it bounced the unauthenticated request here).
 *
 * `next` is taken from the URL, already URL-decoded by Next, but we still
 * sanitise: only allow same-origin paths starting with "/" (no "//foo" or
 * "http://..."). Otherwise a crafted link could ship the user off-site after
 * login.
 */
function safeNext(candidate: string): string {
  if (!candidate || !candidate.startsWith("/")) return "/admin";
  if (candidate.startsWith("//")) return "/admin";
  return candidate;
}

export function LoginForm({ next, error }: { next: string; error?: string }) {
  const target = safeNext(next);
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(Boolean(error));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFailed(false);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, next: target }),
      });
      if (!res.ok) {
        setFailed(true);
        setSubmitting(false);
        return;
      }
      window.location.href = target;
    } catch {
      setFailed(true);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="font-mono text-[10px] uppercase tracking-widest text-mute">
        Password
      </label>
      <input
        type="password"
        autoComplete="current-password"
        autoFocus
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="border border-ink bg-paper px-3 py-2 font-mono text-[13px] focus:outline-none focus:bg-paper-2/40"
      />
      {failed && (
        <div className="font-mono text-[10px] uppercase tracking-widest text-signal">
          Incorrect password
        </div>
      )}
      <button
        type="submit"
        disabled={submitting || password.length === 0}
        className="font-mono text-[10px] uppercase tracking-widest border border-ink px-4 py-2 hover:bg-ink hover:text-paper transition-colors disabled:opacity-40 disabled:hover:bg-paper disabled:hover:text-ink"
      >
        {submitting ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
