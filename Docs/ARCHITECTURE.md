# Architecture

Companion to **DESIGN_DECISIONS.md** (which covers *why*). This is *what* and
*how*: the window layout, the module map, the per-frame data flow, and the cue
model.

## The window

```
┌ top bar: name · open/save · undo/redo · [Build|Program] · ▶ ■ 0:12.4 · BPM · Simple|Pro · output · search · ? ┐
├──────────────┬──────────────────────────────────────────┬──────────────────┤
│ #left        │ #center: <canvas id="view"> + #overlay    │ #right           │
│ library      │  tools · camera · haze/room/house light   │ Inspector        │
│ (Build:      │  laser preview (Program) · sparks · hint  │ fixture / cue /  │
│  fixtures;   │                                           │ venue / show     │
│  Program:    │                                           │                  │
│  patterns +  │                                           │                  │
│  effects)    │                                           │                  │
├──────────────┴──────────────────────────────────────────┴──────────────────┤
│ #bottom: Build → PatchSheet · Program → TimelinePanel · Live → now/next bar │
└─────────────────────────────────────────────────────────────────────────────┘
```

- `body` is a CSS grid (`46px | 1fr | 5px splitter | --bottom-h`); `#workspace`
  is a grid (`--left-w | 5px | 1fr | 5px | --right-w`). `Shell` sets those
  variables (per workspace, remembered in localStorage) and `body[data-ws]` +
  `body.simple/.pro-mode`. Everything is mounted once; CSS hides what doesn't
  belong to the current workspace (`[data-ws-only]`) or mode (`.pro`, `.more`).
- **Selection drives the inspector** (`app.js` `updateInspector()`): the most
  recent pick wins — a timeline item: cue, track or marker
  (`TimelinePanel.onSelect(kind, obj)`) — or a fixture
  (`EditTools.onSelect`, also from patch-sheet rows); nothing selected shows the
  workspace default (Venue in Build, Show in Program). The cue editor is one
  persistent `CueInspector` element the Inspector re-parents.
- **Drag & drop:** fixture cards → the canvas (`PlacementController`, keyed by
  `text/plain` + the pending type set on dragstart); patterns/effects → a track
  of the matching kind, or the "new track" row below the tracks
  (`TimelinePanel`, MIME type `application/x-lightshow`, JSON
  `{kind: 'pattern'|'effect', key}`). Each target ignores the other's drags.
- **Commits:** every finished edit calls `commit()` → `History.record()`
  (snapshot, no-op if unchanged) → listeners update the top bar's undo/redo +
  "Edited", the window title, the patch sheet and the gizmo.

## Process model

- **Main process** (`main.js`): opens the `BrowserWindow`, owns hardware DMX I/O
  on a steady 40 Hz `setInterval`. Mirrors universe buffers pushed from the
  renderer and sends Art-Net/sACN; also runs the Art-Net receiver for External
  mode and forwards incoming DMX to the renderer. It also keeps the window on
  the app: `window.open` and link navigations are denied, and http(s) URLs go
  to the system browser (`shell.openExternal`).
- **Preload** (`preload.js`): `contextBridge` exposes `window.dmxBridge`
  (`pushUniverses`, `setConfig`, `onArtNetIn`). The only renderer↔main channel.
- **Renderer** (`src/app.js` + modules): the 3D scene, show engine, timeline,
  placement tools, UI. This is where almost everything lives.
- **`dmx-io.js`**: pure Node `dgram` Art-Net/sACN senders + Art-Net receiver.
  Covered by `npm test` (loopback round-trip + sACN packet structure).

## Renderer per-frame loop (`src/app.js` → `animate()`)

