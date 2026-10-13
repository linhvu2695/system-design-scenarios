/* DOM helpers shared by the app and the simulations. */

export const $ = (sel, root = document) => root.querySelector(sel);

export const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) n.append(c?.nodeType ? c : document.createTextNode(c ?? ''));
  return n;
};

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const inline = s => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');

/* The formatter for scenario text. Deliberately tiny:
     blank line      -> new paragraph
     "- " lines      -> bullet list (every line of the block)
     ``` fenced ```  -> preformatted block (diagrams, request traces)
     **bold**, `code`
   It escapes before formatting, so content can never inject HTML. */
export function md(text) {
  const box = el('div', { class: 'md' });
  const src = String(text ?? '').replace(/\r/g, '').trim();
  // Split out fenced blocks first; their blank lines must not become paragraphs.
  src.split(/^```[^\n]*\n([\s\S]*?)^```\s*$/m).forEach((part, i) => {
    if (i % 2) { box.append(el('pre', {}, part.replace(/\n$/, ''))); return; }
    for (const block of part.trim().split(/\n\s*\n/)) {
      // Within a block, a run of "- " lines is a list; anything else is a paragraph,
      // so "Constraints:" directly above its bullets works.
      let para = [], ul = null;
      const flush = () => { if (para.length) box.append(el('p', { html: inline(para.join(' ')) })); para = []; };
      for (const line of block.split('\n').map(l => l.trim()).filter(Boolean)) {
        const bullet = line.match(/^[-•]\s+(.*)$/);
        if (bullet) {
          flush();
          if (!ul) box.append(ul = el('ul'));
          ul.append(el('li', { html: inline(bullet[1]) }));
        } else { ul = null; para.push(line); }
      }
      flush();
    }
  });
  return box;
}
