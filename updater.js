// Electron main process: "Check for updates". Asks GitHub for the latest
// release, and if it's newer than this app, downloads its installer
// (LightshowStudio-Setup-x.y.z.exe) to the temp folder with progress, checks
// it, and on request runs it and quits — the one-click installer replaces the
// app and opens the new version. No electron-updater: one small file, no
// dependency, and it only needs what CI already publishes (see release.yml).
//
// The renderer never hands us a URL or a path: we only ever download the
// asset of the release we found ourselves, from this repo's GitHub releases,
// and only run the file we downloaded. How often to check (once a week) and
// the popup are the renderer's (ui/Updates.js).
//
// Testing: LSS_UPDATE_FAKE_VERSION=0.1.0 makes the app think it's 0.1.0, so a
// check finds the real latest release. An unpackaged app (npm start) only
// downloads; "install" reports where the file is and doesn't run it, unless
// LSS_UPDATE_RUN=1.

'use strict';

const { app, ipcMain, net } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = 'Royalkiller2222/Lightshow-Studio';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOADS = `https://github.com/${REPO}/releases/download/`;
const ASSET = /^LightshowStudio-Setup-(\d+\.\d+\.\d+)\.exe$/;
const HEADERS = { 'User-Agent': 'LightshowStudio-updater', Accept: 'application/vnd.github+json' };

let found = null;      // the newer release from the last check: { version, asset }
let downloaded = null; // path of the checked installer
let abort = null;      // AbortController of the running download

const currentVersion = () => process.env.LSS_UPDATE_FAKE_VERSION || app.getVersion();

/** -1 / 0 / 1 for "1.2.3"-style versions (missing parts count as 0). */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function check() {
  const current = currentVersion();
  const res = await net.fetch(API, { headers: HEADERS, cache: 'no-store' });
  if (res.status === 404) return { current, version: null, newer: false }; // no release yet
  if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is limiting requests — try again in an hour' : `GitHub answered ${res.status}`);
  const rel = await res.json();
  const version = String(rel.tag_name || '').replace(/^v/i, '');
  const asset = (rel.assets || []).find((a) => ASSET.exec(a.name)?.[1] === version);
  const newer = !!asset && compareVersions(version, current) > 0;
  found = newer ? { version, asset } : null;
  if (!newer) downloaded = null;
  return {
    current,
    version,
    newer,
    notes: String(rel.body || '').slice(0, 30000),
    date: rel.published_at || null,
    size: asset ? asset.size : 0,
    page: /^https:\/\/github\.com\//.test(rel.html_url || '') ? rel.html_url : `https://github.com/${REPO}/releases`,
  };
}

async function download(sender) {
  if (!found) throw new Error('Check for updates first');
  const { asset, version } = found;
  const url = String(asset.browser_download_url || '');
  if (!url.startsWith(DOWNLOADS)) throw new Error('Unexpected download address');
  const dir = path.join(app.getPath('temp'), 'LightshowStudio-update');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset.name);
  const part = `${dest}.part`;

  abort = new AbortController();
  const total = asset.size || 0;
  let got = 0, lastSent = 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': HEADERS['User-Agent'] }, signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      hash.update(value);
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (now - lastSent > 100 && !sender.isDestroyed()) { lastSent = now; sender.send('update:progress', { got, total }); }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    if (abort?.signal.aborted) return { cancelled: true };
    throw err;
  } finally {
    abort = null;
  }
  // GitHub lists each asset's size, and (for newer releases) its SHA-256.
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '')?.[1];
  if ((total && got !== total) || (digest && hash.digest('hex') !== digest.toLowerCase())) {
    fs.rmSync(part, { force: true });
    throw new Error('The download was damaged — try again');
  }
  fs.rmSync(dest, { force: true });
  fs.renameSync(part, dest);
  downloaded = dest;
  if (!sender.isDestroyed()) sender.send('update:progress', { got, total: got });
  return { path: dest, version };
}

function install() {
  if (!downloaded || !fs.existsSync(downloaded)) throw new Error('Download the update first');
  if (!app.isPackaged && process.env.LSS_UPDATE_RUN !== '1') return { dryRun: true, path: downloaded };
  // Detached, so the installer outlives us; it closes any copy still running.
  spawn(downloaded, [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 400);
  return { ok: true };
}

/** Wrap a handler so errors come back as { error } instead of a rejected invoke. */
const safe = (fn) => async (e) => {
  try { return await fn(e); } catch (err) { return { error: err?.message || String(err) }; }
};

function registerUpdater() {
  ipcMain.handle('app:version', () => currentVersion());
  ipcMain.handle('update:check', safe(() => check()));
  ipcMain.handle('update:download', safe((e) => download(e.sender)));
  ipcMain.on('update:cancel', () => abort?.abort());
  ipcMain.handle('update:install', safe(() => install()));
}

module.exports = { registerUpdater, compareVersions };
