// The Auto "director": picks laser patterns, colours and movement from the
// music. Two modes share the same taste (pattern moods, palettes, settings):
//
//   generateShow()  Pregenerate — reads the whole-song analysis (analyze.js)
//                   and writes ordinary, editable laser cues, directing the
//                   way a lighting designer would:
//                   - changes land where the music changes: phrases, fills,
//                     drops — not on a fixed clock
//                   - builds tighten: the shape contracts, spins faster and
//                     pulses with the snare roll, the colour narrows to one,
//                     then a beat of darkness
//                   - drops release: a flash, the shape pops, both projector
//                     groups play the same pattern mirrored, the palette cycles
//                   - breaks breathe: open shapes, slow turns, long fades
//                   - a story arc: the biggest drop gets patterns held back
//                     for it; repeated sections bring their look back, bigger
//                   - emotion: each section's mood (from the music, or the
//                     chosen Mood) picks the palette, the patterns that suit
//                     it, the speed and how often things change
//   LiveDirector    Live — hears only "now" (the analyser's bass/mid/high), so
//                   it tracks a slow energy level to choose patterns, changes on
//                   bar lines, jumps on a sudden energy rise (a drop), and
//                   modulates size / brightness / spin every frame.
//
// Pure logic, no DOM, no Three.js — Node-testable.

import { allPatterns } from '../laser/patterns.js';

/** Energy tier per built-in pattern: 0 calm, 1 medium, 2 high. */
export const PATTERN_TIER = {
  'liquid-sky': 0, wave: 0, 'double-wave': 0, 'figure-8': 0, lissajous: 0, heart: 0, cone: 0, hexagon: 0,
  tunnel: 1, square: 1, triangle: 1, star: 1, 'wave-stack': 1, spiral: 1, grid: 1, dots: 1, 'light-sheet': 1,
  'beam-fan': 2, 'split-fan': 2, 'ray-burst': 2, cross: 2, 'double-tunnel': 2, zigzag: 2, lines: 2,
};

/** Which moods each built-in pattern suits (picked ~3× as often in those moods). */
export const PATTERN_FEEL = {
  'beam-fan': 'euphoric aggressive', 'split-fan': 'euphoric aggressive', 'ray-burst': 'euphoric aggressive',
  cross: 'aggressive dark', 'light-sheet': 'dark dreamy', 'liquid-sky': 'dreamy dark', cone: 'dreamy dark',
  tunnel: 'dark aggressive', 'double-tunnel': 'aggressive euphoric', square: 'aggressive', triangle: 'dark aggressive',
  hexagon: 'dreamy', star: 'euphoric', heart: 'euphoric dreamy', wave: 'dreamy', 'double-wave': 'dreamy euphoric',
  'wave-stack': 'euphoric', zigzag: 'aggressive', 'figure-8': 'dreamy', lissajous: 'dreamy euphoric',
  spiral: 'dark dreamy', grid: 'dark aggressive', lines: 'aggressive dark', dots: 'dark dreamy',
};

export const INTENSITIES = [
  { key: 'calm', label: 'Calm' },
  { key: 'balanced', label: 'Balanced' },
  { key: 'wild', label: 'Wild' },
];
/** How often the pattern changes: 'auto' follows the music, else every N bars. */
export const CHANGE_RATES = [
  { key: 'auto', label: 'Auto' },
  { key: 1, label: '1 bar' },
  { key: 2, label: '2 bars' },
  { key: 4, label: '4 bars' },
  { key: 8, label: '8 bars' },
];
export const AUTO_GROUPS = [
  { key: 'beams', label: 'Beams' },
  { key: 'shapes', label: 'Shapes' },
  { key: 'waves', label: 'Waves' },
  { key: 'graphics', label: 'Graphics' },
];
/** Pregenerate's overall mood: 'auto' reads it from each section of the music. */
export const MOODS = [
  { key: 'auto', label: 'From the music' },
  { key: 'euphoric', label: 'Euphoric' },
  { key: 'dark', label: 'Dark' },
  { key: 'dreamy', label: 'Dreamy' },
  { key: 'aggressive', label: 'Aggressive' },
];

