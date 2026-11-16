// A small Markdown renderer for the user guide (guide/*.md), so the same pages
// read well on GitHub and inside the app without a dependency. It covers what
// the guide uses: headings (with GitHub-style ids, so "page.md#a-heading"
// links work in both places), paragraphs, **bold**, *italic*, `code`, links,
// images, nested bullet / numbered lists, tables, > quotes, fenced code and
// rules. Raw HTML is escaped, never passed through. Pure — Node-testable.

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GitHub's heading anchor: lower case, punctuation dropped, spaces → "-". */
export function slugify(text) {
  return String(text).toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Heading / search text without Markdown marks: "**Bold** `x` [a](b)" → "Bold x a". */
export function plainText(md) {
  return String(md)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])/g, '$1$2');
}

/**
 * Inline Markdown → HTML. opts.link(href) → { href, attrs } lets the caller
 * rewrite links (the reader keeps .md links inside itself); opts.img(src) → src.
 */
function inline(src, opts) {
  const out = [];
  // pull code spans out first so nothing inside them is formatted
  const codes = [];
  let s = String(src).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = escHtml(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) =>
    `<img src="${escHtml(opts.img ? opts.img(url) : url)}" alt="${alt}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const l = opts.link ? opts.link(url) : { href: url };
    return `<a href="${escHtml(l.href)}"${l.attrs || ''}>${text}</a>`;
  });
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?![\w*])/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escHtml(codes[i])}</code>`);
  out.push(s);
  return out.join('');
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = (l) => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/**
 * Render a Markdown document. Returns { html, headings: [{ level, text, id }] }.
 * opts: { link(href) → { href, attrs }, img(src) → src }
 */
export function renderMarkdown(md, opts = {}) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  const headings = [];
  const used = new Map();
  let i = 0;

  const para = [];
  const flush = () => {
    if (para.length) html.push(`<p>${inline(para.join(' '), opts)}</p>`);
    para.length = 0;
  };

  // a list block, nested by indentation: returns the html, advances i
  const list = () => {
    const items = []; // { indent, ordered, text, children: [] }
    while (i < lines.length) {
      const l = lines[i];
      const m = LIST.exec(l);
      if (m) { items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] }); i++; continue; }
      // a wrapped line continues the item above it
      if (l.trim() && items.length && /^\s+/.test(l) && !isTableRow(l)) { items[items.length - 1].text += ' ' + l.trim(); i++; continue; }
      break;
    }
    const build = (from, to, indent) => {
      let h = '';
      let k = from;
      const ordered = items[from].ordered;
      while (k < to) {
        const it = items[k];
        let end = k + 1;
        while (end < to && items[end].indent > indent) end++;
        h += `<li>${inline(it.text, opts)}${end > k + 1 ? build(k + 1, end, items[k + 1].indent) : ''}</li>`;
        k = end;
      }
      return ordered ? `<ol>${h}</ol>` : `<ul>${h}</ul>`;
    };
    return build(0, items.length, items[0].indent);
  };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { flush(); i++; continue; }

    if (t.startsWith('```')) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
      i++;
      html.push(`<pre><code>${escHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      const level = h[1].length;
      const text = plainText(h[2]);
      let id = slugify(text);
      const n = used.get(id) || 0;
      used.set(id, n + 1);
      if (n) id += `-${n}`;
      headings.push({ level, text, id });
      html.push(`<h${level} id="${escHtml(id)}">${inline(h[2], opts)}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) { flush(); html.push('<hr>'); i++; continue; }
    if (t.startsWith('>')) {
      flush();
      const q = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) q.push(lines[i++].trim().replace(/^>\s?/, ''));
      html.push(`<blockquote>${renderMarkdown(q.join('\n'), opts).html}</blockquote>`);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      html.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c, opts)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '', opts)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LIST.test(line)) { flush(); html.push(list()); continue; }
    para.push(t);
    i++;
  }
  flush();
  return { html: html.join('\n'), headings };
}
