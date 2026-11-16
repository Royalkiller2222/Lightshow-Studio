// MVR (My Virtual Rig) import: the open rig-exchange format written by
// grandMA3, Vectorworks Spotlight, Capture, Depence and others. An .mvr is a
// zip holding GeneralSceneDescription.xml (layers → fixtures with a 3D matrix,
// a GDTF fixture-type file and a DMX address) plus the .gdtf files.
//
// We take the rig only: where each fixture hangs and points, its patch and its
// name. Each fixture becomes one of our own fixture types (we don't simulate
// GDTF fixtures channel by channel); the type is guessed from the GDTF file
// (Pan + Tilt = a moving head) or the names, and the import dialog lets the
// user change any guess. Trusses and other scene objects are counted, not
// drawn.
//
// Coordinates: MVR is Z-up, millimetres, +Y towards the back of the stage.
// The scene is Y-up, metres, with the stage back at -Z. GDTF fixtures rest
// hanging, beam down — the same as our truss fixtures; the laser (aimed
// forward) and floor-standing types get a fixed correction. Pure: no DOM, no
// Three.js; Node-testable.

import { readZip } from './zip.js';
import { parseXml, child, children, descendants, childText } from './xml.js';
import { guessType as guessFromText, finishPlacement, assignAddresses, kindsOf } from './rig.js';

const MAX_FIXTURES = 2000;

/**
 * Read an .mvr file. Returns
 *   { fixtures: [{ name, fixtureId, spec, mode, universe, address, R:[9], o:[3], gdtf }],
 *     trusses, objects, layers, notes: [...] }
 * R is the world rotation (row-major 3×3, MVR axes) and o the position in mm.
 * gdtf: { name, manufacturer, attrs: [...], channels } or null.
 */
export async function readMvr(buffer) {
  const zip = readZip(buffer);
  const sceneName = zip.names.find((n) => /(^|\/)GeneralSceneDescription\.xml$/i.test(n));
  if (!sceneName) throw new Error("it has no GeneralSceneDescription.xml — is it an MVR file?");
  const doc = parseXml(await zip.text(sceneName));
  const scene = child(doc, 'Scene');
  if (!scene) throw new Error('the MVR file has no scene');
  const out = { fixtures: [], trusses: 0, objects: 0, layers: 0, notes: [] };
  const gdtfCache = new Map();

  const walk = (list, parent) => {
    for (const el of list?.children || []) {
      const tag = el.tag.slice(el.tag.indexOf(':') + 1);
      const M = combine(parent, parseMatrix(childText(el, 'Matrix')));
      if (tag === 'Fixture') {
        if (out.fixtures.length >= MAX_FIXTURES) continue;
        const addr = parseAddress(child(el, 'Addresses'));
        out.fixtures.push({
          name: el.attrs.name || '',
          fixtureId: childText(el, 'FixtureID') || childText(el, 'UnitNumber') || '',
          spec: childText(el, 'GDTFSpec'),
          mode: childText(el, 'GDTFMode'),
          universe: addr?.universe ?? null,
          address: addr?.address ?? null,
          R: M.R, o: M.o, gdtf: null,
        });
      } else if (tag === 'Truss') out.trusses++;
      else if (tag !== 'GroupObject') out.objects++;
      // groups (and anything else with children) nest more objects
      const sub = child(el, 'ChildList');
      if (sub) walk(sub, M);
    }
  };
  for (const layer of descendants(scene, 'Layer')) {
    out.layers++;
    walk(child(layer, 'ChildList'), parseMatrix(childText(layer, 'Matrix')));
  }
  if (out.fixtures.length >= MAX_FIXTURES) out.notes.push(`only the first ${MAX_FIXTURES} fixtures were read`);

  // fixture types: read each referenced .gdtf once
  for (const f of out.fixtures) {
    if (!f.spec) continue;
    const file = /\.gdtf$/i.test(f.spec) ? f.spec : `${f.spec}.gdtf`;
    if (!gdtfCache.has(file)) {
      let info = null;
      if (zip.has(file)) {
        try { info = await readGdtf(await zip.bytes(file)); } catch (e) { out.notes.push(`couldn't read ${file}: ${e.message}`); }
      }
      gdtfCache.set(file, info);
    }
    f.gdtf = gdtfCache.get(file);
  }
  return out;
}

