// ILDA (.ild) import — the open laser-frame format every laser program
// (Pangolin BEYOND / QuickShow, LaserOS, LFI…) can export. A file is a run of
// sections, each with a 32-byte "ILDA" header followed by records:
//   format 0  3D points, indexed colour   (x y z: int16, status, colour index)
//   format 1  2D points, indexed colour   (x y, status, colour index)
//   format 2  colour palette              (r g b) — used by later indexed frames
//   format 4  3D points, true colour      (x y z, status, b g r)
//   format 5  2D points, true colour      (x y, status, b g r)
// Big-endian. Status bit 0x40 = blanked (beam off moving to this point),
// 0x80 = last point. A header with 0 records ends the file.
//
// An imported file becomes an animated, coloured pattern (see patterns.js).
// It is saved inside the show file (compact base64) so a show stays one
// self-contained file. Pure data, no DOM, no Three.js — Node-testable.

import { newImportKey } from './patterns.js';

export const MAX_FRAMES = 600;
export const MAX_POINTS = 4000;   // per frame; the renderer draws ≤ 2048 segments
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_FPS = 30;

/** The ILDA standard default 64-colour palette. */
const DEFAULT_PALETTE = [
  [255, 0, 0], [255, 16, 0], [255, 32, 0], [255, 48, 0], [255, 64, 0], [255, 80, 0], [255, 96, 0], [255, 112, 0],
  [255, 128, 0], [255, 144, 0], [255, 160, 0], [255, 176, 0], [255, 192, 0], [255, 208, 0], [255, 224, 0], [255, 240, 0],
  [255, 255, 0], [224, 255, 0], [192, 255, 0], [160, 255, 0], [128, 255, 0], [96, 255, 0], [64, 255, 0], [32, 255, 0],
  [0, 255, 0], [0, 255, 36], [0, 255, 73], [0, 255, 109], [0, 255, 146], [0, 255, 182], [0, 255, 219], [0, 255, 255],
  [0, 227, 255], [0, 198, 255], [0, 170, 255], [0, 142, 255], [0, 113, 255], [0, 85, 255], [0, 56, 255], [0, 28, 255],
  [0, 0, 255], [32, 0, 255], [64, 0, 255], [96, 0, 255], [128, 0, 255], [160, 0, 255], [192, 0, 255], [224, 0, 255],
  [255, 0, 255], [255, 32, 255], [255, 64, 255], [255, 96, 255], [255, 128, 255], [255, 160, 255], [255, 192, 255], [255, 224, 255],
  [255, 255, 255], [255, 224, 224], [255, 192, 192], [255, 160, 160], [255, 128, 128], [255, 96, 96], [255, 64, 64], [255, 32, 32],
];

const REC = { 0: 8, 1: 6, 2: 3, 4: 10, 5: 8 };

/**
 * Parse an .ild file. Returns { name, frames, notes } where each frame is
 * { x: Int16Array, y: Int16Array, rgb: Uint8Array (n*3), blank: Uint8Array }.
 * Throws if the data isn't ILDA or holds no drawable frames.
 */
export function parseIlda(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const notes = [];
  const frames = [];
  let palette = DEFAULT_PALETTE;
  let name = '';
  let off = 0;
  let truncatedPts = false;
  const ascii = (o, n) => String.fromCharCode(...bytes.subarray(o, o + n)).replace(/\0.*$/s, '').trim();

  while (off + 32 <= bytes.length) {
    if (ascii(off, 4) !== 'ILDA') {
      if (!frames.length && off === 0) throw new Error("this isn't an ILDA (.ild) file");
      notes.push('the file ends with data that isn\'t ILDA; the rest was skipped');
      break;
    }
    const format = bytes[off + 7];
    const count = dv.getUint16(off + 24);
    if (!name && format !== 2) name = ascii(off + 8, 8);
    off += 32;
    if (count === 0) break; // end-of-file header
    const size = REC[format];
    if (!size) { notes.push(`skipped an unknown section (format ${format})`); break; }
    if (off + count * size > bytes.length) { notes.push('the file is cut short; the last frame was skipped'); break; }

    if (format === 2) {
      palette = [];
      for (let i = 0; i < count; i++) palette.push([bytes[off + i * 3], bytes[off + i * 3 + 1], bytes[off + i * 3 + 2]]);
      off += count * size;
      continue;
    }
    if (frames.length >= MAX_FRAMES) { off += count * size; continue; }

    const n = Math.min(count, MAX_POINTS);
    if (count > MAX_POINTS) truncatedPts = true;
    const f = { x: new Int16Array(n), y: new Int16Array(n), rgb: new Uint8Array(n * 3), blank: new Uint8Array(n) };
    const is3D = format === 0 || format === 4;
    for (let i = 0; i < n; i++) {
      const o = off + i * size;
      f.x[i] = dv.getInt16(o);
      f.y[i] = dv.getInt16(o + 2);
      const s = o + (is3D ? 6 : 4); // status byte
      const status = bytes[s];
      let r, g, b;
      if (format === 4 || format === 5) { b = bytes[s + 1]; g = bytes[s + 2]; r = bytes[s + 3]; }
      else [r, g, b] = palette[bytes[s + 1]] || [255, 255, 255];
      // many exporters blank with black instead of the status bit
      f.blank[i] = (status & 0x40) || r + g + b < 6 ? 1 : 0;
      f.rgb[i * 3] = r; f.rgb[i * 3 + 1] = g; f.rgb[i * 3 + 2] = b;
    }
    frames.push(f);
    off += count * size;
  }

  if (frames.length >= MAX_FRAMES) notes.push(`only the first ${MAX_FRAMES} frames were kept`);
  if (truncatedPts) notes.push(`frames over ${MAX_POINTS} points were cut short`);
  if (!frames.length) throw new Error('the file has no laser frames');
  return { name, frames, notes };
}

