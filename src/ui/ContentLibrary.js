// Program workspace library: laser patterns (drawn as real thumbnails from the
// pattern data, in collapsible groups — Beams, Shapes, Waves, Graphics and the
// show's Imported ILDA files), ready-made fixture looks, and single fixture
// effects. Drag one onto the timeline, or double-click / press Enter to add it
// at the playhead. An effect dropped onto a look replaces that layer. The
// search box filters every list.

import { allPatterns, PATTERN_GROUPS, drawPatternThumb, onPatternsChanged } from '../laser/patterns.js';
import { EFFECTS } from '../show/effects.js';
import { LOOKS, SLOTS, slotOf } from '../show/looks.js';
import { icon } from './icons.js';
import { esc, prefs } from './dom.js';
import { DND_TYPE } from '../timeline/TimelinePanel.js';
import { effectShortName } from '../timeline/CueInspector.js';

const GROUPS = [
  { attr: 'intensity', label: 'Intensity', color: 'var(--c-int)' },
  { attr: 'color', label: 'Colour', color: 'var(--c-col)' },
  { attr: 'position', label: 'Movement', color: 'var(--c-pos)' },
];

export class ContentLibrary {
  /**
   * deps: shell, onAddPattern(key), onAddEffect(key), onAddLook(key),
   *       onImportIlda(), onRemovePattern(key)
   */
  constructor(root, { shell, onAddPattern, onAddEffect, onAddLook, onImportIlda, onRemovePattern }) {
    this.root = root;
    this.query = '';

    const effectRow = (e, color) => `
      <div class="eff" draggable="true" tabindex="0" data-kind="effect" data-key="${e.key}" data-search="${esc(e.label.toLowerCase())}" title="Drag onto the timeline or double-click">
        <span class="dot" style="background:${color}"></span>${esc(effectShortName(e))}
      </div>`;
    const groups = GROUPS.map((g) => `
      <div class="eff-group" data-group>
        <div class="gt">${g.label}</div>
        ${EFFECTS.filter((e) => e.attr === g.attr && e.key !== 'sparks').map((e) => effectRow(e, g.color)).join('')}
      </div>`).join('') + `
      <div class="eff-group" data-group>
        <div class="gt">Special</div>
        ${effectRow(EFFECTS.find((e) => e.key === 'sparks'), 'var(--c-fx)')}
      </div>`;

    const looks = LOOKS.map((l) => {
      const has = new Set(l.layers.map(([e]) => slotOf(e)));
      const sw = SLOTS.map((s) => `<i class="slot-dot ${s.key}${has.has(s.key) ? '' : ' off'}"></i>`).join('');
      return `
      <div class="look-card" draggable="true" tabindex="0" data-kind="look" data-key="${l.key}" data-search="${esc(`${l.name} ${l.hint} look`.toLowerCase())}" title="${esc(l.hint)} — drag onto a fixture track or double-click">
        <span class="sw">${sw}</span>
        <span><span class="nm">${esc(l.name)}</span><br><span class="sb">${esc(l.hint)}</span></span>
      </div>`;
    }).join('');

    root.innerHTML = `
      <div class="ph">
        <span class="ph-title">Library</span>
        <button type="button" class="btn ghost icon sm" data-act="hide" title="Hide the library" aria-label="Hide the library">${icon('panel-left', 'sm')}</button>
      </div>
      <div class="pbody">
        <input type="search" class="lib-search" placeholder="Search patterns, looks and effects" aria-label="Search the library" />
        <div class="sec">
          <div class="sec-title">${icon('laser', 'sm')}Laser patterns</div>
          <div data-role="pats"></div>
        </div>
        <div class="sec">
          <div class="sec-title">${icon('moving-head', 'sm')}Looks</div>
          <div data-group>${looks}</div>
        </div>
        <div class="sec">
          <div class="sec-title">${icon('sliders', 'sm')}Single effects</div>
          ${groups}
        </div>
        <div class="lib-empty" data-role="none" hidden>Nothing matches that search.</div>
        <div class="tip">${icon('help', 'sm')}<div>Drag onto the timeline, or double-click to add at the playhead. Drop a single effect onto a look to swap that layer.</div></div>
      </div>`;

    this._renderPatterns();
    onPatternsChanged(() => this._renderPatterns());

    root.querySelector('[data-act="hide"]').addEventListener('click', () => shell.togglePanel('left', false));
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'import-ild') onImportIlda?.();
      else if (b.dataset.act === 'del-pat') { e.stopPropagation(); onRemovePattern?.(b.dataset.key); }
    });
    // remember which pattern groups are open (not while a search forces them open)
    root.addEventListener('toggle', (e) => {
      const d = e.target;
      if (d.dataset && d.dataset.pg && !this.query) prefs.set(`lib.pg.${d.dataset.pg}`, d.open);
    }, true);
    const add = (item) => {
      if (item.dataset.kind === 'pattern') onAddPattern(item.dataset.key);
      else if (item.dataset.kind === 'look') onAddLook(item.dataset.key);
      else onAddEffect(item.dataset.key);
    };
    root.addEventListener('dblclick', (e) => { if (e.target.closest('[data-act]')) return; const it = e.target.closest('[data-kind]'); if (it) add(it); });
    root.addEventListener('keydown', (e) => {
      const it = e.target.closest('[data-kind]');
      if (it && e.key === 'Enter') { e.preventDefault(); add(it); }
    });
    root.addEventListener('dragstart', (e) => {
      const it = e.target.closest('[data-kind]');
      if (!it) return;
      e.dataTransfer.setData(DND_TYPE, JSON.stringify({ kind: it.dataset.kind, key: it.dataset.key }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    root.querySelector('.lib-search').addEventListener('input', (e) => this._filter(e.target.value));
  }

  /** The pattern groups (re-rendered when the show's imported patterns change). */
  _renderPatterns() {
    const box = this.root.querySelector('[data-role="pats"]');
    const pats = allPatterns();
    box.innerHTML = PATTERN_GROUPS.map((g) => {
      const list = pats.filter((p) => (p.group || 'graphics') === g.key);
      const imp = g.key === 'imported';
      const cards = list.map((p) => `
        <div class="pat" draggable="true" tabindex="0" data-kind="pattern" data-key="${esc(p.key)}" data-search="${esc(`${p.label} ${g.label}`.toLowerCase())} laser pattern" title="${esc(p.label)}${p.frames ? ` — ${p.frames.length} frame${p.frames.length === 1 ? '' : 's'}` : ''} — drag onto the timeline or double-click">
          <canvas width="184" height="115" data-thumb="${esc(p.key)}"></canvas>
          <div class="nm">${esc(p.label)}</div>
          ${imp ? `<button type="button" class="pat-del" data-act="del-pat" data-key="${esc(p.key)}" title="Remove ${esc(p.label)} from this show" aria-label="Remove ${esc(p.label)}">${icon('x', 'sm')}</button>` : ''}
        </div>`).join('');
      const add = imp ? `<button type="button" class="pat-import" data-act="import-ild" data-search="import ilda ild file imported" title="Import an ILDA laser file (.ild) from BEYOND, QuickShow, LaserOS and others">${icon('plus', 'sm')}<span>Import ILDA file…</span></button>` : '';
      const open = prefs.get(`lib.pg.${g.key}`, true);
      return `<details class="pat-group" data-pg="${g.key}" data-group${open ? ' open' : ''}>
          <summary>${icon('chev-right', 'sm')}${esc(g.label)}<span class="n">${list.length || ''}</span></summary>
          <div class="pat-grid">${cards}</div>${add}
        </details>`;
    }).join('');
    for (const c of box.querySelectorAll('canvas[data-thumb]')) drawPatternThumb(c, pats.find((p) => p.key === c.dataset.thumb));
    if (this.query) this._filter(this.query);
  }

  _filter(q) {
    this.query = q.trim();
    // a search looks inside every pattern group
    for (const d of this.root.querySelectorAll('details[data-pg]')) d.open = this.query ? true : prefs.get(`lib.pg.${d.dataset.pg}`, true);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    let any = false;
    for (const it of this.root.querySelectorAll('[data-search]')) {
      const hit = words.every((w) => it.dataset.search.includes(w));
      it.hidden = !hit;
      any = any || hit;
    }
    for (const g of this.root.querySelectorAll('[data-group]')) {
      g.hidden = ![...g.querySelectorAll('[data-search]')].some((x) => !x.hidden);
    }
    this.root.querySelector('[data-role="none"]').hidden = any;
  }
}
