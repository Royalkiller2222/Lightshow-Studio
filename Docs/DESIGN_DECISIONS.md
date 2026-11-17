# Design decisions — the WHY (read before refactoring)

This file exists because the code reads fine on its own, but several choices look
"wrong" or "over-complicated" until you know what they're protecting against.
Each entry is **Decision → Why → Don't undo it because…**. If you're about to
simplify something and it's listed here, that simplification probably re-breaks a
bug or a constraint we already dealt with.

---

## Platform & constraints

### No build step / no framework / no bundler
- **Decision:** Plain ES modules via an importmap in `src/index.html`; Three from
  `node_modules/three/build/three.module.js`; addons from
  `node_modules/three/examples/jsm/`. No React, no TS build, no Webpack/Vite.
- **Why:** The product ships to non-developers who double-click
  `Start Lightshow.bat`. First run does `npm install` + fetches the Electron
  runtime and just works. A build toolchain would break the one-click promise and
  add maintenance.
- **Don't undo:** Adding a bundler/framework is the single biggest way to make
  this app un-shippable to its actual users. If you need a dev convenience, find
  one that doesn't require an install-time compile.

### Audio decode uses Web Audio, not FFmpeg
- **Decision:** `AudioEngine` decodes with `AudioContext.decodeAudioData`.
- **Why:** Chromium (Electron) decodes mp3/wav/ogg/m4a natively. FFmpeg would be a
  heavy native dependency that complicates the one-click install (same reason
  Enttec USB / `serialport` is deferred).
- **Don't undo:** Only reach for FFmpeg if the user explicitly needs a format
  Chromium can't decode, and even then keep it optional.

---

## DMX core

### UniverseHub is the single source of truth; fixtures read by address
- **Decision:** All channel state lives in `UniverseHub` (1-based, `Uint8Array(512)`
  per universe). Fixtures only know their `universe`+`startAddress` and read
  channel values; they resolve attributes by **name** via `FixtureProfile`
  (`attr('Pan')`), not by magic offset numbers.
- **Why:** Mirrors a real DMX wire. The payoff: **External-console mode drives the
  3D scene with zero extra code** — whether the bytes came from our show engine
  or from QLC+/grandMA over Art-Net, fixtures read them the same way. And decoupling
  channel layout into `FixtureProfile` is what lets a future GDTF importer, the
  patch UI, and paperwork export all read one source.
- **Don't undo:** Don't let fixtures hold their own copy of state or write DMX
  back "for convenience"; don't hardcode channel offsets in fixture scripts again.

### Main process runs a steady 40 Hz output tick, separate from render
- **Decision:** `main.js` mirrors the universe buffers and sends Art-Net/sACN on
  its own `setInterval(25ms)`, independent of the renderer's `requestAnimationFrame`.
- **Why:** A render stall (GC, a heavy frame) must **not** cause gaps in DMX
  output — that would strobe real fixtures. The renderer pushes buffers over IPC;
  the main process paces the wire.
- **Don't undo:** Don't move DMX output into the renderer loop.

### Shutdown: clear the tick before closing sockets (+ guarded sends)
- **Decision:** `window-all-closed` calls `clearInterval(outputTick)` **before**
  `artnetOut.close()`. Senders set `ready=false` in `close()` and wrap
  `socket.send` in try/catch.
- **Why:** The 40 Hz tick was firing once more after the dgram socket closed →
  `ERR_SOCKET_DGRAM_NOT_RUNNING` → an Electron error dialog on exit (reported by
  the user). Three layers of defense so it can't recur.
- **Don't undo:** Keep the ordering and the guards.

---

## Fixtures & placement

### FixtureProfile: channel layout is data, not code
- **Decision:** `FixtureProfile` is `{ name, channels:[{name, offset, bits}] }`.
  Fixtures resolve `attr('Dimmer')` etc. through it; the base `Fixture` exposes
  `attr/attr01/attr16`.
- **Why:** See UniverseHub above — one source of channel truth, GDTF-ready.
- **Don't undo:** This is the seam GDTF import plugs into. Keep it.

### Fixture type registry (`registry.js`)
- **Decision:** `FIXTURE_TYPES` maps a type key → `{ label, onTruss, create(hub, scene, opts) }`.
- **Why:** The "Add fixture" UI, drag-placement, and save/load all go through this
  one seam, so nothing special-cases where a fixture came from. GDTF import will
  register types here too. Every fixture also gets a `typeKey` for serialization.

### dispose() frees per-instance resources but not shared materials
- **Decision:** Each fixture's `dispose()` removes its scene objects and disposes
  geometries/per-instance materials, but **skips module-level shared materials**
  (e.g. `bodyMaterial` shared across all moving heads).
- **Why:** Disposing a shared material would break every other fixture of that
  type. Needed so add/remove doesn't leak *or* corrupt.
- **Don't undo:** Don't "tidy up" by disposing everything in a blanket traverse.

### Selection highlight = material swap, not emissive mutation
- **Decision:** On select, `EditTools` swaps each body mesh's `.material` to a
  shared blue `HILITE` material and restores the originals on deselect. Beams and
  spark points carry `userData.ignorePick`.
- **Why:** Mutating `bodyMaterial.emissive` would light up **all** fixtures that
  share that material. Swapping the per-mesh reference is isolated. `ignorePick`
  means you grab the fixture body, not its (large, invisible-ish) beam cone.
- **Don't undo:** Don't set emissive on shared materials to highlight.

### Placement: mirror-by-default across x=0, snap to 0.5 m
- **Decision:** Drag-in placement mirrors across the venue centre (x=0) by
  default; snaps to a 0.5 m grid. Mirror pairs are linked (`fx.mirror`) so moving
  or rotating one moves/reflects the twin.
- **Why:** The venue is centred on the origin, so x=0 is the natural symmetry
  axis — a standard lighting convention. 0.5 m matches the room floor grid.
  Mirror-rotation reflects as **(pitch, -yaw, -roll)** across the YZ plane.
- **Don't undo:** The room is centred on origin on purpose; keep it.

### Move/Rotate use a Three.js TransformControls gizmo, rotation is full 3-axis
- **Decision:** `EditTools` uses `TransformControls` for Move (X/Y/Z) and Rotate
  (X/Y/Z rings, snapped to 45°), driven through a proxy object. Rotation is a full
  Euler `[x,y,z]` on every fixture (`_rotObject()` in the base class).
- **Why:** Standard 3D-editor feel, discoverable. It started yaw-only (the ask was
  "rotate at 45°") and was widened to 3 axes when the user wanted it. The
  pointerdown listener is **window capture-phase** so grabbing a fixture pre-empts
  OrbitControls before it starts an orbit.
- **Gotcha:** `scene.add(transformControls)` is valid in three r0.165 (the helper
  split came later). Project files store rotation as `rot:[x,y,z]` (old `yaw`
  number still loads via back-compat).

---

## The beam shader (the trap)

### Beams are a fresnel cone shell, and the fragment must NOT read distance-from-axis
- **Decision:** `src/viz/beam.js` renders a unit **cone shell** (lateral surface,
  apex ring + end ring) with a **fresnel** fragment (bright toward the silhouette)
  and `computeVertexNormals()` on the geometry.
- **Why / the trap:** The original shader computed `radial = f(length(vPosOS.xy)/radiusAtZ)`.
  On a cone *shell*, every fragment sits exactly at the cone radius → `r ≡ 1` →
  `radial ≡ 0` → **the beams multiplied to zero and never rendered at all.** This
  was the actual cause of the "haze does nothing / no cones" bug. There is no
  per-fragment "distance from the beam axis" available on a shell, so the
  brightness comes from a fresnel term instead.
