// The short tour: five steps that each light up one part of the window and
// say in a sentence or two what it's for. It switches workspace as it goes, so
// the user sees Build → Program → Live in the order a show is made. Skippable
// at any step (Esc); reopen it from Help or Ctrl+K.
//
// The spotlight is a fixed box over the target with a huge box-shadow that
// dims everything else; clicks are blocked so the tour can't be broken
// half-way by an accidental edit.

import { icon } from './icons.js';
import { esc } from './dom.js';

export const TOUR_STEPS = [
  {
    ws: null, target: '#topbar .tb-tabs', panel: null,
    title: 'Three workspaces',
    body: 'A show is made in three steps: <b>Build</b> the venue, <b>Program</b> it to music, then perform it <b>Live</b>. Switch here or press <kbd>Ctrl</kbd> + <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd>.',
  },
  {
    ws: 'build', target: '#left', panel: 'left',
    title: 'Build: add fixtures',
    body: 'Drag a moving head, laser or spark machine from this library into the 3D room. Click a fixture to select it; <b>X</b> moves it and <b>C</b> rotates it.',
  },
  {
    ws: 'program', target: '#bottom', panel: 'bottom',
    title: 'Program: the timeline',
    body: 'Load a song and its tempo is detected. Drag a laser pattern or a look from the library onto a track. Each clip plays for as long as it is, on the beat grid.',
  },
  {
    ws: 'program', target: '#right', panel: 'right',
    title: 'Edit what you select',
    body: 'Whatever you click — a clip, a track, a fixture — is edited here. Nothing selected shows the show or venue settings. <kbd>Ctrl</kbd> + <kbd>Z</kbd> undoes anything.',
  },
  {
    ws: 'live', target: '#left', panel: 'left',
    title: 'Live: perform it',
    body: 'Each marker on your timeline becomes a pad. Press <b>1–9</b> to jump between sections and <b>B</b> for blackout; the masters on the right set brightness, speed and size.',
    last: 'Lost? <kbd>Ctrl</kbd> + <kbd>K</kbd> finds any command, and <b>?</b> lists the shortcuts and can restart this tour.',
  },
];

export class Tour {
  /** deps: shell; onEnd(completed: boolean) */
  constructor({ shell, onEnd = null }) {
    this.shell = shell;
    this.onEnd = onEnd;
    this.i = -1;

    this.block = document.createElement('div');
    this.block.className = 'tour-block';
    this.spot = document.createElement('div');
    this.spot.className = 'tour-spot';
    this.card = document.createElement('div');
    this.card.className = 'tour-card';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-live', 'polite');
    this.block.hidden = this.spot.hidden = this.card.hidden = true;
    document.body.append(this.block, this.spot, this.card);

    this.card.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'next') this.go(this.i + 1);
      else if (act === 'back') this.go(this.i - 1);
      else if (act === 'skip') this.end(false);
    });
    this._key = (e) => {
      // The tour owns the keyboard while it runs (no stray shortcuts).
      if (e.key === 'Tab') return;
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); this.end(false); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); this.go(this.i + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.i - 1); }
      else if (e.key !== ' ') e.preventDefault();
    };
    this._place = () => this._layout();
  }

  get isOpen() { return this.i >= 0; }

  start() {
    if (this.isOpen) return;
    this._ws = this.shell.workspace; // put the user back where they were
    this.block.hidden = this.spot.hidden = this.card.hidden = false;
    window.addEventListener('keydown', this._key, true);
    window.addEventListener('resize', this._place);
    this.go(0);
  }

  go(i) {
    if (i >= TOUR_STEPS.length) { this.end(true); return; }
    if (i < 0) return;
    this.i = i;
    const s = TOUR_STEPS[i];
    if (s.ws) this.shell.setWorkspace(s.ws);
    if (s.panel && !this.shell.isOpen(s.panel)) this.shell.togglePanel(s.panel, true);
    const n = TOUR_STEPS.length;
    const last = i === n - 1;
    this.card.innerHTML = `
      <div class="tour-step">${i + 1} of ${n}</div>
      <h3>${esc(s.title)}</h3>
      <p>${s.body}</p>
      ${s.last ? `<p class="tour-last">${s.last}</p>` : ''}
      <div class="tour-btns">
        <button type="button" class="btn ghost sm" data-act="skip">${last ? 'Close' : 'Skip tour'}</button>
        <span class="tour-dots">${TOUR_STEPS.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</span>
        ${i > 0 ? `<button type="button" class="btn sm" data-act="back" aria-label="Back">${icon('chev-left', 'sm')}</button>` : ''}
        <button type="button" class="btn primary sm" data-act="next">${last ? 'Done' : 'Next'}${last ? '' : icon('chev-right', 'sm')}</button>
      </div>`;
    this._layout();
    this.card.querySelector('[data-act="next"]').focus({ preventScroll: true });
  }

  end(completed) {
    if (this.i < 0) return;
    this.i = -1;
    this.block.hidden = this.spot.hidden = this.card.hidden = true;
    window.removeEventListener('keydown', this._key, true);
    window.removeEventListener('resize', this._place);
    if (this._ws) this.shell.setWorkspace(this._ws);
    this.onEnd?.(completed);
  }

  /** Spotlight the step's target and put the card on the side with the most room. */
  _layout() {
    if (this.i < 0) return;
    const el = document.querySelector(TOUR_STEPS[this.i].target);
    const r = el?.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight, pad = 6, gap = 14;
    const cw = Math.min(340, W - 32);
    this.card.style.width = `${cw}px`;
    if (!r || !r.width || !r.height) {
      this.spot.hidden = true;
      Object.assign(this.card.style, { left: `${(W - cw) / 2}px`, top: `${H / 3}px` });
      return;
    }
    this.spot.hidden = false;
    Object.assign(this.spot.style, {
      left: `${r.left - pad}px`, top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });
    const ch = this.card.offsetHeight;
    const room = { right: W - r.right, left: r.left, below: H - r.bottom, above: r.top };
    let x, y;
    if (room.below >= ch + gap * 2 && room.below >= room.above) {
      x = r.left; y = r.bottom + gap;
    } else if (room.above >= ch + gap * 2) {
      x = r.left; y = r.top - gap - ch;
    } else if (room.right >= cw + gap * 2) {
      x = r.right + gap; y = r.top;
    } else if (room.left >= cw + gap * 2) {
      x = r.left - gap - cw; y = r.top;
    } else { // target fills the window: centre the card over it
      x = r.left + (r.width - cw) / 2; y = r.top + (r.height - ch) / 2;
    }
    x = Math.max(16, Math.min(W - cw - 16, x));
    y = Math.max(16, Math.min(H - ch - 16, y));
    Object.assign(this.card.style, { left: `${x}px`, top: `${y}px` });
  }
}
