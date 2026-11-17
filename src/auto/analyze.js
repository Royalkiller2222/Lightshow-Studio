// Whole-song analysis for the pregenerated Auto show. Live Auto only ever
// hears "now"; with the decoded song we can look at all of it at once and
// find its shape the way a lighting designer listens to it:
//
//   - how loud each bar is, and *what* is loud: sub/bass, mids, highs, air;
//     how bright or dark it sounds (spectral centroid), how noisy (risers,
//     white-noise sweeps) and how fast the snares / hats hit (a snare roll
//     speeding up from 1/4 to 1/16 notes is the sound of a build)
//   - tension per bar (fast hits + noise + highs + missing bass)
//   - drops: the exact downbeat where the bass slams back in, and from them
//     which beat of the bar is "one" (drops land on downbeats)
//   - sections, cut where the sound changes (novelty) on the 4-bar phrase
//     grid, then named: intro, verse, build, drop, break, outro
//   - fills (a burst of hits on a phrase's last beat), repeats (the chorus
//     coming back) and a mood per section: energy × dark/bright → euphoric,
//     aggressive, dreamy or dark
//   - sweeps: a filter opening and closing, a riser, a falling note — the
//     sound's brightness gliding up or down. Auto moves the lasers with them
//   - one-sided sounds: a lead or an effect that sits clearly left or right
//     in the stereo picture for a moment. Auto changes only that side's lasers
//
// Cheap on purpose: one 1024-point FFT per 23 ms frame (two for a stereo
// song: mid and side; our own radix-2 in src/audio/fft.js, no dependency)
// plus two one-pole filters; everything else is per-bar averages on the
// song's beat grid and two passes over the frames. Values are normalised to the
// song itself (its loud parts ≈ 1), so a quiet master and a loud one give the
// same show.
//
// Works on anything shaped like an AudioBuffer: { sampleRate, length,
// numberOfChannels, getChannelData() }. No DOM; Node-testable.

import { fft, fftTables } from '../audio/fft.js';

const HOP = 1024; // samples per analysis frame (~23 ms at 44.1 kHz); also the FFT size

// ------------------------------------------------------- frame features

/** The spectral bands we listen to, in Hz (bass below 150 comes from the one-pole filter). */
export const BANDS = [
  { key: 'low', lo: 40, hi: 250 },
  { key: 'lowmid', lo: 250, hi: 1000 },
  { key: 'mid', lo: 1000, hi: 4000 },
  { key: 'hi', lo: 4000, hi: 10000 },
  { key: 'air', lo: 10000, hi: 22050 },
];

/** The bands the left/right balance is read in (bass is mono in almost every mix). */
const SIDE_BANDS = BANDS.slice(1);

/**
 * Frame features at sr/HOP fps (Float32Arrays): rms, bass, high, onset (the
 * cheap filters) and from the FFT: one array per BANDS key, centroid (Hz),
 * fluxLo / fluxHi (spectral flux below 250 Hz / above 2 kHz — kicks / snares
 * and hats), flat (spectral flatness above 2 kHz: ~0 tonal, → 1 noise),
 * tilt (how bright the frame sounds, in octaves: the centre of its spectrum
 * from 150 Hz to 16 kHz on a log-frequency axis, each bin weighted by the
 * square root of its magnitude so a loud bass note doesn't pin it down; 0 =
 * silent) and, for a stereo song, left / right: one array per SIDE_BANDS band
 * with that channel's level (null for mono).
 */
