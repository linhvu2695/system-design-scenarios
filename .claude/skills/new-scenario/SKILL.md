---
name: new-scenario
description: Turn a pasted system design question into this site's workflow. First give a verdict on the question's answer. Then, when asked, write an original bilingual scenario with a step-by-step teaching simulation on the shared player, plus tests, a visual check and a report. Use when the user pastes a multiple-choice system design question, asks "what do you think is the answer", or asks to "write the question", "create the scenario" or "build the simulation" for a topic.
---

# New scenario from a pasted question

The user works in two turns, so this skill has two phases. Do phase 1 only, unless they
ask for the scenario in the same message. Never commit until they say "commit and push".

Read `CLAUDE.md` first. Its content rules are hard rules. Above all, **never reuse the
ebook's text, numbers, options or framing**. Take the topic name and nothing else.

## Phase 1: answer the question

When they ask what the answer is:

1. **Give the letter and the deciding reason** in the first two lines.
2. **Rule out each other option** in a line each: what it fixes, and what it still gets
   wrong.
3. **Flag flaws in the question.** For example:
   - two options are really the same mechanism;
   - a stated requirement rules out every option (such as jump-to-page with keyset
     pagination);
   - the numbers don't add up;
   - a missing constraint is needed to separate two options.

   Say what constraint would make one answer the only right one. That constraint
   becomes the scenario's separator in phase 2.
4. If they then ask to be taught the concept, teach it from the ground up. Use a small
   concrete table or example, ASCII pictures and one idea per section, and finish with
   a one-sentence summary. Offer to build the scenario.

## Phase 2: build the scenario

### 1. Design before writing

- **Pick a new real-world setting.** Use a different domain, company shape and numbers
  from the ebook's.
- **Choose 4 options, A–D, with exactly one passing every constraint.** Move the answer
  letter around: recent answers were C, C, B.
- Each wrong option must fail for a teachable reason: a real trade-off, not a straw man.
- **Lay out the simulation:**
  - **Situations (3–5):** a calm one where everything passes, then each one exposes one
    failure.
  - **Setups:** usually "Today" (the status quo, unlocked before the answer) plus the 4
    options.
- **Write the scoreboard matrix first**, as setup × situation → ✓/✗. Only the answer's
  row is all ✓. No two wrong options should share a row, unless one differs only in
  degree (and then show that degree in the picture).
- **Ask what the user wants to see.** Their requests have been "show how each
  transport works", "show celebrity versus normal-user fanout" and "show shallow is
  fast, deep is slow". Make that mechanism the centre of the picture, not a side panel.

### 2. Verify sources before citing

- Use WebFetch on each source and confirm it says what you cite it for. Prefer official
  docs (PostgreSQL, RFCs, WHATWG, MDN), engineering blogs (Slack, Stripe, Twitter) and
  well-known references (Use The Index Luke, DDIA).
- Every URL must be `https`; `tests/scenarios.test.js` rejects anything else.
- A number you can't source is a scenario fact ("you measured…") or labelled an
  estimate. Simulation timings come from a small cost model, and the code says so.

### 3. Files

Run `make new ID=<kebab-id>`, then:

- **`scenarios/<id>/index.js`**
  - `category` (from `scenarios/categories.js`), `topic`, `title`.
  - `scenario` in markdown: the setting, then "what you see", then the constraints, in
    bold.
  - `question`; `options` A–D with `text` and `why`; `answer`; `takeaway` (a bold
    first line, then bullets); `sources`; `simulation`.
  - Every field is `{ en, vi }`, written by hand. Vietnamese keeps the English technical
    terms (cache, index, cursor, rate limit, …) and uses `.` as the thousands separator.
  - Each `why` explains the mechanism, why the option fails or passes *under these
    constraints*, and when it *would* be the right choice.
- **`scenarios/<id>/sim.js`** follows the shape of `scenarios/keyset-pagination/sim.js`,
  `streaming-transport/sim.js` or `feed-fanout/sim.js`:
  - Export `SETUPS`, `SITUATIONS`, the constants, and a pure `run(setup, situation)`
    that returns `{ steps, ok, summary, ...facts for tests }`, plus
    `survives = (s, x) => run(s, x).ok`.
  - A step is `{ label, kind, say: { en, vi }, act }`. `act` is what `draw()` animates.
    Captions are full sentences with the real values (ids, SQL, headers, ms).
  - `mount()` calls `player(root, ctx, { situations, setups, open: ['today'], initial,
    run, survives, height, duration, tone, draw })`. Situation and setup icons are names
    from `js/icons.js`, so check that the name exists.
  - `draw()` rebuilds state from `steps.slice(0, k)` plus the current step at `p`. Use
    theme tokens through `css()`: blue, pink, violet, ok, warn, bad, text, muted, faint,
    line, bg, bg2, surface2, cat-*.
  - **Anything that reveals the answer stays hidden while `!revealed`**: other setups'
    curves, labels and comparisons. Pass a `visible(setup)` helper into `draw`.
  - Lay the canvas out to work at narrow widths (`w < 560`): stack panels, clamp text
    with a maxWidth, and give labels over chart lines a background pill.
- **`tests/<id>.test.js`:**
  - the `EXPECTED` scoreboard matrix;
  - one test per claim the scenario makes (the mechanism and the numbers it cites);
  - "every step has a caption in both languages".
- **`scenarios/index.js`:** append the id.

### 4. Check it

1. Run `make test`. Every test must pass.
2. Print the matrix from the model and compare it with the design:
   ```bash
   node -e "import('./scenarios/<id>/sim.js').then(m => { for (const s of m.SETUPS) console.log(s, m.SITUATIONS.map(x => m.survives(s, x) ? 'T' : 'F').join(' ')) })"
   ```
3. Take screenshots of the key runs and look at every one of them:
   ```bash
   .claude/skills/new-scenario/shot.sh <id> <setup> <situation> [steps=20] [width=860] [play]
   ```
   - The script needs `make serve` running on port 8090 (start it in the background if
     it isn't).
   - With the default 20 steps the run jumps to its end. Use `2 … play` to catch an
     animation part-way through.
   - Look for overlapping text, labels on top of lines, empty or cramped panels, and
     whether the picture alone shows the mechanism.
   - Headless Chrome won't render narrower than about 500px, so judge phone layouts
     from the code.

### 5. Report and stop

Reply with:

- the title, the setting in a line, and the answer;
- what the visitor watches for each setup;
- the ✓/✗ matrix as a table with the deciding numbers;
- the sources as links;
- any judgement call you made (for example a relaxed threshold, and why);
- the changed files;
- "Say 'commit and push' when you're happy with it."

On "commit and push":

1. Run `git status` and stage **only this scenario's files**. Mention any unrelated
   changes and leave them out.
2. Commit with a short title ("Add <topic> scenario"), a two-line body and the
   Co-Authored-By trailer.
3. Push to `main`. Vercel deploys on push.