/** The palette each mood uses when Colours is "By mood" (added to the show when first used). */
export const MOOD_PALETTES = {
  euphoric: { id: 'mood-euphoric', name: 'Sunrise', colors: [[1, 0.25, 0.55], [1, 0.7, 0.05], [0.05, 0.8, 1], [1, 1, 1]] },
  aggressive: { id: 'mood-aggressive', name: 'Acid', colors: [[0.3, 1, 0], [1, 0, 0], [1, 1, 1], [1, 0.4, 0]] },
  dreamy: { id: 'mood-dreamy', name: 'Dream', colors: [[0.55, 0.35, 1], [0.15, 0.9, 0.85], [1, 0.4, 0.8], [0.5, 0.75, 1]] },
  dark: { id: 'mood-dark', name: 'Deep', colors: [[0.55, 0, 1], [1, 0, 0.15], [0.05, 0.1, 1], [0.35, 0, 0.6]] },
};

/** How a mood directs: tier bias, motion speed, brightness, how long a look holds. */
const MOOD_STYLE = {
  euphoric: { tier: 0.04, speed: 1, bright: 1, hold: 1 },
  aggressive: { tier: 0.1, speed: 1.35, bright: 1, hold: 0.5 },
  dreamy: { tier: -0.12, speed: 0.6, bright: 0.85, hold: 2 },
  dark: { tier: 0, speed: 0.85, bright: 0.8, hold: 1 },
};

export const AUTO_DEFAULTS = {
  intensity: 'balanced',
  every: 'auto',
  palette: 'auto',        // a palette id, or 'auto' = per section mood
  mood: 'auto',           // pregenerate: a MOODS key ('auto' = from the music)
  groups: ['beams', 'shapes', 'waves', 'graphics'],
  imported: true,         // may use the show's imported ILDA patterns
  alternate: true,        // with 2+ projectors, odd/even ones get different patterns
  markers: true,          // pregenerate: add section markers (they become Live pads)
  source: 'song',         // live: 'song' (the loaded track) or 'input' (sound input)
};

/** Clean saved Auto settings (unknown values fall back to the defaults). */
export function normalizeAutoSettings(s) {
  const d = AUTO_DEFAULTS;
  if (!s || typeof s !== 'object') return structuredClone(d);
  const groups = Array.isArray(s.groups) ? s.groups.filter((g) => AUTO_GROUPS.some((x) => x.key === g)) : d.groups;
  return {
    intensity: INTENSITIES.some((x) => x.key === s.intensity) ? s.intensity : d.intensity,
    every: CHANGE_RATES.some((x) => x.key === s.every) ? s.every : d.every,
    palette: typeof s.palette === 'string' ? s.palette : d.palette,
    mood: MOODS.some((x) => x.key === s.mood) ? s.mood : d.mood,
    groups: groups.length ? groups : d.groups.slice(),
    imported: s.imported !== false,
    alternate: s.alternate !== false,
    markers: s.markers !== false,
    source: s.source === 'input' ? 'input' : 'song',
  };
}

const BIAS = { calm: -0.15, balanced: 0, wild: 0.15 };
const DEPTH = { calm: 0.6, balanced: 1, wild: 1.35 }; // modulation depth

/** Energy (0..1) -> tier 0/1/2, shifted by the intensity setting. */
export function tierFor(energy, intensity = 'balanced') {
  const e = energy + (BIAS[intensity] ?? 0);
  return e > 0.62 ? 2 : e > 0.36 ? 1 : 0;
}

/** Seeded random numbers, so the same song + settings give the same show. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Patterns Auto may use under these settings: [{ key, tier }]. Never Text. */
export function candidates(settings) {
  const out = [];
  for (const p of allPatterns()) {
    if (p.text) continue;
    if (p.group === 'imported') { if (settings.imported) out.push({ key: p.key, tier: -1 }); continue; } // fits any tier
    if (!settings.groups.includes(p.group)) continue;
    out.push({ key: p.key, tier: PATTERN_TIER[p.key] ?? 1 });
  }
  return out;
}

/**
 * Pick a pattern for a tier, avoiding `avoid` (keys). Falls back to nearby
 * tiers. With a mood, patterns that suit it are ~3× as likely.
 */