export function frameFeatures(buffer) {
  const sr = buffer.sampleRate;
  const chs = Math.min(2, buffer.numberOfChannels || 1);
  const a = buffer.getChannelData(0);
  const b = chs > 1 ? buffer.getChannelData(1) : null;
  const n = Math.floor(a.length / HOP);
  const arr = () => new Float32Array(n);
  const F = { rms: arr(), bass: arr(), high: arr(), onset: arr(), centroid: arr(), fluxLo: arr(), fluxHi: arr(), flat: arr(), tilt: arr(),
    left: b ? SIDE_BANDS.map(arr) : null, right: b ? SIDE_BANDS.map(arr) : null, fps: sr / HOP };
  for (const band of BANDS) F[band.key] = arr();
  // one-pole low-passes: ~150 Hz (bass) and ~2.5 kHz (highs = signal − that)
  const kB = 1 - Math.exp((-2 * Math.PI * 150) / sr);
  const kH = 1 - Math.exp((-2 * Math.PI * 2500) / sr);
  const { win } = fftTables(HOP);
  const re = new Float64Array(HOP), im = new Float64Array(HOP);
  const sre = new Float64Array(HOP), sim = new Float64Array(HOP); // the side signal (L − R) / 2
  const H = HOP / 2;
  const mag = new Float32Array(H), prevMag = new Float32Array(H);
  const binHz = sr / HOP;
  const bin = (hz) => Math.max(1, Math.min(H, Math.round(hz / binHz)));
  const bandBins = BANDS.map((x) => [bin(x.lo), bin(x.hi)]);
  const k250 = bin(250), k2k = bin(2000), k150 = bin(150), k16k = bin(16000);
  const sideBins = SIDE_BANDS.map((x) => [bin(x.lo), bin(Math.min(x.hi, 16000))]);
  const octave = new Float32Array(H);
  for (let k = 1; k < H; k++) octave[k] = Math.log2(k * binHz);
  let lpB = 0, lpH = 0, prev = 0;
  for (let f = 0; f < n; f++) {
    let s2 = 0, b2 = 0, h2 = 0;
    const o = f * HOP;
    for (let j = 0; j < HOP; j++) {
      const s = b ? (a[o + j] + b[o + j]) * 0.5 : a[o + j];
      lpB += kB * (s - lpB);
      lpH += kH * (s - lpH);
      const hi = s - lpH;
      s2 += s * s; b2 += lpB * lpB; h2 += hi * hi;
      re[j] = s * win[j];
      im[j] = 0;
      if (b) { sre[j] = (a[o + j] - b[o + j]) * 0.5 * win[j]; sim[j] = 0; }
    }
    F.rms[f] = Math.sqrt(s2 / HOP);
    F.bass[f] = Math.sqrt(b2 / HOP);
    F.high[f] = Math.sqrt(h2 / HOP);
    F.onset[f] = F.rms[f] > prev ? F.rms[f] - prev : 0;
    prev = F.rms[f];

    fft(re, im);
    if (b) {
      // left = mid + side, right = mid − side, bin by bin (before `re` is reused)
      fft(sre, sim);
      sideBins.forEach(([lo, hi], i) => {
        let l2 = 0, r2 = 0;
        for (let k = lo; k < hi; k++) {
          const lr = re[k] + sre[k], li = im[k] + sim[k], rr = re[k] - sre[k], ri = im[k] - sim[k];
          l2 += lr * lr + li * li;
          r2 += rr * rr + ri * ri;
        }
        F.left[i][f] = Math.sqrt(l2) / HOP;
        F.right[i][f] = Math.sqrt(r2) / HOP;
      });
    }
    let sm = 0, smf = 0, fl = 0, fh = 0, logSum = 0, linSum = 0, tw = 0, to = 0;
    for (let k = 1; k < H; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / HOP;
      mag[k] = m;
      sm += m; smf += m * k;
      const d = m - prevMag[k];
      if (d > 0) { if (k < k250) fl += d; else if (k >= k2k) fh += d; }
      if (k >= k2k) { logSum += Math.log(m + 1e-9); linSum += m; }
      if (k >= k150 && k < k16k) { const w = Math.sqrt(m); tw += w; to += w * octave[k]; }
      prevMag[k] = m;
    }
    F.centroid[f] = sm > 1e-9 ? (smf / sm) * binHz : 0;
    F.tilt[f] = tw > 1e-6 ? to / tw : 0;
    F.fluxLo[f] = fl;
    F.fluxHi[f] = fh;
    const nh = H - k2k;
    F.flat[f] = linSum > 1e-7 && nh > 0 ? Math.exp(logSum / nh) / (linSum / nh) : 0;
    bandBins.forEach(([lo, hi], i) => {
      let e = 0;
      for (let k = lo; k < hi; k++) e += mag[k] * mag[k];
      F[BANDS[i].key][f] = Math.sqrt(e);
    });
  }
  return F;
}

// The FFT pass is the slow part (about a second for a long song) and doesn't
// depend on the grid: keep it per buffer, so a tempo change re-reads instantly.
const heard = new WeakMap();
function features(buffer) {
  let F = heard.get(buffer);
  if (!F) { F = frameFeatures(buffer); heard.set(buffer, F); }
  return F;
}