/** A GDTF file's type name, maker and the attributes its DMX modes use. */
export async function readGdtf(bytes) {
  const z = readZip(bytes);
  const doc = parseXml(await z.text('description.xml'));
  const ft = child(doc, 'FixtureType');
  if (!ft) throw new Error('no FixtureType');
  const attrs = new Set();
  let channels = 0;
  for (const mode of descendants(ft, 'DMXMode')) {
    let n = 0;
    for (const ch of descendants(mode, 'DMXChannel')) {
      n += String(ch.attrs.Offset || '').split(',').filter((x) => /^\s*\d+\s*$/.test(x)).length;
      for (const lc of children(ch, 'LogicalChannel')) if (lc.attrs.Attribute) attrs.add(lc.attrs.Attribute);
    }
    channels = Math.max(channels, n);
  }
  return {
    name: ft.attrs.LongName || ft.attrs.Name || ft.attrs.ShortName || '',
    manufacturer: ft.attrs.Manufacturer || '',
    attrs: [...attrs],
    channels,
  };
}

// ------------------------------------------------------------ matrices
const IDENT = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], o: [0, 0, 0] };

/** "{u1,u2,u3}{v1,v2,v3}{w1,w2,w3}{o1,o2,o3}" — u/v/w are the local axes (columns). */
export function parseMatrix(s) {
  if (!s) return IDENT;
  const g = [...String(s).matchAll(/\{([^}]*)\}/g)].map((m) => m[1].split(',').map(Number));
  if (g.length < 4 || g.some((v) => v.length < 3 || v.some((x) => !Number.isFinite(x)))) return IDENT;
  const [u, v, w, o] = g;
  // normalise the axes (some exporters bake a scale in)
  const nz = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return a.map((x) => x / l); };
  const U = nz(u), V = nz(v), W = nz(w);
  return { R: [U[0], V[0], W[0], U[1], V[1], W[1], U[2], V[2], W[2]], o: o.slice(0, 3) };
}

const mul = (a, b) => {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
};
const apply = (R, p) => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];

function combine(P, L) {
  const q = apply(P.R, L.o);
  return { R: mul(P.R, L.R), o: [q[0] + P.o[0], q[1] + P.o[1], q[2] + P.o[2]] };
}

