// Updates, the renderer half: checks once a week (if the switch in Settings is
// on) and when you press "Check for updates", and pops up a dialog when a
// newer version is out — what's new, then Download and install / Later /
// Skip this version. The download shows its progress; then the app closes and
// the installer runs (main process, updater.js). Your shows are files and
// aren't touched; an unsaved show gets a "Save it first" step.
//
// A weekly check never interrupts a show: while a loaded song plays or the Live
// workspace is open, the popup waits until playback stops and you leave Live.

import { icon } from './icons.js';
import { esc, prefs } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { toast } from './overlays.js';

const WEEK = 7 * 24 * 3600 * 1000;
const MB = (b) => (b / 1048576).toFixed(1);

/** "2 days ago"-style text for a time in ms (null → "never"). */
export function ago(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 86400 * 1.5) return `${Math.max(1, Math.round(s / 3600))} hour${Math.round(s / 3600) === 1 ? '' : 's'} ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export class Updates {
  /** deps: shell, transport, isDirty(), save() */
  constructor(deps) {
    this.d = deps;
    this.bridge = window.appBridge ?? null;
    this.info = null;     // last check result
    this.checking = false;
    this.pending = null;  // a weekly-check result waiting for a quiet moment
    this.state = 'info';  // dialog step: info | downloading | ready | error
    this.progress = { got: 0, total: 0 };
    this.listeners = new Set();

    this.back = document.createElement('div');
    this.back.className = 'cmdk-back';
    this.back.hidden = true;
    this.root = document.createElement('div');
    this.root.className = 'ad up';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Update available');
    this.root.hidden = true;
    document.body.append(this.back, this.root);
    this.back.addEventListener('pointerdown', () => { if (this.state !== 'downloading') this.close(); });
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (this.state !== 'downloading') this.close(); }
    });
    this.root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act && this[`_${act}`]) this[`_${act}`]();
      const a = e.target.closest('a[href]');
      if (a) { e.preventDefault(); if (/^https:\/\//i.test(a.href)) window.open(a.href, '_blank', 'noopener'); }
    });
    this.bridge?.onUpdateProgress((p) => { this.progress = p; this._syncProgress(); });

    // the popup that waits for a quiet moment
    const tryPending = () => { if (this.pending && this._quiet()) { const i = this.pending; this.pending = null; this.open(i); } };
    deps.transport.onChange(tryPending);
    deps.shell.onChange(tryPending);
  }

  get available() { return !!this.bridge; }
  get isOpen() { return !this.root.hidden; }
  get lastChecked() { return prefs.get('updates.last', 0); }
  get auto() { return prefs.get('updates.auto', true); }
  set auto(on) { prefs.set('updates.auto', !!on); this._emit(); }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) fn(); }

  // (the demo loops without a song at start-up — that isn't a show to protect)
  _quiet() { return !(this.d.transport.playing && this.d.transport.hasAudio) && this.d.shell.workspace !== 'live'; }

  /** At start-up: check if the weekly switch is on and a week has passed. */
  startWeekly(delayMs = 8000) {
    if (!this.available) return;
    setTimeout(() => {
      if (this.auto && Date.now() - this.lastChecked >= WEEK) this.check({ auto: true });
    }, delayMs);
  }

  /**
   * Ask GitHub. auto: a weekly check — quiet unless there's an update you
   * haven't skipped. Otherwise (the button) it always reports back.
   */
  async check({ auto = false } = {}) {
    if (!this.available || this.checking) return this.info;
    this.checking = true;
    this._emit();
    const info = await this.bridge.checkForUpdates();
    this.checking = false;
    if (info.error) {
      this.error = info.error;
      this._emit();
      if (!auto) toast(`Couldn't check for updates: ${info.error}`, { kind: 'error', ms: 6000 });
      return null;
    }
    this.error = null;
    this.info = info;
    prefs.set('updates.last', Date.now());
    this._emit();
    if (!info.newer) {
      if (!auto) toast(`You're up to date — Lightshow Studio ${info.current} is the latest version.`, { kind: 'ok' });
      return info;
    }
    if (auto && prefs.get('updates.skip', null) === info.version) return info;
    if (auto && !this._quiet()) this.pending = info;
    else this.open(info);
    return info;
  }

  open(info = this.info) {
    if (!info?.newer) return;
    this.info = info;
    if (this.state !== 'downloading' && this.state !== 'ready') this.state = 'info';
    this.back.hidden = false;
    this.root.hidden = false;
    this.render();
    this.root.querySelector('.btn.primary')?.focus();
  }

  close() {
    this.back.hidden = true;
    this.root.hidden = true;
    if (this.state === 'error') this.state = 'info';
  }

  render() {
    const i = this.info;
    if (!i) return;
    const date = i.date ? new Date(i.date).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    const notes = i.notes?.trim() ? renderMarkdown(i.notes).html : '<p class="muted">No release notes.</p>';
    const head = `
      <div class="ad-head">${icon('download')}<span class="ad-title">Update available</span>
        <button type="button" class="btn ghost icon sm" data-act="close" title="Close (Esc)" aria-label="Close"${this.state === 'downloading' ? ' disabled' : ''}>${icon('x', 'sm')}</button>
      </div>`;
    const intro = `<p class="ad-p"><b>Lightshow Studio ${esc(i.version)}</b> is out${date ? ` (${esc(date)})` : ''}. You have ${esc(i.current)}.</p>`;
    let body = '', foot = '';
    if (this.state === 'info' || this.state === 'error') {
      body = `${intro}
        <div class="up-notes">${notes}</div>
        ${this.state === 'error' ? `<div class="tip warn">${icon('warning', 'sm')}<div>${esc(this.dlError)}. <a href="${esc(i.page)}">Get it from GitHub</a> instead.</div></div>` : ''}
        <p class="ad-p small muted">Your shows are saved files and aren't touched. The download is ${MB(i.size)} MB.</p>`;
      foot = `
        <button type="button" class="btn ghost" data-act="skip" title="Don't tell me about ${esc(i.version)} again (the weekly check skips it)">Skip this version</button>
        <span class="grow"></span>
        <button type="button" class="btn" data-act="close">Later</button>
        <button type="button" class="btn primary" data-act="download">${icon('download', 'sm')}${this.state === 'error' ? 'Try again' : 'Download and install'}</button>`;
    } else if (this.state === 'downloading') {
      body = `${intro}
        <div class="up-bar" role="progressbar" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100"><i data-role="bar"></i></div>
        <p class="ad-p small muted" data-role="prog">Starting the download…</p>`;
      foot = `<span class="grow"></span><button type="button" class="btn" data-act="cancel">Cancel</button>`;
    } else if (this.state === 'ready') {
      const dirty = this.d.isDirty();
      body = `${intro}
        <p class="ad-p">Downloaded. <b>Install and restart</b> closes the app and runs the installer, which opens the new version when it's done.</p>
        ${dirty ? `<div class="tip warn">${icon('warning', 'sm')}<div>Your show has <b>unsaved changes</b>. Save it first, or they're lost when the app closes.</div></div>` : ''}
        <p class="ad-p small muted">Windows may say it protected your PC, because the app isn't signed: click <b>More info</b>, then <b>Run anyway</b>.</p>`;
      foot = `
        ${dirty ? `<button type="button" class="btn" data-act="save">${icon('save', 'sm')}Save the show</button>` : ''}
        <span class="grow"></span>
        <button type="button" class="btn" data-act="close">Later</button>
        <button type="button" class="btn primary" data-act="install">${dirty ? 'Install without saving' : 'Install and restart'}</button>`;
    }
    this.root.innerHTML = `${head}<div class="ad-body">${body}</div><div class="ad-foot">${foot}</div>`;
    this._syncProgress();
  }

  _syncProgress() {
    if (this.state !== 'downloading' || this.root.hidden) return;
    const { got, total } = this.progress;
    const bar = this.root.querySelector('[data-role="bar"]');
    const txt = this.root.querySelector('[data-role="prog"]');
    if (!bar || !txt) return;
    const pct = total ? Math.min(100, (got / total) * 100) : 0;
    bar.style.width = `${pct}%`;
    bar.parentElement.setAttribute('aria-valuenow', String(Math.round(pct)));
    txt.textContent = got ? `${MB(got)} of ${MB(total || this.info.size)} MB` : 'Starting the download…';
  }

  // ---- dialog actions ----
  _close() { this.close(); }

  _skip() {
    prefs.set('updates.skip', this.info.version);
    toast(`Skipped ${this.info.version}. Check for updates in Settings to get it later.`, { ms: 4500 });
    this.close();
  }

  async _download() {
    this.state = 'downloading';
    this.progress = { got: 0, total: this.info.size };
    this.render();
    const r = await this.bridge.downloadUpdate();
    if (r.cancelled) { this.state = 'info'; this.render(); return; }
    if (r.error) { this.state = 'error'; this.dlError = r.error; this.render(); return; }
    this.state = 'ready';
    if (this.root.hidden) this.open(); else this.render();
  }

  _cancel() { this.bridge.cancelDownload(); }

  _save() {
    this.d.save();
    setTimeout(() => this.render(), 300);
  }

  async _install() {
    const r = await this.bridge.installUpdate();
    if (r.error) { this.state = 'error'; this.dlError = r.error; this.render(); return; }
    if (r.dryRun) {
      toast(`Development build: the installer was downloaded to ${r.path} but not run.`, { ms: 8000 });
      this.close();
    }
    // otherwise the app is closing
  }
}
