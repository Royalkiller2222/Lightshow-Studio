// "Import a rig" (MVR, QLC+, xLights): shows what the file holds — one row per kind of
// fixture, with the type we guessed for it (changeable) — and the import
// options: replace or add to the rig, fit the room, centre the rig, keep the
// file's DMX addresses or re-patch, and (QLC+, xLights) which show to bring
// in as cues and which timing track becomes markers. It works on a *source*
// adapter (import/mvr.js mvrSource, import/qlc.js qlcSource,
// import/xlights.js xsqSource) that does the reading and planning; app.js
// applies the result as one undoable edit.

import { icon, fixtureIcon } from './icons.js';
import { esc } from './dom.js';
import { assignAddresses } from '../import/rig.js';

export class ImportRigDialog {
  /**
   * deps: types (FIXTURE_TYPES), chOf(type) -> channel count,
   *       rigCount(), rigSpans() -> [{universe, startAddress, channelCount}],
   *       room() -> {width, depth, height},
   *       onImport({ entries, room, replace, fit, show, replaceCues }) — show: convertShow() result or null
   */
  constructor(deps) {
    this.d = deps;
    this.back = document.createElement('div');
    this.back.className = 'cmdk-back';
    this.back.hidden = true;
    this.root = document.createElement('div');
    this.root.className = 'ad ird';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Import a rig');
    this.root.hidden = true;
    document.body.append(this.back, this.root);
    this.back.addEventListener('pointerdown', () => this.close());
    this.root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act], [data-opt]');
      if (!b) return;
      if (b.dataset.opt) { this.o[b.dataset.opt] = b.dataset.v; this.render(); return; }
      const act = b.dataset.act;
      if (act === 'close') this.close();
      else if (act === 'import') this._import();
    });
    this.root.addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.kind) this.types.set(el.dataset.kind, el.value);
      else if (el.dataset.show != null) this.o.show = el.value;
      else if (el.dataset.markers != null) this.o.markers = el.value;
      else if (el.dataset.sw) this.o[el.dataset.sw] = el.checked;
      this.render();
    });
  }

  get isOpen() { return !this.root.hidden; }

  /** Show the dialog for a source (see the top of this file). */
  open(src) {
    this.src = src;
    this.types = new Map(src.kinds.map((r) => [r.key, r.guess.type]));
    this.o = { mode: 'replace', fit: true, center: true, addr: 'keep', show: src.shows[0]?.id ?? '', cues: 'replace', markers: src.defaultMarkers ?? '' };
    // keep the file's addresses unless that makes our (differently sized) fixtures overlap
    if (src.count && this._plan().overlaps) this.o.addr = 'repatch';
    this.back.hidden = false;
    this.root.hidden = false;
    this.render();
    this.root.querySelector('[data-act="import"]')?.focus();
  }

  close() {
    this.back.hidden = true;
    this.root.hidden = true;
  }

  _plan() {
    const add = this.o.mode === 'add';
    const plan = this.src.plan({
      typeFor: (k) => this.types.get(k),
      center: this.o.center,
      fit: this.o.fit,
      room: this.d.room(),
    });
    const overlaps = assignAddresses(plan.entries, this.d.chOf, { keep: this.o.addr === 'keep', taken: add ? this.d.rigSpans() : [] });
    return { ...plan, overlaps };
  }

  _import() {
    const has = this.src.count > 0;
    const p = has ? this._plan() : { entries: [], room: this.d.room(), overlaps: 0 };
    const show = this.o.show !== '' && this.src.buildShow ? this.src.buildShow(this.o.show, (k) => this.types.get(k), { markers: this.o.markers }) : null;
    this.close();
    this.d.onImport({ ...p, replace: has && this.o.mode === 'replace', fit: has && this.o.fit, show, replaceCues: this.o.cues === 'replace' });
  }

  render() {
    const m = this.src;
    const head = `<div class="ad-head">${icon('open')}<span class="ad-title">${esc(m.title || (m.format === 'MVR' ? 'Import a rig' : `Import a ${m.format} workspace`))}</span>
      <button type="button" class="btn ghost icon sm" data-act="close" title="Close (Esc)" aria-label="Close">${icon('x', 'sm')}</button></div>`;
    if (!m.count && !m.shows.length) {
      this.root.innerHTML = `${head}<div class="ad-body"><p class="ad-p">"${esc(m.fileName)}" has no fixtures in it${m.skipped ? `. ${esc(m.skipped)}` : ''}.</p></div>
        <div class="ad-foot"><span class="grow"></span><button type="button" class="btn primary" data-act="close">Close</button></div>`;
      return;
    }
    const plan = m.count ? this._plan() : null;
    const unis = plan ? new Set(plan.entries.map((e) => e.universe)).size : 0;
    const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    const seg = (key, items, label) => `<div class="seg" role="group" aria-label="${esc(label)}">${items.map(([v, t, title]) => `<button type="button" data-opt="${key}" data-v="${v}" aria-pressed="${String(this.o[key] === v)}" title="${esc(title)}">${esc(t)}</button>`).join('')}</div>`;
    const sw = (key, label, title) => `<label class="prop" title="${esc(title)}"><span class="name">${label}</span><span class="ctl"><input type="checkbox" class="switch" data-sw="${key}" ${this.o[key] ? 'checked' : ''} /></span></label>`;
    const typeSel = (row) => `<select data-kind="${esc(row.key)}" aria-label="Fixture type for ${esc(row.label)}">${m.allowSkip ? `<option value=""${this.types.get(row.key) === '' ? ' selected' : ''}>Not imported</option>` : ''}${this.d.types.map((t) => `<option value="${t.key}"${this.types.get(row.key) === t.key ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`;
    const rows = m.kinds.map((r) => `<tr>
        <td class="ird-ic">${this.types.get(r.key) ? fixtureIcon(this.types.get(r.key)) : ''}</td>
        <td class="ird-nm" title="${esc(r.key)}">${esc(r.label)}<span class="ird-why">${this.types.get(r.key) === r.guess.type ? `guessed from ${esc(r.guess.why)}` : this.types.get(r.key) ? 'your choice' : 'left out'}</span></td>
        <td class="ird-n">${m.countUnit ? plural(r.count, m.countUnit) : `×${r.count}`}</td><td class="ird-ty">${typeSel(r)}</td></tr>`).join('');
    const roomTxt = plan && this.o.fit ? `The room becomes ${plan.room.width} × ${plan.room.depth} m, ${plan.room.height} m high.` : '';
    const notes = [...m.notes];
    if (plan?.aimed) notes.push(`${plan.aimed} laser${plan.aimed === 1 ? ' points' : 's point'} at the floor in the plot, so ${plan.aimed === 1 ? 'it faces' : 'they face'} the audience instead`);
    const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
    const rigOpts = m.count ? `
        <div class="prop"><span class="name">Rig</span><span class="ctl">${seg('mode', [['replace', 'Replace', 'Remove the current fixtures first'], ['add', 'Add to it', 'Keep the current fixtures']], 'Rig')}</span></div>
        <div class="prop"><span class="name">Addresses</span><span class="ctl">${seg('addr', [['keep', "Keep the file's", 'Use the universe and address from the file'], ['repatch', 'Re-patch', 'Give each fixture the next free address for our fixture models']], 'Addresses')}</span></div>
        ${sw('fit', 'Fit the room', 'Resize the room around the rig')}
        ${m.hasPositions === false ? '' : sw('center', 'Centre the rig', 'Move the rig to the middle of the room (left–right and front–back)')}` : '';
    const showOpts = m.shows.length ? `
        <div class="prop"><span class="name">${esc(m.showLabel || 'Show')}</span><span class="ctl"><select data-show aria-label="Show to import as cues">
          ${m.shows.map((s) => `<option value="${esc(s.id)}"${this.o.show === s.id ? ' selected' : ''}>${esc(s.name)} — ${plural(s.items, 'item')}, ${mmss(s.seconds)}</option>`).join('')}
          <option value=""${this.o.show === '' ? ' selected' : ''}>Don't import ${m.showLabel ? 'it' : 'a show'}</option></select></span></div>
        ${m.markerTracks?.length && this.o.show !== '' ? `<div class="prop" title="A timing track whose marks become timeline markers"><span class="name">Markers</span><span class="ctl"><select data-markers aria-label="Timing track for markers">
          ${m.markerTracks.map((t) => `<option value="${esc(t.id)}"${this.o.markers === t.id ? ' selected' : ''}>${esc(t.name)} — ${plural(t.count, 'mark')}</option>`).join('')}
          <option value=""${this.o.markers === '' ? ' selected' : ''}>None</option></select></span></div>` : ''}
        ${this.o.show !== '' ? `<div class="prop"><span class="name">Timeline</span><span class="ctl">${seg('cues', [['replace', 'Replace', 'Clear the timeline first'], ['add', 'Add to it', 'Keep the current tracks and cues']], 'Timeline')}</span></div>` : ''}` : '';
    const what = m.about ? esc(m.about) : m.format === 'MVR'
      ? 'Positions, aim, names and patch come from the file.'
      : `Names and patch come from the file${m.hasPositions ? ', positions from its 2D Monitor' : ''}. A workspace doesn't include its fixture definitions, so show cues are our own effects approximating each scene, chaser and EFX — with the exact timing.`;
    const btn = [plan && plural(plan.entries.length, 'fixture'), this.o.show !== '' && (m.showLabel ? `the ${m.showLabel.toLowerCase()}` : 'the show')].filter(Boolean).join(' and ') || 'nothing';
    this.root.innerHTML = `${head}<div class="ad-body">
      <p class="ad-p"><b>${esc(m.fileName)}</b>: ${m.summary ? esc(m.summary) : `${plural(m.count, 'fixture')}${m.count ? ` in ${plural(unis, 'universe')}` : ''}${m.shows.length ? `, ${plural(m.shows.length, 'show')}` : ''}`}${m.skipped ? `. ${esc(m.skipped)}` : ''}.</p>
      ${rows ? `<table class="ird-tab"><tbody>${rows}</tbody></table>` : ''}
      <div class="auto-form ird-opts">${rigOpts}${showOpts}</div>
      ${plan?.overlaps ? `<div class="tip warn">${icon('warning', 'sm')}<div>With the file's addresses, <b>${plan.overlaps} fixture${plan.overlaps === 1 ? ' overlaps' : 's overlap'}</b> another one, because our fixture models use their own channel counts. Choose <b>Re-patch</b> to avoid it, or fix them in the Patch sheet afterwards.</div></div>` : ''}
      <div class="tip">${icon('help', 'sm')}<div>${what} ${m.count ? "Each fixture is drawn and driven by our model of that type, with its own channel layout — so a real fixture's DMX may differ." : ''} ${roomTxt} Ctrl+Z undoes the import.</div></div>
      ${notes.filter(Boolean).length ? `<p class="ad-p muted small">Note: ${notes.filter(Boolean).map(esc).join('; ')}.</p>` : ''}
      </div>
      <div class="ad-foot"><span class="grow"></span><button type="button" class="btn" data-act="close">Cancel</button>
      <button type="button" class="btn primary" data-act="import"${btn === 'nothing' ? ' disabled' : ''}>${icon('check', 'sm')}Import ${btn}</button></div>`;
  }
}
