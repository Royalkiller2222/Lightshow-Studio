// xLights sequence import (.xsq): the effects on each model and the timing
// tracks, turned into our timeline tracks, cues and markers.
//
// A sequence carries no rig — xLights keeps its models (and their channels)
// in the show folder's xlights_rgbeffects.xml — so this brings a sequence
// onto the CURRENT rig: each xLights model is mapped to one of our fixture
// types (and so a group: movers, PARs, bars…), guessed from its name and
// changeable in the dialog. Each effect becomes a look of our own effects at
// its exact start and length: On / Color Wash -> level + palette colour,
// Bars / Single Strand / Marquee… -> a beat-synced chase, Twinkle / Shimmer
// -> a flicker, Fire -> red/orange, Plasma / Butterfly -> a rainbow, VU Meter
// -> audio level, Moving Head -> movement. One timing track can become
// markers; a "Beats" track also gives the tempo. Pure; Node-testable.

import { parseXml, child, children, descendants, childText } from './xml.js';
import { GROUP_OF_TYPE } from './rig.js';

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const r3 = (v) => Math.round(v * 1000) / 1000;
const MAX_MARKERS = 200; // a track with more marks than this is beats, not sections

/** Parse a .xsq. Throws when it isn't an xLights sequence. */
export function readXsq(text) {
  const doc = parseXml(text);
  if (doc.tag.replace(/^.*:/, '').toLowerCase() !== 'xsequence') throw new Error("it isn't an xLights sequence");
  const head = child(doc, 'head');
  const media = childText(head, 'mediaFile');
  const seq = {
    version: childText(head, 'version'),
    song: media ? media.split(/[\\/]/).pop() : '',
    seconds: num(childText(head, 'sequenceDuration'), 0),
    effectDb: children(child(doc, 'EffectDB'), 'Effect').map((e) => e.text || ''),
    palettes: children(child(doc, 'ColorPalettes'), 'ColorPalette').map((p) => p.text || ''),
    models: [],
    timing: [],
  };
  for (const el of children(child(doc, 'ElementEffects'), 'Element')) {
    const name = el.attrs.name || '';
    const effects = descendants(el, 'Effect').map((e) => ({
      name: e.attrs.name || '',
      label: e.attrs.label || '',
      start: num(e.attrs.startTime) / 1000,
      end: num(e.attrs.endTime) / 1000,
      ref: e.attrs.ref != null ? num(e.attrs.ref, -1) : -1,
      palette: e.attrs.palette != null ? num(e.attrs.palette, -1) : -1,
      inline: e.text || '', // very old sequences keep the settings inline
    }));
    if (el.attrs.type === 'timing') seq.timing.push({ name, marks: effects });
    else if (effects.length) seq.models.push({ name, effects });
  }
  if (!seq.seconds) seq.seconds = Math.max(0, ...seq.models.flatMap((m) => m.effects.map((e) => e.end)));
  return seq;
}

/** "K=V,K=V" settings (xLights escapes commas inside values as &comma;). */
export function parseSettings(s) {
  const out = {};
  for (const part of String(s || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).replace(/&comma;/g, ',');
  }
  return out;
}

