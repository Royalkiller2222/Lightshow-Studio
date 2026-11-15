// The playback engine. It owns the timeline's tracks, cues and markers, and
// the fixture groups. Each frame it blacks out, then evaluates every cue active
// at the transport's time and merges them into the UniverseHub: intensity HTP
// (brightest wins), colour/position LTP (the higher track wins). Fixture cues
// are looks (layers of effects). Laser tracks target projectors (every Laser
// fixture, or chosen ones); each projector draws its own top active laser cue.
// With live Auto on (engine.auto, a LiveDirector), Auto drives every projector
// instead of the laser tracks; fixture cues keep playing.

import { EFFECT_BY_KEY, EFFECTS, writeAttr, writeRGB } from './effects.js';
import { makeLayer, normalizeLayers } from './looks.js';
import { patternByKey } from '../laser/patterns.js';
import { resolveLaserParams } from '../laser/envelopes.js';
import { defaultPalettes, paletteColor } from '../laser/palettes.js';

let _id = 1;
let _tid = 1;

/** "Rainbow · Wave" — a default name from a look's layers. */
export function lookName(layers) {
  const names = (layers || []).map((l) => {
    const e = EFFECTS.find((x) => x.key === l.effectKey);
    if (!e) return null;
    const i = e.label.indexOf(' · ');
    return i >= 0 ? e.label.slice(i + 3) : e.label;
  }).filter(Boolean);
  return names.length ? names.join(' · ') : 'Empty look';
}

/** Default values for the 7 laser-cue parameters (BEYOND-style). */
export function laserParams() {
  return { size: 1, rotX: 0, rotY: 0, rotZ: 0, posX: 0, posY: 0, color: [0.1, 1, 0.4], brightness: 1, points: 1, scan: 1 };
}

export class ShowEngine {
  constructor(hub, fixtures) {
    this.hub = hub;
    this.fixtures = fixtures; // live array (shared with app)
    this.cues = [];
    // Named timeline tracks, top first. A cue belongs to one track (cue.track =
    // track id); the track decides its target fixtures (fixture tracks), its
    // priority (cue.lane = track index: top track wins LTP / the laser) and
    // whether it plays (mute / solo).
    this.tracks = [];
    this.universe = 1;
    this.manualSpark = false;
    // Live masters (performance controls, not saved with the show):
    // dimmer scales all intensity + laser brightness, speed scales effect
    // rates, size scales laser size + movement swing, blackout kills output.
    this.masters = { dimmer: 1, speed: 1, size: 1, blackout: false };
    this._warp = 0;
    this._lastTime = null;
    this.fallbackLaser = null; // set by app: the default projector, used when the rig has no Laser fixtures
    this.palettes = defaultPalettes(); // named laser colour palettes (saved with the show)
    this.beatOffset = 0; // seconds to the song's first beat (set by app each frame), for palette cycles
    this._selection = []; // current viewport selection, for the "Selection" group
    this.auto = null; // live Auto (src/auto/director.js LiveDirector) while it's on

    // Per-frame merge buffer. Effects write here via `sink`; we flush once per
    // fixture. Intensity is HTP (brightest cue wins); colour/position are LTP
    // (last applied — i.e. top lane — wins).
    this._acc = new Map();
    this.sink = {
      fixture: null,
      acc: this._acc,
      _a() {
        let a = this.acc.get(this.fixture);
        if (!a) { a = { dim: 0, lit: false, rgb: null, pan: null, tilt: null, trig: false, height: null }; this.acc.set(this.fixture, a); }
        return a;
      },
      dimmer(v) { const a = this._a(); a.lit = true; if (v > a.dim) a.dim = v; }, // HTP
      rgb(r, g, b) { this._a().rgb = [r, g, b]; },
      panTilt(p, t) { const a = this._a(); a.pan = p; a.tilt = t; },
      trigger(on) { this._a().trig = !!on; },
      height(v) { this._a().height = v; },
    };
  }

