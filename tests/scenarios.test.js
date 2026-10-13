/* Every listed scenario is complete, in both languages, before it ships. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import IDS from '../scenarios/index.js';
import CATEGORIES from '../scenarios/categories.js';

const dir = new URL('../scenarios/', import.meta.url);
const folders = readdirSync(dir, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('_'))
  .map(d => d.name);

test('scenarios/index.js lists every scenario folder exactly once', () => {
  assert.equal(new Set(IDS).size, IDS.length, 'duplicate id in scenarios/index.js');
  assert.deepEqual([...IDS].sort(), [...folders].sort());
  for (const id of IDS) assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `id "${id}" must be kebab-case`);
});

test('categories have unique kebab-case ids, labels in both languages, and a color', () => {
  const ids = CATEGORIES.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate category id');
  const css = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');
  for (const c of CATEGORIES) {
    assert.match(c.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `category id "${c.id}" must be kebab-case`);
    bilingual(c.label, `category ${c.id}.label`);
    assert.match(css, new RegExp(`--cat-${c.id}:`), `add --cat-${c.id} to css/style.css`);
    assert.match(css, new RegExp(`\\.cat-${c.id}\\{`), `add .cat-${c.id} to css/style.css`);
  }
});

/* A { en, vi } pair with real text in both. */
function bilingual(v, where) {
  assert.ok(v && typeof v === 'object', `${where}: expected { en, vi }`);
  for (const lang of ['en', 'vi']) {
    assert.equal(typeof v[lang], 'string', `${where}.${lang} is missing`);
    assert.ok(v[lang].trim(), `${where}.${lang} is empty`);
    assert.doesNotMatch(v[lang], /\bTODO\b/, `${where}.${lang} still has a TODO`);
  }
}

for (const id of IDS) {
  test(`${id}: content is complete in both languages`, async () => {
    const { default: s } = await import(`../scenarios/${id}/index.js`);
    assert.ok(CATEGORIES.some(c => c.id === s.category), `category must be one of scenarios/categories.js, got "${s.category}"`);
    for (const field of ['topic', 'title', 'scenario', 'question', 'takeaway']) bilingual(s[field], field);

    assert.deepEqual(s.options?.map(o => o.id), ['A', 'B', 'C', 'D'], 'options must be A, B, C, D in order');
    for (const o of s.options) {
      bilingual(o.text, `option ${o.id}.text`);
      bilingual(o.why, `option ${o.id}.why`);
    }
    assert.ok(['A', 'B', 'C', 'D'].includes(s.answer), 'answer must be one of A–D');

    assert.ok(Array.isArray(s.sources) && s.sources.length, 'cite at least one source');
    for (const src of s.sources) {
      assert.ok(typeof src.title === 'string' ? src.title.trim() : src.title?.en, 'source needs a title');
      assert.match(src.url, /^https:\/\//, `source url must be https: ${src.url}`);
      assert.doesNotMatch(src.url, /example\.com|TODO/, `placeholder source: ${src.url}`);
    }

    if (s.simulation) assert.equal(typeof s.simulation.mount, 'function', 'simulation must export mount()');
  });
}
