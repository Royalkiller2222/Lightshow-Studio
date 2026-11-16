// QLC+ workspace import (.qxw): the rig (fixtures + patch, and positions from
// QLC+'s 2D Monitor when it has them) and its timed Shows, turned into our
// timeline tracks and cues.
//
// A workspace doesn't carry its fixture definitions (.qxf), so we only know
// what a channel *means* for generic RGB / RGBW / dimmer fixtures. Everything
// else is approximated: each QLC+ function becomes a look of our own effects
// with the same timing — a Scene becomes a level + a colour (from its RGB
// values when known, else from its name: "Red wash" -> red), a Chaser or
// Sequence a chase at its real step time, an EFX a movement at its real
// speed, an RGB Matrix a colour chase. Cues land per fixture group (movers,
// PARs, bars…), because that's what our cues target. Pure; Node-testable.

import { parseXml, child, children, descendants, childText } from './xml.js';
import { guessType as guessFromText, finishPlacement, assignAddresses, kindsOf, GROUP_OF_TYPE } from './rig.js';

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const MAX_DEPTH = 8; // functions nest (collections of chasers of scenes); guard loops

/** Parse a .qxw. Throws when it isn't a QLC+ workspace. */
export function readQlc(text) {
  const doc = parseXml(text);
  if (doc.tag.replace(/^.*:/, '') !== 'Workspace') throw new Error("it isn't a QLC+ workspace");
  const engine = child(doc, 'Engine');
  if (!engine) throw new Error('the workspace has no Engine section');
  const creator = child(doc, 'Creator');
  const ws = {
    creator: { name: childText(creator, 'Name'), version: childText(creator, 'Version') },
    fixtures: [],
    functions: new Map(),
    groups: new Map(),
    monitor: null,
    notes: [],
  };
  for (const f of children(engine, 'Fixture')) {
    const ch = Math.max(1, num(childText(f, 'Channels'), 1));
    ws.fixtures.push({
      id: childText(f, 'ID'),
      name: childText(f, 'Name'),
      manufacturer: childText(f, 'Manufacturer'),
      model: childText(f, 'Model'),
      mode: childText(f, 'Mode'),
      universe: num(childText(f, 'Universe'), 0) + 1, // QLC+ counts from 0
      address: Math.min(512, num(childText(f, 'Address'), 0) + 1),
      channels: ch,
    });
  }
  for (const g of children(engine, 'FixtureGroup')) {
    ws.groups.set(g.attrs.ID, [...new Set(children(g, 'Head').map((h) => h.attrs.Fixture).filter((x) => x != null))]);
  }
  for (const fn of children(engine, 'Function')) ws.functions.set(fn.attrs.ID, fn);

  // 2D Monitor positions (mm), when the user laid the rig out in QLC+
  const mon = descendants(doc, 'Monitor')[0];
  if (mon) {
    const items = new Map();
    for (const it of descendants(mon, 'FxItem')) items.set(it.attrs.ID, { x: num(it.attrs.XPos), y: num(it.attrs.YPos) });
    const grid = child(mon, 'Grid');
    // Positions are read as a top view (x across, y = depth), our truss
    // fixtures at truss height and floor fixtures on the floor.
    const unit = grid?.attrs.Units === '1' ? 0.3048 : 1; // grid size in feet or metres
    if (items.size) {
      ws.monitor = { items, width: num(grid?.attrs.Width, 5) * unit, depth: num(grid?.attrs.Depth, 5) * unit };
    }
  }
  ws.shows = [...ws.functions.values()].filter((f) => f.attrs.Type === 'Show').map((f) => {
    const items = children(f, 'Track').flatMap((t) => children(t, 'ShowFunction'));
    const end = Math.max(0, ...items.map((s) => num(s.attrs.StartTime) + num(s.attrs.Duration)));
    return { id: f.attrs.ID, name: f.attrs.Name || 'Show', tracks: children(f, 'Track').length, items: items.length, seconds: end / 1000 };
  });
  return ws;
}

