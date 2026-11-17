// "Pregenerate an Auto show": reads the whole song (auto/analyze.js), shows
// what it found — the energy of every bar, the sections (Intro, Build,
// Drop…) with their mood, where each drop hits, and under the bars the sweeps
// (a line: up = the sound gets brighter) and the sounds on one side (ticks:
// upper = left, lower = right) — and writes an editable
// laser show onto the timeline with the shared Auto settings. Generating again
// replaces the earlier Auto tracks with a fresh take (a new seed).
//
// The sections are a song map the user can correct before generating: click a
// section (its chip or its part of the chart) to change its type or mood. The
// edits are saved with the show (app.js editSection) and win over what the
// analysis heard.

import { icon } from './icons.js';
import { esc, fmtTime } from './dom.js';
import { MOOD_NAMES, SECTION_NAMES } from '../auto/analyze.js';
import { autoForm, bindAutoForm } from './AutoPanel.js';

// section colours come from the CSS tokens
const KIND_VAR = { intro: '--c-fixture-hi', verse: '--c-fixture', build: '--warn', drop: '--c-play', break: '--c-laser', outro: '--c-fixture-hi' };
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || 'gray';
const BARS_H = 84, STRIP_H = 24; // the chart: energy bars, and the sweep / side strip under them

export class AutoShowDialog {
  /**
   * deps: hasSong(), onLoadSong(), analysis() -> analyzeSong result (cached),
   *       editSection(t, { kind, mood }) (null = as heard), resetSongMap(),
   *       getSettings(), setSettings(s), palettes(), projectors(),
   *       bySide() (do the projectors stand left and right of each other?),
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
      else if (act === 'reset-sec') { this.d.editSection(this.sel, { kind: null, mood: null }); this.render(); }
      else if (act === 'reset-map') { this.d.resetSongMap(); this.render(); }
      const sec = e.target.closest('[data-sec]');
      if (sec) this.select(Number(sec.dataset.sec));
    });
    this.root.addEventListener('change', (e) => {
      const field = e.target.dataset?.secField;
      if (!field || this.sel == null) return;
      this.d.editSection(this.sel, { [field]: e.target.value || null });
      this.render();
      this.root.querySelector(`[data-sec-field="${field}"]`)?.focus();
    });
    // a click on the chart picks the section under it
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target.dataset?.role !== 'energy' || !this._an) return;
      const r = e.target.getBoundingClientRect();
      const tt = ((e.clientX - r.left) / r.width) * this._an.duration;
      const s = this._an.sections.find((q) => tt >= q.t && tt < q.end);
      if (s) this.select(s.t);
    });
    this.sel = null; // start time of the section being edited
  }

  get isOpen() { return !this.root.hidden; }

  /** Open the editor for the section starting at t (or close it, if it's open). */
  select(t) {
    this.sel = this.sel != null && Math.abs(this.sel - t) < 1e-3 ? null : t;
    this.render();
    this.root.querySelector('[data-sec-field="kind"]')?.focus();
  }

  open() {
    this.sel = null;
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
    this._an = an;
    const sel = this.sel == null ? null : an.sections.find((s) => Math.abs(s.t - this.sel) < 1e-3) || null;
    if (!sel) this.sel = null;
    const n = this.d.autoTrackCount();
    this.root.innerHTML = `${head}<div class="ad-body">
      <canvas class="ad-energy" data-role="energy" height="${BARS_H + STRIP_H}" aria-label="The song's energy per bar with its sections; under it the sweeps and the sounds on one side"></canvas>
      <div class="ad-secs" role="group" aria-label="Sections: click one to change it">${an.sections.map((s) => `<button type="button" class="ad-sec${s.edited ? ' edited' : ''}" data-sec="${s.t}" aria-pressed="${String(sel === s)}" style="--k:var(${KIND_VAR[s.kind]})" title="${esc(s.name)}: ${fmtTime(s.t, false)}–${fmtTime(s.end, false)}${s.mood ? ` · ${MOOD_NAMES[s.mood]}` : ''}${s.repeat ? ' · a repeat' : ''}${s.edited ? ' · changed by you' : ''}. Click to change it.">${esc(s.name)}</button>`).join('')}</div>
      ${sel ? this._editor(sel) : ''}
      <p class="ad-p muted small">${summary(an)}${an.sections.some((s) => s.edited) ? ' <button type="button" class="ad-link" data-act="reset-map">Undo all section changes</button>' : ''}</p>
      <div data-role="form"></div>
      <div class="tip">${icon('help', 'sm')}<div>${this.d.projectors() > 1 && this.d.getSettings().alternate ? (this.d.bySide?.() ? 'Adds <b>Auto Left</b> and <b>Auto Right</b> laser tracks (the projectors on each side of the stage) at the top of the timeline. They play' : 'Adds <b>Auto A</b> and <b>Auto B</b> laser tracks (odd and even projectors) at the top of the timeline. They play') : 'Adds an <b>Auto</b> laser track at the top of the timeline. It plays'} over your other laser tracks, and every cue can be edited.${n ? ` <b>Replaces the ${n === 1 ? 'earlier Auto track' : `${n} earlier Auto tracks`}</b> (and any edits to ${n === 1 ? 'it' : 'them'}).` : ''} Ctrl+Z undoes it.</div></div>
      </div>
      <div class="ad-foot"><span class="grow"></span><button type="button" class="btn" data-act="close">Cancel</button>
      <button type="button" class="btn primary" data-act="generate">${icon('sparkles', 'sm')}${n ? 'Generate a new take' : 'Generate'}</button></div>`;
    const form = this.root.querySelector('[data-role="form"]');
    const draw = () => {
      form.innerHTML = autoForm(this.d.getSettings(), { palettes: this.d.palettes(), projectors: this.d.projectors(), live: false });
    };
    draw();
    bindAutoForm(form, () => this.d.getSettings(), (s) => { this.d.setSettings(s); draw(); this._drawEnergy(an); });
    requestAnimationFrame(() => this._drawEnergy(an));
  }

