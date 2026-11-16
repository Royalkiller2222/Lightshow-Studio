// The user guide, inside the app: a large dialog with the contents and a
// search box on the left and the page on the right. The pages are the same
// Markdown files GitHub shows (guide/*.md, rendered by ui/markdown.js), read
// with fetch() from next to src/ — that works from file:// in Electron and
// from the dev server. The page list comes from the contents in
// guide/README.md, so adding a page there adds it here.
//
// Links to other guide pages (and #headings) stay in the reader, with a Back
// button; web links open in the system browser (main.js routes window.open).
// Opened from Help (?), F1 and Ctrl+K.

import { icon } from './icons.js';
import { esc, prefs } from './dom.js';
import { renderMarkdown, plainText } from './markdown.js';

const HOME = 'README.md';

export class GuideReader {
  constructor() {
    this.base = new URL('../guide/', location.href);
    this.pages = null;   // [{ file, title, md, headings, text }] once loaded
    this.page = null;    // file shown now
    this.stack = [];     // Back history: [{ file, scroll }]
    this.query = '';

    this.back = document.createElement('div');
    this.back.className = 'cmdk-back';
    this.back.hidden = true;
    this.root = document.createElement('div');
    this.root.className = 'gr';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'User guide');
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="gr-head">
        ${icon('book')}<span class="gr-title">User guide</span>
        <button type="button" class="btn ghost sm" data-act="back" title="Back (Alt+←)" disabled>${icon('chev-left', 'sm')}Back</button>
        <span class="grow"></span>
        <button type="button" class="btn ghost icon sm" data-act="close" title="Close (Esc)" aria-label="Close">${icon('x', 'sm')}</button>
      </div>
      <div class="gr-main">
        <nav class="gr-side" aria-label="Guide contents">
          <div class="gr-search">${icon('search', 'sm')}<input type="search" placeholder="Search the guide" aria-label="Search the guide" spellcheck="false" /></div>
          <div class="gr-list" data-role="list"></div>
        </nav>
        <article class="gr-doc" data-role="doc" tabindex="-1"></article>
      </div>`;
    document.body.append(this.back, this.root);
    this.$ = (s) => this.root.querySelector(s);
    this.doc = this.$('[data-role="doc"]');
    this.list = this.$('[data-role="list"]');
    this.input = this.$('input[type="search"]');

    this.back.addEventListener('pointerdown', () => this.close());
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (this.query) { this.input.value = ''; this._search(''); this.input.focus(); } else this.close();
      } else if (e.key === 'ArrowLeft' && e.altKey) { e.preventDefault(); this._goBack(); }
      else if (e.key === 'f' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.input.focus(); this.input.select(); }
    });
    this.root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') { this.close(); return; }
      if (act === 'back') { this._goBack(); return; }
      const go = e.target.closest('[data-go]');
      if (go) { e.preventDefault(); this.show(go.dataset.go, go.dataset.hash || ''); return; }
      const a = e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href');
      if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener');
    });
    this.input.addEventListener('input', () => this._search(this.input.value));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.list.querySelector('[data-go]')?.click();
    });
  }

  get isOpen() { return !this.root.hidden; }

  /** Open the guide, at a page (and heading) or where the reader was last. */
  async open(file = null, hash = '') {
    this.back.hidden = false;
    this.root.hidden = false;
    try {
      await this._load();
    } catch (err) {
      console.error('Guide load failed:', err);
      this.doc.innerHTML = `<div class="tip warn">${icon('warning', 'sm')}<div>The guide couldn't be loaded (${esc(err.message)}). It's also on GitHub, in the <b>guide</b> folder.</div></div>`;
      return;
    }
    const want = file || prefs.get('guide.page', HOME);
    this.stack = [];
    this.show(this._find(want) ? want : HOME, hash, false);
    this.doc.focus();
  }

  close() {
    this.back.hidden = true;
    this.root.hidden = true;
  }

  /** Read every page once: the contents of README.md list them in order. */
  async _load() {
    if (this.pages) return;
    const read = async (file) => {
      const r = await fetch(new URL(file, this.base));
      if (!r.ok) throw new Error(`${file}: ${r.status}`);
      return r.text();
    };
    const home = await read(HOME);
    const files = [...new Set([...home.matchAll(/\]\(([\w-]+\.md)\)/g)].map((m) => m[1]))];
    const texts = await Promise.all(files.map(read));
    this.pages = [HOME, ...files].map((file, i) => {
      const md = i ? texts[i - 1] : home;
      const { headings } = renderMarkdown(md);
      return {
        file, md, headings,
        title: i ? (headings[0]?.text || file) : 'Contents',
        text: md.split('\n'), // for search
      };
    });
  }

  _find(file) { return this.pages?.find((p) => p.file === file) || null; }

  /** Show a page (scrolled to a heading id, if given). */
  show(file, hash = '', remember = true) {
    const page = this._find(file);
    if (!page) return;
    if (remember && this.page) this.stack.push({ file: this.page, scroll: this.doc.scrollTop });
    const changed = page.file !== this.page;
    this.page = page.file;
    prefs.set('guide.page', page.file);
    if (changed || !this.doc.firstChild) {
      const pageUrl = new URL(page.file, this.base);
      const { html } = renderMarkdown(page.md, {
        img: (src) => new URL(src, pageUrl).href,
        link: (href) => {
          if (/^(https?:|mailto:)/i.test(href)) return { href, attrs: ' target="_blank" rel="noopener" title="Opens in your browser"' };
          const [f, h = ''] = href.split('#');
          return { href, attrs: ` data-go="${esc(f || page.file)}" data-hash="${esc(h)}"` };
        },
      });
      this.doc.innerHTML = html;
    }
    const target = hash && this.doc.querySelector(`[id="${CSS.escape(hash)}"]`);
    if (target) {
      target.scrollIntoView({ block: 'start' });
      target.classList.remove('gr-flash');
      void target.offsetWidth; // restart the highlight
      target.classList.add('gr-flash');
    } else if (changed) this.doc.scrollTop = 0;
    this.$('[data-act="back"]').disabled = !this.stack.length;
    if (!this.query) this._renderContents();
    else this._markCurrent();
  }

  _goBack() {
    const prev = this.stack.pop();
    if (!prev) return;
    this.show(prev.file, '', false);
    this.doc.scrollTop = prev.scroll;
  }

  /** Contents: every page; the open one lists its sections. */
  _renderContents() {
    this.list.innerHTML = this.pages.map((p) => {
      const cur = p.file === this.page;
      const subs = cur && p.file !== HOME ? p.headings.filter((h) => h.level === 2) : [];
      return `<a href="#" class="gr-item${cur ? ' on' : ''}" data-go="${esc(p.file)}"${cur ? ' aria-current="page"' : ''}>${esc(p.title)}</a>${
        subs.length ? `<div class="gr-subs">${subs.map((h) => `<a href="#" class="gr-sub" data-go="${esc(p.file)}" data-hash="${esc(h.id)}">${esc(h.text)}</a>`).join('')}</div>` : ''}`;
    }).join('');
  }

  _markCurrent() {
    for (const a of this.list.querySelectorAll('.gr-res')) a.classList.toggle('on', a.dataset.go === this.page);
  }

  /** Search every page: each matching line, under the heading it sits in. */
  _search(q) {
    this.query = q.trim();
    if (!this.query) { this._renderContents(); return; }
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];
    for (const p of this.pages) {
      if (p.file === HOME) continue; // the contents only repeat the page summaries
      let head = null; // { text, id } of the section a line is in
      let hi = 0;
      const seen = new Set();
      for (const raw of p.text) {
        const h = /^(#{1,4})\s+(.*)$/.exec(raw.trim());
        if (h) { head = p.headings[hi++] || null; }
        const line = plainText(raw.replace(/^\s*(#{1,4}|[-*]|\d+\.|>|\|)\s*/, '')).replace(/\s*\|\s*/g, ' · ').trim();
        if (!line) continue;
        const low = line.toLowerCase();
        if (!words.every((w) => low.includes(w))) continue;
        const key = head?.id || '';
        if (seen.has(key)) continue; // one hit per section is enough
        seen.add(key);
        const inHead = head && words.some((w) => head.text.toLowerCase().includes(w));
        hits.push({ p, head, line, score: (h ? 3 : 0) + (inHead ? 2 : 0) + (low.includes(this.query.toLowerCase()) ? 1 : 0) });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const mark = (s) => {
      let out = esc(s.length > 140 ? s.slice(0, 137) + '…' : s);
      for (const w of words) out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
      return out;
    };
    this.list.innerHTML = hits.length
      ? `<div class="gr-count muted small">${hits.length} result${hits.length === 1 ? '' : 's'}</div>${hits.slice(0, 60).map((x) => `
        <a href="#" class="gr-res" data-go="${esc(x.p.file)}" data-hash="${esc(x.head && x.head.level > 1 ? x.head.id : '')}">
          <span class="gr-res-t">${esc(x.p.title)}${x.head && x.head.level > 1 ? ` › ${esc(x.head.text)}` : ''}</span>
          <span class="gr-res-s">${mark(x.line)}</span>
        </a>`).join('')}`
      : '<div class="gr-count muted small">Nothing found. Try another word.</div>';
    this._markCurrent();
  }
}
