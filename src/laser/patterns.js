// Laser pattern library — BEYOND-style vector frames. Each pattern is a list of
// "strokes" (polylines) in normalised galvo space (-1..1). The laser rig draws
// the strokes as bright additive lines and the beams that form them.
//
// Three kinds of pattern share one shape (`{ key, label, group, ... }`):
//   - built-in, static:  `strokes`
//   - built-in, text:    `text: true` — strokes come from the cue's text
//                         through a 14-segment vector font (textStrokes)
//   - imported (ILDA):   `frames` (a list of stroke lists, played at `fps`),
//                         `colored: true` — points carry their own colour as
//                         [x, y, r, g, b]; the cue colour tints them
// Imported patterns belong to the open show (saved in its file), so they live
// in a small registry here that the library, inspector and engine all read.

function circle(n, r = 1, cx = 0, cy = 0) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return pts;
}

function polygon(sides, r = 1, rot = 0) {
  const pts = [];
  for (let i = 0; i <= sides; i++) { const a = rot + (i / sides) * Math.PI * 2; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  return pts;
}

function wave(cycles, n, amp = 0.8, y0 = 0, phase = 0) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const x = (i / n) * 2 - 1; pts.push([x, y0 + Math.sin(x * Math.PI * cycles + phase) * amp]); }
  return pts;
}

function fan(count, half = 0.9) {
  const strokes = [];
  for (let i = 0; i < count; i++) {
    const a = -half + (count === 1 ? half : (i / (count - 1)) * 2 * half);
    strokes.push([[0, -1], [Math.sin(a), -1 + Math.cos(a) * 2]]);
  }
  return strokes;
}

/** A parametric curve t in 0..1 -> [x, y]. */
function curve(n, f) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(f(i / n));
  return pts;
}

/** Many points along a line: each point is a beam, so the beams form a sheet. */
function sheet(n, y, amp = 0, cycles = 0) {
  return [curve(n, (t) => { const x = t * 2 - 1; return [x, y + Math.sin(x * Math.PI * cycles) * amp]; })];
}

// ------------------------------------------------------------------- text
// 14-segment font: a cell 1 wide x 2 high. Segment letters:
//   a top, b upper-right, c lower-right, d bottom, e lower-left, f upper-left,
//   g / G middle left / right half, h i j upper diagonals + centre,
//   k l m lower diagonals + centre.
const SEG = {
  a: [[0, 2], [1, 2]], b: [[1, 2], [1, 1]], c: [[1, 1], [1, 0]], d: [[0, 0], [1, 0]],
  e: [[0, 1], [0, 0]], f: [[0, 2], [0, 1]], g: [[0, 1], [0.5, 1]], G: [[0.5, 1], [1, 1]],
  h: [[0, 2], [0.5, 1]], i: [[0.5, 2], [0.5, 1]], j: [[1, 2], [0.5, 1]],
  k: [[0.5, 1], [0, 0]], l: [[0.5, 1], [0.5, 0]], m: [[0.5, 1], [1, 0]],
};
const GLYPHS = {
  A: 'abcefgG', B: 'abcdiGl', C: 'adef', D: 'abcdil', E: 'adefg', F: 'aefg', G: 'acdefG',
  H: 'bcefgG', I: 'adil', J: 'bcde', K: 'efgjm', L: 'def', M: 'bcefhj', N: 'bcefhm',
  O: 'abcdef', P: 'abefgG', Q: 'abcdefm', R: 'abefgGm', S: 'acdfgG', T: 'ail', U: 'bcdef',
  V: 'efjk', W: 'bcefkm', X: 'hjkm', Y: 'hjl', Z: 'adjk',
  0: 'abcdefjk', 1: 'bc', 2: 'abdegG', 3: 'abcdgG', 4: 'bcfgG', 5: 'acdfgG', 6: 'acdefgG',
  7: 'abc', 8: 'abcdefgG', 9: 'abcdfgG', '-': 'gG', '+': 'gGil', '*': 'ghijklmG',
  '/': 'jk', '!': 'il', '?': 'abGl', "'": 'i', '=': 'dgG', '<': 'jm', '>': 'hk',
};
export const TEXT_MAX = 12;
export const DEFAULT_TEXT = 'LASER';

/** Upper-cases and trims to what the font can draw. */
export function cleanText(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9\-+*/!?'=<> ]/g, '').slice(0, TEXT_MAX);
}

const _textCache = new Map();
/** Strokes for a line of text, centred and fitted into -1..1. */
export function textStrokes(text) {
  const s = cleanText(text) || ' ';
  let hit = _textCache.get(s);
  if (hit) return hit;
  const adv = 1.45, w = s.length * adv - 0.45;
  const k = Math.min(1.8 / w, 0.55); // fits the width; short words stay readable size
  const strokes = [];
  [...s].forEach((ch, n) => {
    for (const code of GLYPHS[ch] || '') {
      const [[x1, y1], [x2, y2]] = SEG[code];
      const ox = n * adv - w / 2;
      strokes.push([[(ox + x1) * k, (y1 - 1) * k], [(ox + x2) * k, (y2 - 1) * k]]);
    }
  });
  hit = strokes.length ? strokes : [[[0, 0], [0.001, 0]]];
  if (_textCache.size > 64) _textCache.clear();
  _textCache.set(s, hit);
  return hit;
}

