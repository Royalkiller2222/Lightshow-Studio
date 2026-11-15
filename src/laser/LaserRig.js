// A laser projector's renderer: draws the active frame two ways — bright
// additive 3D beams + the graphic shot into the venue, and a flat 2D galvo
// preview drawn on demand into a canvas. Transformed by the cue's parameters
// (Size, Rotation X/Y/Z, Position X/Y, Colour, Brightness, Visible Points,
// Scan), then by the projector's own output settings (size, position, flip,
// brightness limit — see palettes.js).
//
// Every Laser fixture in the rig carries one, mounted on the fixture so it
// moves and rotates with it. A show with no Laser fixtures uses a standalone
// "default projector" at the back of the room, so laser cues always draw.

import * as THREE from 'three';
import { patternSegments } from './patterns.js';

const MAXSEG = 2048;
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();

export class LaserRig {
  /**
   * parent: the scene (standalone) or a fixture's root group.
   * opts: distance, span, position, tilt, body (draw a housing; default true)
   */
  constructor(parent, opts = {}) {
    this.parent = parent;
    this.D = opts.distance ?? 11;     // frame distance from the projector
    this.span = opts.span ?? 4.2;     // half-size of the frame at full Size

    this.group = new THREE.Group();
    this.group.position.copy(opts.position ?? new THREE.Vector3(0, 5.2, -7.5));
    this.group.rotation.x = opts.tilt ?? 0.32; // aim forward + slightly down
    parent.add(this.group);

    if (opts.body !== false) {
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.2, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x14141a, roughness: 0.5, metalness: 0.5 })
      );
      this.group.add(body);
    }

    this._gpos = new Float32Array(MAXSEG * 2 * 3);
    this._bpos = new Float32Array(MAXSEG * 2 * 2 * 3);
    // Per-vertex colour, multiplied by the material colour (= the cue colour).
    // White for built-in patterns; an imported ILDA frame's own colours.
    this._gcol = new Float32Array(MAXSEG * 2 * 3).fill(1);
    this._bcol = new Float32Array(MAXSEG * 2 * 2 * 3).fill(1);
    this._wasColored = false;

    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute('position', new THREE.BufferAttribute(this._gpos, 3));
    gGeo.setAttribute('color', new THREE.BufferAttribute(this._gcol, 3));
    this.gMat = new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.graphic = new THREE.LineSegments(gGeo, this.gMat);
    this.graphic.frustumCulled = false;
    this.graphic.userData.ignorePick = true; // clicking a beam never grabs the fixture
    this.group.add(this.graphic);

    const bGeo = new THREE.BufferGeometry();
    bGeo.setAttribute('position', new THREE.BufferAttribute(this._bpos, 3));
    bGeo.setAttribute('color', new THREE.BufferAttribute(this._bcol, 3));
    this.bMat = new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.beams = new THREE.LineSegments(bGeo, this.bMat);
    this.beams.frustumCulled = false;
    this.beams.userData.ignorePick = true;
    this.group.add(this.beams);

    this.blank();
  }

  /** True while a laser cue is being drawn (the preview shows "live"). */
  get active() { return this._frame !== null; }

  /** Show / hide the whole projector (the default one hides when the rig has its own). */
  setVisible(on) { this.group.visible = on; }

  blank() {
    this.graphic.geometry.setDrawRange(0, 0);
    this.beams.geometry.setDrawRange(0, 0);
    this.gMat.opacity = 0;
    this.bMat.opacity = 0;
    this._frame = null;
  }

  /**
   * Render `pattern` transformed by cue params `p`, then by the projector's
   * output settings `out` (optional). opts: { frame, text } — see
   * patternStrokes().
   */
  show(pattern, p, out = null, opts = {}) {
    const segs = patternSegments(pattern, p.points ?? 1, opts);
    const colored = !!pattern.colored;
    const stride = Math.max(1, Math.round((1 - (p.scan ?? 1)) * 6)); // low scan rate -> sparser/dotted
    _m.makeRotationFromEuler(_e.set(p.rotX || 0, p.rotY || 0, 0));
    const span = this.span;
    const map = galvoMap(p, out);

    // Same galvo-space transform as the 2D preview, then map to metres.
    const to3D = (pt, o) => {
      map(pt, o);
      o.set(o.x * span, o.y * span, 0).applyMatrix4(_m);
      o.z += this.D;
      return o;
    };

    const G = this._gpos, B = this._bpos, GC = this._gcol, BC = this._bcol;
    let gi = 0, bi = 0;
    for (let s = 0; s < segs.length; s += stride) {
      if (gi / 6 >= MAXSEG) break;
      const pa = segs[s][0], pb = segs[s][1];
      if (colored) {
        // the segment takes its end point's colour (ILDA convention)
        const r = pb[2] ?? 1, g = pb[3] ?? 1, b = pb[4] ?? 1;
        for (let k = 0; k < 2; k++) { GC[gi + k * 3] = r; GC[gi + k * 3 + 1] = g; GC[gi + k * 3 + 2] = b; }
        for (let k = 0; k < 4; k++) { BC[bi + k * 3] = r; BC[bi + k * 3 + 1] = g; BC[bi + k * 3 + 2] = b; }
      }
      const va = to3D(pa, _va), ax = va.x, ay = va.y, az = va.z;
      const vb = to3D(pb, _vb), bx = vb.x, by = vb.y, bz = vb.z;
      G[gi++] = ax; G[gi++] = ay; G[gi++] = az; G[gi++] = bx; G[gi++] = by; G[gi++] = bz;
      B[bi++] = 0; B[bi++] = 0; B[bi++] = 0; B[bi++] = ax; B[bi++] = ay; B[bi++] = az;
      B[bi++] = 0; B[bi++] = 0; B[bi++] = 0; B[bi++] = bx; B[bi++] = by; B[bi++] = bz;
    }
    const gGeo = this.graphic.geometry, bGeo = this.beams.geometry;
    if (!colored && this._wasColored) { GC.fill(1); BC.fill(1); } // back to plain white
    if (colored || this._wasColored) {
      gGeo.attributes.color.needsUpdate = true;
      bGeo.attributes.color.needsUpdate = true;
    }
    this._wasColored = colored;
    gGeo.setDrawRange(0, gi / 3);
    gGeo.attributes.position.needsUpdate = true;
    bGeo.setDrawRange(0, bi / 3);
    bGeo.attributes.position.needsUpdate = true;

    const [r, g, b] = p.color || [1, 1, 1];
    const br = (p.brightness ?? 1) * (out ? out.limit ?? 1 : 1);
    this.gMat.color.setRGB(r, g, b); this.gMat.opacity = Math.min(1, br);
    this.bMat.color.setRGB(r, g, b); this.bMat.opacity = 0.13 * br;

    this._frame = { segs, stride, map, color: [r, g, b], br, colored };
  }

  /**
   * Draw the current frame into a 2D context (the galvo preview). Additive, so
   * several projectors can share one preview. Draws nothing when blank.
   */
  drawPreview(ctx, w, h) {
    const f = this._frame;
    if (!f) return;
    const [r, g, b] = f.color;
    ctx.strokeStyle = `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${Math.min(1, f.br)})`;
    ctx.lineWidth = Math.max(1.5, w / 120); // ~1.5 CSS px on the hi-DPI overlay canvas
    const o = { x: 0, y: 0 };
    const sx = (x) => w / 2 + x * w * 0.45, sy = (y) => h / 2 - y * h * 0.45;
    if (f.colored) {
      // one path per run of same-coloured segments (ILDA frames change colour often)
      const a = Math.min(1, f.br);
      let key = '';
      ctx.beginPath();
      for (let s = 0; s < f.segs.length; s += f.stride) {
        const pb = f.segs[s][1];
        const k = `rgba(${(r * (pb[2] ?? 1) * 255) | 0},${(g * (pb[3] ?? 1) * 255) | 0},${(b * (pb[4] ?? 1) * 255) | 0},${a})`;
        if (k !== key) { if (key) ctx.stroke(); ctx.strokeStyle = key = k; ctx.beginPath(); }
        f.map(f.segs[s][0], o); ctx.moveTo(sx(o.x), sy(o.y));
        f.map(pb, o); ctx.lineTo(sx(o.x), sy(o.y));
      }
      if (key) ctx.stroke();
      return;
    }
    ctx.beginPath();
    for (let s = 0; s < f.segs.length; s += f.stride) {
      f.map(f.segs[s][0], o); ctx.moveTo(sx(o.x), sy(o.y));
      f.map(f.segs[s][1], o); ctx.lineTo(sx(o.x), sy(o.y));
    }
    ctx.stroke();
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.parent.remove(this.group);
  }
}

/**
 * Galvo-space transform for one frame: the cue spins, scales and offsets the
 * pattern (Position is independent of Size — BEYOND semantics), then the
 * projector's output scales, flips and offsets the result. Writes {x, y}.
 */
export function galvoMap(p, out = null) {
  const cz = Math.cos(p.rotZ || 0), sz = Math.sin(p.rotZ || 0);
  const size = p.size ?? 1, px = p.posX || 0, py = p.posY || 0;
  const os = out ? out.size ?? 1 : 1;
  const fx = out && out.flipX ? -os : os, fy = out && out.flipY ? -os : os;
  const ox = out ? out.posX || 0 : 0, oy = out ? out.posY || 0 : 0;
  return (pt, o) => {
    const X = (pt[0] * cz - pt[1] * sz) * size + px;
    const Y = (pt[0] * sz + pt[1] * cz) * size + py;
    o.x = X * fx + ox;
    o.y = Y * fy + oy;
    return o;
  };
}
