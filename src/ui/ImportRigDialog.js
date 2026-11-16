// "Import a rig" (MVR): shows what the file holds — one row per kind of
// fixture, with the type we guessed for it (changeable) — and the import
// options: replace or add to the rig, fit the room, centre the rig, and keep
// the plot's DMX addresses or re-patch. The plan itself (positions, rotation,
// addresses) comes from import/mvr.js; app.js applies it as one undoable edit.

import { icon, fixtureIcon } from './icons.js';
import { esc } from './dom.js';
import { guessType, kindKey, kindLabel, planRig, assignAddresses } from '../import/mvr.js';

export class ImportRigDialog {
  /**
   * deps: types (FIXTURE_TYPES), chOf(type) -> channel count,
   *       rigCount(), rigSpans() -> [{universe, startAddress, channelCount}],
   *       room() -> {width, depth, height}, onImport({ entries, room, replace, fit })
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
      else if (act === 'import') { const p = this._plan(); this.close(); this.d.onImport({ ...p, replace: this.o.mode === 'replace', fit: this.o.fit }); }
    });
    this.root.addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.kind) this.types.set(el.dataset.kind, el.value);
      else if (el.dataset.sw) this.o[el.dataset.sw] = el.checked;
      this.render();
    });
  }

  get isOpen() { return !this.root.hidden; }

  /** Show the dialog for a parsed MVR (import/mvr.js readMvr). */
  open(mvr, fileName) {
    this.mvr = mvr;
    this.fileName = fileName;
    this.types = new Map();
    this.kinds = new Map();
    for (const f of mvr.fixtures) {
      const k = kindKey(f);
      const row = this.kinds.get(k) || { key: k, label: kindLabel(f), count: 0, guess: guessType(f) };
      row.count++;
      this.kinds.set(k, row);
      if (!this.types.has(k)) this.types.set(k, row.guess.type);
    }
    this.o = { mode: 'replace', fit: true, center: true, addr: 'keep' };
    // keep the plot's addresses unless that makes our (differently sized) fixtures overlap
    if (this._plan().overlaps) this.o.addr = 'repatch';
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
    const plan = planRig(this.mvr, {
      typeFor: (k) => this.types.get(k),
      center: this.o.center,
      fit: this.o.fit,
      room: this.d.room(),
    });
    const overlaps = assignAddresses(plan.entries, this.d.chOf, { keep: this.o.addr === 'keep', taken: add ? this.d.rigSpans() : [] });
    return { ...plan, overlaps };
  }