// ------------------------------------------------------------- the rig
const kindKey = (f) => `${f.manufacturer} ${f.model}`.trim().toLowerCase() || 'fixture';
function kindLabel(f) {
  const m = f.model || 'Fixture';
  if (/^generic$/i.test(m)) return `Generic ${f.mode || 'fixture'}`.trim(); // "Generic Dimmer"
  return f.manufacturer && !m.toLowerCase().startsWith(f.manufacturer.toLowerCase()) ? `${f.manufacturer} ${m}` : m;
}
const guessType = (f) => {
  const g = guessFromText(`${f.manufacturer} ${f.model} ${f.name}`);
  // "Generic Dimmer" / "Generic RGB": PARs, said plainly
  return g.why === 'default' && /generic/i.test(f.manufacturer) ? { type: 'led-par', why: 'a generic dimmer / RGB' } : g;
};

// Rows by type when the workspace has no positions (metres; scene axes)
const ROW = {
  'moving-head': { y: 5.4, z: -3 }, 'led-par': { y: 5.4, z: -1 }, 'pixel-bar': { y: 5.4, z: -5 }, batten: { y: 5.4, z: -5.6 },
  laser: { y: 5.2, z: -7.5 }, 'cold-spark': { y: 0, z: -6.5 }, podium: { y: 0, z: -4 },
};

/** Our entries + room for the rig. opts like mvr.planRig. */
export function planRig(ws, { typeFor = null, center = true, fit = true, room = { width: 14, depth: 18, height: 6 } } = {}) {
  const m = ws.monitor;
  const perRow = {};
  const entries = ws.fixtures.map((f) => {
    const type = (typeFor && typeFor(kindKey(f))) || guessType(f).type;
    const row = ROW[type] || ROW['led-par'];
    let pos;
    const it = m?.items.get(f.id);
    if (it) {
      // QLC+ stores item positions in mm from the grid's top-left (upstage-left)
      pos = [it.x * 0.001 - m.width / 2, row.y, it.y * 0.001 - m.depth / 2];
    } else {
      const i = (perRow[type] = (perRow[type] ?? 0) + 1) - 1;
      pos = [i * 1.4, row.y, row.z];
    }
    return { type, label: f.name || `${kindLabel(f)}`, pos, rot: [0, 0, 0], universe: f.universe, startAddress: f.address, qlcId: f.id };
  });
  // row layouts start at x = 0; centre each row on its own
  if (!m) {
    const byRow = {};
    for (const e of entries) (byRow[e.type] ||= []).push(e);
    for (const list of Object.values(byRow)) {
      const half = ((list.length - 1) * 1.4) / 2;
      for (const e of list) e.pos[0] -= half;
    }
  }
  return { entries, room: finishPlacement(entries, { center: center && !!m, fit, room }), aimed: 0 };
}

// ---------------------------------------------------- functions -> looks
const NAME_COLORS = [
  [/\bred\b/, [1, 0, 0]], [/\bgreen\b/, [0, 1, 0.1]], [/\b(cyan|teal|aqua|turquoise)\b/, [0, 1, 1]], [/\bblue\b/, [0, 0.2, 1]],
  [/\b(magenta|pink|fuchsia)\b/, [1, 0, 0.8]], [/\b(purple|violet|uv|lavender)\b/, [0.6, 0, 1]], [/\byellow\b/, [1, 0.9, 0]],
  [/\b(amber|orange)\b/, [1, 0.55, 0.1]], [/\bwarm\b/, [1, 0.75, 0.45]], [/\b(cold|cool)\b/, [0.75, 0.9, 1]], [/\bwhite\b/, [1, 1, 1]],
];
const BLACKOUT = /\b(blackout|black|off|bo|dark)\b/;
const nameColor = (s) => NAME_COLORS.find(([re]) => re.test(String(s).toLowerCase()))?.[1] || null;

/** Channel meanings we can trust without the fixture definition. */
function layoutOf(f) {
  const t = `${f.model} ${f.mode}`.toLowerCase();
  const dimFirst = /\bd ?rgb|dimmer ?\+? ?rgb|\bdim ?rgb/.test(t);
  if (/rgb/.test(t) && f.channels >= 3) {
    const o = dimFirst ? 1 : 0;
    return { dim: dimFirst ? 0 : null, r: o, g: o + 1, b: o + 2, w: /rgbw/.test(t) && f.channels >= o + 4 ? o + 3 : null };
  }
  if (/dimmer/.test(t) && f.channels === 1) return { dim: 0 };
  return null;
}

