# Project guide

Read `README.md` first for how to run it and how the pieces fit. This file is what an agent
needs to change it safely.

## Content rules: read before writing any scenario

1. **Original writing only.** The topic list was inspired by Joud Awad's ebook *60 Days of
   System Design Questions*. Its text is copyrighted. Never open, quote, paraphrase or
   closely follow it: not its scenarios, options, explanations or numbers. Take a topic
   *name* at most, and write everything else from your own understanding and the
   sources you cite.
2. **Every scenario cites real sources** (engineering blogs, official docs, papers). Do not
   invent a source or a statistic. If you can't verify a claim, leave it out, or say in
   the text that it is an estimate.
3. **Both languages are written by hand**, side by side as `{ en, vi }`. Vietnamese keeps
   the standard English technical terms (cache, shard, rate limit, API key) where Vietnamese
   engineers use them.
4. **Exactly one best answer under the stated constraints.** If two options are defensible,
   add a constraint to the scenario that separates them. Don't hide the ambiguity.

## Ground rules for code

1. **No build step, no framework, no runtime dependencies.** Static files served as-is.
   `package.json` exists only so Node treats `.js` as ES modules for the tests.
2. **UI strings** go through `t()` with a Vietnamese entry in `VI` (`js/i18n.js`).
   `tests/i18n.test.js` fails on a missing or unused entry. Avoid apostrophes inside `t('...')`
   literals (use ’) so the scanner reads them.
3. **Content and simulation strings** are `{ en, vi }` read with `tx()`, kept next to the
   scenario they belong to, not in the global table.
4. **Content text goes through `md()`** (`js/dom.js`), which escapes first. Never set
   `innerHTML` from content.
5. **Simulations** follow the contract in `js/sim-kit.js`: pure, exported model functions
   (tested), DOM only in `mount()`, cleanup stops every timer and observer, seeded
   randomness via `rng()`, and answer-revealing controls locked while `!revealed`.
6. **Browser storage** (`localStorage`) is per-visitor convenience only, and every access
   is wrapped in try/catch.

## Testing

`make test`. `tests/scenarios.test.js` checks that every listed scenario is complete in both
languages. Each simulation's model should get its own test file pinning the behaviour the
scenario argues for (see `tests/rate-limit-algorithms.test.js`).