```
dt = clock.getDelta()
transport.loopEnd = last cue end          // no track: free-run loops over the show
transport.update(dt)                      // advance the master clock
engine.setSelection(editTools.selected)   // feed the "Selection" group
engine.auto?.update({beat, bands, dt})    // live Auto: song or sound-input bands,
                                          // the song's beat (free-running when stopped)
engine.update(transport.time, bpm, audio.bands())
    ├─ fixture cues → write to sink → _flush() merges to UniverseHub
    └─ laser cues   → _renderLaser() evaluates envelopes, drives the LaserRig
                      (live Auto on: its cueFor(i) replaces the laser tracks)
                      (which also draws the 2D preview canvas)
for (f of fixtures) f.update(dt)          // fixtures READ the hub, drive 3D
timeline.frame()                          // waveform, beat grid, playhead
cueInspector.frame()                      // animated laser values + curve editor
inspector.frame()                         // re-render if what it shows changed;
                                          // live fixture position while dragging
topBar.frame(); overlay.frame()           // clock text; sparks button / empty note
controls.update(); resize(); composer.render()  // orbit + post (bloom, ACES, output)
```
UI `frame()` methods only touch the DOM when a value actually changed.

The renderer also pushes `hub.snapshotForIpc()` to main every 25 ms (internal
mode) for hardware output.

## Module map

