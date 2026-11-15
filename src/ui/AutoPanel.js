// Auto in the Live workspace: one big pad that hands the lasers to the music,
// a level meter + what Auto is doing, and its settings. The same settings form
// (autoForm / bindAutoForm) is reused by the Pregenerate dialog, so both modes
// share one set of choices (engine.autoSettings, saved with the show).
//
// Live Auto is a performance control like the masters: turning it on/off is
// not an undo step. Changing a setting is (it's saved with the show).

import { icon } from './icons.js';
import { esc } from './dom.js';
import { INTENSITIES, CHANGE_RATES, AUTO_GROUPS } from '../auto/director.js';
import { patternByKey, importedPatterns } from '../laser/patterns.js';

/**
 * The settings form. opts: { palettes, projectors, live (bool) }.
 * Every control carries data-auto="<setting>"; seg buttons data-v="<value>".
 */
export function autoForm(s, { palettes = [], projectors = 1, live = false } = {}) {
  const seg = (key, items, title) => `<div class="seg" role="group" aria-label="${esc(title)}">${items.map((x) => `<button type="button" data-auto="${key}" data-v="${x.key}" aria-pressed="${String(s[key] === x.key)}">${esc(x.label)}</button>`).join('')}</div>`;
  const row = (name, ctl, cls = '', title = '') => `<div class="prop ${cls}"${title ? ` title="${esc(title)}"` : ''}><span class="name">${name}</span><span class="ctl">${ctl}</span></div>`;
  const sw = (key, label, title) => `<label class="prop" title="${esc(title)}"><span class="name">${label}</span><span class="ctl"><input type="checkbox" class="switch" data-auto="${key}" ${s[key] ? 'checked' : ''} /></span></label>`;
  const hasImports = importedPatterns().length > 0;
  return `<div class="auto-form">
    ${live ? row('Listen to', seg('source', [{ key: 'song', label: 'Song' }, { key: 'input', label: 'Sound input' }], 'Listen to'), '', 'Song: the track loaded in Program. Sound input: a microphone or line-in, for music playing from somewhere else.') : ''}
    ${row('Intensity', seg('intensity', INTENSITIES, 'Intensity'), '', 'How energetic Auto is: more movement, faster changes and higher-energy patterns')}
    ${row('Change', `<select data-auto="every" aria-label="How often the pattern changes">${CHANGE_RATES.map((r) => `<option value="${r.key}"${s.every === r.key ? ' selected' : ''}>${r.key === 'auto' ? 'With the music' : `Every ${r.label}`}</option>`).join('')}</select>`, live ? 'pro' : '', 'How often the pattern changes. With the music: often in drops, rarely in calm parts')}
    ${row('Colours', `<select data-auto="palette" aria-label="Colours">${[`<option value="auto"${s.palette === 'auto' ? ' selected' : ''}>By mood (Ice, Fire, Club)</option>`, ...palettes.map((p) => `<option value="${esc(p.id)}"${s.palette === p.id ? ' selected' : ''}>${esc(p.name)}</option>`)].join('')}</select>`, live ? 'pro' : '', 'Which palette Auto cycles through')}
    ${row('Patterns', `<span class="auto-chips">${AUTO_GROUPS.map((g) => `<label class="chip"><input type="checkbox" data-auto="groups" value="${g.key}" ${s.groups.includes(g.key) ? 'checked' : ''} />${esc(g.label)}</label>`).join('')}${hasImports ? `<label class="chip"><input type="checkbox" data-auto="imported" ${s.imported ? 'checked' : ''} />Imported</label>` : ''}</span>`, live ? 'pro' : '', 'Which pattern groups Auto may use (Text is never used)')}
    ${projectors > 1 ? `<div class="${live ? 'pro' : ''}">${sw('alternate', 'Pairs', 'Odd and even projectors get different patterns, spinning opposite ways')}</div>` : ''}
    ${live ? '' : sw('markers', 'Markers', 'Add a marker for each section found (they become pads in Live)')}
  </div>`;
}

/** Wire a form built by autoForm(): get() -> settings, set(next) applies them. */
export function bindAutoForm(root, get, set) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-auto]');
    if (!b) return;
    set({ ...get(), [b.dataset.auto]: b.dataset.v });
  });
  root.addEventListener('change', (e) => {
    const el = e.target;
    const key = el.dataset?.auto;
    if (!key) return;
    const s = { ...get() };
    if (key === 'groups') {
      const on = [...root.querySelectorAll('input[data-auto="groups"]:checked')].map((x) => x.value);
      if (!on.length) { el.checked = true; return; } // keep at least one group
      s.groups = on;
    } else if (key === 'every') s.every = el.value === 'auto' ? 'auto' : Number(el.value);
    else if (el.type === 'checkbox') s[key] = el.checked;
    else s[key] = el.value;
    set(s);
  });
}

export class AutoPanel {
  /**
   * deps: getSettings(), setSettings(s), isOn(), toggle(), onPregenerate(),
   *       palettes(), projectors(), director() (the LiveDirector or null),
   *       level() (0..1 input level now), hasSong()
   */
  constructor(root, deps) {
    this.root = root;
    this.d = deps;
    this._sig = '';
    root.innerHTML = `
      <div class="sec-title">${icon('sparkles', 'sm')}Auto</div>
      <button type="button" class="lv-auto" data-act="auto" aria-pressed="false" title="Let the music drive the lasers (A)">
        <span class="lv-auto-top">${icon('sparkles')}<span class="lv-auto-nm">Auto</span><kbd>A</kbd></span>
        <span class="lv-auto-status" data-role="status">Off — the timeline plays</span>
        <span class="lv-meter"><span data-role="meter"></span></span>
      </button>
      <div data-role="form"></div>
      <button type="button" class="btn lv-big" data-act="pregen" title="Analyse the whole song and write an editable laser show onto the timeline">${icon('program')}Pregenerate a show…</button>`;
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'auto') this.d.toggle();
      else if (act === 'pregen') this.d.onPregenerate();
    });
    this.form = root.querySelector('[data-role="form"]');
    bindAutoForm(this.form, () => this.d.getSettings(), (s) => this.d.setSettings(s));
    this.sync();
  }

  /** Rebuild the form (settings, palettes or the projector count changed). */
  sync() {
    const s = this.d.getSettings();
    const pals = this.d.palettes();
    const n = this.d.projectors();
    const sig = JSON.stringify([s, pals.map((p) => [p.id, p.name]), n > 1, importedPatterns().length > 0]);
    if (sig !== this._sig) {
      this._sig = sig;
      this.form.innerHTML = autoForm(s, { palettes: pals, projectors: n, live: true });
    }
    this.root.querySelector('[data-act="auto"]').setAttribute('aria-pressed', String(this.d.isOn()));
  }

  frame() {
    if (!this.root.offsetParent) return;
    this.sync();
    const on = this.d.isOn();
    const dir = this.d.director();
    const s = this.d.getSettings();
    let text;
    if (!on) text = 'Off — the timeline plays';
    else if (dir && dir.heard > 1.5) text = s.source === 'input' ? 'No sound from the input — following the beat' : (this.d.hasSong() ? 'Press play — following the beat' : 'No song — following the beat');
    else if (dir) text = `${dir.status} · ${patternByKey(dir.patterns[0])?.label || ''}`;
    else text = 'Starting…';
    const st = this.root.querySelector('[data-role="status"]');
    if (st.textContent !== text) st.textContent = text;
    const lv = on && dir ? Math.min(1, dir.fast) : 0;
    this.root.querySelector('[data-role="meter"]').style.width = `${Math.round(lv * 100)}%`;
  }
}
