// A tiny XML reader for the importers (MVR, GDTF, QLC+ and xLights files are
// all XML). The browser has DOMParser, but Node doesn't, and the importers are
// tested in Node — so this parses to a plain tree instead:
//   { tag, attrs: { name: value }, children: [node…], text }
// Enough for well-formed data files: elements, attributes, text, CDATA,
// comments, the XML declaration / processing instructions and a DOCTYPE
// (skipped), and the standard + numeric entities. Not a validating parser.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENT[e] ?? m;
  });
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Parse an XML string. Returns the root element node. Throws on a broken file. */
export function parseXml(src) {
  const text = String(src).replace(/^﻿/, '');
  const root = { tag: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) { addText(top, text.slice(i)); break; }
    if (lt > i) addText(top, text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) throw new Error('an XML comment never ends');
      i = e + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      if (e < 0) throw new Error('an XML CDATA block never ends');
      top.text += text.slice(lt + 9, e);
      i = e + 3;
    } else if (text[lt + 1] === '?') {
      const e = text.indexOf('?>', lt + 2);
      if (e < 0) throw new Error('an XML declaration never ends');
      i = e + 2;
    } else if (text[lt + 1] === '!') {
      // DOCTYPE (possibly with an internal subset in [...])
      let depth = 0, j = lt + 2;
      for (; j < n; j++) {
        if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        else if (text[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (text[lt + 1] === '/') {
      const e = text.indexOf('>', lt);
      if (e < 0) throw new Error('an XML tag never ends');
      const tag = text.slice(lt + 2, e).trim();
      const open = stack.pop();
      if (!open || open === root || open.tag !== tag) throw new Error(`the XML is broken near </${tag}>`);
      i = e + 1;
    } else {
      // start tag: find its end, skipping '>' inside quoted attribute values
      let j = lt + 1, q = null;
      for (; j < n; j++) {
        const c = text[j];
        if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
      }
      if (j >= n) throw new Error('an XML tag never ends');
      let body = text.slice(lt + 1, j);
      const selfClose = body.endsWith('/');
      if (selfClose) body = body.slice(0, -1);
      const m = /^[^\s/>]+/.exec(body);
      if (!m) throw new Error('the XML has an empty tag');
      const node = { tag: m[0], attrs: {}, children: [], text: '' };
      ATTR.lastIndex = m[0].length;
      let a;
      while ((a = ATTR.exec(body))) node.attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
      top.children.push(node);
      if (!selfClose) stack.push(node);
      i = j + 1;
    }
  }
  if (stack.length > 1) throw new Error(`the XML ends inside <${stack[stack.length - 1].tag}>`);
  const el = root.children[0];
  if (!el) throw new Error('the file has no XML in it');
  return el;
}

function addText(node, s) {
  if (node.tag === '#document') return;
  node.text += decodeEntities(s);
}

// ---- small query helpers (tags compare without a namespace prefix)
const local = (tag) => tag.slice(tag.indexOf(':') + 1);

/** The first direct child with this tag. */
export function child(node, tag) { return node?.children.find((c) => local(c.tag) === tag) ?? null; }
/** All direct children with this tag. */
export function children(node, tag) { return node ? node.children.filter((c) => local(c.tag) === tag) : []; }
/** All descendants with this tag (depth-first, document order). */
export function descendants(node, tag, out = []) {
  if (!node) return out;
  for (const c of node.children) {
    if (local(c.tag) === tag) out.push(c);
    descendants(c, tag, out);
  }
  return out;
}
/** Trimmed text of a direct child (or ''). */
export function childText(node, tag) { return (child(node, tag)?.text ?? '').trim(); }
