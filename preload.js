// Secure bridge between the renderer and the main process: DMX I/O
// (window.dmxBridge) and the app itself — version, updates (window.appBridge).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dmxBridge', {
  /** Push the latest universe buffers for hardware output. */
  pushUniverses: (list) => ipcRenderer.send('dmx:universes', list),

  /** Update I/O config: { mode, artnetIp, sacn, output } */
  setConfig: (cfg) => ipcRenderer.send('dmx:config', cfg),

  /** Subscribe to incoming Art-Net (External console mode). */
  onArtNetIn: (callback) =>
    ipcRenderer.on('dmx:artnet-in', (_event, msg) => callback(msg)),
});

contextBridge.exposeInMainWorld('appBridge', {
  /** This app's version, e.g. "0.18.0". */
  version: () => ipcRenderer.invoke('app:version'),

  /** Ask GitHub for the latest release: { current, version, newer, notes, date, size, page } or { error }. */
  checkForUpdates: () => ipcRenderer.invoke('update:check'),

  /** Download the newer release found by the last check: { path, version } | { cancelled } | { error }. */
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  cancelDownload: () => ipcRenderer.send('update:cancel'),
  onUpdateProgress: (callback) =>
    ipcRenderer.on('update:progress', (_event, p) => callback(p)),

  /** Run the downloaded installer and quit: { ok } | { dryRun, path } | { error }. */
  installUpdate: () => ipcRenderer.invoke('update:install'),

  /** The window's background colour (follows the theme). */
  setBackground: (hex) => ipcRenderer.send('app:background', hex),
});