- **Don't undo:** If you "simplify" the beam shader back to reading radial distance
  from `position.xy`, the cones go invisible again. The geometry is a shell; you
  cannot sample interior radius. Keep the normals + fresnel.
- Intensity values were tuned against ACES tonemapping + bloom and the
  Room-brightness exposure control; big changes there wash the cones out.

---

## Audio / timeline / clock

### Transport is the master clock; one BPM source of truth
- **Decision:** `Transport.time` follows `AudioEngine.currentTime` when a track is
  loaded, else free-runs. BPM lives on the transport; the one BPM field (top bar)
  writes `transport.bpm`, and the engine and beat grid read it.
- **Why:** Demo is alive on launch with no track; locks to the song when loaded.
  Two BPM inputs (sidebar + timeline) diverging was a real bug — single source
  fixes it, and the remake reduced it to a single field.

### With no track, the free-running clock loops at the show's end
- **Decision:** `app.js` sets `transport.loopEnd` = the last cue's end every
  frame; with no audio loaded, `Transport.update` wraps to 0 there.
- **Why:** The seed show is 16 s long, and the free-run clock used to run forever
  — the app went dark after 16 s and the playhead walked off the timeline. "It
  launches with a working show" is a core promise. With a track loaded the audio
  clock rules and stops at the track's end as before.

