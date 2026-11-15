// The welcome screen: the first thing a new user sees. Pick how to start (the
// demo show, an empty venue, or a show file) and how much interface to see
// (Simple or Pro), and optionally take the short tour. It shows once on first
// run and can be reopened from Help or Ctrl+K. Picking an option here only
// calls back into the app — the app decides how to load the show.

import { icon } from './icons.js';
import { logoSvg } from './logo.js';
import { esc } from './dom.js';

const STARTS = [
  { id: 'demo', icon: 'play', title: 'Demo show', sub: 'Moving heads and a laser, already programmed. Look around, then change things.' },
  { id: 'empty', icon: 'build', title: 'Empty venue', sub: 'A bare room and an empty timeline. Add your own fixtures and cues.' },
  { id: 'open', icon: 'open', title: 'Open a show…', sub: 'Carry on with a show you saved earlier (.json).' },
];

const MODES = [
  { id: 'simple', title: 'Simple', sub: 'Just the essentials. Best if you are new to lighting software.' },
  { id: 'pro', title: 'Pro', sub: 'Every control, with the advanced ones tucked under “More”.' },
];

export class Welcome {
  /**
   * deps: shell (Simple/Pro),
   *       onStart(id: 'demo'|'empty'|'open', { tour: boolean }) — called after the screen closes
   */
  constructor({ shell, onStart }) {
    this.shell = shell;
    this.onStart = onStart;
    this.firstRun = false;

    this.back = document.createElement('div');
    this.back.className = 'wl-back';
    this.back.hidden = true;
    this.back.innerHTML = `
      <div class="wl" role="dialog" aria-modal="true" aria-labelledby="wl-title">
        <div class="wl-head">
          ${logoSvg({ id: 'wlmark', cls: 'wl-mark' })}
          <div>
            <h1 id="wl-title">Welcome to Lightshow Studio</h1>
            <p>Design laser and lighting shows in 3D, program them to music, then perform them live.</p>
          </div>
          <button type="button" class="btn ghost icon wl-x" data-act="close" title="Close (Esc)" aria-label="Close">${icon('x')}</button>
        </div>
        <div class="wl-label">How do you want to start?</div>
        <div class="wl-starts">${STARTS.map((s) => `
          <button type="button" class="wl-card" data-start="${s.id}">
            <span class="wl-ico">${icon(s.icon)}</span>
            <span class="wl-t">${esc(s.title)}</span>
            <span class="wl-s">${esc(s.sub)}</span>
          </button>`).join('')}
        </div>
        <div class="wl-label">How much do you want to see? <span class="muted">You can switch any time in the top bar.</span></div>
        <div class="wl-modes" role="radiogroup" aria-label="Interface detail">${MODES.map((m) => `
          <button type="button" class="wl-mode" role="radio" data-mode="${m.id}">
            <span class="wl-radio"></span>
            <span><span class="wl-t">${esc(m.title)}</span><span class="wl-s">${esc(m.sub)}</span></span>
          </button>`).join('')}
        </div>
        <div class="wl-foot">
          <label class="wl-tour"><input type="checkbox" class="switch" data-role="tour" /> Show me around (a 5-step tour)</label>
          <span class="wl-note muted small" data-role="note"></span>
        </div>
      </div>`;
    document.body.appendChild(this.back);
    this.$ = (s) => this.back.querySelector(s);

    this.back.addEventListener('click', (e) => {
      if (e.target === this.back || e.target.closest('[data-act="close"]')) { this.close(); return; }
      const mode = e.target.closest('[data-mode]');
      if (mode) { this.shell.setPro(mode.dataset.mode === 'pro'); this._syncMode(); return; }
      const start = e.target.closest('[data-start]');
      if (start) this._choose(start.dataset.start);
    });
    this._key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
      else if (e.key === 'Tab') this._trapTab(e);
    };
  }

  get isOpen() { return !this.back.hidden; }

  /**
   * firstRun: the tour box starts ticked, and closing the screen keeps the
   * demo that's already loaded. Later opens warn that the show is replaced.
   */
  open({ firstRun = false, dirty = false } = {}) {
    this.firstRun = firstRun;
    this.$('[data-role="tour"]').checked = firstRun;
    this.$('[data-role="note"]').textContent = firstRun
      ? ''
      : (dirty ? 'Demo and Empty replace the current show — Ctrl+Z brings it back.' : 'Demo and Empty replace the current show.');
    // Demo is the first-run default; on a later open, closing keeps what you have.
    this.$('[data-act="close"]').title = firstRun ? 'Start with the demo (Esc)' : 'Close (Esc)';
    this._syncMode();
    this.back.hidden = false;
    window.addEventListener('keydown', this._key, true);
    this.$('[data-start="demo"]').focus({ preventScroll: true });
  }

  close() {
    if (this.back.hidden) return;
    this.back.hidden = true;
    window.removeEventListener('keydown', this._key, true);
    // Closing the first-run screen = "just let me in": keep the demo, still
    // honour the tour box.
    if (this.firstRun) this.onStart('demo', { tour: this.$('[data-role="tour"]').checked, keep: true });
  }

  _choose(id) {
    const tour = this.$('[data-role="tour"]').checked;
    this.firstRun = false; // so close() doesn't also start the demo
    this.close();
    this.onStart(id, { tour });
  }

  _syncMode() {
    for (const b of this.back.querySelectorAll('[data-mode]')) b.setAttribute('aria-checked', String((b.dataset.mode === 'pro') === this.shell.pro));
  }

  // Keep Tab focus inside the dialog.
  _trapTab(e) {
    const items = [...this.back.querySelectorAll('button, input')].filter((x) => !x.disabled && x.offsetParent);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}