  /** The editor row for one section: its type and mood. */
  _editor(s) {
    const heard = s.auto || s; // what the analysis said, before the user's edits
    const overall = this.d.getSettings().mood;
    const kinds = Object.keys(SECTION_NAMES).map((k) => `<option value="${k}"${s.kind === k ? ' selected' : ''}>${SECTION_NAMES[k]}${k === heard.kind ? ' (heard)' : ''}</option>`).join('');
    const first = overall !== 'auto' ? `The show's Mood (${MOOD_NAMES[overall]})` : `From the music (${MOOD_NAMES[heard.mood] || 'none'})`;
    const moods = [`<option value=""${s.moodSet ? '' : ' selected'}>${esc(first)}</option>`,
      ...Object.keys(MOOD_NAMES).map((m) => `<option value="${m}"${s.moodSet && s.mood === m ? ' selected' : ''}>${MOOD_NAMES[m]}</option>`)].join('');
    return `<div class="ad-edit" style="--k:var(${KIND_VAR[s.kind]})">
      <span class="ad-edit-t"><b>${esc(s.name)}</b> ${fmtTime(s.t, false)}–${fmtTime(s.end, false)}</span>
      <label>Type <select data-sec-field="kind" aria-label="Section type">${kinds}</select></label>
      <label title="A mood set here wins over the show's Mood">Mood <select data-sec-field="mood" aria-label="Section mood">${moods}</select></label>
      ${s.edited ? '<button type="button" class="btn ghost sm" data-act="reset-sec" title="Back to what the music says">Reset</button>' : ''}
    </div>`;
  }

  _drawEnergy(an) {
    const c = this.root.querySelector('[data-role="energy"]');
    if (!c) return;
    const w = c.clientWidth || 520;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round((BARS_H + STRIP_H) * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const H = BARS_H, x = (t) => (t / (an.duration || 1)) * w;
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
    // where each drop hits
    g.fillStyle = token('--text-1');
    for (const d of an.drops || []) {
      const dx = x(d.t);
      g.beginPath(); g.moveTo(dx - 5, H); g.lineTo(dx + 5, H); g.lineTo(dx, H - 8); g.closePath(); g.fill();
    }
    // under the bars, what else moves the lasers: the sweep line (up = the
    // sound gets brighter) and a tick per one-sided sound (upper half = left).
    // Dimmed when its switch is off.
    const set = this.d.getSettings();
    const y0 = H + 4, half = (STRIP_H - 6) / 2, mid = y0 + half;
    g.fillStyle = token('--line-2');
    g.fillRect(0, mid, w, 1);
    g.globalAlpha = set.stereo ? 1 : 0.3;
    g.fillStyle = token('--warn');
    for (const m of an.sides || []) g.fillRect(x(m.t0), m.side === 'L' ? y0 : mid + 1, Math.max(2, x(m.t1) - x(m.t0)), half);
    const v = an.glide?.v;
    if (v?.length) {
      g.globalAlpha = set.sweeps ? 1 : 0.3;
      g.strokeStyle = token('--text-1');
      g.lineWidth = 1.25;
      g.beginPath();
      const step = Math.max(1, Math.floor(v.length / (w * 2)));
      for (let i = 0; i < v.length; i += step) {
        const px = x(i / an.glide.fps), py = mid - v[i] * (half - 1);
        if (i) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
    const sel = an.sections.find((s) => this.sel != null && Math.abs(s.t - this.sel) < 1e-3);
    if (sel) {
      g.strokeStyle = token('--text-1');
      g.lineWidth = 2;
      g.strokeRect(x(sel.t) + 1, 1, x(sel.end) - x(sel.t) - 2, H - 2);
    }
    g.font = `600 11px ${token('--font')}`;
    g.fillStyle = token('--text-1');
    for (const s of an.sections) if (x(s.end) - x(s.t) > 40) g.fillText(s.name, x(s.t) + 4, 13);
  }
}

/** One line on what the analysis found. */
function summary(an) {
  const n = (k) => an.sections.filter((s) => s.kind === k).length;
  const plural = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
  const parts = [plural(an.sections.length, 'section')];
  if (n('drop')) parts.push(`${plural(n('drop'), 'drop')}${(an.drops || []).length ? ' (▲ where the bass hits)' : ''}`);
  if (n('build')) parts.push(plural(n('build'), 'build'));
  const head = `${parts.join(' · ')} · ${an.bars.length} bars at ${Math.round(an.bpm * 100) / 100} BPM · ${fmtTime(an.duration, false)}.`;
  const grid = an.phase ? ` The drops land ${plural(an.phase, 'beat')} after the top bar's downbeat, so the sections follow the drops.` : '';
  const heard = [];
  if (an.sweeps?.length) heard.push(`${plural(an.sweeps.length, 'sweep')} (the line: up = brighter)`);
  if (an.sides?.length) heard.push(`${plural(an.sides.length, 'sound')} on one side (the ticks: upper = left, lower = right)`);
  const strip = heard.length ? ` Under the bars: ${heard.join(' and ')}.` : '';
  return `${head}${grid}${strip} Sections come from how the sound changes; hover one for its mood, click it to change it. If the bars look twice too long or too short, use ÷2 / ×2 next to the BPM in the top bar.`;
}
