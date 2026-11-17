// Themes for the interface: Dark (the default "Studio graphite"), Blackout
// (near-black, for dark venues where a bright screen glares), Light, and
// Custom (the user picks the main colours; the in-between shades are mixed
// from them in style.css). Dark, Blackout and Light are token sets in
// style.css under :root[data-theme=…]; Custom writes its picks as inline
// custom properties on <html>. The 3D view and the laser previews stay dark
// in every theme — lasers are light on black, and the show is the point.
//
// Canvases can't read CSS variables, so `tc(name)` resolves a token to an
// rgba() string through a hidden probe element (cached until the theme
// changes); canvas views read it every frame or re-render on onThemeChange.

import { prefs } from './dom.js';

export const THEMES = [
  { id: 'dark', label: 'Dark', hint: 'Graphite greys — the default' },
  { id: 'blackout', label: 'Blackout', hint: 'Almost black, dim text: for dark rooms and shows' },
  { id: 'light', label: 'Light', hint: 'Light panels for bright rooms' },
  { id: 'custom', label: 'Custom', hint: 'Pick your own colours' },
];

/** The colours a Custom theme lets you pick, and the CSS token each sets. */
export const CUSTOM_KEYS = [
  { key: 'bg0', token: '--bg-0', label: 'Background' },
  { key: 'bg1', token: '--bg-1', label: 'Panels' },
  { key: 'bg2', token: '--bg-2', label: 'Buttons and fields' },
  { key: 'line', token: '--line-2', label: 'Lines and borders' },
  { key: 'text', token: '--text-1', label: 'Text' },
  { key: 'accent', token: '--accent', label: 'Accent' },
  { key: 'tl', token: '--tl-track', label: 'Timeline' },
  { key: 'play', token: '--c-play', label: 'Playhead' },
  { key: 'laser', token: '--c-laser', label: 'Laser clips' },
  { key: 'fixture', token: '--c-fixture', label: 'Fixture clips' },
  { key: 'key', token: '--c-key', label: 'Keyframes' },
  { key: 'warn', token: '--warn', label: 'Warnings' },
  { key: 'danger', token: '--danger', label: 'Danger' },
  { key: 'ok', token: '--ok', label: 'Success' },
];

/** Starting points for Custom: the Dark and Light colours. */
export const CUSTOM_PRESETS = {
  dark: { bg0: '#0d0f12', bg1: '#14171b', bg2: '#1b1f25', line: '#2f3540', text: '#e6e9ef', accent: '#3d8bfd', tl: '#101317', play: '#ff5c7a', laser: '#23a876', fixture: '#3866b8', key: '#f0a742', warn: '#e0a43a', danger: '#e5534b', ok: '#3fb950' },
  light: { bg0: '#e4e7ec', bg1: '#f5f6f8', bg2: '#ffffff', line: '#c3c9d2', text: '#1b1f26', accent: '#2f6fe0', tl: '#eef0f3', play: '#e0335a', laser: '#1f9a6c', fixture: '#3866b8', key: '#d98a1c', warn: '#b97800', danger: '#d1362e', ok: '#1f8f3a' },
};

const listeners = new Set();
let cache = new Map();
let probe = null;

const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v);

/** The saved theme: { id, custom: { bg0: '#…', … } }. */
export function getTheme() {
  const id = prefs.get('theme', 'dark');
  const saved = prefs.get('theme.custom', null);
  const custom = { ...CUSTOM_PRESETS.dark };
  if (saved && typeof saved === 'object') for (const k of Object.keys(custom)) if (isHex(saved[k])) custom[k] = saved[k];
  return { id: THEMES.some((t) => t.id === id) ? id : 'dark', custom };
}

/** Switch theme (and/or change the Custom colours), save it and apply it. */
export function setTheme(id, custom) {
  if (id) prefs.set('theme', id);
  if (custom) prefs.set('theme.custom', custom);
  applyTheme();
}

/** Put the saved theme on <html>. Called once at start-up, then by setTheme. */
export function applyTheme() {
  const { id, custom } = getTheme();
  const root = document.documentElement;
  root.dataset.theme = id;
  for (const { token } of CUSTOM_KEYS) root.style.removeProperty(token);
  root.style.removeProperty('color-scheme');
  let light = id === 'light';
  if (id === 'custom') {
    for (const { key, token } of CUSTOM_KEYS) root.style.setProperty(token, custom[key]);
    light = luminance(custom.bg1) > 0.45;
    root.style.setProperty('color-scheme', light ? 'light' : 'dark');
  }
  root.dataset.tone = light ? 'light' : 'dark';
  cache = new Map();
  for (const fn of listeners) fn();
}

export function onThemeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * A theme token as a canvas colour, e.g. tc('--tl-lane') → "rgba(11,13,16,1)".
 * `alpha` multiplies the token's own opacity (for fainter copies of a line).
 */
export function tc(name, alpha = 1) {
  const k = `${name}|${alpha}`;
  let v = cache.get(k);
  if (v) return v;
  if (!probe) {
    probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);
  }
  probe.style.color = '';
  probe.style.color = `var(${name})`;
  const [r, g, b, a] = parseColor(getComputedStyle(probe).color);
  v = `rgba(${r},${g},${b},${+(a * alpha).toFixed(3)})`;
  cache.set(k, v);
  return v;
}

/** rgb()/rgba()/color(srgb …) as computed by Chromium → [r, g, b (0–255), a]. */
function parseColor(s) {
  const m = /color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+))?\)/.exec(s);
  if (m) return [m[1], m[2], m[3]].map((x) => Math.round(+x * 255)).concat(m[4] == null ? 1 : +m[4]);
  const n = String(s).match(/[\d.]+/g)?.map(Number) || [128, 128, 128];
  return [n[0], n[1], n[2], n[3] == null ? 1 : n[3]];
}

function luminance(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}