  setSelection(list) { this._selection = list || []; }

  /** Resolve a group id to its current fixture list. */
  groupFixtures(id) {
    const f = this.fixtures;
    switch (id) {
      case 'all': return f;
      case 'movers': return f.filter((x) => x.profile && x.profile.has('Pan'));
      case 'pars': return f.filter((x) => x.constructor.name === 'LedPar');
      case 'bars': return f.filter((x) => x.constructor.name === 'PixelBar' || x.constructor.name === 'Batten');
      case 'lasers': return this.projectors();
      case 'sparks': return f.filter((x) => x.profile && x.profile.has('Trigger'));
      case 'selection': return this._selection;
      default: return [];
    }
  }

  /** Laser projectors in the rig (Laser fixtures), in rig order. */
  projectors() { return this.fixtures.filter((x) => !!x.laser); }

  /**
   * Projectors a laser track plays on: `track.target` null = every projector,
   * else a list of fixtures (removed ones drop out). Fixture tracks: [].
   */
  trackProjectors(track) {
    if (!track || track.kind !== 'laser') return [];
    const all = this.projectors();
    return track.target ? all.filter((p) => track.target.includes(p)) : all;
  }

  // ---------------------------------------------------------------- tracks
  addTrack({ name, kind = 'fixture', groupId = 'movers', target = null, mute = false, solo = false, open = false, index = null, auto = false } = {}) {
    const laser = kind === 'laser';
    const track = { id: _tid++, name: name || (laser ? 'Laser' : 'Fixtures'), kind, groupId: laser ? null : groupId, target: laser && Array.isArray(target) ? target.slice() : null, mute, solo, open };
    if (auto && laser) track.auto = true; // written by Pregenerate (replaced when it runs again)
    if (index == null || index >= this.tracks.length) this.tracks.push(track);
    else this.tracks.splice(Math.max(0, index), 0, track);
    this.syncTracks();
    return track;
  }

  removeTrack(id) {
    const i = this.tracks.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.tracks.splice(i, 1);
    this.cues = this.cues.filter((c) => c.track !== id);
    this.syncTracks();
  }

  moveTrack(id, delta) {
    const i = this.tracks.findIndex((t) => t.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.tracks.length) return;
    const [t] = this.tracks.splice(i, 1);
    this.tracks.splice(j, 0, t);
    this.syncTracks();
  }

  trackOf(cue) { return this.tracks.find((t) => t.id === cue.track) || null; }

  /** Re-derive each cue's priority (lane = track index) and fixture target from its track. */
  syncTracks() {
    const idx = new Map(this.tracks.map((t, i) => [t.id, i]));
    for (const c of this.cues) {
      if (!idx.has(c.track)) continue;
      c.lane = idx.get(c.track);
      const t = this.tracks[c.lane];
      if (c.kind === 'fixture' && t.groupId) c.groupId = t.groupId;
    }
  }

  /** Mute / solo: with any track soloed, only soloed tracks play. */
  audible(cue) {
    const t = this.trackOf(cue);
    if (!t) return true;
    return this.tracks.some((x) => x.solo) ? t.solo : !t.mute;
  }

  // ------------------------------------------------------------------ cues
  /**
   * A fixture cue is a *look*: up to three layers (intensity / colour /
   * movement), each one effect with its own params (see looks.js). Pass
   * `layers`, or a single `effectKey` for a one-layer look.
   */
  addCue({ effectKey = 'i-flat', layers = null, name = null, groupId = 'movers', start = 0, duration = 4, lane = 0, track = null } = {}) {
    const ls = normalizeLayers(layers || [makeLayer(effectKey)]);
    const cue = { id: _id++, kind: 'fixture', name: name || lookName(ls), layers: ls, groupId, start, duration, lane, track };
    this.cues.push(cue);
    if (track != null) this.syncTracks();
    return cue;
  }