```
src/
  app.js                 Composition root: scene + renderer, DMX bridge/output
                         config, builds every module and wires their callbacks,
                         selection → inspector, actions, commands, shortcuts,
                         the animate() loop. Behaviour lives in the modules.
  index.html             importmap (three, three/addons) + the layout skeleton.
  style.css              The "Studio graphite" theme: tokens, controls, layout.
  assets/icon.png        Window/taskbar icon (generated by npm run icons).

  core/
    Rig.js               Fixtures + patch: seedDemo, spawn (auto-patch, labels),
                         place (mirror pairs), remove, restore, labelOf, clear.
    project.js           serializeProject / applyProject (JSON show files) and
                         History (whole-snapshot undo/redo, dirty tracking).

  ui/
    Shell.js             Workspaces (Build/Program/Live), splitters, panel collapse,
                         Simple/Pro, "More" open-state memory.
    TopBar.js            Brand + project name, file/undo, workspace tabs,
                         transport + BPM, Simple/Pro, output popover, help.
    ViewportOverlay.js   Tools, camera reset, atmosphere sliders, laser preview
                         canvas, sparks button, camera hint, empty-venue note
                         (worded per workspace, "Go to Build" outside Build).
    Inspector.js         Right panel: fixture / venue / show views; hosts the
                         CueInspector for cues.
    FixtureLibrary.js    Build library: fixture cards (drag / + / double-click),
                         "Place mirrored pairs", "Import (MVR, QLC+, xLights)…".
    ImportRigDialog.js   MVR / QLC+ / xLights import, on a *source* adapter
                         (mvrSource / qlcSource / xsqSource: kinds, plan(),
                         shows, buildShow(), optional markerTracks): one row
                         per kind of fixture (count, guessed type + why, type
                         select), the options (replace/add, fit room, centre,
                         keep addresses/re-patch) with an overlap warning, and
                         (QLC+, xLights) a Show / Sequence picker, a markers
                         timing track, replace/add the timeline.
                         app.js applyRigImport() / addImportedShow() apply it.
    ContentLibrary.js    Program library: pattern thumbnails + effects, search,
                         drag to the timeline / double-click to add.
    PatchSheet.js        Build bottom panel: fixture list + DMX columns (Pro).
    CommandPalette.js    Ctrl+K search over every command.
    GuideReader.js       The user guide dialog (F1, ? → User guide, Ctrl+K):
                         fetches guide/*.md (page order = the links in
                         guide/README.md), contents + section search, keeps
                         .md links inside with a Back stack; web links go to
                         window.open → main.js → system browser.
    markdown.js          Small Markdown → HTML renderer for the guide (headings
                         with GitHub-style ids, lists, tables, quotes, code,
                         images); escapes raw HTML. Pure, Node-testable.
    LivePanel.js         Live workspace: section pads (left), masters (right),
                         now/next strip + song overview (bottom); quantised
                         jumps; writes engine.masters. Hosts the AutoPanel
                         above the pads (live.autoRoot).
    AutoPanel.js         Live Auto pad (A) + status/meter, and autoForm /
                         bindAutoForm: the settings form shared with the dialog.
    AutoShowDialog.js    "Pregenerate an Auto show": energy + sections + drops canvas,
                         the song-map editor (click a section: type, mood),
                         settings, Generate (app.js pregenerate() writes cues;
                         editSection() / resetSongMap() keep engine.songMap).
    Welcome.js           First-run screen: Demo / Empty venue / Open + Simple or
                         Pro + "show me around". Calls back; app.js loads the show.
    Tour.js              5-step spotlight tour (TOUR_STEPS: target selector,
                         workspace, panel to open); restores the workspace.
    icons.js / logo.js   Hand-drawn SVG icon set; the logo generator.
    dom.js / overlays.js Helpers (esc, fmtTime, colour, prefs, more()); popovers
                         and toasts.

  dmx/UniverseHub.js     Single source of truth. get/setChannel(16), applyExternal,
                         snapshotForIpc. 1-based addresses.

  fixtures/
    Fixture.js           Base: hub read helpers (ch/attr by name), position/rotation
                         get/set (_rotObject), mirror link, pickRoot.
    FixtureProfile.js    Channel layout as data + built-in profiles
                         (MovingHeadRGB, ColdSpark2, LedParRGB, BattenRGB,
                         PixelBarRGB, LaserRGB, PodiumProp).
    registry.js          type key -> factory (the add/place/load seam).
    MovingHead / LedPar / Batten / PixelBar / LaserProjector / ColdSpark / Podium
                         Each builds its own geometry, reads attrs, has dispose().

  viz/
    beam.js              Analytic fresnel cone-shell shader + createUnitConeGeometry
                         + shared hazeUniform. (See DESIGN_DECISIONS "beam trap".)
    Room.js              Parametric venue (back-face box + floor grid at 0.5 m).
    HouseLight.js        Toggleable flood (viewport aid, not DMX).
    Atmosphere.js        Haze / room light / house light state + setters
                         (shared by the overlay sliders, show files and undo).
    strobe.js            Pure strobe gate helper.

  show/
    ShowEngine.js        Owns tracks, cues, markers + groups. update(): orders cues
                         by lane (track order), applies each look's layers via
                         the sink, _flush() (HTP intensity / LTP colour+position),
                         _renderLaser() for laser cues. lookName().
    looks.js             Look layers: SLOTS, slotOf, makeLayer, setLayer,
                         removeSlot, normalizeLayers; the LOOKS presets.
    effects.js           Per-attribute fixture effect registry (intensity/colour/
                         position) + waveform-driven apply + sink writers
                         (writeAttr/writeRGB) + paramsFor().
    waveforms.js         wave(shape,phase,duty), SHAPES/DIVISIONS/FANS, fanPhase.

  audio/
    AudioEngine.js       Web-Audio decode, play/pause/seek, peaks() for waveform,
                         bands() (FFT bass/mid/high) for audio-reactive effects;
                         startInput()/stopInput()/inputBands(): a mic or
                         line-in on its own analyser (never played back).
    bpm.js               analyzeTempo(): onset envelope + autocorrelation +
                         parabolic interp + downbeat offset.

  import/                File imports. Pure; no DOM, no Three.js; Node-testable.
    zip.js               readZip(): read-only zip (central directory by hand,
                         deflate via DecompressionStream). No dependency.
    xml.js               parseXml(): small non-validating XML -> plain tree
                         {tag, attrs, children, text} + child/children/
                         descendants/childText helpers (namespace-agnostic).
    rig.js               What every rig importer shares: guessType() from names
                         (+ GDTF attrs), GROUP_OF_TYPE, finishPlacement()
                         (centre, floor, fit room), assignAddresses() (keep /
                         re-patch for our channel counts), kindsOf().
    qlc.js               readQlc() (.qxw: fixtures, functions, groups, 2D
                         Monitor, shows), planRig() (Monitor positions or rows
                         by type), convertShow() (Show tracks -> our tracks per
                         group; Scene/Chaser/Sequence/EFX/RGBMatrix/Collection
                         -> layers with exact timing), qlcSource().
    xlights.js           readXsq() (.xsq: song, palettes, EffectDB, timing
                         tracks, model effects), guessModel(), effectLayers()
                         (xLights effect name + palette -> our layers),
                         bpmFromTiming(), convertSequence(), xsqSource().
                         No rig: models map onto the current rig's groups.
    mvr.js               readMvr() (scene + per-spec GDTF info), guessType(),
                         placeFixture() (MVR Z-up mm -> scene Y-up m, rotation
                         via C·R·Cᵀ -> Euler XYZ, laser/floor corrections),
                         planRig() (centre, floor, fit room) and
                         mvrSource() for the dialog.

  auto/                  Auto (3c; content-aware since 5a). Pure; no DOM, no
                         Three.js; Node-testable.
    analyze.js           analyzeSong(buffer, {bpm, offset}): frameFeatures()
                         (own radix-2 FFT, 1024 pt / hop: 5 bands, centroid,
                         low/high flux, high-band flatness) -> per-bar energy,
                         bass, high, busy, bright, noise, rate, tension, fill
                         (normalised to the song) + per-beat kick ->
                         downbeatPhase(), findDrops() (bass + energy lift),
                         findSections() (novelty cuts on 4 bars anchored to
                         the first drop, builds by rising tension, kinds,
                         repeat groups, moodOf()). Song map (5b):
                         normalizeSongMap / songMapFits / editAt and
                         applySongMap(an, map): the user's kind / mood edits
                         on top (renames, drop hits, `edited`, `moodSet`).
    director.js          Settings (AUTO_DEFAULTS, normalizeAutoSettings, MOODS),
                         PATTERN_TIER (calm/medium/high), PATTERN_FEEL (mood
                         weights), MOOD_PALETTES; generateShow() (phrase-
                         aligned cues, build risers, dark gap + unison drop
                         openings, hero drop, motifs on repeats, fill
                         strobes; seeded = repeatable; returns cues, markers
                         and the mood palettes it used) and LiveDirector
                         (live: smoothed levels, drop / breakdown detection,
                         bar changes, two virtual cues cueFor(i)).

  timeline/
    Transport.js         Master clock (audio time or free-run, looping at
                         loopEnd), bpm, beatOffset.
    TimelinePanel.js     The DAW-style timeline: ruler (bars, markers), song
                         waveform, named track rows (M/S, rename, select),
                         clips (move/resize/change track), curve lanes under
                         open laser tracks (key editing), zoom/scroll/follow,
                         library drop target; add/delete cues, tracks, markers.
    CueInspector.js      Edits the selected cue: fixture effect controls, or the
                         laser Key Effects (◆, auto-key, ease, clear).
    snap.js              snapTime (beat grid) / snapKeyU (half-beats + cue ends).

  laser/
    patterns.js          Vector pattern library (strokes in -1..1 galvo space),
                         PATTERN_GROUPS, the Text font (14-segment), the
                         imported-pattern registry (allPatterns, patternByKey,
                         setImported/addImported/removeImported,
                         onPatternsChanged) + patternSegments(pattern, visible,
                         {text, frame}) and drawPatternThumb().
    ilda.js              ILDA .ild reader (formats 0/1/2/4/5) -> frames of
                         coloured strokes; compact base64 encode/decode for the
                         show file; importIlda / serializeImported /
                         loadImported. Pure data; Node-testable.
    envelopes.js         LASER_PARAMS (ranges/labels/formats — single source of
                         truth) + pure keyframe math: evalEnvelope, valueAt,
                         resolveLaserParams, setKey/removeKey/clearKeys,
                         keyTimes, loadAnim. No Three.js; Node-testable.
    LaserRig.js          One projector's output: 3D beams + graphic (additive
                         LineSegments) + drawPreview() for the flat galvo view.
                         One per Laser projector fixture (fx.laser), plus the
                         engine's fallbackLaser. galvoMap(params, output).
    palettes.js          Preset palettes, colorRef normalising, paletteColor()
                         (pick / beat cycle + fade), projector output defaults.
                         No Three.js; Node-testable.

  placement/
    PlacementController.js  Drag-in placement (HTML5 DnD) + ghost preview + snap +
                            mirror.
    EditTools.js            Select/Move/Rotate via TransformControls, blue highlight,
                            mirror transforms.
    placement.js            Pure snap/mirror/placementPoints helpers.

  patch/
    Patch.js             Patch registry (entries, rename, repatch, collisions,
                         nextFreeAddress, clear).

guide/
  README.md, 01-…12-*.md The user guide (shown on GitHub and by ui/GuideReader.js).
                         README's links set the page order; img/ holds the
                         screenshots. Shipped in the installer (package.json
                         build.files).

scripts/
  make-icons.js          npm run icons: renders logo.js → build/icon.ico (16–256),
                         build/icon.png, build/icon.svg, src/assets/icon.png.
  builder-include.js     electron-builder onNodeModuleFile hook (keeps
                         three/examples/jsm in the package — see DEV_WORKFLOW).
.github/workflows/
  release.yml            On a vX.Y.Z tag: test, build the NSIS installer,
                         publish a GitHub Release with the CHANGELOG section.
```