/**
 * One frame's points -> strokes of [x, y, r, g, b] (galvo space, colours 0..1).
 * A segment into a lit point is drawn in that point's colour; blanked points
 * break the stroke. A lone lit point becomes a dot.
 */
export function frameStrokes(f) {
  const strokes = [];
  let stroke = null;
  let px = 0, py = 0, have = false;
  const close = () => {
    if (stroke) {
      if (stroke.length === 1) { const p = stroke[0]; stroke.push([p[0] + 0.006, p[1], p[2], p[3], p[4]]); }
      strokes.push(stroke);
    }
    stroke = null;
  };
  for (let i = 0; i < f.x.length; i++) {
    const x = f.x[i] / 32768, y = f.y[i] / 32768;
    if (f.blank[i]) { close(); px = x; py = y; have = true; continue; }
    const r = f.rgb[i * 3] / 255, g = f.rgb[i * 3 + 1] / 255, b = f.rgb[i * 3 + 2] / 255;
    if (!stroke) stroke = have ? [[px, py, r, g, b]] : [];
    const last = stroke[stroke.length - 1];
    if (!last || Math.abs(last[0] - x) > 1e-4 || Math.abs(last[1] - y) > 1e-4) stroke.push([x, y, r, g, b]);
    else { last[2] = r; last[3] = g; last[4] = b; }
    px = x; py = y; have = true;
  }
  close();
  return strokes;
}

// ------------------------------------------------------------ save format
// [u16 frames] then per frame [u16 n] + n × (i16 x, i16 y, u8 r, u8 g, u8 b, u8 blank),
// little-endian, base64.

export function encodeFrames(frames) {
  let size = 2;
  for (const f of frames) size += 2 + f.x.length * 8;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint16(o, frames.length, true); o += 2;
  for (const f of frames) {
    const n = f.x.length;
    dv.setUint16(o, n, true); o += 2;
    for (let i = 0; i < n; i++) {
      dv.setInt16(o, f.x[i], true); dv.setInt16(o + 2, f.y[i], true);
      out[o + 4] = f.rgb[i * 3]; out[o + 5] = f.rgb[i * 3 + 1]; out[o + 6] = f.rgb[i * 3 + 2]; out[o + 7] = f.blank[i];
      o += 8;
    }
  }
  let bin = '';
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function decodeFrames(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dv = new DataView(bytes.buffer);
  let o = 0;
  const nf = Math.min(dv.getUint16(o, true), MAX_FRAMES); o += 2;
  const frames = [];
  for (let k = 0; k < nf && o + 2 <= bytes.length; k++) {
    const n = dv.getUint16(o, true); o += 2;
    if (o + n * 8 > bytes.length) break;
    const f = { x: new Int16Array(n), y: new Int16Array(n), rgb: new Uint8Array(n * 3), blank: new Uint8Array(n) };
    for (let i = 0; i < n; i++) {
      f.x[i] = dv.getInt16(o, true); f.y[i] = dv.getInt16(o + 2, true);
      f.rgb[i * 3] = bytes[o + 4]; f.rgb[i * 3 + 1] = bytes[o + 5]; f.rgb[i * 3 + 2] = bytes[o + 6]; f.blank[i] = bytes[o + 7];
      o += 8;
    }
    frames.push(f);
  }
  return frames;
}

// Decoding is the slow part; undo/redo re-applies the same data string, so
// remember the strokes per string.
const _decoded = new Map();

/** A saved / freshly parsed import -> a pattern object for the registry. */
export function makeImportedPattern({ key, name, fps, data }) {
  let frames = _decoded.get(data);
  if (!frames) {
    frames = decodeFrames(data).map(frameStrokes);
    if (_decoded.size > 32) _decoded.clear();
    _decoded.set(data, frames);
  }
  return {
    key, label: String(name || 'Imported').slice(0, 40), group: 'imported', colored: true,
    fps: clampFps(fps), data, frames,
  };
}

export function clampFps(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(1, Math.min(120, Math.round(n))) : DEFAULT_FPS; }

/** Parse a file and build its pattern. Returns { pattern, notes }. */
export function importIlda(buf, fileName) {
  const parsed = parseIlda(buf);
  const name = String(fileName || '').replace(/\.ild[a]?$/i, '') || parsed.name || 'Imported';
  const pattern = makeImportedPattern({ key: newImportKey(name), name, fps: DEFAULT_FPS, data: encodeFrames(parsed.frames) });
  return { pattern, notes: parsed.notes };
}

/** Saved-file shape for one imported pattern. */
export function serializeImported(p) { return { key: p.key, name: p.label, fps: p.fps, data: p.data }; }

/** Saved list -> patterns (bad entries dropped). */
export function loadImported(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e.key !== 'string' || typeof e.data !== 'string') continue;
    try { out.push(makeImportedPattern(e)); } catch { /* skip a corrupt entry */ }
  }
  return out;
}