export function pickPattern(tier, list, rand, avoid = [], mood = null) {
  for (const spread of [0, 1, 2]) {
    let pool = list.filter((c) => (c.tier === -1 || Math.abs(c.tier - tier) <= spread) && !avoid.includes(c.key));
    if (!pool.length) pool = list.filter((c) => c.tier === -1 || Math.abs(c.tier - tier) <= spread);
    // imported art is a treat, not the whole show: weight it down
    const exact = pool.filter((c) => c.tier !== -1);
    if (exact.length && rand() < 0.75) pool = exact;
    if (!pool.length) continue;
    if (!mood) return pool[Math.floor(rand() * pool.length)].key;
    const w = pool.map((c) => ((PATTERN_FEEL[c.key] || '').includes(mood) ? 3 : 1));
    let r = rand() * w.reduce((x, y) => x + y, 0);
    for (let i = 0; i < pool.length; i++) if ((r -= w[i]) < 0) return pool[i].key;
    return pool[pool.length - 1].key;
  }
  return 'beam-fan';
}

const MOOD_PALETTE = { intro: 'ice', break: 'ice', outro: 'ice', build: 'fire', verse: 'club', drop: 'club' };

/** Live: the palette id to use — the chosen one, or per section kind ('auto'). */
export function paletteFor(settings, kind, palettes) {
  const has = (id) => palettes.some((p) => p.id === id);
  if (settings.palette !== 'auto' && has(settings.palette)) return settings.palette;
  const id = MOOD_PALETTE[kind] || 'club';
  return has(id) ? id : palettes[0]?.id || null;
}

/** A section's mood when the analysis has none (older analyses, hand-made sections). */
const KIND_MOOD = { drop: 'euphoric', build: 'aggressive', verse: 'dark', intro: 'dreamy', break: 'dreamy', outro: 'dreamy' };

