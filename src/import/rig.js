// What every rig importer (MVR, QLC+) shares once it has read its file:
// guessing which of OUR fixture types a foreign fixture should become,
// finishing the placement (centre, onto the floor, fit the room) and giving
// fixtures DMX addresses that suit our models' channel counts. Pure; no DOM,
// no Three.js; Node-testable.

/**
 * Guess one of our fixture types from a fixture's names.
 * text: maker + model + name (any case). opts.attrs: GDTF attribute names
 * when a fixture file was found (null = none). Returns { type, why }.
 */
export function guessType(text, { attrs = null } = {}) {
  const t = String(text || '').toLowerCase();
  const has = (a) => !!attrs && attrs.some((x) => x.toLowerCase() === a);
  if (/laser|kvant|ilda|beyond/.test(t)) return { type: 'laser', why: 'laser in the name' };
  if (/spark|sparkular|flame/.test(t)) return { type: 'cold-spark', why: 'spark in the name' };
  if (has('pan') && has('tilt')) return { type: 'moving-head', why: 'pan + tilt' };
  if (/batten|cyc\b|cyclorama/.test(t)) return { type: 'batten', why: 'batten in the name' };
  if (/pixel|tube|strip|sunstrip|\bbar\b|led ?bar/.test(t)) return { type: 'pixel-bar', why: 'bar in the name' };
  if (!attrs && /spot|beam|moving|mover|\bhead\b|sharpy|robin|\bmac\b|pointe|hybrid|wash|scan|yoke/.test(t)) return { type: 'moving-head', why: 'the name' };
  if (/podium|riser|stage ?deck/.test(t)) return { type: 'podium', why: 'podium in the name' };
  return { type: 'led-par', why: attrs ? 'no pan/tilt' : 'default' };
}

/** Which timeline group a fixture type plays in (show/ShowEngine GROUPS). */
export const GROUP_OF_TYPE = { 'moving-head': 'movers', 'led-par': 'pars', 'pixel-bar': 'bars', batten: 'bars', laser: 'lasers', 'cold-spark': 'sparks' };

const r4 = (v) => Math.round(v * 1e4) / 1e4 || 0;
const clampRoom = (v, min) => Math.max(min, Math.min(60, v));

/**
 * Finish a list of placed entries ({pos:[x,y,z]} in scene metres): centre
 * them left-right / front-back, lift anything below the floor, and size a
 * room around them. Mutates entries; returns the room.
 */
export function finishPlacement(entries, { center = true, fit = true, room = { width: 14, depth: 18, height: 6 } } = {}) {
  if (!entries.length) return { ...room };
  const lo = (a) => Math.min(...a), hi = (a) => Math.max(...a);
  const col = (i) => entries.map((e) => e.pos[i]);
  if (center) {
    const xs = col(0), zs = col(2);
    const cx = (lo(xs) + hi(xs)) / 2, cz = (lo(zs) + hi(zs)) / 2;
    for (const e of entries) { e.pos[0] = r4(e.pos[0] - cx); e.pos[2] = r4(e.pos[2] - cz); }
  }
  const minY = lo(col(1));
  if (minY < 0) for (const e of entries) e.pos[1] = r4(e.pos[1] - minY); // a stage below 0 sits on the floor
  if (!fit) return { ...room };
  const span = (a) => 2 * Math.max(Math.abs(lo(a)), Math.abs(hi(a)));
  return {
    width: clampRoom(Math.ceil(span(col(0)) + 4), 8),
    depth: clampRoom(Math.ceil(span(col(2)) + 6), 10),
    height: clampRoom(Math.ceil(hi(col(1)) + 1), 4),
  };
}

/**
 * Give every entry a universe/startAddress for OUR fixture models (which have
 * their own channel counts — usually not the source's). keep: use the file's
 * address where there is one; otherwise (and for fixtures the file never
 * patched) take the next free span, starting in the entry's universe and
 * moving on when it's full. taken: spans already in the rig
 * [{universe, startAddress, channelCount}]. chOf(type) -> channel count.
 * Mutates entries; returns how many entries overlap another one.
 */
export function assignAddresses(entries, chOf, { keep = true, taken = [] } = {}) {
  const spans = taken.map((t) => ({ u: t.universe, s: t.startAddress, e: t.startAddress + Math.max(1, t.channelCount) - 1 }));
  const fits = (u, s, n) => s + n - 1 <= 512 && !spans.some((x) => x.u === u && s <= x.e && x.s <= s + n - 1);
  let overlaps = 0;
  const free = [];
  for (const e of entries) {
    const n = chOf(e.type);
    if (n <= 0) { e.universe = e.universe || 1; e.startAddress = e.startAddress || 1; continue; } // props: no DMX
    if (keep && e.universe && e.startAddress) {
      if (!fits(e.universe, e.startAddress, n)) overlaps++;
      spans.push({ u: e.universe, s: e.startAddress, e: e.startAddress + n - 1 });
    } else free.push(e);
  }
  for (const e of free) {
    const n = chOf(e.type);
    let u = e.universe || 1, s = 1;
    for (;;) {
      while (s + n - 1 <= 512 && !fits(u, s, n)) s++;
      if (s + n - 1 <= 512) break;
      u++; s = 1;
    }
    e.universe = u; e.startAddress = s;
    spans.push({ u, s, e: s + n - 1 });
  }
  return overlaps;
}

/** Group fixtures into the dialog's rows: [{ key, label, count, guess }]. */
export function kindsOf(items, keyOf, labelOf, guessOf) {
  const kinds = new Map();
  for (const f of items) {
    const k = keyOf(f);
    const row = kinds.get(k) || { key: k, label: labelOf(f), count: 0, guess: guessOf(f) };
    row.count++;
    kinds.set(k, row);
  }
  return [...kinds.values()];
}
