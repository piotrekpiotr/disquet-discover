/**
 * Shared Apple Music URL helpers. Lives in its own tiny module so
 * importing the helper doesn't pull in (and execute) the heavy
 * sync-artists / backfill scripts that also use it.
 */

/**
 * Pull the Apple Music collection ID out of an
 * `https://music.apple.com/.../album/.../<id>` URL. Returns null when
 * the URL isn't an Apple album link (search URLs, off-host,
 * malformed, etc.). Used for cross-artist dedup: same album under
 * different artist credits has the same Apple album ID.
 */
export function extractAppleAlbumId(url) {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/\/album\/(?:[^/]+\/)?(\d{6,})/i);
  return m ? m[1] : null;
}
