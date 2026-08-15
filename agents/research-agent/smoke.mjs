import { buildPptx } from "./src/deck-to-pptx.ts";
import { writeFileSync } from "node:fs";

const sampleDeck = `## Why draft, and what we're optimizing for

- Low-cost, low-commitment way to play a full game night with friends
- No deckbuilding homework beforehand — everyone starts from the same pool
- Optimizing for fun and a fair fight, not competitive tuning

> Frame this as the pitch before anything else, since it sets expectations for the rest of the deck.

---

## Recommended set: Bloomburrow

- Draftable as booster boxes, ~$100-120/box, 30 packs
- Power level is moderate — built for limited, not just Standard
- Small, animal-tribal color pairs make archetypes easy to read

> Lead with why this set specifically fits a casual home pod.
`;

const buf = await buildPptx("Casual MTG Draft Night — Test Deck", sampleDeck, {
  tier: 1,
  stub: false,
  inputTokens: 1234,
  outputTokens: 567,
  calls: 2,
});

writeFileSync("/tmp/smoke-output.pptx", buf);
console.log("wrote", buf.length, "bytes");
