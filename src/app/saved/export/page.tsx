import type { Metadata } from "next";
import { ExportClient } from "./ExportClient";
import "./print.css";

/**
 * /saved/export — print-optimised view of the visitor's saved list.
 *
 * Noindex and nofollow: this page is personal, ephemeral, and depends on
 * localStorage state that search engines don't have. It has no canonical
 * content to index.
 */
export const metadata: Metadata = {
  title: "Export saved",
  robots: { index: false, follow: false },
  alternates: { canonical: "/saved" },
};

export const dynamic = "force-dynamic";

export default function ExportPage() {
  return <ExportClient />;
}