/** <Addresses><Address>1025</Address> (absolute) or "2.1" (universe.address). */
function parseAddress(el) {
  const a = el ? children(el, 'Address')[0] : null;
  const t = (a?.text || '').trim();
  if (!t) return null;
  const dot = /^(\d+)\.(\d+)$/.exec(t);
  if (dot) return { universe: Math.max(1, +dot[1]), address: clampAddr(+dot[2]) };
  const n = parseInt(t, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return { universe: Math.floor((n - 1) / 512) + 1, address: ((n - 1) % 512) + 1 };
}
const clampAddr = (a) => Math.min(512, Math.max(1, a || 1));

// --------------------------------------------------------- fixture types
/** Guess one of our fixture types for an MVR fixture. Returns { type, why }. */
export function guessType(f) {
  const g = f.gdtf;
  const text = [g?.manufacturer, g?.name, f.spec, f.name].filter(Boolean).join(' ');
  return guessFromText(text, { attrs: g ? g.attrs : null });
}

/** A stable key for "fixtures of the same kind" (the dialog's rows). */
export function kindKey(f) { return (f.spec || f.gdtf?.name || f.name.replace(/\s*\d+$/, '') || 'Fixture').toLowerCase(); }
export function kindLabel(f) {
  const g = f.gdtf;
  if (g?.name) return g.manufacturer && !g.name.toLowerCase().startsWith(g.manufacturer.toLowerCase()) ? `${g.manufacturer} ${g.name}` : g.name;
  if (f.spec) return f.spec.replace(/\.gdtf$/i, '').replace(/@/g, ' ');
  return f.name.replace(/\s*\d+$/, '') || 'Fixture';
}

// ---------------------------------------------------- MVR -> our scene
// C maps MVR axes to the scene's: (x, y, z) -> (x, z, -y)
const C = [1, 0, 0, 0, 0, 1, 0, -1, 0];
const CT = [1, 0, 0, 0, 0, -1, 0, 1, 0];
const RX90 = [1, 0, 0, 0, 0, -1, 0, 1, 0];
const RX180 = [1, 0, 0, 0, -1, 0, 0, 0, -1];
const FLOOR = new Set(['cold-spark', 'podium']);

/** Euler XYZ (Three.js's default order) from a row-major rotation. */
export function eulerXYZ(m) {
  const y = Math.asin(Math.max(-1, Math.min(1, m[2])));
  if (Math.abs(m[2]) < 0.9999999) return [Math.atan2(-m[5], m[8]), y, Math.atan2(-m[1], m[0])];
  return [Math.atan2(m[7], m[4]), y, 0];
}
const r4 = (v) => Math.round(v * 1e4) / 1e4 || 0;

/**
 * Turn one MVR fixture into our placement: { pos:[x,y,z] m, rot:[x,y,z] rad, note? }.
 * Hanging types copy the orientation; the laser's forward axis is the GDTF
 * beam axis; floor types stand up. Pointing a laser or a spark machine
 * straight down is almost always an un-rotated plot symbol, so those keep our
 * default upright / facing-the-audience pose.
 */
export function placeFixture(f, type) {
  const pos = [f.o[0] / 1000, f.o[2] / 1000, -f.o[1] / 1000].map(r4);
  const Rs = mul(mul(C, f.R), CT); // the rotation in scene axes
  let R = Rs, note = null;
  if (type === 'laser') {
    R = mul(Rs, RX90);
    if (apply(R, [0, 0, 1])[1] < -0.95) { R = IDENT.R; note = 'laser aimed at the audience (the plot points it at the floor)'; }
  } else if (FLOOR.has(type)) {
    R = mul(Rs, RX180);
    if (apply(R, [0, 1, 0])[1] < 0) R = IDENT.R; // upside down -> stand it up
  }
  return { pos, rot: eulerXYZ(R).map(r4), note };
}

/**
 * Plan the import: our fixture entries (rig.restore shape) and the room.
 * opts: { typeFor(kindKey) -> type, center (bool), fit (bool),
 * room: {width, depth, height} (the current one) }.
 */
export function planRig(mvr, { typeFor = null, center = true, fit = true, room = { width: 14, depth: 18, height: 6 } } = {}) {
  let aimed = 0;
  const entries = mvr.fixtures.map((f) => {
    const type = (typeFor && typeFor(kindKey(f))) || guessType(f).type;
    const { pos, rot, note } = placeFixture(f, type);
    if (note) aimed++;
    const label = f.name || `${kindLabel(f)}${f.fixtureId ? ` ${f.fixtureId}` : ''}`;
    return { type, label, pos, rot, universe: f.universe, startAddress: f.address };
  });
  return { entries, room: finishPlacement(entries, { center, fit, room }), aimed };
}

/** The import dialog's view of an MVR file (see ui/ImportRigDialog.js). */
export function mvrSource(mvr, fileName) {
  const skipped = [mvr.trusses && `${mvr.trusses} truss${mvr.trusses === 1 ? '' : 'es'}`, mvr.objects && `${mvr.objects} other object${mvr.objects === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
  return {
    fileName,
    format: 'MVR',
    count: mvr.fixtures.length,
    universes: new Set(mvr.fixtures.map((f) => f.universe).filter(Boolean)).size,
    skipped: skipped ? `${skipped} ${mvr.trusses + mvr.objects === 1 ? "isn't" : "aren't"} imported (we only take fixtures)` : '',
    notes: mvr.notes,
    kinds: kindsOf(mvr.fixtures, kindKey, kindLabel, guessType),
    plan: (opts) => planRig(mvr, opts),
    shows: [],
  };
}

export { assignAddresses };
