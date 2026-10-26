# System Design Scenarios

Real-world system design situations, each with four possible calls, a simulation to play
with, and the reasoning behind every option. English and Vietnamese.

No framework, no build step, no dependencies: static HTML, CSS and ES modules, served as-is.

## Run it

```bash
make serve     # http://127.0.0.1:8090/
make test      # node --test (Node 20+)
```

ES modules don't load from `file://`, so open it through the server, not by double-clicking.

## Add a scenario

```bash
make new ID=cache-stampede
```

This copies `scenarios/_template/` to `scenarios/cache-stampede/`. Then:

1. Add `'cache-stampede'` to `scenarios/index.js`, in the order it should appear.
2. Set `category` to one id from `scenarios/categories.js` (caching, database, queue,
   microservices, networking, reliability, scalability, security). A new category needs
   an entry there plus a `--cat-<id>` color and `.cat-<id>` class in `css/style.css`.
3. Write the content in `index.js`: situation, question, four options each with a *why*,
   the answer, a takeaway and sources. Every text field is `{ en, vi }`.
4. Build the simulation in `sim.js`, or remove it if the scenario doesn't need one.
5. Run `make test`. It fails while any `TODO`, missing translation or placeholder source remains.

`scenarios/rate-limit-algorithms/` is a complete worked example.

## How it fits together

```
index.html            the shell: header, language switch, #main
css/style.css         theme tokens (simulations read these too) and all styles
js/app.js             hash routing, the list, the scenario page, the answer picker and reveal
js/i18n.js            EN/VI: t() for UI strings, tx() for { en, vi } content
js/dom.js             el() and md(), the small, escape-first text formatter
js/progress.js        what this browser has answered (localStorage)
js/sim-kit.js         controls, canvas, animation and seeded randomness for simulations
js/sim-player.js      the shared player for watched simulations: situation × setup
                      pickers, speed, pause/step/replay, captions, log, scoreboard
js/sim-draw.js        canvas pieces for services passing messages: boxes with icons,
                      roads, messages in flight, the "later" card
scenarios/index.js    the ordered list of scenario ids
scenarios/categories.js  the categories (filter order, labels); colors are in style.css
scenarios/<id>/       index.js (content) + sim.js (simulation)
tests/                node:test, no dependencies
```

A simulation exports `mount(root, { revealed, state })` and returns a cleanup function.
The app re-mounts it when the visitor checks their answer, so a simulation can keep the
controls that would give the answer away locked until then.

## Deploy

Any static host works. On Vercel: import the repo, set the framework preset to **Other**,
and leave the build command and output directory empty.

## Credits

The topic list is inspired by *60 Days of System Design Questions* by
[Joud Awad](https://www.linkedin.com/in/joud-awad/). The scenarios, explanations and
simulations here are original and cite their own sources.