// --------------------------------------------------------------- built-ins
export const PATTERN_GROUPS = [
  { key: 'beams', label: 'Beams & sheets' },
  { key: 'shapes', label: 'Shapes' },
  { key: 'waves', label: 'Waves & curves' },
  { key: 'graphics', label: 'Graphics & text' },
  { key: 'imported', label: 'Imported' },
];

export const PATTERNS = [
  // Beams & sheets — read best as aerial beams through haze
  { key: 'beam-fan', group: 'beams', label: 'Beam fan', strokes: fan(9, 0.8) },
  { key: 'split-fan', group: 'beams', label: 'Split fan', strokes: [...fan(9, 0.8).slice(0, 3), ...fan(9, 0.8).slice(6)] },
  {
    key: 'ray-burst', group: 'beams', label: 'Ray burst',
    strokes: Array.from({ length: 16 }, (_, i) => { const a = (i / 16) * Math.PI * 2; return [[Math.cos(a) * 0.15, Math.sin(a) * 0.15], [Math.cos(a), Math.sin(a)]]; }),
  },
  { key: 'cross', group: 'beams', label: 'Cross', strokes: [[[-1, 0], [1, 0]], [[0, -1], [0, 1]]] },
  { key: 'light-sheet', group: 'beams', label: 'Light sheet', strokes: sheet(96, 0.9) },
  { key: 'liquid-sky', group: 'beams', label: 'Liquid sky', strokes: sheet(128, 0.85, 0.12, 3) },

  // Shapes
  { key: 'cone', group: 'shapes', label: 'Cone (circle)', strokes: [circle(64)] },
  { key: 'tunnel', group: 'shapes', label: 'Tunnel', strokes: [circle(48, 1), circle(48, 0.66), circle(48, 0.33)] },
  {
    key: 'double-tunnel', group: 'shapes', label: 'Double tunnel',
    strokes: [-0.5, 0.5].flatMap((cx) => [circle(40, 0.48, cx), circle(40, 0.3, cx), circle(40, 0.12, cx)]),
  },
  { key: 'square', group: 'shapes', label: 'Square', strokes: [polygon(4, 1, Math.PI / 4)] },
  { key: 'triangle', group: 'shapes', label: 'Triangle', strokes: [polygon(3, 1, Math.PI / 2)] },
  { key: 'hexagon', group: 'shapes', label: 'Hexagon', strokes: [polygon(6, 1, Math.PI / 2)] },
  {
    key: 'star', group: 'shapes', label: 'Star',
    strokes: [Array.from({ length: 11 }, (_, i) => { const a = Math.PI / 2 + (i / 10) * Math.PI * 2; const r = i % 2 ? 0.4 : 1; return [Math.cos(a) * r, Math.sin(a) * r]; })],
  },
  {
    key: 'heart', group: 'shapes', label: 'Heart',
    strokes: [curve(96, (t) => { const a = t * Math.PI * 2; const s = Math.sin(a); return [(16 * s * s * s) / 17, (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) / 17 + 0.1]; })],
  },

  // Waves & curves
  { key: 'wave', group: 'waves', label: 'Wave', strokes: [wave(2, 96)] },
  { key: 'double-wave', group: 'waves', label: 'Double wave', strokes: [wave(2, 96, 0.6), wave(2, 96, 0.6, 0, Math.PI)] },
  { key: 'wave-stack', group: 'waves', label: 'Wave stack', strokes: [wave(3, 96, 0.18, 0.6), wave(3, 96, 0.18, 0), wave(3, 96, 0.18, -0.6)] },
  { key: 'zigzag', group: 'waves', label: 'Zig-zag', strokes: [Array.from({ length: 9 }, (_, i) => [i / 4 - 1, i % 2 ? 0.7 : -0.7])] },
  { key: 'figure-8', group: 'waves', label: 'Figure eight', strokes: [curve(96, (t) => { const a = t * Math.PI * 2; return [Math.sin(a), Math.sin(a) * Math.cos(a) * 1.4]; })] },
  { key: 'lissajous', group: 'waves', label: 'Lissajous', strokes: [curve(160, (t) => { const a = t * Math.PI * 2; return [Math.sin(3 * a + Math.PI / 2), Math.sin(2 * a)]; })] },
  { key: 'spiral', group: 'waves', label: 'Spiral', strokes: [(() => { const p = []; for (let i = 0; i <= 160; i++) { const t = i / 160; const a = t * Math.PI * 8; const r = t; p.push([Math.cos(a) * r, Math.sin(a) * r]); } return p; })()] },

  // Graphics & text
  {
    key: 'grid', group: 'graphics', label: 'Grid',
    strokes: [
      [[-1, -0.6], [1, -0.6]], [[-1, 0], [1, 0]], [[-1, 0.6], [1, 0.6]],
      [[-0.6, -1], [-0.6, 1]], [[0, -1], [0, 1]], [[0.6, -1], [0.6, 1]],
    ],
  },
  {
    key: 'lines', group: 'graphics', label: 'Scan lines',
    strokes: [[[-1, -0.5], [1, -0.5]], [[-1, 0], [1, 0]], [[-1, 0.5], [1, 0.5]]],
  },
  {
    key: 'dots', group: 'graphics', label: 'Dot field',
    strokes: (() => {
      const s = [];
      for (let y = -0.8; y <= 0.8; y += 0.4) for (let x = -0.8; x <= 0.8; x += 0.4) s.push([[x, y], [x + 0.02, y]]);
      return s;
    })(),
  },
  { key: 'text', group: 'graphics', label: 'Text', text: true },
];

