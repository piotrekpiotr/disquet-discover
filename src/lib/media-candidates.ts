import { promises as fs } from "fs";
import path from "path";

/**
 * Media-driven candidate pool. Populated by scripts/sync-media.mjs on
 * every daily run: when a Pitchfork / RA / Fact / Quietus RSS entry
 * references an artist we DON'T already track, we accumulate that name
 * here so the curator can review and (optionally) promote to the
 * monitoring pool.
 *
 * Shape on disk (`data/media-candidates.json`):
 *
 *   {
 *     "Artist Name": {
 *       firstSeen: "2026-04-23",
 *       lastSeen: "2026-04-25",
 *       sources: ["pitchfork", "ra"],
 *       titleHints: ["Album Name", "Single Name"],
 *       mentions: 3,
 *       dismissed?: true         // curator chose "not interested"
 *     },
 *     ...
 *   }
 *
 * "Promote" = curator clicks the button, we add the artist to
 * monitoring-extras AND mark the candidate as dismissed so it doesn't
 * clutter the list again (we can't delete — the RSS scan would just
 * re-add it next run).
 *
 * "Dismiss" = curator passes on it. Marked dismissed in-place. The RSS
 * scan still reads the entry's existing record and won't append more
 * sources if the candidate is dismissed — but if a new source mentions
 * the artist later, we'll un-dismiss (hypothesis: that's usually news).
 *
 * We never hard-delete: the file is a decision ledger, and empty-list
 * weeks should look exactly like "nothing new this week", not "list
 * was wiped".
 */

const FILE = path.join(process.cwd(), "data", "media-candidates.json");

export interface AutoPromoteScore {
  topMatch: number;
  poolMatchCount: number;
  bestPoolArtist?: string;
}

export interface MediaCandidate {
  firstSeen: string; // YYYY-MM-DD
  lastSeen: string; // YYYY-MM-DD
  sources: string[];
  titleHints: string[];
  mentions: number;
  dismissed?: boolean;
  promoted?: boolean;
  /**
   * True when the daily sync-media run promoted this artist itself
   * (multi-source press + Last.fm similarity passed both gates). The
   * admin UI uses this to show a small badge distinguishing an artist
   * the curator promoted manually from one the workflow promoted, so
   * unexpected additions to monitoring-extras aren't mysterious.
   */
  autoPromoted?: boolean;
  autoPromoteScore?: AutoPromoteScore;
  /**
   * Populated by the Last.fm tag-discovery source — the subset of our
   * pool's tag fingerprint that this candidate ALSO appears under.
   * UI renders this as a small "matched on: ambient · idm · dub
   * techno" subtitle so the curator immediately sees why the
   * algorithm thought this artist was scene-adjacent.
   */
  poolTags?: string[];
  /** Count of fingerprint tags the candidate hit (denormalised from
   *  poolTags.length to stay forward-compatible if we ever truncate
   *  the displayed list). */
  poolTagOverlap?: number;
}

export type MediaCandidates = Record<string, MediaCandidate>;

/** Shape surfaced to the admin UI — the object form is awkward to map. */
export interface CandidateRow extends MediaCandidate {
  name: string;
}

let cache: MediaCandidates | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function load(): Promise<MediaCandidates> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    cache = sanitise(parsed);
    return cache;
  } catch (e: unknown) {
    if (isEnoent(e)) {
      cache = {};
      return cache;
    }
    throw e;
  }
}

function sanitise(raw: unknown): MediaCandidates {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: MediaCandidates = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const v = val as Record<string, unknown>;
    const score = v.autoPromoteScore;
    const sanitisedScore: AutoPromoteScore | undefined =
      score && typeof score === "object"
        ? {
            topMatch:
              typeof (score as Record<string, unknown>).topMatch === "number"
                ? ((score as Record<string, unknown>).topMatch as number)
                : 0,
            poolMatchCount:
              typeof (score as Record<string, unknown>).poolMatchCount ===
              "number"
                ? ((score as Record<string, unknown>).poolMatchCount as number)
                : 0,
            bestPoolArtist:
              typeof (score as Record<string, unknown>).bestPoolArtist ===
              "string"
                ? ((score as Record<string, unknown>).bestPoolArtist as string)
                : undefined,
          }
        : undefined;

    out[name] = {
      firstSeen: typeof v.firstSeen === "string" ? v.firstSeen : "",
      lastSeen: typeof v.lastSeen === "string" ? v.lastSeen : "",
      sources: Array.isArray(v.sources)
        ? v.sources.filter((s): s is string => typeof s === "string")
        : [],
      titleHints: Array.isArray(v.titleHints)
        ? v.titleHints.filter((s): s is string => typeof s === "string")
        : [],
      mentions: typeof v.mentions === "number" ? v.mentions : 0,
      dismissed: v.dismissed === true ? true : undefined,
      promoted: v.promoted === true ? true : undefined,
      autoPromoted: v.autoPromoted === true ? true : undefined,
      autoPromoteScore: sanitisedScore,
      poolTags: Array.isArray(v.poolTags)
        ? v.poolTags.filter((s): s is string => typeof s === "string")
        : undefined,
      poolTagOverlap:
        typeof v.poolTagOverlap === "number" ? v.poolTagOverlap : undefined,
    };
  }
  return out;
}

async function persist(data: MediaCandidates): Promise<void> {
  cache = data;
  writeQueue = writeQueue.then(() =>
    fs.writeFile(FILE, JSON.stringify(data, null, 2), "utf-8"),
  );
  await writeQueue;
}

/**
 * Return candidates as an array sorted by (source-count desc, last-seen desc).
 * The UI shows multi-source candidates at the top because "three outlets
 * independently wrote about this artist this month" is much stronger
 * signal than "Pitchfork ran one review".
 *
 * Dismissed AND promoted entries are hidden by default — they're only
 * kept on disk to prevent re-surfacing. Pass `includeHidden: true` to
 * see everything (e.g. for an audit view).
 */
export async function listCandidates(opts: {
  includeHidden?: boolean;
} = {}): Promise<CandidateRow[]> {
  const data = await load();
  const rows: CandidateRow[] = Object.entries(data).map(([name, c]) => ({
    name,
    ...c,
  }));
  const visible = opts.includeHidden
    ? rows
    : rows.filter((r) => !r.dismissed && !r.promoted);
  visible.sort((a, b) => {
    const sa = (a.sources || []).length;
    const sb = (b.sources || []).length;
    if (sb !== sa) return sb - sa;
    return (b.lastSeen || "").localeCompare(a.lastSeen || "");
  });
  return visible;
}

export async function markDismissed(name: string): Promise<boolean> {
  const data = await load();
  const cur = data[name];
  if (!cur) return false;
  if (cur.dismissed) return false;
  data[name] = { ...cur, dismissed: true };
  await persist(data);
  return true;
}

export async function markPromoted(name: string): Promise<boolean> {
  const data = await load();
  const cur = data[name];
  if (!cur) {
    // Promoting something the sync never saw — allow it anyway, as a
    // bookkeeping record. Otherwise the admin couldn't promote an artist
    // they typed in manually but which was also in the candidate file
    // for one run, was promoted, then fell off — then came back.
    data[name] = {
      firstSeen: new Date().toISOString().slice(0, 10),
      lastSeen: new Date().toISOString().slice(0, 10),
      sources: [],
      titleHints: [],
      mentions: 0,
      promoted: true,
    };
  } else {
    data[name] = { ...cur, promoted: true };
  }
  await persist(data);
  return true;
}

function isEnoent(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: unknown }).code === "ENOENT"
  );
}
