/**
 * Edge middleware - the single gate in front of every admin surface.
 *
 * Protected paths:
 *   - /admin/**                     (the UI)
 *   - /api/curate                   (status changes)
 *   - /api/edit                     (record edits)
 *   - /api/pool                     (admin list endpoint)
 *   - /api/newsletter/queue         (newsletter queue add/remove)
 *   - /api/newsletter/send          (trigger newsletter send)
 *
 * Public paths (explicitly NOT auth-gated):
 *   - /api/newsletter/subscribe     (public signup form)
 *   - /api/newsletter/unsubscribe   (public unsubscribe form)
 *
 * Rules:
 *   1. Unauthenticated request to a protected path → 302 to /admin/login
 *      (with `?next=` preserved so the login can bounce back).
 *   2. Authenticated request to /admin/login → 302 to /admin (no re-login).
 *   3. All other traffic passes through untouched.
 *
 * Authentication = valid HMAC'd session cookie. See src/lib/admin-auth.ts.
 *
 * Note: middleware runs on the Edge runtime, so auth must stay crypto-subtle-
 * only (no Node `crypto` import). Cookie scope is site-wide but marked
 * httpOnly so client JS (and any embedded iframe player) can't read it.
 */
import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, verifySession } from "@/lib/admin-auth";

const PROTECTED_EXACT = [
  "/api/newsletter/queue",
  "/api/newsletter/send",
];
const PROTECTED_PREFIXES = ["/admin", "/api/curate", "/api/edit", "/api/pool"];
const LOGIN_PATH = "/admin/login";
const LOGIN_API = "/api/admin/login";

function isProtected(pathname: string): boolean {
  if (pathname === LOGIN_PATH) return false; // allow login UI
  if (pathname === LOGIN_API) return false;  // allow login POST
  if (pathname === "/api/admin/logout") return false; // allow logout
  if (PROTECTED_EXACT.includes(pathname)) return true;
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const cookie = req.cookies.get(ADMIN_COOKIE)?.value;
  const authed = await verifySession(cookie);

  // Already-logged-in: don't show the login form.
  if (authed && pathname === LOGIN_PATH) {
    const url = req.nextUrl.clone();
    url.pathname = "/admin";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (isProtected(pathname) && !authed) {
    // API routes get a plain 401 - the client code already handles it.
    // UI requests get bounced to the login page with ?next= for convenience.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = LOGIN_PATH;
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

/**
 * Matcher: only run on routes we actually care about. Avoids the cost of
 * edge invocation on every static asset / public page.
 */
export const config = {
  matcher: [
    "/admin/:path*",
    "/api/curate/:path*",
    "/api/edit/:path*",
    "/api/pool/:path*",
    "/api/admin/:path*",
    "/api/newsletter/queue",
    "/api/newsletter/send",
  ],
};
