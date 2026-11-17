// Tempo and beat position of a decoded song — what puts the timeline's grid
// on the music when a track is loaded. Everything Auto does afterwards (bars,
// drops, sections) stands on this grid, so it has to be right, not "close".
//
// How it listens (one FFT pass, both channels mixed):
//
//   1. Onsets. The spectrum is cut into third-octave bands. A band fires when
//      it gets louder than anything it did in the last 100 ms. Comparing with
//      a 100 ms window (not just the previous frame) is what keeps a tremolo
//      or a wobbling synth from looking like a drum roll — the old detector
//      was fooled by exactly that. Two envelopes come out of the same pass:
//      `fine`   = rises of the log level: every hat counts → finds the period
//      `strong` = rises of the plain level: kicks and snares dominate → says
//                 which pulse is "the beat" and where it sits.
//   2. Family. `fine` is autocorrelated and every beat period from 70 to 180
//      BPM is scored by how well the song repeats after 1, 2, 4, 8 and 16 of
//      it. Music repeats by the beat, the bar and the phrase; a wrong tempo
//      does not.
//   3. Sharpen. The song is folded onto one period — all beats laid on top of
//      each other. The right period gives the sharpest pile, which pins the
//      tempo to about 0.01 BPM.
//   4. Level. Step 2 can land on a relative of the tempo (half, double, 2/3…).
//      Each relative is tried; the one whose beats carry the most energy wins,
//      with a gentle preference for tempi near 120 BPM. Half/double stays a
//      judgement call for some songs — the caller gets the runner-up as `alt`
//      and the top bar has ÷2 / ×2 buttons.
//   5. Whole tempi. Electronic music is made at whole tempi, so 82.01 becomes
//      82 — but only if the song folds just as sharply at 82 (a real 127.96
//      does not fold at 128, and stays).
//
// Works on anything shaped like an AudioBuffer: { sampleRate, length,
// numberOfChannels, getChannelData() }. No DOM; Node-testable.

import { fft, fftTables } from './fft.js';

const REF_MS = 100;                       // an onset must rise above the last 100 ms
const BINS = 64;                          // phase bins when the song is folded onto one beat
const LEVELS = [1, 2, 4, 8, 16];          // beat, two beats, bar, two bars, four bars
const WEIGHTS = [1, 1, 1, 0.6, 0.4];
const RELATIVES = [1 / 3, 1 / 2, 2 / 3, 3 / 4, 1, 4 / 3, 3 / 2, 2, 3];
const CENTRE = 120, SPREAD = 1;           // tempo preference: log-normal around 120 BPM, 1 octave wide
const LEAD = 0.6;                         // frames: a hit shows in the envelope this much early (measured)
const SNAP_BPM = 0.08, SNAP_KEEP = 0.9;   // snap to a whole tempo within 0.08 BPM if it folds ≥ 90 % as sharply
const NEAR_ZERO = 0.02;                   // a beat within 20 ms before 0:00 counts as "at 0:00"

const heard = new WeakMap();              // buffer -> its envelopes (the FFT pass is the slow part)