  render() {
    const m = this.mvr;
    const head = `<div class="ad-head">${icon('open')}<span class="ad-title">Import a rig</span>
      <button type="button" class="btn ghost icon sm" data-act="close" title="Close (Esc)" aria-label="Close">${icon('x', 'sm')}</button></div>`;
    if (!m.fixtures.length) {
      this.root.innerHTML = `${head}<div class="ad-body"><p class="ad-p">"${esc(this.fileName)}" has no fixtures in it${m.trusses || m.objects ? ` (only ${[m.trusses && `${m.trusses} truss${m.trusses === 1 ? '' : 'es'}`, m.objects && `${m.objects} other object${m.objects === 1 ? '' : 's'}`].filter(Boolean).join(' and ')})` : ''}.</p></div>
        <div class="ad-foot"><span class="grow"></span><button type="button" class="btn primary" data-act="close">Close</button></div>`;
      return;
    }
    const plan = this._plan();
    const unis = new Set(plan.entries.map((e) => e.universe)).size;
    const seg = (key, items, label) => `<div class="seg" role="group" aria-label="${esc(label)}">${items.map(([v, t, title]) => `<button type="button" data-opt="${key}" data-v="${v}" aria-pressed="${String(this.o[key] === v)}" title="${esc(title)}">${esc(t)}</button>`).join('')}</div>`;
    const sw = (key, label, title) => `<label class="prop" title="${esc(title)}"><span class="name">${label}</span><span class="ctl"><input type="checkbox" class="switch" data-sw="${key}" ${this.o[key] ? 'checked' : ''} /></span></label>`;
    const typeSel = (row) => `<select data-kind="${esc(row.key)}" aria-label="Fixture type for ${esc(row.label)}">${this.d.types.map((t) => `<option value="${t.key}"${this.types.get(row.key) === t.key ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select>`;
    const rows = [...this.kinds.values()].map((r) => `<tr>
        <td class="ird-ic">${fixtureIcon(this.types.get(r.key))}</td>
        <td class="ird-nm" title="${esc(r.key)}">${esc(r.label)}<span class="ird-why">${this.types.get(r.key) === r.guess.type ? `guessed from ${esc(r.guess.why)}` : 'your choice'}</span></td>
        <td class="ird-n">×${r.count}</td><td class="ird-ty">${typeSel(r)}</td></tr>`).join('');
    const skipped = [m.trusses && `${m.trusses} truss${m.trusses === 1 ? '' : 'es'}`, m.objects && `${m.objects} other object${m.objects === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
    const roomTxt = this.o.fit ? `The room becomes ${plan.room.width} × ${plan.room.depth} m, ${plan.room.height} m high.` : '';
    const notes = [...m.notes];
    if (plan.aimed) notes.push(`${plan.aimed} laser${plan.aimed === 1 ? ' points' : 's point'} at the floor in the plot, so ${plan.aimed === 1 ? 'it faces' : 'they face'} the audience instead`);
    this.root.innerHTML = `${head}<div class="ad-body">
      <p class="ad-p"><b>${esc(this.fileName)}</b>: ${m.fixtures.length} fixture${m.fixtures.length === 1 ? '' : 's'} in ${unis} universe${unis === 1 ? '' : 's'}${skipped ? `. ${skipped} ${m.trusses + m.objects === 1 ? "isn't" : "aren't"} imported (we only take fixtures)` : ''}.</p>
      <table class="ird-tab"><tbody>${rows}</tbody></table>
      <div class="auto-form ird-opts">
        <div class="prop"><span class="name">Rig</span><span class="ctl">${seg('mode', [['replace', 'Replace', 'Remove the current fixtures first'], ['add', 'Add to it', 'Keep the current fixtures']], 'Rig')}</span></div>
        <div class="prop"><span class="name">Addresses</span><span class="ctl">${seg('addr', [['keep', "Keep the plot's", 'Use the universe and address from the file'], ['repatch', 'Re-patch', 'Give each fixture the next free address for our fixture models']], 'Addresses')}</span></div>
        ${sw('fit', 'Fit the room', 'Resize the room around the rig')}
        ${sw('center', 'Centre the rig', 'Move the rig to the middle of the room (left–right and front–back)')}
      </div>
      ${plan.overlaps ? `<div class="tip warn">${icon('warning', 'sm')}<div>With the plot's addresses, <b>${plan.overlaps} fixture${plan.overlaps === 1 ? ' overlaps' : 's overlap'}</b> another one, because our fixture models use their own channel counts. Choose <b>Re-patch</b> to avoid it, or fix them in the Patch sheet afterwards.</div></div>` : ''}
      <div class="tip">${icon('help', 'sm')}<div>Positions, aim, names and patch come from the file. Each fixture is drawn and driven by our model of that type, with its own channel layout — so the 3D view matches your plot, but a real fixture's DMX may differ. ${roomTxt} Ctrl+Z undoes the import.</div></div>
      ${notes.filter(Boolean).length ? `<p class="ad-p muted small">Note: ${notes.filter(Boolean).map(esc).join('; ')}.</p>` : ''}
      </div>
      <div class="ad-foot"><span class="grow"></span><button type="button" class="btn" data-act="close">Cancel</button>
      <button type="button" class="btn primary" data-act="import">${icon('check', 'sm')}Import ${plan.entries.length} fixture${plan.entries.length === 1 ? '' : 's'}</button></div>`;
  }
}
