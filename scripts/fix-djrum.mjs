#!/usr/bin/env node
/** Correct Djrum - Portrait With Firewood to its real 2018 R&S release. */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/recommendations.json");
const raw = await fs.readFile(FILE, "utf8");
const items = JSON.parse(raw);

const res = await fetch(
  "https://itunes.apple.com/search?term=Djrum+Portrait+with+Firewood&entity=album&limit=5&media=music",
).then((r) => r.json());
const match = (res.results || []).find(
  (r) => r.artistName === "Djrum" && /portrait with firewood/i.test(r.collectionName),
);
if (!match) {
  console.error("No iTunes match; aborting.");
  process.exit(1);
}

const art = match.artworkUrl100.replace(/\/\d+x\d+(bb)?\./, "/600x600bb.");
const apple = (match.collectionViewUrl || "").split("?")[0];

const idx = items.findIndex((r) => r.id === "djrum-portrait");
if (idx === -1) {
  console.error("djrum-portrait not found");
  process.exit(1);
}

items[idx] = {
  ...items[idx],
  type: "album",
  title: "Portrait With Firewood",
  label: "R&S Records",
  releaseDate: match.releaseDate.slice(0, 10),
  description:
    "Felix Manuel's third LP: jazz piano samples threaded through jungle, drum & bass and ambient detours, built with the patience of a producer who treats the album as a long-form composition. For listeners who keep returning to Pessimist, Loraine James and the Exit Records catalogue.",
  coverImageUrl: art,
  links: {
    ...items[idx].links,
    apple,
    bandcamp: "https://djrum.bandcamp.com/album/portrait-with-firewood",
    spotify: "https://open.spotify.com/album/1LMb8ufOTjRB8Ly5cJDNse",
    youtube: "https://www.youtube.com/results?search_query=djrum+portrait+with+firewood",
  },
};

await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
console.log("Fixed djrum-portrait:", items[idx].releaseDate, items[idx].coverImageUrl);