/** A fixture's level (0..1) and colour from its channel values, or null if unknown. */
function readValues(f, vals) {
  const L = layoutOf(f);
  if (!L) return null;
  const v = (i) => (i == null ? null : (vals.get(i) ?? 0) / 255);
  const dim = v(L.dim);
  if (L.r == null) return { level: dim ?? 0, color: null };
  const w = v(L.w) ?? 0;
  const rgb = [v(L.r) + w, v(L.g) + w, v(L.b) + w].map((x) => Math.min(1, x));
  const peak = Math.max(...rgb);
  const level = (dim ?? 1) * peak;
  return { level, color: peak > 0 ? rgb.map((x) => x / peak) : null };
}

const slotOf = (key) => (key.startsWith('c-') ? 'color' : key.startsWith('p-') ? 'position' : 'intensity');
const avgColor = (list) => {
  if (!list.length) return null;
  const s = [0, 0, 0];
  for (const c of list) for (let i = 0; i < 3; i++) s[i] += c[i];
  const peak = Math.max(...s) || 1;
  return s.map((x) => Math.round((x / peak) * 1000) / 1000);
};
const sameColor = (a, b) => a && b && a.every((x, i) => Math.abs(x - b[i]) < 0.08);
const hz = (ms) => Math.round((1000 / Math.max(20, ms)) * 1000) / 1000;
const argb = (n) => { const v = num(n, -1); return v < 0 ? null : [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => Math.round((x / 255) * 1000) / 1000); };

/**
 * Turn a show of `ws` into tracks of cues. groupOf(fixtureId) -> our group
 * id (movers, pars…) or null. Returns { name, bpm, tracks: [{ name, mute,
 * groupId, cues: [{ name, start, duration, layers: [[effectKey, params]…] }] }],
 * audio: [file names], skipped: count, cues: count }.
 */
