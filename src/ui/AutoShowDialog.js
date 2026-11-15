// "Pregenerate an Auto show": reads the whole song (auto/analyze.js), shows
// what it found — the energy of every bar and the sections (Intro, Build,
// Drop…) — and writes an editable laser show onto the timeline with the
// shared Auto settings. Generating again replaces the earlier Auto tracks with
// a fresh take (a new seed).

import { icon } from './icons.js';
import { esc, fmtTime } from './dom.js';
import { autoForm, bindAutoForm } from './AutoPanel.js';

// section colours come from the CSS tokens
const KIND_VAR = { intro: '--c-fixture-hi', verse: '--c-fixture', build: '--warn', drop: '--c-play', break: '--c-laser', outro: '--c-fixture-hi' };
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'gray';

export class AutoShowDialog {
  /**
   * deps: hasSong(), onLoadSong(), analysis() -> analyzeSong result (cached),
   *       getSettings(), setSettings(s), palettes(), projectors(),
   *       autoTrackCount(), onGenerate()
   */
  constructor(deps) {
    this.d = deps;
    this.back = document.createElement('div');
    this.back.className = 'cmdk-back';
    this.back.hidden = true;
    this.root = document.createElement('div');
    this.root.className = 'ad';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Pregenerate an Auto show');
    this.root.hidden = true;
    document.body.append(this.back, this.root);
    this.back.addEventListener('pointerdown', () => this.close());
    this.root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
    this.root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'close') this.close();
      else if (act === 'load') { this.close(); this.d.onLoadSong(); }
      else if (act === 'generate') { this.d.onGenerate(); this.close(); }
    });
  }

  get isOpen() { return !this.root.hidden; }

  open() {
    this.back.hidden = false;
    this.root.hidden = false;
    this.render();
    (this.root.querySelector('[data-act="generate"]') || this.root.querySelector('button'))?.focus();
  }

  close() {
    this.back.hidden = true;
    this.root.hidden = true;
  }

  render() {
    const head = `<div class="ad-head">${icon('sparkles')}<span class="ad-title">Pregenerate an Auto show</span>
      <button type="button" class="btn ghost icon sm" data-act="close" title="Close (Esc)" aria-label="Close">${icon('x', 'sm')}</button></div>`;
    if (!this.d.hasSong()) {
      this.root.innerHTML = `${head}<div class="ad-body">
        <p class="ad-p">Pregenerate reads the whole song — its builds, drops and breaks — and writes a laser show onto the timeline that you can then edit.</p>
        <div class="tip">${icon('music', 'sm')}<div>Load a song first.</div></div></div>
        <div class="ad-foot"><span class="grow"></span><button type="button" class="btn" data-act="close">Cancel</button>
        <button type="button" class="btn primary" data-act="load">${icon('music', 'sm')}Load a song…</button></div>`;
      return;
    }
    const an = this.d.analysis();
    const n = this.d.autoTrackCount();
    this.root.innerHTML = `${head}<div class="ad-body">
      <canvas class="ad-energy" data-role="energy" height="84" aria-label="The song's energy per bar, with its sections"></canvas>
      <div class="ad-secs">${an.sections.map((s) => `<span class="ad-sec" style="--k:var(${KIND_VAR[s.kind]})" title="${esc(s.name)}: ${fmtTime(s.t, false)}–${fmtTime(s.end, false)}">${esc(s.name)}</span>`).join('')}</div>
      <p class="ad-p muted small">${an.sections.length} section${an.sections.length === 1 ? '' : 's'} · ${an.bars.length} bars at ${Math.round(an.bpm * 10) / 10} BPM · ${fmtTime(an.duration, false)}. Sections come from how loud and busy each bar is; check the BPM in the top bar if the grid looks off.</p>
      <div data-role="form"></div>
      <div class="tip">${icon('help', 'sm')}<div>${this.d.projectors() > 1 && this.d.getSettings().alternate ? 'Adds <b>Auto A</b> and <b>Auto B</b> laser tracks (odd and even projectors) at the top of the timeline. They play' : 'Adds an <b>Auto</b> laser track at the top of the timeline. It plays'} over your other laser tracks, and every cue can be edited.${n ? ` <b>Replaces the ${n === 1 ? 'earlier Auto track' : `${n} earlier Auto tracks`}</b> (and any edits to ${n === 1 ? 'it' : 'them'}).` : ''} Ctrl+Z undoes it.</div></div>
      </div>
      <div class="ad-foot"><span class="grow"></span><button type="button" class="btn" data-act="close">Cancel</button>
      <button type="button" class="btn primary" data-act="generate">${icon('sparkles', 'sm')}${n ? 'Generate a new take' : 'Generate'}</button></div>`;
    const form = this.root.querySelector('[data-role="form"]');
    const draw = () => {
      form.innerHTML = autoForm(this.d.getSettings(), { palettes: this.d.palettes(), projectors: this.d.projectors(), live: false });
    };
    draw();
    bindAutoForm(form, () => this.d.getSettings(), (s) => { this.d.setSettings(s); draw(); });
    requestAnimationFrame(() => this._drawEnergy(an));
  }

  _drawEnergy(an) {
    const c = this.root.querySelector('[data-role="energy"]');
    if (!c) return;
    const w = c.clientWidth || 520;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(84 * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const H = 84, x = (t) => (t / (an.duration || 1)) * w;
    for (const s of an.sections) {
      g.fillStyle = token(KIND_VAR[s.kind]);
      g.globalAlpha = 0.16;
      g.fillRect(x(s.t), 0, x(s.end) - x(s.t), H);
      g.globalAlpha = 1;
      g.fillRect(x(s.t), 0, 1, H);
    }
    g.globalAlpha = 1;
    const bw = Math.max(1, x(an.barLen) - 1);
    an.bars.forEach((b) => {
      const s = an.sections.find((q) => b.t >= q.t - 1e-3 && b.t < q.end);
      g.fillStyle = token(s ? KIND_VAR[s.kind] : '--text-3');
      const h = Math.max(2, b.energy * (H - 18));
      g.fillRect(x(b.t), H - h, bw, h);
    });
    g.font = `600 11px ${token('--font')}`;
    g.fillStyle = token('--text-1');
    for (const s of an.sections) if (x(s.end) - x(s.t) > 40) g.fillText(s.name, x(s.t) + 4, 13);
  }
}
