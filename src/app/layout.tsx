import type { Metadata, Viewport } from "next";
import { Archivo, Space_Grotesk, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ConsentBanner } from "@/components/ConsentBanner";
import {
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
} from "@/lib/site";
import { siteGraph, jsonLdScript } from "@/lib/structured-data";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "800", "900"],
  variable: "--font-archivo",
  display: "swap",
});
const grotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-grotesk",
  display: "swap",
});
const jbm = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-jbm",
  display: "swap",
});
const instrument = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-instrument",
  display: "swap",
});

/**
 * Site-wide metadata. `metadataBase` lets Next.js turn relative URLs into
 * absolute ones automatically for OpenGraph / Twitter / canonical tags.
 *
 * The `title.template` slot means every child page that sets its own title
 * gets "<page> | Disquet Discover" for free. The default title is the
 * full tagline (SEO keyword-rich, but still reads like English).
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} - ${SITE_TAGLINE}`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  applicationName: SITE_NAME,
  authors: [{ name: "Disquet" }],
  creator: "Disquet",
  publisher: "Disquet",
  category: "Music",
  alternates: {
    canonical: "/",
    types: {
      "application/rss+xml": [{ url: "/feed.xml", title: SITE_NAME }],
    },
  },
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: `${SITE_NAME} - ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} - ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-snippet": -1,
      "max-image-preview": "large",
      "max-video-preview": -1,
    },
  },
};

export const viewport: Viewport = {
  themeColor: "#fafaf5",
  colorScheme: "light",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${grotesk.variable} ${jbm.variable} ${instrument.variable}`}
    >
      <head>
        {/*
         * Site-wide JSON-LD graph (Organization + WebSite). Lives in <head>
         * so every page carries the identity context, regardless of whether
         * the page adds its own more-specific JSON-LD (MusicAlbum, FAQPage).
         * We stringify once; the helper escapes `</` to prevent a malicious
         * description from closing the script tag early.
         */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(siteGraph()) }}
        />
      </head>
      <body className="min-h-screen bg-paper text-ink flex flex-col">
        <Header />
        <main className="flex-1">{children}</main>
        <Footer />
        <ConsentBanner />
      </body>
    </html>
  );
}