## The cue model

All cues live in `ShowEngine.cues`; each cue has
`{ id, kind, start, duration, track, lane, params }`. `track` is the id of its
track in `ShowEngine.tracks` (`{ id, name, kind: 'laser'|'fixture', groupId,
mute, solo, open }`, top first). `engine.syncTracks()` derives `lane` (= track
index; 0 = top = highest priority) and, for fixture cues, `groupId` from the
track. `engine.audible(cue)` applies mute/solo. `engine.markers` holds the
section markers `{ t, name }` (sorted).

### Fixture cue (`kind: 'fixture'`) — a look
`{ name, groupId (from the track), layers: [{ effectKey, params }] }`, at most
one layer per slot — intensity / colour / position ("Movement") — kept in slot
order by `looks.js`. The engine runs every layer on the track's fixtures. Each
layer is one per-attribute effect from `effects.js`:
- **Intensity:** `i-flat`, `i-wave`, `i-audio`, `i-chase`
- **Colour:** `c-static`, `c-rainbow`, `c-two`
- **Position:** `p-static`, `p-circle`, `p-wave`
- (plus `sparks`)

Shared params (effects use a subset, declared in each effect's `controls`):
`shape, rate, sync, division, size, base, phase, spread, fan, dir, duty, band,
color, color2, pan, tilt`. Effects write via `c.out`; merge is HTP intensity /
LTP colour+position (see DESIGN_DECISIONS).

### Laser cue (`kind: 'laser'`) — the BEYOND model
`{ pattern, params, anim? }`. `params` are the **7 Key Effects as static values**:
`{ size, rotX, rotY, rotZ, posX, posY, color[3], brightness, points, scan }`
(rotation in radians). Ranges/labels live in `LASER_PARAMS` (`envelopes.js`).

- `pattern` → `patterns.js`: 25 built-ins `{key,label,group,strokes}` in four
  groups, each a list of **strokes** (polylines) in -1..1. `text` (`text:true`)
  draws the cue's `cue.text` in a 14-segment font. **Imported** ILDA patterns
  (`group:'imported'`, `colored:true`) have `frames` (a stroke list per frame,
  points `[x,y,r,g,b]`), `fps` and `data` (base64 of the frames); they live in
  a module-level registry the show owns (`setImported` on load). The engine
  picks `frame = floor((t − start)·(cue.fps || pat.fps))`; LaserRig writes
  per-vertex colours, and the cue colour multiplies them (white = as drawn).
  `engine.patternUsers(key)` guards removing a pattern cues still use.
- `LaserRig.show(pattern, params)` transforms the frame: rotZ spins in-plane,
  size scales, pos offsets (independent of size), rotX/rotY tilt the frame plane
  in 3D, then places it at distance `D` in front of the projector. `points`
  (Visible Points) truncates the stroke list; `scan` strides/sparsifies;
  `brightness` = opacity; `color` = line colour. It draws a bright **graphic**
  (LineSegments through frame points) plus faint **beams** (projector origin →
  each point) for the volumetric cone, and mirrors a flat 2D galvo view to the
  preview canvas using the same transform.
- **Projectors (Stage 3a).** Every fixture with `.laser` (the Laser projector:
  `fx.laser` = its LaserRig, `fx.laserOut` = `{size,posX,posY,flipX,flipY,limit}`)
  is a projector. A laser track's `target` is `null` (all projectors) or an
  array of fixtures. `_renderLaser` gives each projector the **top active
  audible cue among the tracks targeting it** (lane 0 wins). With no projectors
  in the rig, `engine.fallbackLaser` (standalone, over the stage) plays every
  laser cue; otherwise it's hidden. Output is applied in `galvoMap` after the
  cue's own transform: flip/size, then offset; `limit` scales brightness.
- **Palettes.** `engine.palettes = [{id,name,colors:[[r,g,b]…]}]`. A cue's
  `colorRef` is `null` (own colour) or `{palette, mode:'pick'|'cycle', index,
  every, fade}`; cycle steps on song beats `(time − beatOffset)·bpm/60` (app
  copies `transport.beatOffset` into `engine.beatOffset` each frame).
  `removePalette` bakes the current pick colour into its cues first.
- `ViewportOverlay.drawLaser(engine)` composites the selected projector (or all,
  additively) into the preview canvas.

### Keyframe envelopes (Stage 2)
```
cue.anim = {
  rotZ: { ease: 'linear', keys: [ { t: 0, v: 0 }, { t: 1, v: 6.283 } ] },
  color:{ ease: 'smooth', keys: [ { t: 0.25, v: [1,0,0.25] }, { t: 0.75, v: [0.1,0.25,1] } ] },
}
```
- `t` is **cue-local, 0..1**; `v` is in the param's stored units (colour = RGB
  0..1 array). Keys are kept sorted; one key per time (`KEY_EPS`).
