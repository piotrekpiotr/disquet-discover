#!/usr/bin/env node
/**
 * One-off: resize Apple Music embeds to a usable height (450 for album/ep,
 * 175 for single) and hand-write mockup descriptions for the 14 records
 * currently approved in the feed, so the user can see what the final layout
 * will look like before we run the auto-description pass.
 *
 * These descriptions are marked with a DESC_MOCK prefix comment block in
 * this file so we can identify and regenerate them later. They're written
 * in the same Boomkat-style voice the description prompt will produce.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/recommendations.json");

const MOCK = {
  "flying-lotus-1983":
    "Plug Research reissues the beat-splatter debut that introduced Steven Ellison's signal vocabulary - jazzy, warped, already unmistakably Brainfeeder-adjacent. Nothing here has aged into the period it came from.",
  "shinichi-atobe-silent-way":
    "The famously reclusive Chain Reaction alumnus resurfaces with another studio of glassy, narcotic dub techno. Loops drift rather than lock; for anyone still returning to Butterfly Effects.",
  "oneohtrix-point-never-dim-stars-for-residue-extended":
    "Two long-form Lopatin sketches extended into the kind of elastic, synth-warped ambient he has been quietly refining since Magic Oneohtrix. Warp doing what Warp does.",
  "ok-eg-geko01":
    "Melbourne duo inaugurate their own GEKO label with four cuts of live-edit dub, broken beat and reverb-soaked house. Built from jam sessions, left rough on purpose.",
  "djrum-come-find-me":
    "A loose, after-hours 12\" from the Houndstooth regular: woody percussion and half-heard voices sat somewhere between jungle and the more wistful end of Hessle Audio. Contained, not quiet.",
  "oneohtrix-point-never-tranquilizer":
    "Lopatin dials back the maximalism. Warp-issued, structurally loose, more interested in the texture of a decaying sample than the payoff. For anyone who prefers Replica to Garden of Delete.",
  "stenny-sharp-fragments":
    "Ilian Tape's Stenny commits to the harder end of the label's Munich palette: swung hi-hats, tunnelling sub, the odd passage of near-breakcore. Tools, not tracks.",
  "mount-xlr-phase-i":
    "Four tracks of lurching bass music that sits close to AD 93's broken-club axis without naming it. Heavier than it pretends to be.",
  "ben-bondy-xo-salt-llif3":
    "Another dispatch from the 3XL orbit: blurred ambient pop where melody keeps surfacing through fog. Sits next to exael and Ulla without sounding derivative.",
  "mount-xlr-limequaker":
    "A one-off cut that doubles down on the wobble. Functional, unpretty, built for a specific hour.",
  "dj-python-early-hours-dj-mix":
    "Python in mix mode: deng-deng rhythms folded through ambient interludes, the whole thing paced for a 4am room rather than a festival slot. Fans of Huerco S. will recognise the gravity.",
  "rival-consoles-landscape-from-memory":
    "Ryan Lee West's latest for Erased Tapes is the melancholic, melodic modular record you expected and then some. Less Nils Frahm, more a slowly collapsing arpeggio.",
  "four-tet-into-dust-still-falling":
    "Hebden in his 2020s mode: a single long arc of chopped vocal, bright pad and micro-detail that resolves into something close to pop. XL-issued, unmistakable.",
  "rival-consoles-if-not-now":
    "A one-track aside between albums: a slow build on analogue synths that keeps threatening a climax and wisely refuses one.",
};

async function main() {
  const items = JSON.parse(await fs.readFile(FILE, "utf8"));
  let resized = 0;
  let described = 0;
  for (const item of items) {
    // Resize Apple embeds
    if (item.embed && item.embed.provider === "apple") {
      const target = item.type === "single" ? 175 : 450;
      if (item.embed.height !== target) {
        item.embed.height = target;
        resized++;
      }
    }
    // Apply mockup description if one exists for this id AND the record
    // currently has no description
    const mock = MOCK[item.id];
    if (mock && (!item.description || !item.description.trim())) {
      item.description = mock;
      described++;
    }
  }
  await fs.writeFile(FILE, JSON.stringify(items, null, 2), "utf8");
  console.log(`Resized ${resized} embeds, applied ${described} mockup descriptions.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