/** The two onset envelopes of a song: { fine, strong, fps }. Cached per buffer. */
function listen(buffer) {
  const hit = heard.get(buffer);
  if (hit) return hit;
  const sr = buffer.sampleRate;
  const N = sr > 60000 ? 2048 : 1024, hop = N / 2;
  const a = buffer.getChannelData(0);
  const b = (buffer.numberOfChannels || 1) > 1 ? buffer.getChannelData(1) : null;
  const frames = Math.max(0, Math.floor((a.length - N) / hop) + 1);
  const fps = sr / hop;
  // third-octave band edges, 40 Hz .. 16 kHz, as FFT bins
  const top = Math.min(16000, sr * 0.45);
  const edges = [];
  for (let f = 40; f < top; f *= 2 ** (1 / 3)) edges.push(f);
  edges.push(top);
  const bins = edges.map((f) => Math.max(1, Math.min(N / 2, Math.round((f / sr) * N))));
  const nb = bins.length - 1;
  const { win } = fftTables(N);
  const K = Math.max(1, Math.round((REF_MS / 1000) * fps)); // frames in the look-back window
  const pastLog = new Float32Array(nb * K), pastLin = new Float32Array(nb * K); // rings: the last K levels per band
  const fine = new Float32Array(frames), strong = new Float32Array(frames);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    if (b) for (let j = 0; j < N; j++) { re[j] = (a[o + j] + b[o + j]) * 0.5 * win[j]; im[j] = 0; }
    else for (let j = 0; j < N; j++) { re[j] = a[o + j] * win[j]; im[j] = 0; }
    fft(re, im);
    let sumLog = 0, sumLin = 0;
    for (let k = 0; k < nb; k++) {
      let p = 0;
      const end = Math.max(bins[k] + 1, bins[k + 1]);
      for (let i = bins[k]; i < end; i++) p += re[i] * re[i] + im[i] * im[i];
      const lin = Math.sqrt(p) / (N / 4);
      const log = Math.log(1 + 1000 * lin);
      let refLog = 0, refLin = 0;
      for (let j = k * K; j < k * K + K; j++) { if (pastLog[j] > refLog) refLog = pastLog[j]; if (pastLin[j] > refLin) refLin = pastLin[j]; }
      if (f >= K) { if (log > refLog) sumLog += log - refLog; if (lin > refLin) sumLin += lin - refLin; }
      pastLog[k * K + (f % K)] = log; pastLin[k * K + (f % K)] = lin;
    }
    fine[f] = sumLog; strong[f] = sumLin;
  }
  const out = { fine, strong, fps };
  heard.set(buffer, out);
  return out;
}

/** Autocorrelation of the envelope (mean removed, 1 at lag 0) up to maxLag frames. */
function autocorr(env, maxLag) {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n || 1;
  const x = new Float32Array(n);
  let v0 = 0;
  for (let i = 0; i < n; i++) { x[i] = env[i] - mean; v0 += x[i] * x[i]; }
  v0 /= n || 1;
  const ac = new Float32Array(maxLag + 1);
  if (!(v0 > 0)) return ac;
  for (let lag = 0; lag <= maxLag; lag++) {
    let c = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) c += x[i] * x[i + lag];
    ac[lag] = m > 0 ? c / m / v0 : 0;
  }
  return ac;
}

const at = (arr, x) => {
  if (x <= 0) return arr[0];
  if (x >= arr.length - 1) return arr[arr.length - 1];
  const i = Math.floor(x), f = x - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
};

/** How well the song repeats after 1, 2, 4, 8 and 16 × `lag` frames. */
function combScore(ac, lag) {
  let s = 0, w = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    const L = lag * LEVELS[i];
    if (L > ac.length - 2) break;
    s += WEIGHTS[i] * Math.max(at(ac, L - 0.5), at(ac, L), at(ac, L + 0.5));
    w += WEIGHTS[i];
  }
  return w ? s / w : 0;
}

/** The envelope folded onto one period (in frames): its mean per phase bin. */
function fold(env, period) {
  const sum = new Float64Array(BINS), cnt = new Uint32Array(BINS);
  const n = Math.floor(Math.floor((env.length - 1) / period) * period); // whole periods only
  for (let i = 0; i < n; i++) { const b = Math.floor(((i % period) / period) * BINS) % BINS; sum[b] += env[i]; cnt[b]++; }
  const out = new Float64Array(BINS);
  for (let b = 0; b < BINS; b++) out[b] = cnt[b] ? sum[b] / cnt[b] : 0;
  return out;
}

const smooth = (h, i) => { const B = h.length; i = ((i % B) + B) % B; return 0.25 * h[(i - 1 + B) % B] + 0.5 * h[i] + 0.25 * h[(i + 1) % B]; };

/** The pile in a folded envelope: { value (peak above the floor), pos (bins, sub-bin by parabola) }. */
function peakOf(h) {
  const B = h.length;
  let bi = 0, bv = -1, floor = Infinity;
  for (let i = 0; i < B; i++) { const v = smooth(h, i); if (v > bv) { bv = v; bi = i; } if (v < floor) floor = v; }
  const a = smooth(h, bi - 1), c = smooth(h, bi + 1);
  const d = a - 2 * bv + c;
  const delta = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
  return { value: bv - floor, pos: (bi + 0.5 + delta + B) % B };
}

