// Named colour palettes and per-projector output settings for laser shows.
//
// A palette is a short list of colours saved with the show ("Ice", "Fire",
// "Club RGB" to start, plus any the user makes). A laser cue's colour can
// *reference* a palette instead of holding its own RGB: either one colour of
// it ("pick"), or the whole palette stepping on the beat ("cycle"). Editing a
// palette colour changes every cue that uses it — that's the point.
//
// Projector output is BEYOND's projection-zone idea in small: every laser
// projector scales, offsets, flips and brightness-limits whatever it is sent,
// after the cue's own parameters. Pure functions — unit-testable in Node.

export const PRESET_PALETTES = [
  { id: 'ice', name: 'Ice', colors: [[0.55, 0.9, 1], [0.1, 0.5, 1], [1, 1, 1], [0.35, 0.25, 1]] },
  { id: 'fire', name: 'Fire', colors: [[1, 0.12, 0], [1, 0.45, 0], [1, 0.8, 0.1], [1, 0, 0.15]] },
  { id: 'club', name: 'Club RGB', colors: [[1, 0, 0], [0, 1, 0.1], [0.05, 0.2, 1], [1, 0, 1]] },
];

/** A fresh copy of the preset palettes (new shows start with these). */
export function defaultPalettes() { return structuredClone(PRESET_PALETTES); }

/** How often a cycling palette moves to its next colour, in beats. */
export const CYCLE_RATES = [
  { key: 0.5, label: 'Every ½ beat' },
  { key: 1, label: 'Every beat' },
  { key: 2, label: 'Every 2 beats' },
  { key: 4, label: 'Every bar' },
  { key: 8, label: 'Every 2 bars' },
];

export const MAX_COLORS = 8;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const isRgb = (c) => Array.isArray(c) && c.length === 3 && c.every(Number.isFinite);

/** Clean a saved palette list; null if there's nothing usable. */
export function normalizePalettes(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const out = [];
  for (const p of list) {
    if (!p || typeof p.id !== 'string' || seen.has(p.id)) continue;
    const colors = (Array.isArray(p.colors) ? p.colors : []).filter(isRgb).slice(0, MAX_COLORS).map((c) => c.map(clamp01));
    if (!colors.length) continue;
    seen.add(p.id);
    out.push({ id: p.id, name: String(p.name || 'Palette'), colors });
  }
  return out;
}

/** A unique id for a new user palette. */
export function newPaletteId(palettes) {
  let n = palettes.length + 1;
  while (palettes.some((p) => p.id === `p${n}`)) n++;
  return `p${n}`;
}

/**
 * A cue's colour reference: { palette: id, mode: 'pick'|'cycle', index,
 * every (beats), fade }. Returns null when it doesn't point at a palette.
 */
export function normalizeColorRef(ref, palettes) {
  if (!ref || typeof ref.palette !== 'string') return null;
  if (palettes && !palettes.some((p) => p.id === ref.palette)) return null;
  const every = CYCLE_RATES.some((r) => r.key === ref.every) ? ref.every : 1;
  return {
    palette: ref.palette,
    mode: ref.mode === 'cycle' ? 'cycle' : 'pick',
    index: Number.isInteger(ref.index) && ref.index >= 0 ? ref.index : 0,
    every,
    fade: !!ref.fade,
  };
}

const mod = (a, n) => ((a % n) + n) % n;

/**
 * The colour a reference resolves to at song beat `beat`. A cycle starts at
 * `index` and steps every `every` beats (fading across the step if `fade`).
 * Returns null if the palette is gone.
 */
export function paletteColor(palettes, ref, beat = 0) {
  const pal = ref && palettes.find((p) => p.id === ref.palette);
  if (!pal || !pal.colors.length) return null;
  const n = pal.colors.length;
  if (ref.mode !== 'cycle' || n === 1) return pal.colors[mod(ref.index, n)].slice();
  const pos = (Number.isFinite(beat) ? beat : 0) / (ref.every || 1);
  const step = Math.floor(pos);
  const a = pal.colors[mod(ref.index + step, n)];
  if (!ref.fade) return a.slice();
  const b = pal.colors[mod(ref.index + step + 1, n)];
  let f = pos - step;
  f = f * f * (3 - 2 * f);
  return a.map((x, i) => x + (b[i] - x) * f);
}

// ------------------------------------------------------- projector output

/** Default output settings for a laser projector (no change to the cue). */
export function defaultOutput() {
  return { size: 1, posX: 0, posY: 0, flipX: false, flipY: false, limit: 1 };
}

/** Clean saved output settings (missing / bad values fall back to defaults). */
export function normalizeOutput(o) {
  const d = defaultOutput();
  if (!o || typeof o !== 'object') return d;
  const num = (v, lo, hi, def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
  return {
    size: num(o.size, 0, 2, d.size),
    posX: num(o.posX, -1, 1, d.posX),
    posY: num(o.posY, -1, 1, d.posY),
    flipX: !!o.flipX,
    flipY: !!o.flipY,
    limit: num(o.limit, 0, 1, d.limit),
  };
}

/** True when the settings leave the cue's output untouched. */
export function isDefaultOutput(o) {
  const d = defaultOutput();
  return !o || Object.keys(d).every((k) => o[k] === d[k]);
}