const hex = (h) => { const m = /#([0-9a-f]{6})/i.exec(h || ''); if (!m) return null; const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => r3(x / 255)); };

/** The checked palette colours (0..1 RGB), in order. */
export function paletteColors(p) {
  const cs = [];
  for (let i = 1; i <= 8; i++) if (p[`C_CHECKBOX_Palette${i}`] === '1') { const c = hex(p[`C_BUTTON_Palette${i}`]); if (c) cs.push(c); }
  if (!cs.length) { const c = hex(p.C_BUTTON_Palette1); if (c) cs.push(c); }
  return cs;
}

// ------------------------------------------------------- models -> types
/** Guess our fixture type for an xLights model from its name. */
export function guessModel(name) {
  const t = String(name || '').toLowerCase();
  if (/laser/.test(t)) return { type: 'laser', why: 'laser in the name' };
  if (/spark|flame|pyro/.test(t)) return { type: 'cold-spark', why: 'spark in the name' };
  if (/\bmh\b|moving ?head|mover|\bspot\b|\bbeam\b/.test(t)) return { type: 'moving-head', why: 'moving head in the name' };
  if (/flood|\bpar\b|\bpars\b|uplight|\bwash\b|spotlight/.test(t)) return { type: 'led-par', why: 'flood / PAR in the name' };
  return { type: 'pixel-bar', why: 'pixels (most xLights models)' };
}

// ------------------------------------------------------- effects -> looks
const CHASE = /^(bars|single strand|marquee|meteors|spirals|curtain|wave|morph|garlands|fan|pinwheel|ripple|shockwave|circles|galaxy|spirograph|chase|candle|tree|wreath|warp|lines)$/;
const FLICKER = /^(twinkle|shimmer|lightning|snowflakes|fireworks|sparkle|snowstorm|life|bubbles)$/;
const RAINBOW = /^(plasma|butterfly|kaleidoscope|liquid|shader|tendril|color wash rainbow)$/;

/**
 * Our layers ([effectKey, params]…) for one xLights effect, or null to skip
 * it (Off). type: our fixture type the model maps to. dur: seconds.
 */
export function effectLayers(name, settings, type, dur) {
  const n = String(name || '').toLowerCase();
  if (n === 'off' || n === 'servo' || n === 'dmx') return null;
  if (type === 'cold-spark') return [['sparks', { size: 0.8 }]];
  const colors = paletteColors(settings);
  const c1 = colors[0] || [1, 1, 1];
  const bright = Math.max(0.05, Math.min(1, num(settings.C_SLIDER_Brightness, 100) / 100));
  const colour = colors.length > 1 && colors.some((c) => c.join() !== c1.join())
    ? ['c-two', { color: c1, color2: colors.find((c) => c.join() !== c1.join()), shape: 'square', sync: true, division: 2, spread: 0 }]
    : ['c-static', { color: c1 }];
  if (n === 'on') return [['i-flat', { size: bright }], ['c-static', { color: c1 }]];
  if (n === 'color wash') {
    const fade = colour[0] === 'c-two' ? ['c-two', { ...colour[1], shape: 'ramp', sync: false, rate: r3(1 / Math.max(0.1, dur)) }] : colour;
    return [['i-flat', { size: bright }], fade];
  }
  if (n === 'strobe') return [['i-wave', { shape: 'square', duty: 0.2, sync: false, rate: 10, size: bright, base: 0 }], ['c-static', { color: c1 }]];
  if (n === 'fire') return [['i-wave', { shape: 'random', sync: false, rate: 8, size: bright, base: bright * 0.5, spread: 1 }], ['c-two', { color: [1, 0.15, 0], color2: [1, 0.55, 0], shape: 'random', sync: false, rate: 6, spread: 1 }]];
  if (n === 'vu meter') return [['i-audio', { band: 'bass', size: bright, base: 0.04 }], colour];
  if (n === 'moving head') return [['i-flat', { size: bright }], ['c-static', { color: c1 }], ['p-wave', { shape: 'sine', sync: true, division: 4, size: 0.6, tilt: 0.6, spread: 1 }]];
  if (RAINBOW.test(n) || colors.length > 3) return [['i-flat', { size: bright }], ['c-rainbow', { sync: true, division: 4, spread: 1 }]];
  if (CHASE.test(n)) return [['i-chase', { sync: true, division: 0.5, size: bright, base: 0.05 }], colour];
  if (FLICKER.test(n)) return [['i-wave', { shape: 'random', sync: true, division: 0.25, size: bright, base: 0.1, spread: 1 }], colour];
  return [['i-flat', { size: bright }], colour]; // Pictures, Text, Video, Faces, Shape…: lit in the palette colour
}

/** Tempo from a beat-like timing track (median gap), folded into 70..180 BPM. */
export function bpmFromTiming(seq) {
  const t = seq.timing.find((x) => /beat/i.test(x.name) && x.marks.length >= 8);
  if (!t) return null;
  const gaps = t.marks.slice(1).map((m, i) => m.start - t.marks[i].start).filter((g) => g > 0.05).sort((a, b) => a - b);
  if (gaps.length < 4) return null;
  let bpm = 60 / gaps[Math.floor(gaps.length / 2)];
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

/**
 * The sequence -> { name, bpm, tracks: [{ name, mute, groupId, cues }], audio,
 * markers: [{t, name}], skipped, cues }. typeFor(modelName) -> our type, or
 * '' to leave the model out. markers: a timing track name, or '' for none.
 */
export function convertSequence(seq, typeFor, { markers = '', name = 'Sequence' } = {}) {
  const out = { name, bpm: bpmFromTiming(seq), tracks: [], audio: seq.song ? [seq.song] : [], markers: [], skipped: 0, cues: 0 };
  const db = seq.effectDb.map(parseSettings);
  const pals = seq.palettes.map(parseSettings);
  for (const m of seq.models) {
    const type = typeFor(m.name);
    const groupId = type ? GROUP_OF_TYPE[type] : null;
    if (!groupId) { out.skipped += m.effects.length; continue; }
    const cues = [];
    for (const e of m.effects) {
      const dur = Math.max(0.05, e.end - e.start);
      const settings = { ...(e.ref >= 0 ? db[e.ref] : parseSettings(e.inline)), ...(pals[e.palette] || {}) };
      const layers = effectLayers(e.name, settings, type, dur);
      if (!layers) { out.skipped++; continue; }
      cues.push({ name: e.name || 'Effect', start: r3(e.start), duration: r3(dur), layers });
    }
    if (!cues.length) continue;
    cues.sort((a, b) => a.start - b.start);
    out.tracks.push({ name: m.name, mute: false, groupId, cues });
    out.cues += cues.length;
  }
  const mt = seq.timing.find((t) => t.name === markers);
  if (mt) out.markers = mt.marks.map((k, i) => ({ t: r3(k.start), name: k.label || `${i + 1}` }));
  return out;
}

/** The import dialog's view of a sequence (see ui/ImportRigDialog.js). */
export function xsqSource(seq, fileName) {
  const markerTracks = seq.timing.map((t) => ({ id: t.name, name: t.name, count: t.marks.length, labelled: t.marks.filter((k) => k.label).length }));
  const best = markerTracks.filter((t) => t.count <= MAX_MARKERS && t.labelled).sort((a, b) => b.labelled - a.labelled)[0];
  const effects = seq.models.reduce((a, m) => a + m.effects.length, 0);
  const name = fileName.replace(/\.xsq$/i, '');
  return {
    fileName,
    format: 'xLights',
    title: 'Import an xLights sequence',
    count: 0, // no rig in a sequence
    universes: 0,
    summary: `${seq.models.length} model${seq.models.length === 1 ? '' : 's'} with ${effects} effect${effects === 1 ? '' : 's'}${seq.timing.length ? `, ${seq.timing.length} timing track${seq.timing.length === 1 ? '' : 's'}` : ''}`,
    skipped: '',
    notes: [],
    allowSkip: true,
    countUnit: 'effect',
    showLabel: 'Sequence',
    about: "xLights keeps its models in the show folder, not the sequence, so effects land on your current rig: choose which of our fixtures each model plays on. Each effect becomes one of our looks at its exact time — an approximation of the pixels, with the timing kept.",
    kinds: seq.models.map((m) => ({ key: m.name, label: m.name, count: m.effects.length, guess: guessModel(m.name) })),
    plan: null,
    shows: [{ id: 'seq', name, items: effects, seconds: seq.seconds }],
    markerTracks,
    defaultMarkers: best ? best.id : '',
    buildShow: (_id, typeFor, opts = {}) => convertSequence(seq, typeFor, { ...opts, name }),
  };
}
