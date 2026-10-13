/* Every t('...') string in the app has a Vietnamese entry; a missing one would
   silently show English. (Scenario and simulation text is { en, vi } and is checked
   by scenarios.test.js and by reading it.) */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { VI } from '../js/i18n.js';

const jsDir = new URL('../js/', import.meta.url);
const used = new Set();
for (const f of readdirSync(jsDir).filter(f => f.endsWith('.js'))) {
  const src = readFileSync(new URL(f, jsDir), 'utf8');
  for (const m of src.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) used.add(m[1].replace(/\\'/g, "'"));
}

test('every UI string has a Vietnamese translation', () => {
  const missing = [...used].filter(s => !VI[s]);
  assert.deepEqual(missing, [], 'add these to VI in js/i18n.js');
});

test('the VI table has no leftovers', () => {
  const unused = Object.keys(VI).filter(s => !used.has(s));
  assert.deepEqual(unused, [], 'remove these from VI in js/i18n.js, or use them');
});

test('placeholders survive translation', () => {
  for (const [en, vi] of Object.entries(VI)) {
    const vars = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    assert.deepEqual(vars(vi), vars(en), `placeholders differ in: ${en}`);
  }
});