  /** A BEYOND-style laser cue: a vector pattern + the 7 laser parameters. */
  addLaserCue({ pattern = 'beam-fan', start = 0, duration = 4, lane = 0, track = null } = {}) {
    const cue = { id: _id++, kind: 'laser', pattern, start, duration, lane, track, params: laserParams(), colorRef: null };
    // An imported (coloured) pattern starts white so the file's own colours show.
    if (patternByKey(pattern)?.colored) cue.params.color = [1, 1, 1];
    this.cues.push(cue);
    if (track != null) this.syncTracks();
    return cue;
  }

  removeCue(id) {
    const i = this.cues.findIndex((c) => c.id === id);
    if (i >= 0) this.cues.splice(i, 1);
  }

  update(time, bpm, bands = null) {
    if (this.hub.mode !== 'internal') return;
    this._acc.clear();

    // Speed master: effects run on a warped clock. The warp accumulates
    // (speed - 1) × elapsed time, so moving the fader changes the rate smoothly
    // instead of jumping every effect's phase; a seek (time jump) resets it.
    const m = this.masters;
    const dt = time - (this._lastTime ?? time);
    this._lastTime = time;
    if (dt > 0 && dt < 0.5) this._warp += (m.speed - 1) * dt;
    else if (dt !== 0) this._warp = 0;

    // Apply lower lanes first so the top lane (lane 0) wins per channel (LTP);
    // within a lane, later-starting cues take precedence. Intensity from HTP
    // cues is accumulated as a max instead of replaced.
    const ordered = this.cues.slice().sort((a, b) => (b.lane - a.lane) || (a.start - b.start));
    for (const cue of ordered) {
      if (time < cue.start || time >= cue.start + cue.duration) continue;
      if (cue.kind !== 'fixture' || !this.audible(cue)) continue;
      const group = this.groupFixtures(cue.groupId);
      const n = group.length;
      // (the warped clock alone speeds up both Hz and beat-synced effects)
      const localT = Math.max(0, time - cue.start + this._warp);
      const beat = (localT * bpm) / 60;
      for (const layer of cue.layers) {
        const effect = EFFECT_BY_KEY[layer.effectKey];
        if (!effect) continue;
        // Size master scales how far movement layers swing.
        const p = m.size !== 1 && effect.attr === 'position' ? { ...layer.params, size: (layer.params.size ?? 1) * m.size } : layer.params;
        for (let i = 0; i < n; i++) {
          this.sink.fixture = group[i];
          effect.apply(group[i], { t: localT, beat, i, n, p, out: this.sink, bands, bpm });
        }
      }
    }

    if (this.manualSpark && !m.blackout) {
      for (const fx of this.groupFixtures('sparks')) {
        this.sink.fixture = fx;
        this.sink.trigger(true);
        this.sink.height(0.8);
      }
    }

    this._flush();
    this._renderLaser(time, bpm);
  }

  /**
   * Each projector draws the top active laser cue (lane 0 wins) among the
   * tracks that target it, with keyframed parameters evaluated at the
   * cue-local time (0..1) and a palette colour resolved at the song beat.
   * With no Laser fixtures in the rig, the default projector plays every
   * laser track.
   */
  _renderLaser(time, bpm) {
    const projs = this.projectors();
    const fb = this.fallbackLaser;
    if (fb) { fb.setVisible(!projs.length); if (projs.length) fb.blank(); }
    const active = [];
    for (const c of this.cues) {
      if (c.kind !== 'laser' || time < c.start || time >= c.start + c.duration) continue;
      if (this.audible(c)) active.push(c);
    }
    // live Auto keeps its own beat clock (it runs with the transport stopped too)
    const beat = this.auto ? this.auto.beat : ((time - (this.beatOffset || 0)) * (bpm || 120)) / 60;
    const draw = (rig, out, onIt) => {
      let top = null;
      for (const c of active) {
        if (!onIt(this.trackOf(c))) continue;
        if (!top || c.lane < top.lane || (c.lane === top.lane && c.start > top.start)) top = c;
      }
      this._drawCue(rig, out, top, time, beat);
    };
    if (this.auto) {
      if (!projs.length) { if (fb) this._drawCue(fb, null, this.auto.cueFor(0), time, beat); return; }
      projs.forEach((pr, i) => this._drawCue(pr.laser, pr.laserOut, this.auto.cueFor(i), time, beat));
      return;
    }
    if (!projs.length) { if (fb) draw(fb, null, () => true); return; }
    for (const pr of projs) draw(pr.laser, pr.laserOut, (t) => !t || !t.target || t.target.includes(pr));
  }