/** The p-th percentile of an array (0..1), ignoring silence. */
function pct(arr, p, fallback = 1) {
  const v = Array.from(arr).filter((x) => x > 1e-6).sort((x, y) => x - y);
  if (!v.length) return fallback;
  return v[Math.min(v.length - 1, Math.floor(p * v.length))] || fallback;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export const SECTION_NAMES = { intro: 'Intro', verse: 'Verse', build: 'Build', drop: 'Drop', break: 'Break', outro: 'Outro' };
export const MOOD_NAMES = { euphoric: 'Euphoric', aggressive: 'Aggressive', dreamy: 'Dreamy', dark: 'Dark' };

/** Energy and brightness (0..1) -> one of the four moods. */
export function moodOf(energy, bright) {
  if (energy >= 0.58) return bright >= 0.5 ? 'euphoric' : 'aggressive';
  return bright >= 0.5 ? 'dreamy' : 'dark';
}

// ---------------------------------------------------------------- song

/**
 * Analyse a decoded song on its beat grid.
 * Returns { bpm, offset, barLen, duration, phase (beats the bar grid was
 *           moved so drops land on "one"), first (seconds: the first downbeat),
 *   bars:  [{ t, energy, bass, high, busy, bright, noise, rate, tension, fill, vec }],
 *   beats: [{ t, bass }],                                  (per beat, 0..1)
 *   drops: [{ bar, t, strength }],
 *   sections: [{ t, end, bar0, bar1, kind, name, energy, bright, tension,
 *                mood, group, repeat, hit }],
 *   sweeps, glide (see findSweeps), sides (see findSides) }
 * `hit` = the section starts on a detected drop; `group` = sections that
 * sound alike share a number, `repeat` = how many times it came before.
 */
export function analyzeSong(buffer, { bpm = 120, offset = 0 } = {}) {
  const duration = buffer.length / buffer.sampleRate;
  const F = features(buffer);
  const beatLen = 60 / (bpm || 120);
  const barLen = beatLen * 4;
  const avg = (arr, t0, t1) => {
    const i0 = Math.max(0, Math.floor(t0 * F.fps)), i1 = Math.min(arr.length, Math.ceil(t1 * F.fps));
    if (i1 <= i0) return 0;
    let s = 0;
    for (let i = i0; i < i1; i++) s += arr[i];
    return s / (i1 - i0);
  };

  // ---- beats: kick strength (short window) and bass level (whole beat)
  const beats = [];
  const b0 = ((offset % beatLen) + beatLen) % beatLen;
  for (let t = b0; t < duration; t += beatLen) {
    beats.push({ t, bass: avg(F.bass, t - 0.03, t + Math.min(0.15, beatLen * 0.4)), level: avg(F.bass, t, t + beatLen) });
  }
  const nK = pct(beats.map((b) => b.bass), 0.9);
  const nL = pct(beats.map((b) => b.level), 0.9);
  for (const b of beats) { b.bass = clamp01(b.bass / nK); b.level = clamp01(b.level / nL); }

  // ---- which beat is "one": drops (bass slamming back in) land on downbeats
  const phase = downbeatPhase(beats, offset, beatLen);
  const first = phase || offset < 0 || offset >= barLen ? ((((offset + phase * beatLen) % barLen) + barLen) % barLen) : offset;

  // ---- hits: peaks of the high flux (snares, claps, hats)
  const thrHi = 1.5 * pct(F.fluxHi, 0.5, 0);
  const peak = new Uint8Array(F.fluxHi.length);
  let lastPeak = -9;
  for (let i = 1; i < F.fluxHi.length - 1; i++) {
    const v = F.fluxHi[i];
    if (v > thrHi && v >= F.fluxHi[i - 1] && v > F.fluxHi[i + 1] && i - lastPeak >= 2) { peak[i] = 1; lastPeak = i; }
  }
  const count = (t0, t1) => {
    let c = 0;
    for (let i = Math.max(0, Math.floor(t0 * F.fps)); i < Math.min(peak.length, Math.ceil(t1 * F.fps)); i++) c += peak[i];
    return c;
  };
  // high-band flatness, weighted by how loud the highs are (silence isn't noise)
  const flatW = (t0, t1) => {
    let s = 0, w = 0;
    for (let i = Math.max(0, Math.floor(t0 * F.fps)); i < Math.min(F.flat.length, Math.ceil(t1 * F.fps)); i++) { s += F.flat[i] * F.high[i]; w += F.high[i]; }
    return w > 1e-9 ? s / w : 0;
  };

  // ---- bars on the grid. The bit before the first downbeat joins the first bar.
  const raw = [];
  for (let t = first; t < duration - 0.25 * barLen; t += barLen) {
    const t0 = raw.length ? t : 0;
    const t1 = Math.min(duration, t + barLen);
    const r = { t: t0, rms: avg(F.rms, t0, t1), bass: avg(F.bass, t0, t1), high: avg(F.high, t0, t1), busy: avg(F.onset, t0, t1),
      centroid: avg(F.centroid, t0, t1), flat: flatW(t0, t1), hits: count(t, t1), fluxHi: avg(F.fluxHi, t0, t1),
      lastBeatFlux: avg(F.fluxHi, t1 - beatLen, t1 - 1.5 / F.fps) }; // stop short of the next downbeat
    for (const band of BANDS) r[band.key] = avg(F[band.key], t0, t1);
    raw.push(r);
  }
  // normalise each feature to the song's loud bars (its ~90th percentile bar = 1)
  const norm = (k) => pct(raw.map((b) => b[k]), 0.9);
  const N = {};
  for (const k of ['rms', 'bass', 'high', 'busy', ...BANDS.map((x) => x.key)]) N[k] = norm(k);
  const span = (k) => {
    const lo = pct(raw.map((b) => b[k]), 0.1, 0), hi = pct(raw.map((b) => b[k]), 0.9, 1);
    return (v) => (hi - lo > 1e-9 ? clamp01((v - lo) / (hi - lo)) : 0.5);
  };
  const relC = span('centroid'), relF = span('flat');
  const bars = raw.map((b, i) => {
    const rms = clamp01(b.rms / N.rms), bass = clamp01(b.bass / N.bass), high = clamp01(b.high / N.high), busy = clamp01(b.busy / N.busy);
    const energy = clamp01(0.45 * rms + 0.3 * bass + 0.1 * high + 0.15 * busy);
    // bright: half relative to this song, half absolute (≈ 600 Hz dark .. 3.6 kHz bright)
    const bright = clamp01(0.5 * relC(b.centroid) + 0.5 * clamp01((b.centroid - 600) / 3000));
    const noise = relF(b.flat) * clamp01(high / 0.3); // flatness of near-silent highs means nothing
    const rate = b.hits / 4; // hits per beat
    const tension = clamp01(0.35 * Math.min(1, rate / 4) + 0.25 * noise + 0.2 * high + 0.2 * (1 - bass));
    // a fill: the bar's last beat hits much harder than the last beat of the
    // bars before it (so a clap on every 4th beat isn't one)
    const prevLast = mean(raw.slice(Math.max(0, i - 3), i).map((x) => x.lastBeatFlux));
    const fill = i >= 2 && b.lastBeatFlux > 1.8 * prevLast && b.lastBeatFlux > 1.5 * b.fluxHi && rms > 0.15;
    const vec = [bass, ...BANDS.map((x) => clamp01(b[x.key] / N[x.key])), bright, energy, Math.min(1, rate / 4), noise];
    return { t: b.t, energy, bass, high, busy, bright, noise, rate, tension, fill, vec };
  });
  if (!bars.length) bars.push({ t: 0, energy: 0.5, bass: 0.5, high: 0.5, busy: 0.5, bright: 0.5, noise: 0, rate: 0, tension: 0.3, fill: false, vec: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0, 0] });

  const drops = findDrops(bars);
  const sections = findSections(bars, duration, drops);
  const { sweeps, glide } = findSweeps(F, beatLen);
  const sides = findSides(F);
  return { bpm, offset, barLen, duration, phase, first, bars, beats: beats.map(({ t, bass }) => ({ t, bass })), drops, sections, sweeps, glide, sides };
}

