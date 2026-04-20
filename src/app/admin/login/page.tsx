import type { Metadata } from "next";
import { LoginForm } from "./LoginForm";

/**
 * Login gate for /admin. Kept out of every index - this page has no reason
 * to appear in Google, Bing, Claude, or anywhere else. `robots: noindex`
 * metadata plus the site-wide robots.txt disallow on /admin enforce that
 * from both sides.
 */
export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLoginPage({
  searchParams,
}: {
  searchParams: { next?: string; error?: string };
}) {
  const next = searchParams?.next || "/admin";
  const error = searchParams?.error;
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm border border-ink px-6 py-8 flex flex-col gap-6">
        <h1
          className="font-display font-black text-[40px] leading-[0.95]"
          style={{ letterSpacing: "-0.03em" }}
        >
          Sign in
          <span
            className="font-serif italic font-normal text-mute text-[0.34em] block leading-[1.25] mt-1"
            style={{ letterSpacing: "0" }}
          >
            curator only
          </span>
        </h1>
        <LoginForm next={next} error={error} />
        <p className="font-mono text-[10px] uppercase tracking-widest text-mute leading-[1.6]">
          This area is restricted to the site curator. If you are here by
          accident, head back to the{" "}
          <a href="/" className="border-b border-mute hover:text-ink hover:border-ink">
            feed
          </a>
          .
        </p>
      </div>
    </div>
  );
}