  _drawCue(rig, out, cue, time, beat) {
    const pat = cue && patternByKey(cue.pattern);
    const m = this.masters;
    if (!pat || m.blackout || m.dimmer <= 0) { rig.blank(); return; }
    const u = Math.min(1, Math.max(0, (time - cue.start) / (cue.duration || 1)));
    let p = resolveLaserParams(cue, u);
    const col = cue.colorRef ? paletteColor(this.palettes, cue.colorRef, beat) : null;
    if (col || m.dimmer !== 1 || m.size !== 1) {
      p = { ...p, brightness: (p.brightness ?? 1) * m.dimmer, size: (p.size ?? 1) * m.size };
      if (col) p.color = col;
    }
    // Animated imports play from the cue's start at its frame rate; the Text
    // pattern draws the cue's text.
    const frame = pat.frames ? Math.floor(Math.max(0, time - cue.start) * (cue.fps || pat.fps || 30)) : 0;
    rig.show(pat, p, out, { frame, text: cue.text });
  }

  /** Laser cues drawing pattern `key` (an imported pattern can't go while used). */
  patternUsers(key) { return this.cues.filter((c) => c.kind === 'laser' && c.pattern === key); }

  // -------------------------------------------------------------- palettes
  paletteById(id) { return this.palettes.find((p) => p.id === id) || null; }

  /** Cues whose colour comes from palette `id`. */
  paletteUsers(id) { return this.cues.filter((c) => c.colorRef && c.colorRef.palette === id); }

  /**
   * Delete a palette. Cues that used it keep the colour they showed (their
   * first referenced colour) as a fixed colour.
   */
  removePalette(id) {
    const pal = this.paletteById(id);
    if (!pal) return;
    for (const c of this.paletteUsers(id)) {
      c.params.color = paletteColor(this.palettes, { ...c.colorRef, mode: 'pick' }) || c.params.color;
      c.colorRef = null;
    }
    this.palettes.splice(this.palettes.indexOf(pal), 1);
  }

  /** Merge the accumulator to DMX: intensity HTP, colour/position LTP. */
  _flush() {
    const m = this.masters;
    const master = m.blackout ? 0 : m.dimmer;
    for (const fx of this.fixtures) {
      if (!fx.profile) continue;
      const a = this._acc.get(fx);
      if (fx.profile.offsetOf('Dimmer') >= 0) writeAttr(fx, 'Dimmer', a ? a.dim * master : 0);
      if (a && a.rgb) writeRGB(fx, a.rgb[0], a.rgb[1], a.rgb[2]);
      if (a && a.pan != null) { writeAttr(fx, 'Pan', a.pan); writeAttr(fx, 'Tilt', a.tilt); }
      if (fx.profile.offsetOf('Trigger') >= 0) writeAttr(fx, 'Trigger', a && a.trig && !m.blackout ? 1 : 0);
      if (a && a.height != null) writeAttr(fx, 'Height', a.height);
    }
  }
}

export const GROUPS = [
  { id: 'movers', label: 'Movers' },
  { id: 'pars', label: 'LED PARs' },
  { id: 'bars', label: 'Bars' },
  { id: 'lasers', label: 'Lasers' },
  { id: 'sparks', label: 'Cold sparks' },
  { id: 'selection', label: 'Selection' },
  { id: 'all', label: 'All fixtures' },
];