// ------------------------------------------------------------- sweeps

const SWEEP_MIN = 0.7;    // octaves: a smaller glide is the mix breathing, not a sweep
const SWEEP_SHORT = 0.4;  // seconds: a faster one is a cut or a hit, not a sweep
const SWEEP_LONG = 12;    // seconds: a slower one is the song changing, not a sweep
const SWEEP_FAST = 4;     // octaves a second: steeper is a hard cut smeared by the smoothing
const SWEEP_FULL = 1;     // octaves that swing the lasers (nearly) all the way
const GLIDE_HOLD = 6;     // seconds: how long a sweep's swing lasts while sweeps keep coming
const GLIDE_HOME = 2;     // beats: how fast the lasers drift home once nothing sweeps
const GLIDE_FPS = 20;     // the movement curve's resolution

/** Median of the n frames around each frame (hats and clicks are shorter than that). */
function medianFilter(src, n) {
  const out = new Float32Array(src.length), h = n >> 1, w = [];
  for (let i = 0; i < src.length; i++) {
    w.length = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(src.length - 1, i + h); j++) w.push(src[j]);
    w.sort((x, y) => x - y);
    out[i] = w[w.length >> 1];
  }
  return out;
}

function boxFilter(src, n) {
  const out = new Float32Array(src.length), h = n >> 1;
  let s = 0, c = 0;
  for (let i = 0; i < Math.min(h, src.length); i++) { s += src[i]; c++; }
  for (let i = 0; i < src.length; i++) {
    if (i + h < src.length) { s += src[i + h]; c++; }
    if (i - h - 1 >= 0) { s -= src[i - h - 1]; c--; }
    out[i] = s / c;
  }
  return out;
}

/**
 * Sweeps: stretches where the sound's brightness (frame tilt) glides at least
 * SWEEP_MIN octaves one way — a filter opening or closing, a riser, a note
 * falling away. Returns
 *   sweeps: [{ t0, t1, dir: 1 up | -1 down, span (octaves) }]
 *   glide:  { fps, v: Float32Array } the movement that copies them, −1..1:
 *           0 at rest; each sweep moves it by its own glide (a filter that
 *           opens and closes takes the lasers up and back), and it drifts
 *           home — slowly while sweeps keep coming, within a bar or two once
 *           they stop — so a big sweep never parks the lasers at the edge.
 * Quiet passages count too (a faint swoosh still sweeps), silence doesn't.
 */