export function convertShow(ws, showId, groupOf) {
  const show = ws.functions.get(String(showId));
  if (!show || show.attrs.Type !== 'Show') throw new Error('that show is missing from the workspace');
  const fxById = new Map(ws.fixtures.map((f) => [f.id, f]));
  const td = child(show, 'TimeDivision');
  const bpm = /bpm/i.test(td?.attrs.Type || '') ? num(td.attrs.BPM, 0) || null : null;
  const out = { name: show.attrs.Name || 'Show', bpm, tracks: [], audio: [], skipped: 0, cues: 0 };
  const cache = new Map();

  // A fixture-level "state" (who's lit, how bright, which colour) for scenes
  const sceneState = (fn) => {
    const vals = new Map(); // fixtureId -> Map(channel -> value)
    for (const fv of children(fn, 'FixtureVal')) {
      const m = new Map();
      const nums = (fv.text || '').split(',').map((x) => x.trim()).filter(Boolean).map(Number);
      for (let i = 0; i + 1 < nums.length; i += 2) m.set(nums[i], nums[i + 1]);
      vals.set(fv.attrs.ID, m);
    }
    for (const v of children(fn, 'Value')) { // QLC 3 / early QLC+
      const id = v.attrs.Fixture;
      if (!vals.has(id)) vals.set(id, new Map());
      vals.get(id).set(num(v.attrs.Channel), num(v.text));
    }
    return statesFrom(vals, fn.attrs.Name || '');
  };
  // vals: fixtureId -> Map(ch -> value). Returns Map(group -> { level, color, lit:Set, total:Set })
  const statesFrom = (vals, name) => {
    const byGroup = new Map();
    const fromName = nameColor(name);
    const dark = BLACKOUT.test(name.toLowerCase());
    for (const [id, m] of vals) {
      const f = fxById.get(id);
      const g = f && groupOf(id);
      if (!g) continue;
      const st = byGroup.get(g) || { level: 0, colors: [], lit: new Set(), total: new Set() };
      st.total.add(id);
      const known = readValues(f, m);
      const level = known ? known.level : dark ? 0 : [...m.values()].some((x) => x > 0) ? 1 : 0;
      if (level > 0.02) {
        st.lit.add(id);
        st.level = Math.max(st.level, level);
        const c = known?.color || fromName;
        if (c) st.colors.push(c);
      }
      byGroup.set(g, st);
    }
    for (const st of byGroup.values()) st.color = avgColor(st.colors) || fromName || [1, 1, 1];
    return byGroup;
  };
  const staticLook = (st, group) => {
    if (group === 'sparks') return st.level > 0 ? [['sparks', { size: 0.8 }]] : [];
    if (st.level <= 0.02) return [];
    return [['i-flat', { size: Math.round(st.level * 100) / 100 }], ['c-static', { color: st.color }]];
  };

  // A function -> Map(group -> layers[]); also states for scenes (chasers read them)
  const look = (id, depth = 0) => {
    if (cache.has(id)) return cache.get(id);
    const fn = ws.functions.get(String(id));
    let res = { looks: new Map(), states: null, kind: fn?.attrs.Type || 'missing', audio: null };
    cache.set(id, res); // (a loop resolves to "empty")
    if (!fn || depth > MAX_DEPTH) return res;
    const type = fn.attrs.Type;
    const speed = child(fn, 'Speed');
    if (type === 'Scene') {
      res.states = sceneState(fn);
      for (const [g, st] of res.states) { const l = staticLook(st, g); if (l.length) res.looks.set(g, l); }
    } else if (type === 'Chaser' || type === 'Sequence') {
      const modes = child(fn, 'SpeedModes');
      const common = /common/i.test(modes?.attrs.Duration || '');
      const steps = children(fn, 'Step');
      let stepStates;
      if (type === 'Sequence') {
        stepStates = steps.map((s) => {
          const vals = new Map();
          const tok = (s.text || '').split(':');
          for (let i = 0; i + 1 < tok.length; i += 2) {
            const m = new Map();
            const nums = tok[i + 1].split(',').map(Number);
            for (let k = 0; k + 1 < nums.length; k += 2) m.set(nums[k], nums[k + 1]);
            vals.set(tok[i].trim(), m);
          }
          return statesFrom(vals, s.attrs.Note || fn.attrs.Name || '');
        });
      } else {
        stepStates = steps.map((s) => look((s.text || '').trim(), depth + 1).states).filter(Boolean);
      }
      const times = steps.map((s) => num(s.attrs.FadeIn) + num(s.attrs.Hold));
      const stepMs = common || !times.some((t) => t > 0) ? num(speed?.attrs.Duration, 0) || 1000 : times.reduce((a, b) => a + b, 0) / times.length || 1000;
      const groups = new Set(stepStates.flatMap((m) => [...m.keys()]));
      for (const g of groups) {
        const per = stepStates.map((m) => m.get(g)).filter(Boolean);
        const lit = per.filter((st) => st.level > 0.02);
        if (!lit.length) continue;
        if (g === 'sparks') { res.looks.set(g, [['sparks', { size: 0.8 }]]); continue; }
        const all = new Set(per.flatMap((st) => [...st.total]));
        const subset = lit.some((st) => st.lit.size < all.size);
        const colors = [];
        for (const st of lit) if (!colors.some((c) => sameColor(c, st.color))) colors.push(st.color);
        const level = Math.round(Math.max(...lit.map((st) => st.level)) * 100) / 100;
        const layers = [subset
          ? ['i-chase', { sync: false, rate: hz(stepMs), size: level, base: 0.03 }]
          : ['i-flat', { size: level }]];
        layers.push(colors.length > 1
          ? ['c-two', { color: colors[0], color2: colors[1], shape: 'square', sync: false, rate: hz(stepMs * 2), spread: 0 }]
          : ['c-static', { color: colors[0] }]);
        res.looks.set(g, layers);
      }
    } else if (type === 'EFX') {
      const alg = childText(fn, 'Algorithm').toLowerCase();
      const width = num(childText(fn, 'Width'), 127);
      const params = {
        sync: false,
        rate: hz(num(speed?.attrs.Duration, 0) || 4000),
        size: Math.max(0.1, Math.min(1, (width / 127) * 0.6)),
        dir: /backward/i.test(childText(fn, 'Direction')) ? -1 : 1,
        spread: /parallel/i.test(childText(fn, 'Propagation')) ? 0 : 1,
      };
      const layer = /circle|eight/.test(alg) ? ['p-circle', params] : ['p-wave', { ...params, shape: 'sine', tilt: 0.6 }];
      for (const fx of children(fn, 'Fixture')) {
        const g = groupOf(childText(fx, 'ID'));
        if (g && g !== 'sparks') res.looks.set(g, [layer]);
      }
    } else if (type === 'RGBMatrix') {
      const ids = ws.groups.get(childText(fn, 'FixtureGroup')) || [];
      const alg = childText(fn, 'Algorithm').toLowerCase();
      const stepMs = num(speed?.attrs.Duration, 0) || 500;
      const cs = [argb(childText(fn, 'MonoColor')), argb(childText(fn, 'EndColor')),
        ...children(fn, 'Color').map((c) => argb(c.text))].filter((c) => c && Math.max(...c) > 0);
      const color = /rainbow|plasma|fire|random|gradient/.test(alg) || !cs.length
        ? ['c-rainbow', { sync: false, rate: hz(stepMs * 8), spread: 1 }]
        : cs.length > 1 && !sameColor(cs[0], cs[1])
          ? ['c-two', { color: cs[0], color2: cs[1], sync: false, rate: hz(stepMs * 2), spread: 1 }]
          : ['c-static', { color: cs[0] }];
      const inten = /stripe|chase|snake|marquee|bounce|wave|random|single|strobe|lines|balls/.test(alg)
        ? ['i-chase', { sync: false, rate: hz(stepMs), size: 1, base: 0.05 }]
        : ['i-flat', { size: 1 }];
      for (const id of ids) {
        const g = groupOf(id);
        if (g && g !== 'sparks') res.looks.set(g, [inten, color]);
      }
    } else if (type === 'Collection') {
      for (const s of children(fn, 'Step')) {
        const sub = look((s.text || '').trim(), depth + 1);
        for (const [g, layers] of sub.looks) {
          const merged = new Map((res.looks.get(g) || []).map((l) => [slotOf(l[0]), l]));
          for (const l of layers) merged.set(slotOf(l[0]), l);
          res.looks.set(g, [...merged.values()]);
        }
        if (sub.audio) res.audio = sub.audio;
      }
    } else if (type === 'Audio') {
      res.audio = (childText(fn, 'Source') || fn.attrs.Name || '').split(/[\\/]/).pop();
    }
    return res;
  };

  const GROUP_LABEL = { movers: 'Movers', pars: 'PARs', bars: 'Bars', lasers: 'Lasers', sparks: 'Sparks' };
  for (const t of children(show, 'Track')) {
    const byGroup = new Map();
    for (const sf of children(t, 'ShowFunction')) {
      const id = sf.attrs.ID;
      const fn = ws.functions.get(String(id));
      const r = look(id);
      if (r.audio || fn?.attrs.Type === 'Audio') { if (r.audio && !out.audio.includes(r.audio)) out.audio.push(r.audio); if (fn?.attrs.Type === 'Audio') continue; }
      if (!r.looks.size) { out.skipped++; continue; }
      const start = num(sf.attrs.StartTime) / 1000;
      const duration = Math.max(0.1, num(sf.attrs.Duration) / 1000 || 4);
      for (const [g, layers] of r.looks) {
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push({ name: fn?.attrs.Name || 'Cue', start, duration, layers: layers.map(([k, p]) => [k, { ...p }]) });
      }
    }
    const name = t.attrs.Name || 'Track';
    for (const [g, cues] of byGroup) {
      out.tracks.push({ name: byGroup.size > 1 ? `${name} · ${GROUP_LABEL[g] || g}` : name, mute: t.attrs.isMute === '1', groupId: g, cues });
      out.cues += cues.length;
    }
  }
  return out;
}

/** The import dialog's view of a QLC+ workspace (see ui/ImportRigDialog.js). */
export function qlcSource(ws, fileName) {
  return {
    fileName,
    format: 'QLC+',
    count: ws.fixtures.length,
    universes: new Set(ws.fixtures.map((f) => f.universe)).size,
    skipped: '',
    notes: [...ws.notes, ...(ws.monitor ? [] : ['the workspace has no 2D Monitor layout, so fixtures are set out in rows by type'])],
    hasPositions: !!ws.monitor,
    kinds: kindsOf(ws.fixtures, kindKey, kindLabel, guessType),
    plan: (opts) => planRig(ws, opts),
    shows: ws.shows,
    /** typeFor(kindKey) -> our type; returns convertShow's result. */
    buildShow: (showId, typeFor) => {
      const typeOf = new Map(ws.fixtures.map((f) => [f.id, typeFor(kindKey(f)) || guessType(f).type]));
      return convertShow(ws, showId, (id) => GROUP_OF_TYPE[typeOf.get(String(id))] || null);
    },
  };
}

export { assignAddresses, kindKey, guessType };