const pile = (env, fps, T) => peakOf(fold(env, T * fps));

/** The period within ±span of T (seconds) that folds the envelope most sharply. */
function sharpen(env, fps, T, span, steps) {
  let best = null;
  for (let s = 0; s < steps; s++) {
    const t = T * (1 + span * ((2 * s) / (steps - 1) - 1));
    const p = pile(env, fps, t);
    if (!best || p.value > best.value) best = { T: t, value: p.value };
  }
  return best;
}

const prefer = (T) => Math.exp(-0.5 * (Math.log2(60 / T / CENTRE) / SPREAD) ** 2);

/** Where the beat sits for period T: seconds from 0:00 to the first beat, in [0, T). */
function phaseOf(strong, fps, T) {
  let offset = (pile(strong, fps, T).pos / BINS) * T + LEAD / fps;
  offset = ((offset % T) + T) % T;
  return T - offset <= NEAR_ZERO ? 0 : offset;
}

/**
 * Tempo and first beat of a song.
 * Returns { bpm, offset (seconds, 0 ≤ offset < one beat), confidence (0..1:
 * how strictly the song repeats on this grid; below ~0.1 there is no steady
 * beat), alt (the next-best tempo — usually half or double — or null),
 * margin (how clearly bpm beat alt: 1 = a coin toss, 1.3+ = clear) }.
 */
export function analyzeTempo(buffer, { min = 70, max = 180 } = {}) {
  const none = { bpm: 120, offset: 0, confidence: 0, alt: null, margin: 9 };
  const { fine, strong, fps } = listen(buffer);
  if (fine.length < fps * 4) return none; // too short to judge
  const lo = 60 / max, hi = 60 / min;

  // 2. the family: the period whose multiples all repeat
  const ac = autocorr(fine, Math.min(fine.length >> 1, Math.ceil(16 * hi * fps) + 2));
  let comb = { T: lo, score: -Infinity };
  for (let T = lo; T <= hi + 1e-9; T += 0.00025) {
    const s = combScore(ac, T * fps);
    if (s > comb.score) comb = { T, score: s };
  }
  if (!(comb.score > 0)) return none; // silence

  // 3. sharpen it on the whole song
  const base = sharpen(fine, fps, comb.T, 0.004, 161);

  // 4. which relative is the beat
  const family = [];
  for (const r of RELATIVES) {
    const T0 = base.T * r;
    if (T0 < lo * 0.999 || T0 > hi * 1.001) continue;
    const T = sharpen(fine, fps, T0, 0.001, 21).T;
    family.push({ T, score: pile(strong, fps, T).value * prefer(T) });
  }
  family.sort((x, y) => y.score - x.score);
  let T = sharpen(fine, fps, family[0].T, 0.002, 81).T;

  // 5. whole tempi, when the song agrees
  let bpm = 60 / T;
  const whole = Math.round(bpm);
  const keeps = (env) => pile(env, fps, 60 / whole).value / (pile(env, fps, T).value || 1);
  if (Math.abs(bpm - whole) <= SNAP_BPM && (keeps(fine) + keeps(strong)) / 2 >= SNAP_KEEP) bpm = whole;
  else bpm = Math.round(bpm * 100) / 100;
  T = 60 / bpm;

  const second = family[1] && family[1].score > 0 ? Math.round((60 / family[1].T) * 100) / 100 : null;
  const alt = second == null ? null : Math.abs(second - Math.round(second)) <= SNAP_BPM ? Math.round(second) : second;
  const margin = second == null ? 9 : family[0].score / family[1].score;
  return { bpm, offset: phaseOf(strong, fps, T), confidence: Math.max(0, Math.min(1, comb.score)), alt, margin };
}

/**
 * Where the beat sits when the tempo is already known (the user typed it, or
 * halved / doubled ours): seconds to the first beat, in [0, one beat).
 */
export function beatOffsetAt(buffer, bpm) {
  const { strong, fps } = listen(buffer);
  const T = 60 / (bpm || 120);
  if (strong.length < fps * 4) return 0;
  return phaseOf(strong, fps, T);
}