export function findSweeps(F, beatLen = 0.5) {
  const n = F.tilt.length;
  const glide = { fps: GLIDE_FPS, v: new Float32Array(Math.ceil((n / F.fps) * GLIDE_FPS) + 1) };
  if (n < 8) return { sweeps: [], glide };
  // silence has no brightness: hold the last one heard
  const quiet = 0.02 * pct(F.rms, 0.9, 0);
  const s0 = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) if (F.tilt[i] > 0 && F.rms[i] > quiet) { last = F.tilt[i]; break; }
  for (let i = 0; i < n; i++) { if (F.tilt[i] > 0 && F.rms[i] > quiet) last = F.tilt[i]; s0[i] = last; }
  const s = boxFilter(medianFilter(s0, Math.max(3, Math.round(0.2 * F.fps) | 1)), Math.max(3, Math.round(0.15 * F.fps) | 1));

  // turning points: the curve has to come back SWEEP_MIN from an extreme
  // before that extreme counts (a zigzag), so wiggles inside a sweep don't end it
  const piv = [0];
  let dir = 0, ext = 0;
  for (let i = 1; i < n; i++) {
    if (dir >= 0 && s[i] > s[ext]) ext = i;
    else if (dir <= 0 && s[i] < s[ext]) ext = i;
    if (dir === 0) {
      if (Math.abs(s[i] - s[piv[0]]) >= SWEEP_MIN) { dir = s[i] > s[piv[0]] ? 1 : -1; ext = i; }
    } else if ((s[ext] - s[i]) * dir >= SWEEP_MIN) {
      piv.push(ext);
      dir = -dir;
      ext = i;
    }
  }
  if (dir !== 0 && ext !== piv[piv.length - 1]) piv.push(ext);

  // legs between turning points; a leg starts where the curve leaves its
  // turning point for good (it may rest there for a while first)
  const legs = [];
  for (let k = 0; k + 1 < piv.length; k++) {
    const i1 = piv[k + 1], d = s[i1] - s[piv[k]];
    let i0 = i1;
    while (i0 > piv[k] && Math.abs(s[i0 - 1] - s[piv[k]]) > 0.12 * Math.abs(d)) i0--;
    i0 = Math.max(piv[k], i0 - 1);
    const dur = (i1 - i0) / F.fps;
    legs.push({ p0: piv[k], i0, i1, d, ok: Math.abs(d) >= SWEEP_MIN && dur >= SWEEP_SHORT && dur <= SWEEP_LONG && Math.abs(d) <= SWEEP_FAST * dur });
  }
  const sweeps = legs.filter((l) => l.ok).map((l) => ({
    t0: r3s(l.i0 / F.fps), t1: r3s(l.i1 / F.fps), dir: l.d > 0 ? 1 : -1, span: r3s(Math.abs(l.d)),
  }));

  // the movement curve: inside a sweep it moves as the brightness does;
  // all the time it leaks home (a soft limit instead of a hard stop keeps
  // movement visible after a very big sweep)
  const inLeg = new Uint8Array(n);
  for (const l of legs) if (l.ok) inLeg.fill(1, l.i0 + 1, l.i1 + 1);
  const kIn = Math.exp(-1 / (GLIDE_HOLD * F.fps)), kOut = Math.exp(-1 / (GLIDE_HOME * beatLen * F.fps));
  const raw = new Float32Array(n);
  let g = 0;
  for (let i = 1; i < n; i++) {
    g = inLeg[i] ? Math.max(-1.5, Math.min(1.5, g * kIn + (s[i] - s[i - 1]) / SWEEP_FULL)) : g * kOut;
    raw[i] = Math.tanh(g);
  }
  const curve = boxFilter(raw, Math.max(3, Math.round(0.3 * F.fps) | 1));
  for (let j = 0; j < glide.v.length; j++) {
    const x = (j / GLIDE_FPS) * F.fps, i = Math.min(n - 1, Math.floor(x)), f = x - i;
    glide.v[j] = i + 1 < n ? curve[i] + (curve[i + 1] - curve[i]) * f : curve[i];
  }
  return { sweeps, glide };
}

const r3s = (v) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------- one-sided sounds

const SIDE_ON = 0.2;      // how far the balance has to lean to start a one-sided moment…
const SIDE_OFF = 0.08;    // …and how far back it has to come to end it ("normal stereo")
const SIDE_MIN = 0.3;     // seconds: shorter is a ping-pong hat, not a part on one side
const SIDE_GAP = 0.2;     // seconds: two moments on one side this close are one

/**
 * One-sided sounds: moments when what is playing above the bass sits clearly
 * left or right. Per frame the balance (right − left) / (right + left) is
 * read in each SIDE_BANDS band, weighted by how loud that band is compared to
 * its own loud level (so a panned hat counts although hats are quiet), minus
 * the mix's own slow lean (a guitar parked on the left all song is "normal").
 * Returns [{ t0, t1, side: 'L' | 'R', amount (0..1, the peak lean) }].
 */
