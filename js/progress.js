/* What this visitor has answered: { [scenarioId]: { picked, correct, at } }.
   Per-browser and disposable, so localStorage is the right place; when storage is
   blocked it still works for the session, it just forgets on reload. */

const KEY = 'sds-progress';

let state = (() => {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
})();

const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* keep the in-memory copy */ }
};

export const get = id => state[id] || null;

export function record(id, picked, correct) {
  state[id] = { picked, correct, at: new Date().toISOString() };
  save();
}

export function clear(id) {
  delete state[id];
  save();
}

export const solvedCount = ids => ids.filter(id => state[id]?.correct).length;