### Auto-BPM: band onsets, repetition, folding (rebuilt in v0.17.0)
- **Decision:** `src/audio/bpm.js` `analyzeTempo()` works in five steps (the
  file's header has the detail): onsets per third-octave band, each compared
  with the last 100 ms; a beat period (70–180 BPM) scored by how well the
  song repeats after 1, 2, 4, 8 and 16 of it; the song folded onto that
  period to sharpen it to about 0.01 BPM; half / double / other relatives
  chosen by the energy on the beats; whole tempi preferred when they fold
  just as sharply. It returns `{ bpm, offset, confidence, alt, margin }`.
- **Why it replaced the old one** (energy-onset autocorrelation + parabolic
  interpolation, ~±1 BPM): tuning Auto on a real track showed that
  everything else stands on the grid. One BPM off drifts a bar within a
  minute, and a full-band energy envelope takes a wobbling synth or a
  tremolo for a drum roll. Comparing each band with a 100 ms window instead
  of the previous frame is what stops that.
- **Half/double is a judgement call, so the user gets buttons.** 82 and 164
  both fit the same music. The detector picks one and reports the runner-up
  (`alt`, `margin`); when it's close, the "Loaded" message says so, and
  **÷2 / ×2** sit next to the BPM. They find the beat again for the new
  tempo (`beatOffsetAt`).
- **Bar 1 = the first downbeat.** After detection, `alignBars()` moves
  `beatOffset` to the analysis's drop-anchored bar start, so the ruler's bar
  numbers match the music and Auto's bars. The inspector field is called
  "Bar 1 starts at" for the same reason.
- **A hand-set tempo wins for its song.** Typing a BPM, ÷2 / ×2 or editing
  "Bar 1 starts at" sets `transport.byHand` (saved as `tempoByHand`).
  Loading the same song again (opening a show, then its song) keeps it;
  another song is detected fresh.
- **The window blocks for a second or two** while it listens, so a
  "Listening to…" message is shown and painted first. No worker: the
  analysis is pure and fast enough, and a worker would need the samples
  copied or transferred.
- **Don't undo:** the 100 ms reference window, and trying the relatives
  (step 4). Both were added for failures on real music.

### Timeline window grows to fit cues (so resize grips stay reachable)
- **Decision:** With no audio, the timeline window = `max(30, longestCueEnd + 4)`.
  Seeded cues have **finite** durations (16 s), not 3600 s.
- **Why:** A 3600 s seed cue put its right-edge resize grip off-screen (reported
  bug). Finite durations + a growing window keep every cue's grip reachable and
  let you drag-extend a cue past the default window without a track loaded.

### Canvases sit absolutely inside a sized wrapper
- **Decision:** Every timeline canvas — ruler, waveform, curve lanes
  (`.tl-cv`, `.crv-body`) — is `position:absolute; inset:0` inside a wrapper
  whose size comes from layout.
- **Why:** A canvas in a flex column feeds its backing-store size (which we set
  from its CSS size × devicePixelRatio) back into layout and grows every frame;
  before the remake that squeezed the waveform to 0 px and ballooned the curve
  editor to 350 px.
- **Don't undo:** Keep canvases out of the flex/grid size calculation.

---

## The cue & effect model (this is where the design is still moving)

### Why the fixture-cue model is "per-attribute" — and why the user found it unintuitive
- **What it is:** A fixture cue runs **one** per-attribute effect — Intensity
  *or* Colour *or* Position (`effects.js`, grouped by `attr`). Effects are
  waveform-driven (shape / rate / beat-sync division / size / base / phase / fan /
  direction / duty). You build a "look" by **stacking** an intensity + colour +
  position cue on different lanes.
- **Why it was built this way:** It's the console-correct attribute model and it's
  powerful (independent per-attribute automation, clean HTP/LTP merge).
- **Why the user pushed back:** A single cue is never a complete look — a lone
  Colour cue shows nothing (no brightness), so you must mentally compose 2–3 cues.
  Too steep a mental model for this user's workflow. **This is the friction that
  triggered the laser pivot.** Keep this context: don't "fix" it by collapsing
  effects back into monolithic looks — that was the *old* model we moved away from
  for a different reason (it couldn't layer).

### Merge: intensity = HTP, colour/position = LTP (automatic, per attribute)
- **Decision:** Effects write to the engine **sink** (`c.out.dimmer/rgb/panTilt`).
  The engine accumulates per fixture and flushes once: **intensity takes the max
  across cues (HTP)**, colour/position take the last writer in lane order (LTP,
  lane 0 = top wins).
- **Why:** Standard console behaviour — a base wash at 40% plus a beat-pulse layer
  should ride to 100% on the beat and stay at 40% between (HTP), not get replaced
  down to 0. Colour/position want a single owner (LTP). This replaced an earlier
  per-cue HTP toggle; making it automatic-per-attribute is more correct and less
  for the user to think about.
- **Don't undo:** Effects must not write the hub directly; they go through the
  sink so the merge can apply. The flush is also the per-frame blackout (a fixture
  no cue touched reads 0).

### Groups are resolved by fixture type (for now)
- **Decision:** `ShowEngine.groupFixtures('movers'|'pars'|'bars'|'lasers'|'sparks'|'selection'|'all')`.
- **Why:** Good enough until user-defined groups land (a V2 item). "Selection" =
  the current viewport selection (fed in each frame).

### The laser pivot — cue = pattern, effects = BEYOND's 7 "Key Effects"
- **Decision:** A `kind:'laser'` cue is a **vector pattern** (`src/laser/patterns.js`)
  plus seven parameters as values: **Size, Rotation X/Y/Z, Position X/Y, Colour,
  Brightness, Visible Points, Scan Rate**. `LaserRig` renders the top active laser
  cue as **both** 3D beams-into-the-venue **and** a flat 2D galvo preview canvas.
- **Why:** The user wants parity with **Pangolin BEYOND** (they shared a
  screenshot). In BEYOND, a cue is laser *content* and effects are modifiers you
  keyframe. That model is far more intuitive for a laser show than stacking
  per-attribute fixture cues: one cue = one complete pattern you tune in place.
  The 7 parameters are exactly BEYOND's "Key effect" list.
- **Rendering choice — "Both":** the user explicitly chose both the 3D volumetric
  beams (fits our venue + haze) and the flat galvo preview (BEYOND's projector
  windows). Not either/or.
- **Status:** **Stage 1 done** (patterns + 7 params as *values* + render + timeline
  + save/load). **Stage 2 done** (keyframe envelopes — see below). Stage 3 =
  multiple projectors/zones + palettes + an audio-reactive auto-preset for live
  song visualizing.
- **Don't undo:** Fixture cues stay for hybrid shows. The laser system is the
  strategic focus; build toward BEYOND, don't collapse the two cue kinds together
  prematurely.
- **Laser cues are visual-only.** Nothing writes laser cues to DMX or ILDA yet;
  the `LaserProjector` *fixture* is a separate DMX-driven model. Bridging the two
  (laser cue → DMX laser channels, or real ILDA/galvo output) is open.

### Size and Position are independent (same transform in 3D and in the preview)
- **Decision:** Both `LaserRig` paths transform a galvo point as rotate-Z →
  `X*size + posX` → (3D only) tilt by rotX/rotY and map to metres.
- **Why:** Stage 1's 3D path added the position *before* scaling, so in the venue
  Position moved with Size while the 2D preview didn't — the two views disagreed.
  BEYOND semantics: Position is where the frame sits, Size scales it in place.
  A Node check compares the 3D buffer against the preview's canvas calls.

### Keyframe envelopes are an overlay on static params (`cue.anim`)
- **Decision:** `cue.params` keeps a plain static value for every parameter;
  `cue.anim[key] = { ease, keys:[{t, v}] }` (optional) overrides it while the cue
  plays. `resolveLaserParams(cue, u)` returns `cue.params` itself when nothing is
  animated.
- **Why:** The earlier plan was polymorphic params (a scalar *or* a keys object).
  That would make every consumer type-check (`LaserRig`, the inspector, the
  `{...params}` copies in save/undo). With an overlay, old saves load unchanged,
  `LaserRig` still only sees numbers, an un-animated cue costs nothing per frame,
  and removing an envelope just freezes its current value back into `params`.
- **Don't undo:** Don't fold envelopes into `params`.

### Key time is normalised 0..1 across the cue
- **Decision:** `t` = fraction of the cue (BEYOND's 0–100% "effect based on
  time" strip), not seconds.
- **Why:** Moving a cue carries its animation with it, and resizing a cue to fit
  the music stretches the animation to fit too — the common case when you extend
  a cue. Trade-off: after a resize, keys no longer sit exactly on the beats they
  were snapped to. Snapping is done against the absolute beat grid at edit time.

### Keying works like After Effects, plus BEYOND's auto-key
- **Decision:** Once a parameter is animated, changing it in the inspector writes
  a key at the playhead; it never silently edits the hidden base value. The ◆
  button keys the current value explicitly (the "start animating" gesture). The
  **Auto-key** toggle (BEYOND's "Enable auto-keying") makes edits to static
  parameters key too. Animated parameters' sliders follow the playhead live.
- **Why:** Without this, moving the slider of an animated parameter would change
  `params` while the envelope keeps overriding it — "I moved it and nothing
  happened". Paused edits key *exactly* at the playhead so the control keeps the
  value you set; edits and ◆ presses **during playback** quantise to the
  half-beat grid, so tapping ◆ lands on the beat and a slider drag records at
  most one key per half-beat instead of one per frame.

### Envelope editing details
(Since v0.4.0 keys are edited in the timeline's curve lanes — see "Keyframe
curves live under the track"; these rules carried over unchanged.)
- **One key per time:** `setKey` updates a key within `KEY_EPS` (0.3% of the cue)
  rather than inserting; dropping a dragged key onto another replaces it (AE).
- **Snapping:** keys snap to the half-beat grid aligned to the detected downbeat
  (`beatOffset`), and to the cue's ends; **Shift** = free. Laser hits land on
  beats and half-beats, and this matches cue snapping to beats.
- **Seek on key:** while paused, pressing or releasing a key moves the playhead
  to it, so the inspector shows and edits that key's value.
- **Ease is per envelope** (`linear` / `smooth` / `step`), not per key. That covers
  the BEYOND basics; per-key bezier handles are a later refinement.
- **Colour interpolates in RGB** (simple, predictable). HSV interpolation sweeps
  through hues, which could become an option.
- **Del on a focused curve lane never reaches the global handler**, which would
  otherwise delete the selected cue, track or fixture.

### `LASER_PARAMS` is the single source of truth for laser parameters
- **Decision:** `src/laser/envelopes.js` declares each parameter's key, label,
  range, step and display format. The inspector rows, the envelope editor's
  value axis and `loadAnim` (save-file sanitising) are all built from it.
- **Why:** In Stage 1 the laser inspector reused the fixture sliders: Size was
  capped at 1 (a laser zooms *up*, so the range is now 0–2), and rotation showed
  raw radians with no readout. Rotation is **stored in radians** (what `LaserRig`
  consumes, so saves need no migration) and **displayed in degrees**.

### Projectors are fixtures; tracks target them (Stage 3a, v0.8.0)
- **Decision:** a Laser projector fixture *is* the projector — it owns a
  `LaserRig` mounted on its body. Laser tracks (not cues) choose projectors:
  `target = null` means "all", which is the default.
- **Why:** BEYOND's zones map to physical projectors, and users already place
  fixtures in Build — a separate "projector list" would duplicate the rig.
  Targeting per track (not per cue) matches how fixture tracks already drive a
  group, and a new projector automatically picks up every "all" track, so
  adding hardware never silently leaves it dark.
- **Each projector shows one cue** — the top active audible one among its
  tracks — like a real projector playing one frame. Layering is done with tracks.
- **Default projector:** with no Laser fixtures the old standalone rig plays
  everything, so v3 shows and empty venues still show their lasers.
- **Output settings live on the projector**, applied *after* the cue transform
  (flip/size, then offset) so one show adapts to different mounts — the
  BEYOND "projection zone" idea. A mirrored placement flips the twin's X.
- **Renamed the type to "Laser projector"** because default names "Laser 1"
  collided with the demo's laser track "Laser 1" and hid the "plays on" label.

### Palettes are referenced, not copied (Stage 3a)
- **Decision:** a cue stores `colorRef` (palette id + pick/cycle) instead of
  copying colours; editing a palette changes every cue using it. Deleting a
  palette **bakes** the cue's current pick colour into `params.color` so nothing
  turns white.
- **Cycle runs on song beats** (aligned to `beatOffset`), not cue-local time,
  so several cues cycling the same palette stay in step. Beat rates are a small
  fixed set (½–8 beats) — enough for shows, nothing to type.
- The palette colour replaces `params.color` (and any colour envelope) while a
  palette is in use; the Colour row is hidden to make that obvious.

### ILDA imports live in the show file (Stage 3b, v0.9.0)
- **Decision:** an imported `.ild` is decoded once and stored **inside the show
  JSON** as compact base64 (8 bytes/point), not as a path to the original file.
  A show stays one self-contained file that opens on another PC, and undo
  (whole-JSON snapshots) carries imports for free. Decoded strokes are cached
  per data string so undo/redo doesn't re-decode.
- **Colours tint, not replace:** imported points keep their own colours and the
  cue colour multiplies them; new cues on an imported pattern start white. That
  keeps palettes/envelopes useful on imported art without destroying it.
- **Removal is guarded:** an imported pattern used by any cue can't be removed
  (the toast says how many use it) — deleting it would leave cues drawing
  nothing. Unused ones remove with undo.
- **Limits** (20 MB, 600 frames, 4000 points/frame) keep the show file and the
  renderer (≤ 2048 segments) sane; what got cut is reported.
- **Black = blank:** many exporters blank by colour instead of the status bit,
  so black points are treated as blanked.

### Text uses a 14-segment font (Stage 3b)
- Laser text is drawn as straight segments (like a scanner font), not
  outlines from a system font: no font files, no canvas text measuring, fast
  to draw, and it looks like laser lettering. Up to 12 characters, upper case.

### Auto: live and pregenerated, one set of settings (Stage 3c, v0.10.0)
- **Two modes, because they can know different things.** Live only hears
  "now", so it reacts: smoothed slow/fast levels, a drop = the fast level
  jumping well above the slow one, a breakdown = it falling well below.
  Pregenerate sees the whole song, so it can plan: sections, ramps through
  builds, a blackout gap *before* a drop, a pulse on every kick. The user asked
  for both; the settings (intensity, change rate, colours, pattern groups,
  pairs) are shared so they feel like one feature.
- **Pregenerate writes ordinary cues**, not a special "auto" object: the show
  stays editable with every existing tool, plays without the analyser, and
  saves/undoes like anything else. Its tracks and markers carry `auto: true`
  so a new take replaces exactly what Auto made (and nothing the user made);
  edits to Auto cues are lost on regenerate, which the dialog says.
- **Auto tracks go to the top** (lane 0 wins the laser), so a generated show
  plays over hand-made laser tracks without deleting them. Mute or delete the
  Auto track to get them back.
- **Live Auto overrides the laser tracks** while it's on (`engine.auto`), and
  is a performance control like the masters: on/off isn't saved or undoable,
  and leaving Live turns it off so Program never shows a timeline that isn't
  what's playing.
- **Repeatable takes:** generation is seeded (mulberry32); same song + settings
  + seed = same show. Each "new take" uses the next seed.
- **Pairs (3c: odd / even projectors; since v0.17.0: left / right of the
  stage, see "Sweeps and one-sided sounds").**
- **Cheap analysis, no FFT (3c; replaced in 5a, see below):** two one-pole filters split bass/highs; bars and
  beats come from the detected BPM grid. A 4-minute song analyses in well under
  a second, and values are normalised to the song's own loud bars, so quiet and
  loud masters give the same show. If the BPM is wrong, sections drift — the
  dialog tells the user to check it.
- **Sound input is listened to, never played back** (its analyser isn't
  connected to the speakers), with echo cancellation / noise suppression off
  so music isn't treated as noise. With no sound, Auto keeps going on the
  beat instead of freezing.

### Content-aware Pregenerate (Stage 5a, v0.14.0)
- **Rules on real features, not machine learning.** The user asked for Auto
  to "understand drops, when to change lasers, emotion". A trained model
  would need a runtime and a dependency (hard constraint 4) and couldn't be
  tuned by reading it. EDM structure is regular enough for rules on good
  features, and every rule can be explained and tested on a synthetic song
  (`src/auto/` stays pure and Node-testable).
- **An FFT after all.** 3c's two one-pole filters couldn't tell a riser from
  a lead or a snare roll from hats. Our own 1024-point radix-2 FFT (hop =
  1024, about 30 lines, no dependency) gives 5 bands, brightness (centroid),
  low/high spectral flux and high-band flatness ("noise"). 2.5 minutes
  analyse in about 0.2 s.
- **Tension is the build detector.** Builds are where the snare rate, noise
  and highs climb while the bass leaves: `tension` per bar, and a build is
  the last 16/8/4 bars before a drop whose tension climbs quarter by quarter
  and which don't start louder than they end. That second check stops a
  build from swallowing the tail of the previous drop.
- **Drops anchor the grid** (since v0.17.0 the timeline's bar 1 follows too,
  see "Auto-BPM"). Auto-BPM's downbeat can be a beat off; drops are
  the most reliable bar ones in dance music, so beat-level bass lifts vote on
  the phase (only moved with ≥ 60% of votes), and section cuts snap to the
  4-bar grid counted from the first drop.
- **Sections from change, kinds from content.** Cuts come where the feature
  vector jumps (novelty), plus forced cuts at drops and build starts. A
  "break" needs a real drop in energy from the section before it, otherwise
  it's a verse.
- **Mood = energy × brightness** (euphoric / aggressive / dreamy / dark), a
  simple valence-arousal map. The user chose "audio + optional mood": each
  section's mood comes from the audio unless an overall Mood is set. Mood
  picks the palette, the speed, the hold length and weights the patterns
  (`PATTERN_FEEL`).
- **Direction follows how designers program.** Changes on phrase boundaries
  (and right after a fill, the musical "here comes something"); a build is
  one rising cue, not many; a dark gap of ¾ beat before a drop so the drop
  hits; the drop opens in unison with a flash; the strongest patterns are
  saved for the biggest drop and earlier drops stay smaller, so the show
  has an arc; repeats reuse their looks (motifs) and grow a little.
- **Mood palettes are added to the show when used,** as ordinary palettes,
  so cues can reference them, they save and undo, and the user can edit
  them. Live Auto keeps its own three (Ice / Fire / Club).

### Sweeps and one-sided sounds (v0.17.0)
The user asked for two things after hearing Auto on their own track: "analyze
when audio sweeps, and copy that in laser sweeping", and "if one sound is
mainly happening on one side, change only one laser until it returns to
normal stereo".
- **A sweep is the brightness gliding.** Per frame, `tilt` is the
  log-frequency centroid (in octaves, 150 Hz–16 kHz); silence holds the last
  value. After smoothing, a leg between two turning points is a sweep when
  it travels ≥ 0.7 octave in 0.4–12 s and no faster than 4 octaves a second
  (steeper is a hard cut between sections, smeared by the smoothing).
- **The glide is a leaky integral, not the brightness itself.** The lasers
  shouldn't sit high just because a section is bright. Inside a sweep the
  glide adds the change (1 octave ≈ full travel, through tanh so it can't
  stick at the limit); outside it drifts home in about 2 beats. So a filter
  opening raises the pictures, and they come back when it stops.
- **Sweeps move every picture up and down** (`posY`), both sides together.
  Position is the one Key Effect Auto didn't already use, it reads as
  "sweeping" in the room, and up = brighter matches how people describe
  pitch and filters. Depth follows Intensity (0.3 / 0.45 / 0.6 of the
  field). Pregenerate writes simplified keys onto each cue, so the user
  can see and edit them.
- **One-sided = clearly off the song's own balance.** A mid/side FFT gives
  left and right levels per band above 250 Hz (bass is mono in practice and
  would drown the rest). Each band's lean is normalised by its own loud
  level, and the song's slow lean (median over ±8 s) is subtracted, so a
  mix that sits slightly left everywhere isn't one long "left" moment.
  Hysteresis (on 0.2, off 0.08) and a minimum length keep it from
  chattering.
- **Pairs = stage sides.** Lanes used to be odd / even projectors. To
  change "the left laser", lane A is now the projectors left of the rig's
  middle and lane B the ones right of it (centre-line projectors take
  turns), and the tracks are named Auto Left / Auto Right. Projectors all
  in one line front to back have no sides and keep odd / even (Auto A / B).
- **Left is the audience's left, and the left channel.** The audience
  stands on +z looking at the rig, which is also the camera's home view. A
  projector's own picture can be mirrored relative to that (it may face the
  other way), so the lean is multiplied by the sign of the projector's
  world x axis (`leanSign`).
- **Two lanes → an accent cue; one lane → a lean.** With a lane per side,
  "change only one laser" is literal: the side's cue is cut, a short accent
  (another pattern, brighter, the next palette colour) plays for the sound,
  and the cut look resumes exactly where it would have been (envelopes are
  sliced, the palette runs on song beats). With one projector or Pairs off
  there is no "one laser" to change, so the picture leans towards the sound
  (`posX`) and returns. Same-side sounds closer than half a beat merge, so
  the old look doesn't flicker between them.
- **Ordinary cues again.** Accents and Position keys are plain cues and
  envelopes: editable, saved, undone, and played without the analyser.
- **Live Auto has its own, simpler versions**, because it only hears now:
  the glide is fast brightness minus slow brightness (past a dead zone);
  a side is the lean of two per-channel analysers against its own slow
  average. Sound input is mixed to one analyser, so it follows sweeps only.
- **Two switches, both on by default** (Follow sweeps, Follow sides; Pro in
  Live, always in the dialog). The dialog draws what was heard under the
  energy chart, so the user can see why the lasers moved before generating.
- **Look length follows the tempo.** "With the music" used to mean a fixed
  number of bars. On an 82 BPM track a bar is almost 3 s, and looks held
  twice as long as intended. The bar counts are now scaled by a power of
  two against a 1.875 s reference bar (128 BPM). A chosen "every N bars"
  is left alone.
- **Drops merge only when they sound alike.** Two drops in a row with a
  different sound (distance ≥ 0.18 between their feature vectors) stay
  separate sections with their own looks; phrases of one drop are about
  0.1 apart.
- **Tuned on one real track so far.** The thresholds above were set on it
  and on the synthetic test song. Expect to revisit them as more songs
  arrive.

### The song map (Stage 5b, v0.15.0)
- **Correct the analysis, don't replace it.** Rules get real songs wrong
  sometimes: a drop with no bass lift, a quiet verse heard as a break. The
  user picks a section and changes its type or mood. Everything else
  (bars, energy, fills, the rest of the sections) still comes from the audio.
- **Edits are keyed by start time** (matched within half a bar), not by
  index. Re-analysing the same song lands the same cuts, so the edits
  survive; if the BPM changes and the cuts move, unmatched edits just don't
  apply.
- **Tied to the song** by its name + length (`songMapFits`). Loading another
  track starts with a clean map, without deleting the saved one.
- **Kept as edits, applied late:** `applySongMap` is a pure layer over the
  cached analysis, so the expensive pass never reruns for an edit. Names,
  drop hits (a relabelled drop "hits" unless it continues a drop) and repeat
  groups are worked out again. Relabelled sections of one kind share a motif.
- **A section's own mood beats the overall Mood**: the more specific choice
  wins, so "Dreamy show, Aggressive last drop" is possible.
- Edits are show data, so they save, undo and redo like any other edit.

### Importing an MVR rig (Stage 4a, v0.11.0)
- **Rig only, mapped to our types.** We don't simulate GDTF fixtures channel
  by channel; each MVR fixture becomes one of our fixture types, so it works
  with looks, effects, Live and Auto at once. The 3D view matches the plot,
  but the DMX layout is ours — the dialog says so.
- **The guess is explainable and overridable.** Rules in order: laser/Kvant
  in the name → laser; spark/flame → cold spark; GDTF has Pan and Tilt →
  moving head; batten/cyc → batten; pixel/tube/strip/bar → pixel bar; no GDTF
  but a mover-ish name → moving head; else LED PAR. The dialog shows the
  reason ("pan + tilt") per kind of fixture, and the user can change it.
- **Addresses: keep or re-patch.** Plots pack real fixtures by their real
  footprints, and ours differ (a 3-channel PAR is 5 channels here), so
  keeping the plot's addresses can overlap. The dialog counts the overlaps
  and defaults to Re-patch when there are any; Re-patch starts each fixture
  in its own universe and moves on when it's full.
- **Orientation:** MVR is Z-up in millimetres with +Y upstage; the scene is
  Y-up in metres with the stage back at -Z, so position = (x, z, -y)/1000
  and rotation R' = C·R·Cᵀ. GDTF fixtures rest hanging, beam down — the same
  as our truss fixtures at rotation 0 — so those copy R' directly. Our laser
  rests aiming forward, so it gets R'·Rx(90°); if that still points at the
  floor (plots often leave the symbol un-rotated), it keeps our default aim.
  Spark machines and podiums stand on the floor.
- **No dependencies:** MVR and GDTF are zips of XML. A ~70-line zip reader
  (DecompressionStream does the inflating) and a ~100-line XML parser run in
  both Electron and Node, so the importer is tested headless. DOMParser was
  avoided because Node doesn't have it.

### Importing a QLC+ workspace (Stage 4b, v0.12.0)
- **One dialog, many sources.** Each importer hands `ImportRigDialog` a
  source adapter (kinds of fixture, `plan(opts)`, shows, `buildShow()`);
  the shared pieces (type guess, placement finish, addressing) live in
  `import/rig.js`. xLights (4c) plugs in the same way.
- **Shows become looks, not channel data.** A `.qxw` has no fixture
  definitions, so we can't know what channel 7 of a "Martin MAC" means. We
  read values only where the layout is certain (generic RGB / RGBW / dimmer)
  and otherwise take colour from the function's name. Each QLC+ function
  becomes a look in our effects with the **exact** start, length and speed
  (`sync: false`, rate in Hz from QLC+'s milliseconds), because timing is
  what a programmer cares about most and what we can carry over faithfully.
- **Tracks per group.** Our cues target a fixture group, so a QLC+ track that
  drives PARs and movers splits into "Wash · PARs" and "Wash · Movers".
- **Lasers get laser cues.** A DMX laser in QLC+ becomes a laser track (beams
  in the cue's colour, a tunnel when it moved), since our projectors are
  driven by laser cues, not fixture looks.
- **Positions:** the 2D Monitor is read as a top view (mm from the grid's
  upstage-left), at our truss height; without it, fixtures hang in rows by
  type, each row centred.
- **Replace the timeline** clears tracks, cues and markers; the show's BPM
  is taken only when no song is loaded (a loaded song's detected tempo wins).
  The whole import is one `history.record()`.

### Importing an xLights sequence (Stage 4c, v0.13.0)
- **A sequence onto the current rig.** An `.xsq` names models but doesn't
  define them (that's `xlights_rgbeffects.xml` in the show folder), so we
  don't build a rig: each model is mapped to one of our fixture types — and
  so a group — guessed from its name (most xLights models are pixels, so the
  default is pixel bars) or left out. The dialog's kind rows are the models,
  with "Not imported" as an extra choice (`allowSkip` on the source).
- **A track per model,** not per group: xLights users think in models, and
  it keeps a model's layered effects together. Cues on several tracks that
  share a group merge as usual (HTP / LTP).
- **Effects by name.** Pixel effects can't be reproduced on our fixtures, so
  each effect name maps to the closest look: chases are beat-synced (they
  follow the song you load), Color Wash fades over the cue (`ramp` at
  1/duration Hz, cue-local time), flickers use the `random` wave, VU Meter
  uses the audio band. Colours come from the palette's *checked* colours
  (the first stop of a gradient); brightness from `C_SLIDER_Brightness`.
- **Markers from one timing track,** chosen in the dialog; the default is the
  track with the most labels and at most 200 marks (beat tracks would bury
  the ruler). A track named "Beats" gives the BPM (median gap, folded into
  70–180) when no song is loaded.

---

## Project persistence & undo

### Save/load = JSON snapshot; audio is NOT embedded
- **Decision:** `serializeProject()`/`applyProject()` (`src/core/project.js`)
  round-trip room + fixtures (type/patch/pos/rot/mirror) + cues (fixture and
  laser) + settings to JSON. Audio is re-imported on load (only its name is
  stored). Opening a file shows a notification ("Opened x: N fixtures, M cues",
  plus a reminder to re-load the song); the file name becomes the show name.
- **Why:** JSON is simple and already drives undo. Embedding audio needs a zip
  container (a later item). The notification exists because a silent load failure
  (or loading an old/empty file) looked like "cues vanished" — now you see exactly
  what the file contained. Old files without cues are almost always an older save
  or the wrong `lightshow-project (N).json`.
- Output settings (Art-Net IP, sACN) are **not** in the show file — they belong
  to the computer/network, so they're remembered per machine instead.

### Undo/redo = whole-project snapshots (not a command pattern)
- **Decision:** `history` snapshots the full serialized project on each committed
  edit; undo/redo re-applies a snapshot (100 deep).
- **Why:** Reuses the serializer, so it covers everything (fixtures, cues, room,
  BPM, haze/brightness, laser envelopes) with a one-line `history.record()` hook
  per action. Simple and robust for this scale.
- **Undo keeps your place:** undo/redo call `applyProject(..., { keepTransport:
  true })` and re-select the cue and the fixture at the same index (cue and
  patch order are stable in the snapshot). Edits happen at the playhead / on the
  selection, so jumping to 0 and clearing the inspector on every Ctrl+Z (the old
  behaviour) lost the user's place. Loading a file still stops the transport.
- **"Edited" flag:** `History` remembers the snapshot at the last save/open;
  "Edited" (and a • in the window title) shows whenever the current snapshot
  differs — undoing back to the saved state clears it, which a simple "changed
  since save" boolean wouldn't.
- Saved envelopes go through `loadAnim()` (drops unknown parameters and malformed
  keys, clamps and sorts) on both load and undo, so a hand-edited file can't
  break playback.

---

## The interface (V2 remake, Oct 2026)

The user asked for the app to be "as user friendly and simple as possible with
advanced things — pros and beginner friendly". Every choice below was made by
the user from multiple-choice options after seeing a mockup; the recommended
option won each time. **Don't re-litigate these** — refine within them.

### Workspaces: Build / Program (Live later), one shared 3D view
- **Decision:** Tabs in the top bar switch the *task*: Build (fixture library,
  fixture/venue inspector, patch sheet) and Program (pattern + effect library,
  cue inspector, timeline). The 3D view never changes. Live arrives in remake
  Stage 4 ("perform the programmed show": section pads from markers, masters,
  blackout, sparks, fullscreen); the auto-preset joins it in laser Stage 3.
- **Why:** Beginners follow the tabs left to right; pros jump straight to the
  one they need. Each screen only shows what that task needs, instead of one
  sidebar holding everything. The tab doesn't exist until its content does — no
  "coming soon" UI.
- **How:** all panels are mounted once; CSS hides `[data-ws-only]` content for
  other workspaces. Panel sizes are remembered *per workspace* (Build wants a
  wide library; Program a tall timeline).

### Simple / Pro = a global switch *and* "More" rows
- **Decision:** Simple shows the essentials only; Pro shows everything, with
  rarely-used controls inside collapsible "More" rows that remember being open.
  `.pro` = only in Pro; `more()` = a "More" disclosure (Pro only).
- **What counts as Pro today:** DMX universe/address/channels (fixtures are
  auto-patched, so beginners never need them), extra rotation axes, laser
  tilt X/Y, visible points, scan rate, auto-key and easing, fixture-effect
  waveform details, the beat-offset field, external-console mode and sACN.
- **Why:** The user chose "Both". A switch alone hides features people later
  can't find; More rows alone still crowd beginners. Default is Pro; the
  welcome screen (remake Stage 5) asks on first run.

### Look: "Studio graphite"
- **Decision:** Neutral dark greys with a single blue accent (`--accent`).
  Colour is reserved for show content — beams, laser green, fixture-cue blue,
  keyframe amber, the pink playhead.
- **Why:** Chosen over "Neon club" and "Laser green": the UI must never compete
  with the show being designed, and it reads as a calm pro tool.
- **Themes (v0.18.0):** graphite stays the default ("Dark"). The user asked
  for **Blackout** (near-black, dim text, for dark venues), **Light** and
  **Custom** (14 pickable colours) in a new Settings dialog. All four are
  token sets: `data-theme` on `<html>` switches a `:root[data-theme=…]` block
  in `style.css`; Custom writes its 14 picked tokens inline on `<html>` and
  the `:root[data-theme="custom"]` block derives the rest (hover shades,
  `-soft`/`-hi` variants, dim text) with `color-mix`, so a user can't pick an
  inconsistent half-theme. `data-tone` (light/dark, from the
  luminance of the panel colour) picks scrims, shadows and dark cue-clip labels for a light
  custom theme. `ui/theme.js` owns it; the choice is a per-computer pref
  (`lss.theme`, `lss.theme.custom`), never in the show file.
- **What stays dark:** the 3D view, the galvo preview and the pattern
  thumbnails are *show content* — they keep the room's look in every theme
  so a laser looks the way it will in the venue.
- **Canvases read tokens too.** Every hard-coded UI colour (timeline canvas,
  Auto chart, cue clips) became a token (`--tl-*`, `--on-accent`, `--scrim`,
  …). Canvas code calls `tc('--name', alpha)` (`theme.js`), which resolves a
  token through a probe element and caches it until the theme changes —
  canvases can't use `var()` directly. `main.js` gets the theme's background
  (`app:background` IPC) so a resize or reload doesn't flash the old colour.

### One inspector, driven by selection
- **Decision:** The right panel edits whatever was picked most recently — a
  cue or a fixture (from the 3D view or a patch-sheet row). With nothing
  selected it shows the workspace default: Venue (room size, rig summary) in
  Build, Show (song, tempo, cue counts) in Program.
- **Why:** "One place to edit" is the core beginner affordance; the old UI
  split settings between a long sidebar and a strip under the timeline. The
  cue editor is a single persistent element the inspector re-parents, so its
  state (curve parameter, auto-key) survives switching selections.

### Libraries + drag and drop everywhere
- **Decision:** Build's library is fixture cards (drag into the venue, `+`, or
  double-click). Program's library is laser patterns drawn as real thumbnails
  from the pattern data, plus fixture effects; drag onto a timeline lane (drop
  position snaps to the beat, lane under the cursor), or double-click / Enter
  to add at the playhead in the first free lane.
- **Why:** Direct manipulation is the most learnable interaction; thumbnails
  beat names for picking a pattern. Each drop target ignores the other kind of
  drag (patterns can't land in the venue).

### Ctrl+K command search
- **Why:** Beginners find features by describing them ("add tunnel", "house
  light"); pros get keyboard access to everything without menus. Every command
  shows its shortcut, which teaches the shortcuts.

### Output settings live behind the status pill
- **Decision:** The top bar shows a status pill ("Art-Net 127.0.0.1", amber when
  following a console); clicking it opens the settings. Mode and sACN are Pro.
- **Why:** Set once per venue, glanced at constantly — status in view, settings
  out of the way. Remembered per computer, not per show.

### Atmosphere and tools float on the 3D view
- **Decision:** Select/Move/Rotate + camera reset (top-left), haze / room light /
  house light (top-right), "Hold for sparks" + a mouse hint (bottom-left), the
  laser preview (bottom-right, Program).
- **Why:** These change how you *see* or *touch* the venue, so they sit on it.
  The camera hint disappears for good after the first orbit; the sparks button
  only appears when the rig has spark machines.

### Named tracks (remake Stage 2, v0.4.0)
- **Decision:** The timeline is a list of tracks (`engine.tracks`, top first).
  A cue belongs to one track (`cue.track` = track id). A track has a kind
  (laser / fixture), a name, and — for fixture tracks — the fixtures it drives
  (`groupId`), plus mute / solo / open.
- **The target lives on the track**, not the cue: "drop it on the Movers track"
  is how beginners think, and it's DAW-familiar for pros. The engine still reads
  `cue.groupId` and `cue.lane`; `engine.syncTracks()` derives both from the
  track (lane = track index), so the HTP/LTP merge and "top laser wins" didn't
  have to change. **Call `syncTracks()` after any track/cue reassignment.**
- **Tracks are layers, so several may drive the same fixtures.** Higher track
  wins colour/position; brightness is still HTP. (Before Looks, a mover look
  needed three tracks; since v0.5.0 one look clip covers all three.)
- **Clips may overlap within a track** (later-starting wins, as lanes did) —
  not forbidden, so moving things around never fails.
- **Mute / solo:** any solo means only soloed tracks play (`engine.audible()`).
- **Why:** The anonymous 5 lanes made every cue pick its own target and gave
  no way to name, mute or reorder parts of a show.

### Keyframe curves live under the track, lined up with the music
- **Decision:** A laser track opens into one curve lane per animated Key
  Effect (+ the parameter you last focused). Lanes span the whole timeline; each
  laser cue on the track draws its own envelope inside its time range. Keys are
  edited in place (click to add, drag, double-click / Del). The inspector keeps
  the ◆ buttons, values, ease and Clear; clicking a parameter name or ◆ opens
  its lane (`timeline.focusCurve`).
- **Why:** The user chose "curves under the cue, aligned to the music" — hitting
  a beat or a drop is the whole point of keyframing, and the narrow inspector
  canvas couldn't show that. Key times are still cue-normalised (0..1), so the
  envelope model and snapping (`timeline/snap.js`) didn't change.

### Zoom, scroll and follow
- **Decision:** The timeline view is `t0` (left-edge time) + `pps` (px/s).
  Ctrl+wheel zooms about the cursor, Shift+wheel / the scrollbar / the wheel over
  the ruler scroll, Fit shows everything; while playing the view pages forward
  when the playhead leaves it. The waveform asks `AudioEngine.peaksRange()` for
  only the visible slice (cached per view), so zooming in shows detail.
- Clip positions are recomputed from the view on every change (`_layoutClips`);
  rows are rebuilt only when data changes (`render`). Cheap at show sizes.

### Section markers
- **Decision:** `engine.markers = [{t, name}]` (kept sorted), drawn as flags on
  the ruler; add with M / the Marker button / double-click the ruler; drag to
  move (beat snap, Shift free); edit in the inspector.
- **Why:** Songs have sections; naming them is how both beginners and pros
  navigate a show — and they become the Live workspace's section pads (Stage 4).

### Show file version 2
- **Decision:** `version: 2` adds `tracks` and `markers`; each cue stores its
  track index. Opening a v1 file runs `tracksFromLanes()`: one track per (old
  lane, laser | fixture group), named from its content ("Laser 1",
  "Movers · Colour"), in lane order so priorities are unchanged. A cue whose
  track is missing or the wrong kind gets a fresh track instead of failing.
- **Don't undo:** Never drop v1 support silently — users have v0.3.0 files.

### Looks: a fixture cue is a complete look made of layers (remake Stage 3, v0.5.0)
- **Decision:** A fixture cue is `{ kind:'fixture', name, layers:[{effectKey,
  params}] }` with at most one layer per slot — Intensity, Colour, Movement
  (`show/looks.js`: `SLOTS`, `slotOf`, `makeLayer`, `setLayer`,
  `normalizeLayers`). The engine applies every layer of an active look to the
  track's fixtures through the same sink, so the HTP/LTP merge across tracks is
  unchanged. Seven ready-made presets (`LOOKS`) sit in the library.
- **Why:** The user found the per-attribute model unintuitive ("a lone Colour
  cue shows nothing") and chose "Looks with layers" over keeping separate cues.
  This is **not** a return to the old monolithic looks: each layer is still an
  independent waveform effect, and looks on different tracks still layer
  (brightest intensity wins; the higher track wins colour/movement).
- **Editing:** the inspector shows one section per slot (effect picker incl.
  "None" + that effect's controls; advanced under More). Dropping a single
  effect onto a look replaces that slot. A look named automatically
  ("Flat · Rainbow · Wave") keeps following its layers until the user renames it.
- **Files:** version 3 stores `layers` + `name`; v1/v2 fixture cues
  (`effectKey` + `params`) open as one-layer looks.
- **Placement:** double-clicked library items go to a track with room at the
  playhead, else onto a **new** track — a clip stacked exactly on another is
  invisible and confusing.

### Live workspace (remake Stage 4, v0.6.0)
- **Decision:** A third workspace for performing the pre-programmed show
  (`ui/LivePanel.js`): section pads from the timeline markers (+ Start),
  quantised jumps (Now / Next beat / Next bar, Pro), masters (brightness, speed,
  size), blackout, sparks, fullscreen, and a now/next strip with a song overview.
- **Why:** The user chose "perform the programmed show" for Live before the
  auto-preset exists; markers double as the song's sections, so nothing new has
  to be authored to perform. Quantised jumps keep cuts on the music.
- **Masters live on `engine.masters`** and are applied at output: dimmer scales
  the HTP intensity in `_flush()` and the laser brightness; size scales the
  laser and movement layers' swing; blackout zeroes intensity, blanks the laser
  and blocks spark triggers. They are **performance state** — not saved with
  the show, not undoable (a show file shouldn't open blacked out).
- **Speed uses a warped clock:** `engine._warp` accumulates (speed − 1) × dt, so
  effect time = cue-local time + warp. Changing the fader changes the *rate*
  smoothly instead of jumping every effect's phase (as `t × speed` would); a
  seek resets it. Because the warped time drives both Hz and beat-synced
  effects, the bpm passed to effects is **not** also scaled.
- **Keys:** B (blackout) works in every workspace; 1–9, ←/→ and F only in Live.
- `[data-ws-only]` takes a space-separated list (`"program live"`) — CSS uses
  `~=` so one element can belong to several workspaces.

### First run: welcome screen + tour (remake Stage 5, v0.7.0)
- **Decision:** On first run (pref `welcomed` unset) a welcome screen offers
  Demo show / Empty venue / Open a show, a Simple-or-Pro choice and a "Show me
  around" switch (on by default). Closing it (Esc / ×) keeps the demo that's
  already loaded. A 5-step spotlight tour (`ui/Tour.js`) walks
  Build → Program → Live. Both reopen from Help (?) and Ctrl+K.
- **Why:** The user chose "welcome screen + short tour". The app always boots
  the demo first, so the welcome screen never blocks a working show and
  skipping it costs nothing.
- **Demo / Empty from a later open are undo steps** (`history.record()`), so
  picking one by mistake never loses work; on first run the history is reset
  instead. The demo is a serialized snapshot taken at boot (`DEMO_SNAPSHOT`),
  so it can come back after edits. Known gap: the show *name* isn't in
  snapshots, so Ctrl+Z after a swap restores the show but keeps the new name.
- **The tour blocks clicks and owns the keyboard** (capture-phase listener) so
  a stray shortcut or click can't change the show half-way. It opens any
  collapsed panel it points at and returns to the starting workspace.
- **Empty states say the next step where you are:** the timeline's three-step
  card floats over the empty clip area with `pointer-events: none` (drops
  reach the track underneath); the empty-venue note is worded per workspace.

### The user guide: Markdown in guide/, read in the app and on GitHub (v0.16.0)
- **Decision:** The guide is plain Markdown in `guide/` (one file per topic,
  `README.md` as the contents) with screenshots in `guide/img/`. The app shows
  the same files in a reader dialog (`ui/GuideReader.js`): F1, ? → User guide,
  Ctrl+K "guide". Contents on the left, the open page's sections under it,
  search over every section, links kept inside with Back.
- **Why:** The user chose "in the app + on GitHub". One source means the two
  can't drift apart, and the guide works offline in the installed app.
- **Our own renderer (`ui/markdown.js`), no dependency:** the guide only uses
  a small part of Markdown, and hard constraint 4 keeps dependencies minimal.
  Headings get GitHub's anchor ids, so `page.md#a-heading` links work in both
  places. Raw HTML is escaped, never passed through.
- **The page order comes from README's links,** so adding a page is one line
  in the contents. Pages are fetched relative to `src/` (`../guide/`), which
  works from `file://` in Electron and from the dev server.
- **Web links open in the system browser.** `main.js` denies `window.open`
  and blocks navigations off the app page, handing http(s) URLs to
  `shell.openExternal`. Before this, a clicked web link could have replaced
  the app in its own window. Save (an `<a download>` blob) is a download, not a
  navigation, and is unaffected (checked over CDP before and after).
- **Writing style:** short sentences, the UI's own words in **bold**, Pro-only
  controls marked "(Pro)". Every claim was checked against the code. When the
  UI changes, update the matching page (and its screenshot if it shows the
  change).

---

## Shipping

### Releases: tag → GitHub Actions → installer on a GitHub Release
- **Decision:** Every finished stage bumps `package.json`'s version, adds a
  `## vX.Y.Z` section to `CHANGELOG.md`, and pushes a `vX.Y.Z` tag. The
  `release.yml` workflow (windows-latest) runs `npm test`, builds the NSIS
  installer and publishes it with `gh release create` — the notes are that
  CHANGELOG section.
- **Why:** The user wants every update as "an exe they install". Building in CI
  needs no tokens or extra tools on the developer's machine (the workflow's own
  `GITHUB_TOKEN` publishes) and is reproducible. Only first-party actions
  (`actions/checkout`, `actions/setup-node`) and the preinstalled `gh` CLI.
  The workflow fails fast if the tag doesn't match `package.json`.

### Installer: NSIS one-click, per-user
- **Decision:** `oneClick`, `perMachine: false`, desktop + Start-menu shortcuts,
  launches when done. Artifact `LightshowStudio-Setup-<version>.exe`.
- **Why:** "Just run an exe they install" — no wizard pages, no admin prompt.
- **Known:** it isn't code-signed (a certificate costs money), so SmartScreen
  warns on first run; README and release notes explain "More info → Run anyway".

### Updates: our own small updater, weekly, download + install in-app (v0.18.0)
- **Decision:** `updater.js` (main process) asks the GitHub API for the
  latest release, compares versions, and on request downloads that release's
  `LightshowStudio-Setup-x.y.z.exe` to `%TEMP%\LightshowStudio-update\` with
  progress, then runs it detached and quits; the one-click installer replaces
  the app and opens the new version. `ui/Updates.js` (renderer) checks at
  start-up when a week has passed (the "once a week" switch in Settings,
  default on) and when you press **Check for updates**, and shows the popup:
  what's new (the release notes = the CHANGELOG section) → Download and
  install / Later / Skip this version.
- **Why not electron-updater:** hard constraint 4 (no new dependencies), and
  it needs `latest.yml` + blockmaps published by CI. Ours needs only what
  `release.yml` already publishes: the installer and its GitHub-listed size
  and SHA-256 `digest`. The user chose "download + install in-app" over
  "open the download page".
- **Safety:** the renderer never passes a URL or path. Main only downloads
  the asset of the release *it* found, only from
  `https://github.com/Royalkiller2222/Lightshow-Studio/releases/download/`,
  checks size and SHA-256 (a mismatch deletes it), and only runs the file it
  downloaded. The User-Agent is the generic `LightshowStudio-updater`;
  nothing about the user or their shows is sent.
- **Never interrupts a show:** a weekly result waits while a loaded song is
  playing or Live is open (the song-less demo loop doesn't count — it plays
  at every start-up). A dirty show gets "Save the show" / "Install without
  saving" before installing. Skip only silences the *weekly* check for that
  version; the button always shows the newest.
- **Testing:** `LSS_UPDATE_FAKE_VERSION=0.1.0` makes the app think it's old.
  Unpackaged (`npm start`), install is a dry run (a toast with the file's
  path) unless `LSS_UPDATE_RUN=1`. The installer is unsigned, so SmartScreen
  warns; the popup says "More info → Run anyway".

### electron-builder drops `three/examples` unless told not to
- **Decision:** `build.onNodeModuleFile` points at `scripts/builder-include.js`,
  which force-includes `node_modules/three/examples/jsm`.
- **Why:** electron-builder hard-codes skipping every dependency's top-level
  `examples` folder — and three ships its addons (OrbitControls,
  TransformControls, bloom passes) there. Without the hook the packaged app
  opens to a blank window. A `files` pattern does **not** override this.
- **Don't undo:** Keep the hook (and check the packaged app after any
  dependency change — see DEV_WORKFLOW "Verify the packaged app").

### The logo
- **Decision:** A fan of coloured beams fired from a white diamond emitter (the
  ◆ keyframe symbol) on a graphite tile. `src/ui/logo.js` generates it: the full
  5-beam mark, and a bolder 3-beam cut for 16–32 px where thin beams smear.
  `npm run icons` rasterises it with Electron's own Chromium into
  `build/icon.ico` (BMP entries ≤128 px + PNG 256, the layout every Windows
  tool incl. NSIS accepts), `build/icon.png`, `build/icon.svg` and the window
  icon `src/assets/icon.png`.
- **Why:** Laser show identity (beams + keyframes), readable at taskbar size,
  and one source of truth so the top-bar mark, window icon and installer icon
  never drift apart. No image libraries needed.

---

## Smaller but non-obvious choices

- **House light** (`src/viz/HouseLight.js`) is a viewport aid, **not** a DMX
  fixture — a toggleable flood (hemisphere + point + bulb) so you can see the rig.
  It doesn't touch the hub. Opening a show re-hangs it for the show's room.
- **Room brightness** drives tone-mapping **exposure** + ambient, not just ambient
  — the room shell material is near-black, so ambient alone barely changes it.
- **Haze** drives the beam shader's `uHaze` (shared uniform across all beam
  materials) **and** a gentle scene fog. The shared-uniform trick means one slider
  moves every beam.
- **Cold sparks share address 37 on purpose** (a mirrored pair, now also
  mirror-linked so moving one moves the other). The patch sheet flags it as a
  collision (Pro) because surfacing overlapping addresses is correct — real
  consoles warn too. It's not a bug.
- **Atmosphere** (haze, room light, house light) is one `Atmosphere` object so
  the viewport sliders, show files and undo all go through the same setters.
- **Shortcuts stand down only in text fields.** Space / Ctrl+Z / V-X-C still
  work right after dragging a slider or picking a colour (the laser inspector is
  mostly sliders); Del never deletes from a focused slider. Esc deselects only
  when you're not typing (it used to clear a fixture mid-rename).