export function findSides(F) {
  if (!F.left) return [];
  const n = F.rms.length, nb = F.left.length;
  const sm = Math.max(3, Math.round(0.1 * F.fps) | 1);
  const L = F.left.map((x) => boxFilter(x, sm)), R = F.right.map((x) => boxFilter(x, sm));
  const ref = L.map((_, i) => {
    const sum = new Float32Array(n);
    for (let f = 0; f < n; f++) sum[f] = L[i][f] + R[i][f];
    return pct(sum, 0.9, 0);
  });
  const lean = new Float32Array(n), loud = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let d = 0, w = 0;
    for (let i = 0; i < nb; i++) {
      if (!(ref[i] > 0)) continue;
      d += (R[i][f] - L[i][f]) / ref[i];
      w += (R[i][f] + L[i][f]) / ref[i];
    }
    loud[f] = w / nb;
    lean[f] = w > 1e-6 ? d / w : 0;
  }
  // the mix's own lean: the median over ±8 s, read once a second
  const step = Math.max(1, Math.round(F.fps)), half = Math.round(8 * F.fps);
  const slow = [];
  for (let c = 0; c < n; c += step) {
    const w = [];
    for (let j = Math.max(0, c - half); j < Math.min(n, c + half); j += 2) if (loud[j] > 0.1) w.push(lean[j]);
    w.sort((x, y) => x - y);
    slow.push(w.length ? w[w.length >> 1] : 0);
  }
  for (let f = 0; f < n; f++) lean[f] -= slow[Math.min(slow.length - 1, Math.floor(f / step))];

  const out = [];
  let cur = null;
  const close = (f) => {
    cur.t1 = f / F.fps;
    const prev = out[out.length - 1];
    if (prev && prev.side === cur.side && cur.t0 - prev.t1 <= SIDE_GAP) { prev.t1 = cur.t1; prev.amount = Math.max(prev.amount, cur.amount); }
    else out.push(cur);
    cur = null;
  };
  for (let f = 0; f < n; f++) {
    const v = lean[f], a = Math.abs(v);
    if (cur) {
      const same = (v > 0) === (cur.side === 'R');
      if (!same || a < SIDE_OFF || loud[f] < 0.1) close(f);
      else cur.amount = Math.max(cur.amount, a);
    }
    if (!cur && a >= SIDE_ON && loud[f] >= 0.2) cur = { t0: f / F.fps, t1: 0, side: v > 0 ? 'R' : 'L', amount: a };
  }
  if (cur) close(n);
  return out.filter((x) => x.t1 - x.t0 >= SIDE_MIN).map((x) => ({ t0: r3s(x.t0), t1: r3s(x.t1), side: x.side, amount: r3s(Math.min(1, x.amount)) }));
}

/**
 * Which beat of the given bar grid is really "one" (0..3)? Find where the bass
 * jumps up and stays (a drop), and vote with the jumps' beat-in-bar. Without
 * clear drops, keep the grid as it is.
 */
export function downbeatPhase(beats, offset, beatLen) {
  const lv = beats.map((b) => b.level);
  const lift = lv.map((_, j) => (j < 4 || j + 4 > lv.length ? 0 : mean(lv.slice(j, j + 4)) - mean(lv.slice(j - 4, j))));
  const votes = [0, 0, 0, 0];
  let strong = 0;
  for (let j = 4; j < lift.length - 4; j++) {
    const v = lift[j];
    if (v < 0.3) continue;
    let isMax = true;
    for (let k = j - 4; k <= j + 4; k++) if (k !== j && lift[k] > v) { isMax = false; break; }
    if (!isMax) continue;
    const pos = (((Math.round((beats[j].t - offset) / beatLen)) % 4) + 4) % 4;
    votes[pos] += v;
    strong++;
  }
  const total = votes.reduce((x, y) => x + y, 0);
  if (!strong || total <= 0) return 0;
  const best = votes.indexOf(Math.max(...votes));
  return votes[best] >= 0.6 * total ? best : 0;
}

/** Drops: bars where the bass (and the energy) jump up and stay up. */
export function findDrops(bars) {
  const n = bars.length;
  const lift = bars.map((b, i) => {
    if (i < 1 || i + 1 > n) return 0;
    const pre = bars.slice(Math.max(0, i - 2), i), post = bars.slice(i, i + 2);
    const bassLift = mean(post.map((x) => x.bass)) - mean(pre.map((x) => x.bass));
    const eLift = mean(post.map((x) => x.energy)) - mean(pre.map((x) => x.energy));
    return 0.6 * bassLift + 0.4 * eLift;
  });
  const cands = [];
  for (let i = 1; i < n; i++) {
    const post = bars.slice(i, i + 2);
    if (lift[i] > 0.22 && mean(post.map((x) => x.bass)) > 0.55 && bars[i].energy > 0.5) cands.push(i);
  }
  // one drop per 8 bars: keep the strongest
  const out = [];
  for (const i of cands.sort((a, b) => lift[b] - lift[a])) {
    if (out.some((d) => Math.abs(d.bar - i) < 8)) continue;
    out.push({ bar: i, t: bars[i].t, strength: Math.round(lift[i] * 1000) / 1000 });
  }
  return out.sort((a, b) => a.bar - b.bar);
}

const dist = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0) / a.length);
const SAME_DROP = 0.18; // sound distance: phrases of one drop are ~0.1 apart, a new part 0.2+
const meanVec = (rows) => rows[0].map((_, i) => mean(rows.map((r) => r[i])));

/**
 * Cut the bars into sections and name them. Music changes on phrases, so
 * cuts land on the 4-bar grid that the first drop sits on: wherever the sound
 * of the next 4 bars differs clearly from the last 4 (novelty), at every drop,
 * and where the build before a drop starts. Then name each section from its
 * energy, its tension and what comes next.
 */
