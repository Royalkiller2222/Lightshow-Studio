// Settings (the gear in the top bar, Ctrl+,): the app's own preferences, as
// opposed to the show's (those are in the show inspector and saved with the
// show). Sections:
//   Theme     — Dark (default), Blackout, Light, Custom (pick the colours)
//   Start-up  — show the welcome screen every time
//   Interface — Simple / Pro, put the panels back to their first sizes
//   Updates   — version, last check, Check for updates, the weekly switch
// Everything here is a per-computer preference (dom.js prefs), applied at once.

import { icon } from './icons.js';
import { esc, prefs } from './dom.js';
import { THEMES, CUSTOM_KEYS, CUSTOM_PRESETS, getTheme, setTheme } from './theme.js';
import { ago } from './Updates.js';

export class SettingsDialog {
  /** deps: shell, updates (Updates), resetLayout() */
  constructor(deps) {
    this.d = deps;
    this.version = '';
    window.appBridge?.version().then((v) => { this.version = v; if (this.isOpen) this.render(); });

    this.back = document.createElement('div');
    this.back.className = 'cmdk-back';
    this.back.hidden = true;
    this.root = document.createElement('div');
    this.root.className = 'ad st';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Settings');
    this.root.hidden = true;
    document.body.append(this.back, this.root);
    this.back.addEventListener('pointerdown', () => this.close());
    this.root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });

    this.root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const theme = e.target.closest('[data-theme-id]')?.dataset.themeId;
      if (theme) { setTheme(theme); this.render(); this.root.querySelector(`[data-theme-id="${theme}"]`)?.focus(); return; }
      const mode = e.target.closest('[data-st-mode]')?.dataset.stMode;
      if (mode) { this.d.shell.setPro(mode === 'pro'); return; }
      if (act === 'close') this.close();
      else if (act === 'preset-dark' || act === 'preset-light') {
        setTheme('custom', { ...CUSTOM_PRESETS[act.slice(7)] });
        this.render();
      } else if (act === 'check') {
        this.d.updates.check().then((info) => { if (info?.newer) this.close(); });
        this.render();
      } else if (act === 'see-update') { this.close(); this.d.updates.open(); }
      else if (act === 'reset-layout') { this.d.resetLayout(); }
    });
    // colour pickers apply live while you drag
    this.root.addEventListener('input', (e) => {
      const key = e.target.dataset?.custom;
      if (!key) return;
      const { custom } = getTheme();
      custom[key] = e.target.value;
      setTheme('custom', custom);
    });
    this.root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.pref === 'welcome') prefs.set('startup.welcome', t.checked);
      else if (t.dataset.pref === 'auto-update') this.d.updates.auto = t.checked;
    });
    deps.updates.onChange(() => { if (this.isOpen) this._syncUpdates(); });
    deps.shell.onChange(() => { if (this.isOpen) this._syncMode(); });
  }

  get isOpen() { return !this.root.hidden; }

  open() {
    this.back.hidden = false;
    this.root.hidden = false;
    this.render();
    this.root.querySelector('[data-theme-id][aria-checked="true"]')?.focus();
  }

  close() {
    this.back.hidden = true;
    this.root.hidden = true;
  }

  render() {
    const { id, custom } = getTheme();
    const cards = THEMES.map((t) => `
      <button type="button" class="st-theme" role="radio" data-theme-id="${t.id}" aria-checked="${t.id === id}" title="${esc(t.hint)}">
        <span class="st-prev" data-t="${t.id}"><i></i><i></i><i></i><b></b></span>
        <span class="st-name">${esc(t.label)}</span>
      </button>`).join('');
    const picks = CUSTOM_KEYS.map((k) => `
      <label class="st-pick"><input type="color" data-custom="${k.key}" value="${esc(custom[k.key])}" /><span>${esc(k.label)}</span></label>`).join('');
    this.root.innerHTML = `
      <div class="ad-head">${icon('gear')}<span class="ad-title">Settings</span>
        <button type="button" class="btn ghost icon sm" data-act="close" title="Close (Esc)" aria-label="Close">${icon('x', 'sm')}</button>
      </div>
      <div class="ad-body">
        <section class="st-sec">
          <h3>Theme</h3>
          <div class="st-themes" role="radiogroup" aria-label="Theme">${cards}</div>
          <p class="ad-p small muted">The 3D view stays dark in every theme, so the lasers look the way they will in the room.</p>
          ${id === 'custom' ? `
          <div class="st-custom">
            <div class="st-picks">${picks}</div>
            <div class="st-row"><span class="muted small">Start again from</span>
              <button type="button" class="btn sm" data-act="preset-dark">Dark</button>
              <button type="button" class="btn sm" data-act="preset-light">Light</button>
            </div>
          </div>` : ''}
        </section>
        <section class="st-sec">
          <h3>Start-up</h3>
          <label class="st-line"><input type="checkbox" class="switch" data-pref="welcome"${prefs.get('startup.welcome', false) ? ' checked' : ''} />
            <span>Show the welcome screen every time the app starts</span></label>
        </section>
        <section class="st-sec">
          <h3>Interface</h3>
          <div class="st-line"><span class="grow">Detail</span>
            <div class="seg" role="group" aria-label="Interface detail">
              <button type="button" data-st-mode="simple" title="Simple: just the essentials">Simple</button>
              <button type="button" data-st-mode="pro" title="Pro: every control; advanced ones sit under 'More'">Pro</button>
            </div>
          </div>
          <div class="st-line"><span class="grow">Panel sizes</span>
            <button type="button" class="btn sm" data-act="reset-layout" title="Every workspace's panels go back to their first sizes and are all shown">Reset panels</button>
          </div>
        </section>
        <section class="st-sec">
          <h3>Updates</h3>
          <div data-role="updates"></div>
        </section>
      </div>`;
    this._syncMode();
    this._syncUpdates();
  }

  _syncMode() {
    for (const b of this.root.querySelectorAll('[data-st-mode]')) b.setAttribute('aria-pressed', String((b.dataset.stMode === 'pro') === this.d.shell.pro));
  }

  _syncUpdates() {
    const box = this.root.querySelector('[data-role="updates"]');
    if (!box) return;
    const u = this.d.updates;
    if (!u.available) {
      box.innerHTML = `<p class="ad-p muted">Updates are checked in the installed app.</p>`;
      return;
    }
    const i = u.info;
    let status = `Last checked ${esc(ago(u.lastChecked))}.`;
    if (u.checking) status = 'Checking…';
    else if (u.error) status = `Couldn't check: ${esc(u.error)}.`;
    else if (i?.newer) status = `<b>Lightshow Studio ${esc(i.version)} is available.</b> <button type="button" class="ad-link" data-act="see-update">See what's new</button>`;
    else if (i) status = `You're up to date. Last checked ${esc(ago(u.lastChecked))}.`;
    box.innerHTML = `
      <div class="st-line"><span class="grow">Version <b>${esc(this.version || '…')}</b></span>
        <button type="button" class="btn sm" data-act="check"${u.checking ? ' disabled' : ''}>${icon('download', 'sm')}Check for updates</button>
      </div>
      <p class="ad-p small muted st-status">${status}</p>
      <label class="st-line"><input type="checkbox" class="switch" data-pref="auto-update"${u.auto ? ' checked' : ''} />
        <span>Check for updates once a week</span></label>`;
  }
}