- Evaluation: before the first / after the last key the value holds; between
  keys `ease` is `linear`, `smooth` (smoothstep) or `step` (hold previous).
- `_renderLaser` computes `u = (time - start) / duration` and passes
  `resolveLaserParams(cue, u)` to the rig — a copy with animated params
  evaluated, or `cue.params` itself if nothing is animated.
- Editing: in the inspector (`CueInspector`) ◆ keys the current value at the
  playhead; edits to an animated param (or any param with **Auto-key** on) write
  a key at the playhead — exact when paused, half-beat-quantised while playing;
  Ease and Clear act on the focused parameter. In the timeline, an open laser
  track shows one **curve lane** per animated param (+ the focused one): click
  inside a cue's span = add key, drag = move (half-beat snap, Shift = free),
  double-click / Del = remove. The cue block shows a tick per key time.

## Save/load shape (`core/project.js`)
```
{ app:'lightshow-studio', version:5,
  room:{w,d,h},
  settings:{ bpm, beatOffset, haze, brightness, house },
  fixtures:[ { type, universe, startAddress, label, pos:[x,y,z], rot:[x,y,z], mirror:index|null, laser?:output } ],
  tracks:[ { name, kind, groupId, mute, solo, open, target?:[fixtureIndex…]|null, auto?:true } ],
  palettes:[ { id, name, colors:[[r,g,b]…] } ],
  patterns:[ { key:'ild:…', name, fps, data:base64 } ],
  cues:[ { kind:'laser', pattern, start, duration, track:index, params, anim?, colorRef?, text?, fps? }
       | { kind:'fixture', name, groupId, start, duration, track:index, layers:[{effectKey, params}] } ],
  markers:[ { t, name, auto?:true } ],
  auto:{ intensity, every, palette, groups, imported, alternate, markers, source, mood },
  songMap?:{ song:{ name, duration }, edits:[ { t, kind?, mood? } ] },
  audioName }
```
Version 1 (≤ v0.3.0) had no `tracks`/`markers` and a `lane` per cue;
`tracksFromLanes()` converts it on open. Versions 1–2 stored a fixture cue as a
single `effectKey` + `params`; it opens as a one-layer look. Versions ≤ 3 have
no targets / palettes / laser output: tracks play on all projectors, the preset
palettes load, cues keep their own colour. Versions ≤ 4 have no imported
patterns (the registry is cleared). Files without `auto` (any version) get
the default Auto settings; `auto: true` marks tracks/markers Pregenerate made
(they're replaced when it runs again); `songMap` holds the user's section
edits for the song it names (ignored for any other song). These are optional fields, so the
version stayed 5. `applyProject` clears, rebuilds the
room (and re-hangs the house light) and fixtures (relinking mirror pairs by
index), the tracks and markers, re-adds cues by kind onto their tracks (laser
`anim` through `loadAnim()`), applies settings, and stops the transport.
Undo/redo snapshot this same JSON but pass `keepTransport: true` and re-select
the cue / track / marker and the fixture at the same index, so the playhead and
the open inspector survive Ctrl+Z. Output settings (Art-Net IP, sACN) are per-computer preferences, not
part of the show file.