export function findSections(bars, duration, drops = []) {
  const n = bars.length;
  const PH = 4;
  const origin = drops.length ? drops[0].bar % PH : 0;
  const novelty = new Array(n).fill(0);
  for (let i = 2; i < n - 1; i++) {
    const a = bars.slice(Math.max(0, i - PH), i), b = bars.slice(i, Math.min(n, i + PH));
    novelty[i] = dist(meanVec(a.map((x) => x.vec)), meanVec(b.map((x) => x.vec))) + 0.5 * Math.abs(mean(b.map((x) => x.energy)) - mean(a.map((x) => x.energy)));
  }
  const grid = [];
  for (let i = origin; i < n; i += PH) if (i > 0 && i < n - 1) grid.push(i);
  const med = grid.length ? grid.map((i) => novelty[i]).sort((x, y) => x - y)[Math.floor(grid.length / 2)] : 0;
  const thr = Math.max(0.07, med * 1.4);
  const cuts = new Map(); // bar -> strength (forced cuts are Infinity)
  for (const i of grid) if (novelty[i] > thr && novelty[i] >= (novelty[i - PH] ?? 0) * 0.8) cuts.set(i, novelty[i]);
  for (const d of drops) if (d.bar > 0) cuts.set(d.bar, Infinity);
  // the build before each drop: the last 16 / 8 / 4 bars whose tension climbs
  // step by step into it (a flat calm stretch followed by a short build isn't
  // a 16-bar build: every quarter of the window has to climb)
  drops.forEach((d, di) => {
    const floor = di ? drops[di - 1].bar + PH : 1; // never reach back into the previous drop
    for (const k of [16, 8, 4]) {
      const s = d.bar - k;
      if (s < floor) continue;
      const q = [0, 1, 2, 3].map((j) => mean(bars.slice(s + (j * k) / 4, s + ((j + 1) * k) / 4).map((x) => x.tension)));
      const climbs = q[1] - q[0] > 0.015 && q[2] - q[1] > -0.02 && q[3] - q[2] > -0.02 && q[3] - q[0] > 0.1;
      // ...and doesn't start in something louder (the tail of a drop isn't a build)
      const e0 = mean(bars.slice(s, s + k / 4).map((x) => x.energy)), e3 = mean(bars.slice(d.bar - k / 4, d.bar).map((x) => x.energy));
      if (climbs && mean(q) > 0.3 && e0 <= e3 + 0.1) {
        for (const c of [...cuts.keys()]) if (c > s && c < d.bar && cuts.get(c) !== Infinity) cuts.delete(c);
        cuts.set(s, Infinity);
        break;
      }
    }
  });
  // cuts at least 4 bars apart (forced and stronger ones win), sections at most 32 bars
  let list = [...cuts.entries()].sort((a, b) => b[1] - a[1]);
  const kept = [];
  for (const [bar] of list) if (!kept.some((k) => Math.abs(k - bar) < PH) || cuts.get(bar) === Infinity) kept.push(bar);
  list = [0, ...kept.filter((b) => b > 0).sort((a, b) => a - b)];
  list = list.filter((b, i) => i === 0 || b !== list[i - 1]);
  const secs = [];
  list.forEach((b0, i) => {
    const b1 = list[i + 1] ?? n;
    for (let s = b0; s < b1; s += 32) secs.push({ bar0: s, bar1: Math.min(b1, s + 32) });
  });
  // a lone short tail joins the section before it
  if (secs.length > 1 && secs.at(-1).bar1 - secs.at(-1).bar0 < PH && !drops.some((d) => d.bar === secs.at(-1).bar0)) {
    const tail = secs.pop();
    secs.at(-1).bar1 = tail.bar1;
  }
  for (const s of secs) {
    const sl = bars.slice(s.bar0, s.bar1);
    s.energy = mean(sl.map((x) => x.energy));
    s.bright = mean(sl.map((x) => x.bright));
    s.tension = mean(sl.map((x) => x.tension));
    s.vec = meanVec(sl.map((x) => x.vec));
    s.hit = drops.some((d) => d.bar === s.bar0);
    const h = Math.floor(sl.length / 2);
    s.rise = sl.length >= 2 ? mean(sl.slice(h).map((x) => x.tension)) - mean(sl.slice(0, h).map((x) => x.tension)) : 0;
  }

  const es = secs.map((s) => s.energy).sort((a, b) => a - b);
  const hiCut = es[Math.floor(es.length * 0.66)] ?? 0.6;
  const loCut = es[Math.floor(es.length * 0.34)] ?? 0.3;
  secs.forEach((s, i) => {
    const prev = secs[i - 1], next = secs[i + 1];
    const high = s.energy >= hiCut && s.energy > 0.45;
    const low = s.energy <= loCut || s.energy < 0.3;
    if (s.hit || (high && !(next?.hit && s.rise > 0.05))) s.kind = 'drop';
    else if (next && (next.hit || next.energy - s.energy > 0.12) && s.rise > 0.05 && s.tension > 0.3) s.kind = 'build';
    else if (low && i === 0) s.kind = 'intro';
    else if (low && i === secs.length - 1) s.kind = 'outro';
    else if (low && prev && prev.energy - s.energy > 0.1) s.kind = 'break'; // a break comes down from something
    else s.kind = i === 0 ? 'intro' : 'verse';
  });
  // a drop that runs on past a cut is still the same drop
  for (let i = secs.length - 1; i > 0; i--) {
    const a = secs[i - 1], b = secs[i];
    // (unless it turns into something that sounds clearly different: that's a new part)
    if (a.kind === 'drop' && b.kind === 'drop' && !b.hit && b.bar1 - a.bar0 <= 32 && dist(a.vec, b.vec) < SAME_DROP) {
      const wa = a.bar1 - a.bar0, wb = b.bar1 - b.bar0;
      a.energy = (a.energy * wa + b.energy * wb) / (wa + wb);
      a.bright = (a.bright * wa + b.bright * wb) / (wa + wb);
      a.tension = (a.tension * wa + b.tension * wb) / (wa + wb);
      a.vec = a.vec.map((x, k) => (x * wa + b.vec[k] * wb) / (wa + wb));
      a.bar1 = b.bar1;
      secs.splice(i, 1);
    }
  }
  // repeats: sections that sound alike (the chorus coming back) share a group
  const groups = [];
  for (const s of secs) {
    let g = groups.findIndex((x) => x.kind === s.kind && dist(x.vec, s.vec) < 0.12);
    if (g < 0) { g = groups.length; groups.push({ kind: s.kind, vec: s.vec, n: 0 }); }
    s.group = g;
    s.repeat = groups[g].n++;
  }

  const count = {};
  const total = {};
  for (const s of secs) total[s.kind] = (total[s.kind] || 0) + 1;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return secs.map((s, i) => {
    count[s.kind] = (count[s.kind] || 0) + 1;
    const name = SECTION_NAMES[s.kind] + (total[s.kind] > 1 ? ` ${count[s.kind]}` : '');
    const t = bars[s.bar0].t;
    const end = i + 1 < secs.length ? bars[secs[i + 1].bar0].t : duration;
    return { t, end, bar0: s.bar0, bar1: s.bar1, kind: s.kind, name, energy: r3(s.energy), bright: r3(s.bright), tension: r3(s.tension),
      mood: moodOf(s.energy, s.bright), group: s.group, repeat: s.repeat, hit: s.hit };
  });
}