/** Bars a look holds in a section, before fills and the mood shorten / stretch it. */
function holdBars(settings, kind, style, hero) {
  if (settings.every !== 'auto') return settings.every;
  let base = { drop: 4, verse: 4, build: 4, break: 8, intro: 8, outro: 8 }[kind] || 4;
  if (hero) base = 2;
  base *= style.hold;
  if (settings.intensity === 'wild') base /= 2;
  if (settings.intensity === 'calm') base *= 2;
  return Math.max(1, Math.min(16, Math.round(base)));
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Pregenerate: the analysis -> laser cue specs.
 * Returns { cues: [{ lane:'A'|'B', pattern, start, duration, params, anim, colorRef, unison? }],
 *           markers: [{ t, name }],
 *           palettes: [palettes the show doesn't have yet but the cues use] }.
 * Times in seconds.
 */
export function generateShow(an, settings, { palettes = [], projectors = 1, seed = 1 } = {}) {
  const s = normalizeAutoSettings(settings);
  const rand = rng(seed);
  const list = candidates(s);
  const two = s.alternate && projectors > 1;
  const depth = DEPTH[s.intensity];
  const beatLen = 60 / (an.bpm || 120);
  const cues = [];
  const addPalettes = [];
  const hasPal = (id) => palettes.some((p) => p.id === id) || addPalettes.some((p) => p.id === id);
  // a mood set on the song map wins, then the overall Mood, then what the audio says
  const moodOf = (sec) => (sec.moodSet && MOOD_STYLE[sec.mood] ? sec.mood
    : s.mood !== 'auto' ? s.mood : MOOD_STYLE[sec.mood] ? sec.mood : KIND_MOOD[sec.kind] || 'euphoric');
  const paletteOf = (mood) => {
    if (s.palette !== 'auto' && palettes.some((p) => p.id === s.palette)) return s.palette;
    const p = MOOD_PALETTES[mood];
    if (!hasPal(p.id)) addPalettes.push(structuredClone(p));
    return p.id;
  };

  // the story arc: the biggest drop (the later one on a tie) is the hero;
  // with 2+ drops, two high-energy patterns are held back for it
  const drops = an.sections.filter((x) => x.kind === 'drop');
  const hero = drops.reduce((a, b) => (!a || b.energy >= a.energy - 0.02 ? b : a), null);
  const reserve = [];
  if (hero && drops.length > 1) {
    reserve.push(pickPattern(2, list, rand, [], moodOf(hero)));
    reserve.push(pickPattern(2, list, rand, reserve, moodOf(hero)));
  }
  const motif = new Map(); // section group -> [[patternA, patternB], ...] per look
  let prevA = null, prevB = null, dir = 1;

  an.sections.forEach((sec, si) => {
    const next = an.sections[si + 1];
    const mood = moodOf(sec);
    const style = MOOD_STYLE[mood];
    const isHero = sec === hero;
    const dropNo = drops.indexOf(sec);
    // escalation: the first of several drops holds back, the hero goes further, repeats grow
    const lvl = (isHero ? 1.15 : dropNo === 0 && drops.length > 1 ? 0.88 : 1) * (1 + 0.06 * Math.min(2, sec.repeat || 0));
    const nextDrop = an.sections.slice(si + 1).find((x) => x.kind === 'drop');

    // where the looks change: every `per` bars, plus right after a fill
    let bounds;
    if (sec.kind === 'build' && s.every === 'auto') bounds = [sec.bar0];
    else {
      const per = holdBars(s, sec.kind, style, isHero);
      bounds = [];
      for (let b = sec.bar0; b < sec.bar1; b += per) bounds.push(b);
      if (s.every === 'auto') {
        for (let b = sec.bar0; b < sec.bar1 - 1; b++) {
          if (an.bars[b]?.fill && !bounds.some((x) => Math.abs(x - (b + 1)) < 2)) bounds.push(b + 1);
        }
        bounds.sort((x, y) => x - y);
      }
    }

    const looks = motif.get(sec.group) || [];
    const fresh = !motif.has(sec.group);
    bounds.forEach((b0, ci) => {
      const b1 = bounds[ci + 1] ?? sec.bar1;
      const t0 = an.bars[b0].t;
      const t1 = b1 < an.bars.length ? an.bars[b1].t : sec.end;
      const sl = an.bars.slice(b0, b1);
      const e = sl.reduce((x, b) => x + b.energy, 0) / sl.length;
      let tier = tierFor(e + style.tier, s.intensity);
      const opening = sec.kind === 'drop' && ci === 0;
      if (sec.kind === 'drop') tier = Math.max(tier, opening ? 2 : 1);
      if (sec.kind === 'break' || sec.kind === 'intro' || sec.kind === 'outro') tier = Math.min(tier, mood === 'dreamy' ? 0 : 1);
      // a beat of darkness right before a drop makes it hit
      const last = ci === bounds.length - 1;
      const gap = last && next && next.kind === 'drop' && (sec.kind !== 'drop' || next.hit) ? beatLen * 0.75 : 0;
      const duration = Math.max(beatLen, t1 - t0 - gap);

      // patterns: the hero's held-back pair, a repeated section's motif, or a fresh pick
      const avoid = [prevA, prevB, ...(isHero ? [] : reserve)];
      let pa, pb;
      const again = !fresh && looks[ci];
      if (isHero && opening && reserve.length) [pa, pb] = reserve;
      else if (again && again[0] !== prevA) [pa, pb] = again;
      else {
        pa = pickPattern(tier, list, rand, avoid, mood);
        pb = pickPattern(tier, list, rand, [pa, ...avoid], mood);
      }
      const unison = two && opening; // drops open with every projector on one pattern, mirrored
      if (unison) pb = pa;
      if (fresh) looks[ci] = [pa, pb];
      prevA = pa;
      prevB = pb;
      dir = -dir;

      const base = {
        size: r3(clamp((0.7 + 0.35 * e) * lvl, 0.5, 1.2)),
        brightness: r3(clamp((0.55 + 0.45 * e) * style.bright, 0.35, 1)),
      };
      // colour: builds narrow to one colour of the coming drop's palette; drops cycle fast
      let colorRef;
      if (sec.kind === 'build') {
        colorRef = { palette: paletteOf(nextDrop ? moodOf(nextDrop) : mood), mode: 'pick', index: Math.floor(rand() * 4), every: 1, fade: false };
      } else {
        const every = sec.kind === 'drop'
          ? (s.intensity === 'calm' ? 2 : mood === 'aggressive' || isHero ? 0.5 : 1)
          : sec.kind === 'verse' ? 2 : mood === 'dreamy' ? 8 : 4;
        colorRef = { palette: paletteOf(mood), mode: 'cycle', index: Math.floor(rand() * 8), every, fade: sec.kind !== 'drop' };
      }
      const fills = sl.map((b, k) => (b.fill ? an.bars[b0 + k].t + 3 * beatLen : null)).filter((x) => x != null && x < t0 + duration);
      const ctx = { an, kind: sec.kind, t0, dur: duration, tier, depth: depth * lvl, beatLen, speed: style.speed, opening, fills, bars: sl, base };
      cues.push({ lane: 'A', pattern: pa, start: r3(t0), duration: r3(duration), params: base, anim: cueAnim({ ...ctx, dir }), colorRef, ...(unison ? { unison } : {}) });
      if (two) {
        cues.push({
          lane: 'B', pattern: pb, start: r3(t0), duration: r3(duration), params: { ...base },
          anim: cueAnim({ ...ctx, dir: -dir }),
          colorRef: { ...colorRef, index: colorRef.index + (sec.kind === 'build' ? 0 : 2) },
          ...(unison ? { unison } : {}),
        });
      }
    });
    if (fresh) motif.set(sec.group, looks);
  });

  const markers = s.markers ? an.sections.map((x) => ({ t: r3(x.t), name: x.name })) : [];
  return { cues, markers, palettes: addPalettes };
}

/**
 * Keyframes for one generated cue (u = 0..1 across the cue):
 *   build — the shape contracts, the spin accelerates and brightness pulses
 *           with the snare roll (1, 2, 4 hits a beat), getting brighter
 *   drop / verse — brightness pulses on each beat's kick, steady spin; a
 *           drop's opening cue flashes and pops on its first beat; a fill's
 *           beat strobes in 16ths
 *   calm  — a slow quarter turn, gentle size breathing
 */
function cueAnim({ an, kind, t0, dur, tier, dir, depth, beatLen, speed = 1, opening = false, fills = [], bars = [], base = {} }) {
  const anim = {};
  const u = (t) => r3(clamp((t - t0) / dur, 0, 1));
  if (kind === 'build') {
    anim.size = { ease: 'smooth', keys: [{ t: 0, v: 0.95 }, { t: 1, v: r3(clamp(0.6 - 0.1 * depth, 0.35, 0.6)) }] };
    anim.rotZ = { ease: 'smooth', keys: [{ t: 0, v: 0 }, { t: 0.5, v: r3(dir * 0.5) }, { t: 0.8, v: r3(dir * 2) }, { t: 1, v: r3(dir * Math.PI * 2) }] };
    // the snare roll: a peak on every hit, brighter as the build climbs. A long
    // build at 16ths would bury the curve in keys, so cap the subdivision.
    const roll = (maxPer) => {
      const keys = [];
      bars.forEach((b, k) => {
        const per = Math.min(maxPer, b.rate >= 3 ? 4 : b.rate >= 1.5 ? 2 : 1);
        for (let h = 0; h < 4 * per; h++) {
          const t = b.t + (h * beatLen) / per;
          if (t >= t0 + dur - 1e-3) break;
          const peak = clamp(0.45 + 0.55 * ((k + h / (4 * per)) / Math.max(1, bars.length)), 0.3, 1);
          keys.push({ t: u(t), v: r3(peak) }, { t: u(t + beatLen / per / 2), v: r3(peak * 0.35) });
        }
      });
      return keys;
    };
    let keys = roll(4);
    if (keys.length > 256) keys = roll(2);
    if (keys.length > 256) keys = roll(1);
    anim.brightness = keys.length >= 4 && keys.length <= 256
      ? { ease: 'linear', keys: dedupe(keys) }
      : { ease: 'linear', keys: [{ t: 0, v: 0.45 }, { t: 1, v: 1 }] };
    return anim;
  }
  if (tier === 0 || kind === 'break' || kind === 'intro' || kind === 'outro') {
    anim.rotZ = { ease: 'smooth', keys: [{ t: 0, v: 0 }, { t: 1, v: r3(dir * clamp(Math.PI * 0.5 * depth * speed, 0.2, Math.PI)) }] };
    anim.size = { ease: 'smooth', keys: [{ t: 0, v: 0.75 }, { t: 0.5, v: 0.95 }, { t: 1, v: 0.75 }] };
    return anim;
  }
  // spin: a full turn per 4 bars at tier 2, slower at tier 1 (kept inside ±360°)
  const turns = Math.min(1, (dur / (beatLen * 16)) * (tier === 2 ? 1 : 0.5) * depth * speed);
  anim.rotZ = { ease: 'linear', keys: [{ t: 0, v: 0 }, { t: 1, v: r3(dir * turns * Math.PI * 2) }] };
  // brightness on the kick: a key on every beat (peak) and half-way (dip)
  const beats = an.beats.filter((b) => b.t >= t0 - 1e-3 && b.t < t0 + dur - 1e-3);
  if (beats.length >= 2 && beats.length <= 64) {
    let keys = [];
    const lo = r3(clamp(0.55 - 0.3 * depth, 0.15, 0.6));
    for (const b of beats) {
      keys.push({ t: u(b.t), v: r3(clamp(0.6 + 0.45 * b.bass * depth, lo + 0.1, 1)) });
      const mid = b.t + beatLen * 0.5;
      if (mid < t0 + dur) keys.push({ t: u(mid), v: lo });
    }
    // a fill's beat strobes in 16ths
    for (const f of fills) {
      keys = keys.filter((k) => k.t < u(f) - 1e-3 || k.t > u(f + beatLen) + 1e-3);
      for (let h = 0; h < 4; h++) {
        const t = f + (h * beatLen) / 4;
        if (t >= t0 + dur) break;
        keys.push({ t: u(t), v: 1 }, { t: u(t + beatLen / 8), v: lo });
      }
    }
    if (opening && keys.length) keys[0] = { t: 0, v: 1 }; // the drop's flash
    anim.brightness = { ease: 'linear', keys: dedupe(keys) };
  }
  if (opening) {
    const sz = base.size || 1;
    anim.size = { ease: 'smooth', keys: [{ t: 0, v: r3(Math.min(2, sz * 1.35)) }, { t: u(t0 + beatLen), v: r3(sz) }] };
  }
  return anim;
}

function dedupe(keys) {
  const out = [];
  for (const k of keys.sort((a, b) => a.t - b.t)) if (!out.length || k.t - out[out.length - 1].t > 0.004) out.push(k);
  return out;
}

/**
 * Live mode. Call update() every frame with the clock and the current band
 * levels; read cues() for what each projector should draw. The cues are
 * ordinary laser-cue-shaped objects (pattern, params, colorRef) so the engine
 * draws them like any timeline cue.
 */
export class LiveDirector {
  constructor(settings = AUTO_DEFAULTS, seed = Date.now() & 0xffff) {
    this.settings = normalizeAutoSettings(settings);
    this.rand = rng(seed);
    this.slow = 0.4;      // ~4 s energy average: picks the tier
    this.fast = 0;        // ~0.25 s: catches drops
    this.bass = 0;        // smoothed bass for the pulse
    this.high = 0;
    this.heard = 0;       // seconds since we last heard sound
    this.tier = 1;
    this.patterns = ['beam-fan', 'tunnel'];
    this.spin = [0, 0];
    this.dir = 1;
    this._lastBar = null;
    this._barsSince = 0;
    this._cool = 2;       // seconds before a drop / breakdown can trigger (none right at the start)
    this._pendingBeat = null;
    this.changes = 0;
    this.beat = 0;
    this._cues = [this._cue(0), this._cue(1)];
    this._pick(true);
  }

  setSettings(s) {
    const next = normalizeAutoSettings(s);
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return; // e.g. an undo that didn't touch Auto
    this.settings = next;
    this._pick(true);
  }

  _cue(i) {
    return { id: `auto-${i}`, kind: 'laser', pattern: 'beam-fan', start: 0, duration: 1e9, lane: -1, track: null,
      params: { size: 1, rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, color: [1, 1, 1], brightness: 1, points: 1, scan: 1 }, colorRef: null };
  }

  _pick(force = false) {
    const list = candidates(this.settings);
    const a = pickPattern(this.tier, list, this.rand, force ? [] : this.patterns);
    const b = pickPattern(this.tier, list, this.rand, [a, ...this.patterns]);
    this.patterns = [a, b];
    this.dir = -this.dir;
    this.changes++;
  }

  /** Bars per change right now. */
  get every() {
    const s = this.settings;
    if (s.every !== 'auto') return s.every;
    const base = [8, 4, 2][this.tier];
    return s.intensity === 'wild' ? Math.max(1, base / 2) : s.intensity === 'calm' ? base * 2 : base;
  }

  /**
   * time: song (or free-running) seconds; beat: song beat number (float);
   * bands: { bass, mid, high } 0..1 or null; dt: seconds since last frame.
   */
  update({ beat, bands, dt, palettes = [] }) {
    const s = this.settings;
    this.beat = beat;
    dt = Math.max(0, Math.min(0.1, dt || 0));
    const b = bands || { bass: 0, mid: 0, high: 0 };
    const level = 0.5 * b.bass + 0.3 * b.mid + 0.2 * b.high;
    const silent = level < 0.02;
    this.heard = silent ? this.heard + dt : 0;
    // with no sound for a while, Auto keeps going on the beat at a medium level
    const e = this.heard > 1.5 ? 0.5 : Math.min(1, level * 1.6);
    const k = (tau) => 1 - Math.exp(-dt / tau);
    this.slow += (e - this.slow) * k(4);
    this.fast += (e - this.fast) * k(0.25);
    this.bass += ((this.heard > 1.5 ? 0 : b.bass) - this.bass) * k(0.06);
    this.high += ((this.heard > 1.5 ? 0.3 : b.high) - this.high) * k(0.15);
    this._cool = Math.max(0, this._cool - dt);

    const want = tierFor(this.slow, s.intensity);
    // a drop: energy jumps well above the recent average
    if (!this._cool && this.fast > 0.55 && this.fast > this.slow * 1.5 && this.heard === 0) {
      this._cool = 8;
      this.tier = Math.max(want, 2 - (s.intensity === 'calm' ? 1 : 0));
      this._pendingBeat = Math.floor(beat) + 1; // change on the next beat
    }
    // a breakdown: the music suddenly drops out -> calm down on the next beat
    else if (!this._cool && this.slow > 0.35 && this.fast < this.slow * 0.4) {
      this._cool = 4;
      this.slow = this.fast + (this.slow - this.fast) * 0.3;
      this.tier = tierFor(this.slow, s.intensity);
      this._pendingBeat = Math.floor(beat) + 1;
    }
    if (this._pendingBeat != null && beat >= this._pendingBeat) {
      this._pendingBeat = null;
      this._barsSince = 0;
      this._pick();
    }
    const bar = Math.floor(beat / 4);
    if (this._lastBar == null || bar < this._lastBar) this._lastBar = bar; // seek back / start
    if (bar > this._lastBar) {
      this._barsSince += bar - this._lastBar;
      this._lastBar = bar;
      if (this._barsSince >= this.every) {
        this._barsSince = 0;
        this.tier = want;
        this._pick();
      }
    }

    // modulation
    const depth = DEPTH[s.intensity];
    const phase = beat - Math.floor(beat);
    const beatPulse = this.heard > 1.5 ? Math.exp(-phase * 5) : 0; // synthetic kick when silent
    const pulse = Math.min(1, Math.max(this.bass * 1.2, beatPulse));
    const spinRate = (0.15 + 0.9 * this.high * depth) * [0.4, 0.8, 1.4][this.tier]; // rad/s
    const pal = paletteFor(s, ['break', 'verse', 'drop'][this.tier], palettes);
    for (let i = 0; i < 2; i++) {
      const c = this._cues[i];
      this.spin[i] = (this.spin[i] + (i ? -1 : 1) * this.dir * spinRate * dt) % (Math.PI * 2);
      c.pattern = this.patterns[i];
      c.params.rotZ = this.spin[i];
      c.params.size = clamp((0.75 + 0.15 * this.tier) * (1 + 0.22 * pulse * depth), 0.3, 1.6);
      c.params.brightness = clamp((0.5 + 0.12 * this.tier) + 0.45 * pulse * depth, 0.2, 1);
      c.colorRef = pal ? { palette: pal, mode: 'cycle', index: i * 2, every: [4, 2, 1][this.tier], fade: this.tier < 2 } : null;
      c.start = 0;
    }
  }

  /** What projector i draws (pairs alternate when the setting is on). */
  cueFor(i) { return this._cues[this.settings.alternate ? i % 2 : 0]; }

  /** A short description for the Live panel: "Medium · Tunnel". */
  get status() { return ['Calm', 'Medium', 'High'][this.tier]; }
}