export const PATTERN_BY_KEY = Object.fromEntries(PATTERNS.map((p) => [p.key, p]));

// ------------------------------------------------- imported (per show) registry
const imported = [];
const listeners = new Set();

/** Built-ins followed by the show's imported patterns. */
export function allPatterns() { return imported.length ? [...PATTERNS, ...imported] : PATTERNS; }
export function importedPatterns() { return imported; }
export function patternByKey(key) { return PATTERN_BY_KEY[key] || imported.find((p) => p.key === key) || null; }
export function onPatternsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(); }

/** Replace the imported list (open / undo). Only notifies when it changed. */
export function setImported(list) {
  const same = list.length === imported.length && list.every((p, i) => p === imported[i] || (p.key === imported[i].key && p.data === imported[i].data && p.label === imported[i].label));
  if (same) return;
  imported.length = 0;
  imported.push(...list);
  emit();
}
export function addImported(p) { imported.push(p); emit(); }
export function removeImported(key) {
  const i = imported.findIndex((p) => p.key === key);
  if (i >= 0) { imported.splice(i, 1); emit(); }
}
/** A key no other imported pattern uses, from a file name. */
export function newImportKey(name) {
  const base = 'ild:' + (String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'pattern');
  let key = base, n = 2;
  while (patternByKey(key)) key = `${base}-${n++}`;
  return key;
}

/** Frame count of an animated pattern (1 for everything else). */
export function frameCount(pattern) { return pattern.frames ? pattern.frames.length : 1; }

/**
 * The strokes to draw right now. opts: { text, frame } — `text` for the Text
 * pattern, `frame` (an integer, wraps) for an animated import.
 */
export function patternStrokes(pattern, opts = {}) {
  if (pattern.text) return textStrokes(opts.text ?? DEFAULT_TEXT);
  if (pattern.frames) {
    const n = pattern.frames.length;
    return n ? pattern.frames[(((opts.frame | 0) % n) + n) % n] : [];
  }
  return pattern.strokes;
}

/** Flatten strokes into [a, b] segment pairs, honouring visible-points (0..1). */
export function patternSegments(pattern, visible = 1, opts = {}) {
  const segs = [];
  for (const stroke of patternStrokes(pattern, opts)) {
    for (let i = 0; i < stroke.length - 1; i++) segs.push([stroke[i], stroke[i + 1]]);
  }
  const keep = Math.max(1, Math.round(segs.length * Math.max(0, Math.min(1, visible))));
  return segs.slice(0, keep);
}

/**
 * Draw a pattern into a thumbnail canvas: soft glow pass, then a crisp core,
 * so it reads as a laser rather than a line drawing. Imported patterns show
 * their own colours (first frame).
 */
export function drawPatternThumb(c, pat, { color = [0.37, 0.88, 0.67] } = {}) {
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.fillStyle = '#050608';
  ctx.fillRect(0, 0, w, h);
  if (!pat) return;
  const s = Math.min(w, h) * 0.42;
  const strokes = patternStrokes(pat, { frame: 0 });
  const rgb = (r, g, b, a) => `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [width, alpha] of [[6, 0.18], [2.2, 1]]) {
    ctx.lineWidth = width;
    if (!pat.colored) {
      ctx.strokeStyle = rgb(...color, alpha);
      ctx.beginPath();
      for (const stroke of strokes) stroke.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, -y * s) : ctx.moveTo(x * s, -y * s)));
      ctx.stroke();
      continue;
    }
    for (const stroke of strokes) {
      for (let i = 1; i < stroke.length; i++) {
        const a = stroke[i - 1], b = stroke[i];
        ctx.strokeStyle = rgb(b[2] ?? 1, b[3] ?? 1, b[4] ?? 1, alpha);
        ctx.beginPath(); ctx.moveTo(a[0] * s, -a[1] * s); ctx.lineTo(b[0] * s, -b[1] * s); ctx.stroke();
      }
    }
  }
  ctx.restore();
}