// ---- the song map (5b): the user's corrections on top of the analysis ----

/**
 * A song map: { song: { name, duration }, edits: [{ t, kind?, mood? }] }.
 * Saved with the show. `song` ties it to the loaded track (a different song
 * ignores it); each edit finds its section by start time, so it survives a
 * re-analysis that lands the same cuts.
 */
export function normalizeSongMap(m) {
  if (!m || typeof m !== 'object' || !Array.isArray(m.edits)) return null;
  const edits = m.edits
    .filter((e) => e && Number.isFinite(e.t) && e.t >= 0)
    .map((e) => {
      const out = { t: Math.round(e.t * 1000) / 1000 };
      if (SECTION_NAMES[e.kind]) out.kind = e.kind;
      if (MOOD_NAMES[e.mood]) out.mood = e.mood;
      return out;
    })
    .filter((e) => e.kind || e.mood);
  const song = m.song && typeof m.song === 'object'
    ? { name: String(m.song.name || ''), duration: Number.isFinite(m.song.duration) ? Math.round(m.song.duration * 100) / 100 : 0 }
    : null;
  return edits.length ? { song, edits } : null;
}

/** Does this map belong to the song (same name and length to 0.1 s)? */
export function songMapFits(map, name, duration) {
  return !!map?.song && map.song.name === name && Math.abs(map.song.duration - duration) < 0.1;
}

/** The edit for the section starting at t (within half a bar), if any. */
export function editAt(map, t, barLen) {
  return map?.edits.find((e) => Math.abs(e.t - t) < barLen / 2) || null;
}

/**
 * The analysis with the map applied: kinds and moods replaced, then names,
 * drop hits and repeat groups worked out again. Edited sections are flagged
 * `edited`, and a mood the user picked `moodSet` (it beats the overall Mood).
 * Pure: `an` is not changed.
 */
export function applySongMap(an, map) {
  if (!map?.edits?.length) return an;
  const secs = an.sections.map((s) => {
    const e = editAt(map, s.t, an.barLen);
    if (!e) return { ...s };
    const out = { ...s, edited: true, auto: { kind: s.kind, mood: s.mood } };
    if (e.kind && e.kind !== s.kind) {
      out.kind = e.kind;
      out.group = `edit-${e.kind}`; // relabelled sections of one kind share their looks
      out.repeat = 0;
    }
    if (e.mood) { out.mood = e.mood; out.moodSet = true; }
    return out;
  });
  // a drop now "hits" when it starts one (not when it continues the drop before it)
  secs.forEach((s, i) => {
    if (s.kind !== s.auto?.kind) s.hit = s.kind === 'drop' && secs[i - 1]?.kind !== 'drop';
  });
  // repeat counts within each relabelled group
  const seen = {};
  for (const s of secs) if (typeof s.group === 'string') s.repeat = (seen[s.group] = (seen[s.group] ?? -1) + 1);
  const total = {}, count = {};
  for (const s of secs) total[s.kind] = (total[s.kind] || 0) + 1;
  for (const s of secs) {
    count[s.kind] = (count[s.kind] || 0) + 1;
    s.name = SECTION_NAMES[s.kind] + (total[s.kind] > 1 ? ` ${count[s.kind]}` : '');
  }
  return { ...an, sections: secs };
}
