/* Template for a new scenario. `make new ID=<id>` copies this folder; then add the id
   to scenarios/index.js. The tests fail while any TODO is left, so nothing half-written
   ships.

   Every text field is { en, vi }. Text supports a small formatter (js/dom.js md()):
   blank line = new paragraph, "- " lines = bullets, ```fenced``` = preformatted,
   **bold** and `code`. Use template literals for multi-paragraph text.

   Write it yourself, from your own understanding and the sources you cite. See
   CLAUDE.md -> Content rules. */

import * as simulation from './sim.js';

export default {
  // One id from scenarios/categories.js.
  category: 'TODO',
  topic: { en: 'TODO topic', vi: 'TODO chủ đề' },
  title: { en: 'TODO a short, concrete title', vi: 'TODO tiêu đề' },

  // The situation: a concrete system, what went wrong, and the constraints that make
  // exactly one option the best call. The constraints are what make the question fair.
  scenario: {
    en: `TODO`,
    vi: `TODO`,
  },

  question: { en: 'TODO What do you do?', vi: 'TODO Bạn sẽ làm gì?' },

  // Four plausible options. Every `why` explains the option on its own terms: what it
  // gets right, where it breaks under *these* constraints, and when it would be right.
  options: [
    { id: 'A', text: { en: 'TODO', vi: 'TODO' }, why: { en: 'TODO', vi: 'TODO' } },
    { id: 'B', text: { en: 'TODO', vi: 'TODO' }, why: { en: 'TODO', vi: 'TODO' } },
    { id: 'C', text: { en: 'TODO', vi: 'TODO' }, why: { en: 'TODO', vi: 'TODO' } },
    { id: 'D', text: { en: 'TODO', vi: 'TODO' }, why: { en: 'TODO', vi: 'TODO' } },
  ],

  answer: 'A',

  // The one idea worth remembering, plus the alternatives worth knowing.
  takeaway: { en: `TODO`, vi: `TODO` },

  // Primary sources: engineering blogs, docs, papers. Open every link before you ship.
  sources: [
    { title: 'TODO', url: 'https://example.com/TODO' },
  ],

  // Optional: delete this and the import above for a scenario without a simulation.
  simulation,
};
