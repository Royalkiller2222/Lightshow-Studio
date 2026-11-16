// Renderer entry and composition root: builds the 3D scene, the DMX core, the
// rig, the show engine and the UI, wires them together, and runs the frame
// loop. Behaviour lives in the modules; this file only connects them.
//
//   top bar ─ workspaces (Build / Program), transport, Simple/Pro, output
//   left    ─ Build: fixture library · Program: pattern + effect library
//   centre  ─ the 3D view + floating tools / atmosphere / laser preview
//   right   ─ inspector (selected fixture or cue, else venue / show)
//   bottom  ─ Build: patch sheet · Program: timeline
//   first run ─ welcome screen (demo / empty venue / open + Simple or Pro) and
//               an optional 5-step tour; both reopen from Help and Ctrl+K

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { UniverseHub } from './dmx/UniverseHub.js';
import { hazeUniform } from './viz/beam.js';
import { Room } from './viz/Room.js';
import { HouseLight } from './viz/HouseLight.js';
import { Atmosphere } from './viz/Atmosphere.js';
import { ShowEngine, GROUPS } from './show/ShowEngine.js';
import { EFFECTS } from './show/effects.js';
import { LOOKS, lookLayers, makeLayer } from './show/looks.js';
import { Patch } from './patch/Patch.js';
import { FIXTURE_TYPES, fixtureType } from './fixtures/registry.js';
import { PlacementController } from './placement/PlacementController.js';
import { EditTools } from './placement/EditTools.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { analyzeTempo } from './audio/bpm.js';
import { Transport } from './timeline/Transport.js';
import { TimelinePanel } from './timeline/TimelinePanel.js';
import { CueInspector, effectShortName } from './timeline/CueInspector.js';
import { LaserRig } from './laser/LaserRig.js';
import { allPatterns, addImported, removeImported, patternByKey } from './laser/patterns.js';
import { importIlda, MAX_FILE_BYTES } from './laser/ilda.js';
import { Rig } from './core/Rig.js';
import { serializeProject, applyProject, History } from './core/project.js';
import { Shell, WORKSPACES } from './ui/Shell.js';
import { TopBar } from './ui/TopBar.js';
import { ViewportOverlay } from './ui/ViewportOverlay.js';
import { Inspector } from './ui/Inspector.js';
import { FixtureLibrary } from './ui/FixtureLibrary.js';
import { ContentLibrary } from './ui/ContentLibrary.js';
import { PatchSheet } from './ui/PatchSheet.js';
import { CommandPalette } from './ui/CommandPalette.js';
import { LivePanel } from './ui/LivePanel.js';
import { AutoPanel } from './ui/AutoPanel.js';
import { AutoShowDialog } from './ui/AutoShowDialog.js';
import { ImportRigDialog } from './ui/ImportRigDialog.js';
import { readMvr, mvrSource } from './import/mvr.js';
import { readQlc, qlcSource } from './import/qlc.js';
import { readXsq, xsqSource } from './import/xlights.js';
import { analyzeSong } from './auto/analyze.js';
import { LiveDirector, generateShow, normalizeAutoSettings } from './auto/director.js';
import { Welcome } from './ui/Welcome.js';
import { Tour } from './ui/Tour.js';
import { toast } from './ui/overlays.js';
import { isTypingTarget, prefs } from './ui/dom.js';

// ---------- Renderer / scene ----------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0c);
// Haze drives this: more haze => thicker air, so beam cones read as volume.
// Beam materials don't sample fog, so cones stay bright while the room behind
// them fades — the "light scattering through haze" look.
scene.fog = new THREE.FogExp2(0x15151f, 0);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
const CAMERA_HOME = { pos: new THREE.Vector3(11, 7.5, 14), target: new THREE.Vector3(0, 1.8, 0) };
camera.position.copy(CAMERA_HOME.pos);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(CAMERA_HOME.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.52;

// Room fill light — the Room light control drives its intensity so a dark
// venue can be lit enough to see geometry without flooding the beams.
const ambient = new THREE.AmbientLight(0x6a6a78, 0.9);
scene.add(ambient);

// ---------- DMX core + venue ----------
const hub = new UniverseHub();
const room = new Room(scene);
room.build(14, 18, 6);
const houseLight = new HouseLight(scene);
const atmosphere = new Atmosphere({ scene, renderer, ambient, houseLight, hazeUniform });

// ---------- Rig ----------
const patch = new Patch();
const rig = new Rig({ hub, scene, patch });
rig.seedDemo();
const fixtures = rig.fixtures;

// ---------- Show engine + the demo show ----------
const engine = new ShowEngine(hub, fixtures);
// Demo show: a laser track on top and a "Movers" track playing one look
// (intensity + rainbow colour + pan wave). Two section markers on the ruler.
const tLaser = engine.addTrack({ kind: 'laser', name: 'Laser 1', open: true });
const tMovers = engine.addTrack({ kind: 'fixture', groupId: 'movers', name: 'Movers' });
engine.markers = [{ t: 0, name: 'Intro' }, { t: 8, name: 'Build' }];
engine.addCue({ layers: lookLayers('rainbow-wave'), name: 'Rainbow wave', start: 0, duration: 16, track: tMovers.id });
// A BEYOND-style laser cue (vector pattern + the 7 parameters) with two
// keyframed Key Effects: a full spin and a size swell across the cue.
const seedLaser = engine.addLaserCue({ pattern: 'tunnel', start: 0, duration: 16, track: tLaser.id });
seedLaser.params.color = [0.2, 1, 0.5];
seedLaser.anim = {
  rotZ: { ease: 'linear', keys: [{ t: 0, v: 0 }, { t: 1, v: 2 * Math.PI }] },
  size: { ease: 'smooth', keys: [{ t: 0, v: 0.6 }, { t: 0.5, v: 1.2 }, { t: 1, v: 0.6 }] },
};

// ---------- Post-processing ----------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.5, 0.82));
composer.addPass(new OutputPass());

let lastW = 0, lastH = 0;
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h || (w === lastW && h === lastH)) return;
  lastW = w; lastH = h;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---------- DMX output (bridge to the main process) ----------
const bridge = window.dmxBridge ?? null;
const output = {
  mode: 'internal',
  artnetIp: prefs.get('output.ip', '127.0.0.1'),
  sacn: prefs.get('output.sacn', false),
};
function pushConfig() {
  hub.mode = output.mode;
  bridge?.setConfig({ mode: output.mode, artnetIp: output.artnetIp, sacn: output.sacn });
}
function setOutput(change) {
  Object.assign(output, change);
  prefs.set('output.ip', output.artnetIp);
  prefs.set('output.sacn', output.sacn);
  pushConfig();
}
if (bridge) {
  bridge.onArtNetIn(({ universe, data }) => hub.applyExternal(universe, data));
  // Mirror universe state to the main process for its steady 40 Hz output tick.
  setInterval(() => {
    if (hub.mode === 'internal') bridge.pushUniverses(hub.snapshotForIpc());
  }, 25);
}
pushConfig();

// ---------- Audio / transport ----------
const audio = new AudioEngine();
const transport = new Transport(audio);

// ---------- UI ----------
const shell = new Shell();
let history = null; // assigned in the Project section below
const commit = () => history?.record();
const project = { name: 'Demo show' };

const editTools = new EditTools({
  canvas, camera, controls, scene, fixtures, grid: 0.5,
  onChange: commit,
  onSelect: (fx) => onFixtureSelected(fx),
});
rig.onRemoved = (fx) => editTools.onFixtureRemoved(fx);

const placement = new PlacementController({
  canvas, camera, controls, scene, fixtures, fixtureType,
  onPlace: (key, points) => {
    const made = rig.place(key, points);
    if (!made.length) { toast('Universe 1 is full — remove a fixture to make room.', { kind: 'error' }); return; }
    editTools.select(made[0]);
    commit();
  },
  grid: 0.5,
  trussY: 5.4,
  getMirror: () => fixtureLibrary.mirror,
});

const cueInspector = new CueInspector({
  transport, engine,
  onChange: () => timeline.renderCues(),
  onCommit: commit,
  onDelete: (cue) => timeline.deleteCue(cue),
  onPickParam: (cue, key) => timeline.focusCurve(cue, key),
  onSelectTrack: (track) => timeline.selectTrack(track),
});

const timeline = new TimelinePanel(transport, audio, engine, document.getElementById('timeline'), {
  onLoadAudio: loadSong,
  onAutoShow: () => autoDialog.open(),
  onEdit: commit,
  onSelect: (kind, obj) => onTimelineSelected(kind, obj),
  onCueMoved: () => cueInspector.refreshMeta(),
  onCurveChange: (cue) => { if (cue === cueInspector.cue) cueInspector.refresh(); },
  onCurvePick: (key) => cueInspector.setFocus(key),
  // "Laser 1 + Laser 2" under a laser track that targets chosen projectors.
  laserTargetLabel: (t) => {
    if (!t.target) return '';
    const on = engine.trackProjectors(t);
    return on.length ? on.map((p) => rig.labelOf(p)).join(' + ') : 'no projector';
  },
});

const overlay = new ViewportOverlay(document.getElementById('overlay'), {
  atmosphere,
  onTool: setTool,
  onCameraReset: resetCamera,
  onSpark: (on) => { engine.manualSpark = on; },
  onAtmosphereCommit: commit,
  hasSparks: () => fixtures.some((f) => f.profile && f.profile.has('Trigger')),
  fixtureCount: () => fixtures.length,
  workspace: () => shell.workspace,
  onGoBuild: () => shell.setWorkspace('build'),
  labelOf: (fx) => rig.labelOf(fx),
});
controls.addEventListener('start', () => overlay.cameraMoved());

// The default laser projector: draws laser cues when the rig has no Laser
// fixtures of its own (each Laser fixture carries its own projector).
const fallbackLaser = new LaserRig(scene);
engine.fallbackLaser = fallbackLaser;

const fixtureLibrary = new FixtureLibrary(document.getElementById('lib-build'), {
  types: FIXTURE_TYPES,
  shell,
  onAdd: addFixture,
  onDragStart: (key) => placement.setPendingType(key),
  onDragEnd: () => placement.setPendingType(null),
  onImportRig: () => importRigFile(),
});

new ContentLibrary(document.getElementById('lib-program'), {
  shell,
  onAddPattern: (key) => timeline.addLaserCueAt(key),
  onAddEffect: (key) => timeline.addFixtureCueAt(key),
  onAddLook: (key) => timeline.addLookAt(key),
  onImportIlda: () => importIldaFile(),
  onRemovePattern: (key) => removeImportedPattern(key),
});

const patchSheet = new PatchSheet(document.getElementById('patchsheet'), {
  patch, rig, shell, fixtureType,
  onSelect: (fx) => editTools.select(fx),
  onRemove: removeFixture,
  onCommit: commit,
});

const inspector = new Inspector(document.getElementById('inspector'), {
  shell, patch, rig, room, editTools, cueInspector, transport, audio, engine, fixtureType,
  getProjectName: () => project.name,
  onCommit: commit,
  onRoomChange: setRoom,
  onRemoveFixture: removeFixture,
  onSelectFixture: (fx) => editTools.select(fx),
  onLoadSong: () => timeline.pickAudio(),
  groups: GROUPS,
  onTrackChange: () => { engine.syncTracks(); timeline.render(); commit(); },
  onMoveTrack: (track, delta) => timeline.moveTrack(track, delta),
  onDeleteTrack: (track) => timeline.deleteTrack(track),
  onMarkerChange: () => { engine.markers.sort((a, b) => a.t - b.t); commit(); },
  onDeleteMarker: (m) => timeline.deleteMarker(m),
});

const topBar = new TopBar(document.getElementById('topbar'), {
  transport, shell,
  getDuration: () => timeline.length,
  actions: {
    open: openProject,
    save: saveProject,
    undo: () => history.undo(),
    redo: () => history.redo(),
    search: () => palette.open(),
    setBpm,
    playPause: () => transport.toggle(),
    stop: () => transport.stop(),
    welcome: () => openWelcome(),
    tour: () => tour.start(),
  },
  output: { get: () => output, set: setOutput },
});

const palette = new CommandPalette(commands);

const live = new LivePanel({
  sections: document.getElementById('live-sections'),
  masters: document.getElementById('live-masters'),
  bar: document.getElementById('livebar'),
}, {
  transport, engine, shell,
  getLength: () => timeline.length,
  onSpark: (on) => { engine.manualSpark = on; },
});

// ---------- Auto (Stage 3c) ----------
// Two modes share one set of settings (engine.autoSettings, saved with the show):
//   live        — LiveDirector picks patterns from what it hears right now
//                 (the song, or a mic / line-in) and overrides the laser tracks
//                 while it's on. A performance control: on/off isn't undoable.
//   pregenerate — analyse the whole song, then write editable laser cues onto
//                 "Auto" tracks at the top of the timeline (an undo step).
engine.autoSettings = normalizeAutoSettings(null);
let autoBeat = 0; // live Auto's beat clock: the song's beat while playing, else free-running
let autoSeed = 1; // each pregenerated take uses the next seed
let analysisCache = null; // { buffer, bpm, offset, an }

async function setAuto(on) {
  if (on === !!engine.auto) return;
  if (!on) {
    engine.auto = null;
    audio.stopInput();
    autoPanel.sync();
    return;
  }
  autoBeat = transport.beat;
  engine.auto = new LiveDirector(engine.autoSettings, (Date.now() & 0xffff) + 1);
  autoPanel.sync();
  if (engine.autoSettings.source === 'input') await startSoundInput();
}
async function startSoundInput() {
  try {
    await audio.startInput();
    toast(`Auto is listening to ${audio.inputLabel || 'the sound input'}.`, { kind: 'ok' });
  } catch (e) {
    console.warn('Sound input failed:', e);
    toast(`Couldn't open a sound input: ${e.message}. Auto follows the beat instead.`, { kind: 'error', ms: 6000 });
  }
}
function setAutoSettings(next) {
  const prev = engine.autoSettings;
  engine.autoSettings = normalizeAutoSettings(next);
  engine.auto?.setSettings(engine.autoSettings);
  if (engine.auto && prev.source !== engine.autoSettings.source) {
    if (engine.autoSettings.source === 'input') startSoundInput();
    else audio.stopInput();
  }
  history.record();
  autoPanel.sync();
}
const projectorCount = () => Math.max(1, engine.projectors().length);

function songAnalysis() {
  const c = analysisCache;
  if (c && c.buffer === audio.buffer && c.bpm === transport.bpm && c.offset === transport.beatOffset) return c.an;
  const an = analyzeSong(audio.buffer, { bpm: transport.bpm, offset: transport.beatOffset || 0 });
  analysisCache = { buffer: audio.buffer, bpm: transport.bpm, offset: transport.beatOffset, an };
  return an;
}
const autoTracks = () => engine.tracks.filter((t) => t.auto);

/** Write a pregenerated show: replaces earlier Auto tracks + markers (one undo step). */
function pregenerate() {
  if (!audio.buffer) return;
  const an = songAnalysis();
  const s = engine.autoSettings;
  const projs = engine.projectors();
  const pairs = s.alternate && projs.length > 1;
  const show = generateShow(an, s, { palettes: engine.palettes, projectors: pairs ? 2 : 1, seed: autoSeed++ });
  setAuto(false);
  for (const t of autoTracks()) engine.removeTrack(t.id);
  engine.markers = engine.markers.filter((m) => !m.auto);
  const lane = {};
  if (pairs) {
    lane.A = engine.addTrack({ name: 'Auto A', kind: 'laser', index: 0, auto: true, target: projs.filter((_, i) => i % 2 === 0) });
    lane.B = engine.addTrack({ name: 'Auto B', kind: 'laser', index: 1, auto: true, target: projs.filter((_, i) => i % 2 === 1) });
  } else lane.A = engine.addTrack({ name: 'Auto', kind: 'laser', index: 0, auto: true });
  for (const c of show.cues) {
    const track = lane[c.lane];
    if (!track) continue;
    const cue = engine.addLaserCue({ pattern: c.pattern, start: c.start, duration: c.duration, track: track.id });
    Object.assign(cue.params, c.params);
    if (c.anim && Object.keys(c.anim).length) cue.anim = c.anim;
    if (c.colorRef) cue.colorRef = c.colorRef;
  }
  for (const m of show.markers) {
    if (engine.markers.some((x) => Math.abs(x.t - m.t) < 0.25)) continue;
    engine.markers.push({ t: m.t, name: m.name, auto: true });
  }
  engine.markers.sort((a, b) => a.t - b.t);
  engine.syncTracks();
  shell.setWorkspace('program');
  timeline.selectCue(null);
  timeline.render();
  history.record();
  const n = show.cues.length;
  toast(`Auto show: ${n} laser cue${n === 1 ? '' : 's'} over ${an.sections.length} sections. Edit anything; Ctrl+Z undoes it.`, { kind: 'ok', ms: 5500 });
}

const autoDialog = new AutoShowDialog({
  hasSong: () => !!audio.buffer,
  onLoadSong: () => timeline.pickAudio(),
  analysis: songAnalysis,
  getSettings: () => engine.autoSettings,
  setSettings: setAutoSettings,
  palettes: () => engine.palettes,
  projectors: projectorCount,
  autoTrackCount: () => autoTracks().length,
  onGenerate: pregenerate,
});

const autoPanel = new AutoPanel(live.autoRoot, {
  getSettings: () => engine.autoSettings,
  setSettings: setAutoSettings,
  isOn: () => !!engine.auto,
  toggle: () => setAuto(!engine.auto),
  onPregenerate: () => autoDialog.open(),
  palettes: () => engine.palettes,
  projectors: projectorCount,
  director: () => engine.auto,
  hasSong: () => !!audio.buffer,
});
// Auto is a Live control: leaving Live hands the lasers back to the timeline.
shell.onChange(() => { if (shell.workspace !== 'live' && engine.auto) setAuto(false); });

// ---------- Selection -> inspector ----------
// The inspector follows the most recent pick: a timeline item (cue, track or
// marker) or a fixture; with nothing selected it shows the workspace's default
// (venue in Build, show in Program).
let lastPicked = null; // 'fixture' | 'timeline'
function timelinePick() {
  if (shell.workspace !== 'program') return null;
  if (timeline.selected) return { kind: 'cue', cue: timeline.selected };
  if (timeline.selectedTrack) return { kind: 'track', track: timeline.selectedTrack };
  if (timeline.selectedMarker) return { kind: 'marker', marker: timeline.selectedMarker };
  return null;
}
function updateInspector() {
  const tl = timelinePick();
  const fx = editTools.selected;
  if (tl && (lastPicked === 'timeline' || !fx)) inspector.show(tl);
  else if (fx) inspector.show({ kind: 'fixture', fx });
  else inspector.show(null);
}
function onFixtureSelected(fx) {
  if (fx) lastPicked = 'fixture';
  patchSheet.setSelected(fx);
  updateInspector();
}
function onTimelineSelected(kind) {
  if (kind) lastPicked = 'timeline';
  updateInspector();
}
shell.onChange(() => updateInspector());

// ---------- Actions ----------
function setTool(mode) {
  editTools.setMode(mode);
  overlay.setTool(mode);
}

function resetCamera() {
  camera.position.copy(CAMERA_HOME.pos);
  controls.target.copy(CAMERA_HOME.target);
  controls.update();
}

function setBpm(v) {
  transport.bpm = v;
  topBar.syncBpm();
  commit();
}

function setRoom(w, d, h) {
  room.build(w, d, h);
  houseLight.setRoom(w, d, h);
  placement.setTrussY(h - 0.6); // hang drag-placed fixtures just below the ceiling
  commit();
}

function addFixture(key) {
  const fx = rig.spawn(key);
  if (!fx) { toast('Universe 1 is full — remove a fixture to make room.', { kind: 'error' }); return; }
  editTools.select(fx);
  commit();
}

function removeFixture(fx) {
  rig.remove(fx);
  if (fx.laser) timeline.render(); // laser track headers name their projectors
  commit();
}

/** Del: whatever the inspector shows (cue / track / marker), else the selected fixture. */
function deleteSelection() {
  const t = inspector.target;
  if (t?.kind === 'cue') timeline.deleteCue(t.cue);
  else if (t?.kind === 'track') timeline.deleteTrack(t.track);
  else if (t?.kind === 'marker') timeline.deleteMarker(t.marker);
  else if (editTools.selected) removeFixture(editTools.selected);
}

function deselectAll() {
  editTools.deselect();
  timeline.selectedTrack = null;
  timeline.selectedMarker = null;
  timeline.selectCue(null);
}

async function loadSong(file) {
  try {
    await audio.load(file);
    transport.pause();
    transport.seek(0);
    // Auto-detect tempo + downbeat so the grid and snapping line up.
    const { bpm, offset } = analyzeTempo(audio.buffer);
    transport.bpm = bpm;
    transport.beatOffset = offset;
    topBar.syncBpm();
    timeline.onAudioLoaded();
    commit();
    toast(`Loaded "${audio.name}" — ${Math.round(bpm * 10) / 10} BPM detected`, { kind: 'ok' });
  } catch (e) {
    console.warn('Audio load failed:', e.message);
    toast(`Couldn't load that song: ${e.message}`, { kind: 'error' });
  }
}

// ---------- Project: save / open / undo ----------
const ctx = { room, houseLight, placement, rig, patch, engine, transport, audio, atmosphere, timeline, editTools };

history = new History({
  snapshot: () => JSON.stringify(serializeProject(ctx)),
  // Keep the playhead, the open cue and the selected fixture across undo/redo —
  // edits happen at the playhead / on the selection, so jumping to 0 or
  // clearing the inspector would lose the user's place. Cue and patch order are
  // stable in the snapshot, so an index finds the same object again (or
  // nothing, if the undo removed it).
  restore: (json) => {
    const cueIdx = engine.cues.indexOf(timeline.selected);
    const trkIdx = engine.tracks.indexOf(timeline.selectedTrack);
    const mkIdx = engine.markers.indexOf(timeline.selectedMarker);
    const fxIdx = patch.entries.findIndex((e) => e.fixture === editTools.selected);
    const picked = lastPicked;
    applyProject(ctx, JSON.parse(json), { keepTransport: true });
    if (fxIdx >= 0 && patch.entries[fxIdx]) editTools.select(patch.entries[fxIdx].fixture);
    if (cueIdx >= 0 && engine.cues[cueIdx]) timeline.selectCue(engine.cues[cueIdx]);
    else if (trkIdx >= 0 && engine.tracks[trkIdx]) timeline.selectTrack(engine.tracks[trkIdx]);
    else if (mkIdx >= 0 && engine.markers[mkIdx]) timeline.selectMarker(engine.markers[mkIdx]);
    lastPicked = picked;
    updateInspector();
    topBar.syncBpm();
    engine.auto?.setSettings(engine.autoSettings);
    autoPanel.sync();
  },
});
history.onChange(() => {
  topBar.setHistory(history.canUndo, history.canRedo);
  topBar.setDirty(history.dirty);
  document.title = `${history.dirty ? '• ' : ''}${project.name} — Lightshow Studio`;
  patchSheet.render(); // mirror links aren't patch events; keep the twin column current
  editTools.refresh(); // re-glow the twin and re-seat the gizmo after inspector edits / undo
  // (the inspector re-renders itself when what it shows changes — see Inspector.frame)
});
history.reset();
topBar.setProject(project.name);

function saveProject() {
  const blob = new Blob([JSON.stringify(serializeProject(ctx), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${project.name.replace(/[\\/:*?"<>|]+/g, '-') || 'show'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  history.markSaved();
  toast(`Saved "${a.download}"`, { kind: 'ok' });
}

const projFile = document.createElement('input');
projFile.type = 'file';
projFile.accept = '.json,application/json';
projFile.hidden = true;
document.body.appendChild(projFile);
function openProject() { projFile.click(); }
projFile.addEventListener('change', async () => {
  const file = projFile.files[0];
  projFile.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    applyProject(ctx, data);
    project.name = file.name.replace(/\.json$/i, '');
    topBar.setProject(project.name);
    topBar.syncBpm();
    history.reset();
    const nFix = (data.fixtures || []).length;
    const nCue = (data.cues || []).length;
    const song = data.audioName ? ` Load "${data.audioName}" again to hear it.` : '';
    toast(`Opened "${file.name}": ${nFix} fixture${nFix === 1 ? '' : 's'}, ${nCue} cue${nCue === 1 ? '' : 's'}.${song}`, { kind: 'ok', ms: 5000 });
  } catch (e) {
    console.error('Project load failed:', e);
    toast(`Couldn't open "${file.name}": ${e.message}`, { kind: 'error', ms: 5000 });
  }
});

// ---------- ILDA import (laser frames from other laser software) ----------
// Imported patterns belong to the show: they're saved inside its file and
// undo/redo like any edit (see project.js / ilda.js).
const ildFile = document.createElement('input');
ildFile.type = 'file';
ildFile.accept = '.ild,.ilda';
ildFile.multiple = true;
ildFile.hidden = true;
document.body.appendChild(ildFile);
function importIldaFile() { ildFile.click(); }
ildFile.addEventListener('change', async () => {
  const files = [...ildFile.files];
  ildFile.value = '';
  const done = [];
  for (const file of files) {
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error(`it's over ${MAX_FILE_BYTES / 1048576} MB`);
      const { pattern, notes } = importIlda(await file.arrayBuffer(), file.name);
      addImported(pattern);
      done.push(pattern);
      const n = pattern.frames.length;
      toast(`Imported "${pattern.label}": ${n} frame${n === 1 ? '' : 's'}. Find it under Laser patterns → Imported.${notes.length ? ` Note: ${notes.join('; ')}.` : ''}`, { kind: 'ok', ms: 6000 });
    } catch (e) {
      console.warn('ILDA import failed:', e);
      toast(`Couldn't import "${file.name}": ${e.message}`, { kind: 'error', ms: 6000 });
    }
  }
  if (done.length) {
    shell.setWorkspace('program');
    history.record();
  }
});
function removeImportedPattern(key) {
  const pat = patternByKey(key);
  if (!pat) return;
  const n = engine.patternUsers(key).length;
  if (n) {
    toast(`"${pat.label}" is used by ${n} laser cue${n === 1 ? '' : 's'}. Change or delete ${n === 1 ? 'it' : 'them'} first.`, { kind: 'error', ms: 5000 });
    return;
  }
  removeImported(key);
  history.record();
  toast(`Removed "${pat.label}" from this show. Ctrl+Z brings it back.`, { kind: 'ok' });
}

// ---------- Rig / show import (MVR from grandMA3, Vectorworks, Capture…; QLC+; xLights) ----------
// The file is read (import/mvr.js, import/qlc.js), the dialog shows what it
// found and the options, then the rig (and a QLC+ show's cues) are rebuilt as
// one undoable edit.
const MAX_RIG_BYTES = 300 * 1048576; // MVRs carry 3D models inside their GDTFs
const rigFile = document.createElement('input');
rigFile.type = 'file';
rigFile.accept = '.mvr,.qxw,.xsq';
rigFile.hidden = true;
document.body.appendChild(rigFile);
function importRigFile() { rigFile.click(); }
const importRigDialog = new ImportRigDialog({
  types: FIXTURE_TYPES,
  chOf: (key) => fixtureType(key)?.profile?.channelCount ?? 0,
  rigCount: () => rig.fixtures.length,
  rigSpans: () => rig.patch.entries.map((e) => ({ universe: e.universe, startAddress: e.startAddress, channelCount: e.channelCount })),
  room: () => ({ ...room.size }),
  onImport: applyRigImport,
});
rigFile.addEventListener('change', async () => {
  const file = rigFile.files[0];
  rigFile.value = '';
  if (!file) return;
  try {
    if (file.size > MAX_RIG_BYTES) throw new Error(`it's over ${MAX_RIG_BYTES / 1048576} MB`);
    if (/\.qxw$/i.test(file.name)) importRigDialog.open(qlcSource(readQlc(await file.text()), file.name));
    else if (/\.xsq$/i.test(file.name)) importRigDialog.open(xsqSource(readXsq(await file.text()), file.name));
    else importRigDialog.open(mvrSource(await readMvr(await file.arrayBuffer()), file.name));
  } catch (e) {
    console.warn('Rig import failed:', e);
    toast(`Couldn't read "${file.name}": ${e.message}`, { kind: 'error', ms: 6000 });
  }
});
function applyRigImport({ entries, room: size, replace, fit, show = null, replaceCues = true }) {
  deselectAll();
  if (replace) rig.clear();
  if (fit) {
    room.build(size.width, size.depth, size.height);
    houseLight.setRoom(size.width, size.depth, size.height);
    placement.setTrussY(size.height - 0.6);
  }
  let made = 0;
  for (const e of entries) if (rig.restore(e)) made++;
  if (show) addImportedShow(show, replaceCues);
  timeline.render(); // laser track headers name their projectors
  shell.setWorkspace(show && !entries.length ? 'program' : 'build');
  history.record();
  const clashes = entries.length ? rig.patch.collisions().filter(Boolean).length : 0; // only news when we patched
  const parts = [entries.length && `${made} fixture${made === 1 ? '' : 's'}`, show && `"${show.name}" (${show.cues} cue${show.cues === 1 ? '' : 's'})`].filter(Boolean);
  const song = show?.audio.length ? ` Load the song (${show.audio.join(', ')}) to hear it.` : '';
  toast(`Imported ${parts.join(' and ')}.${clashes ? ` ${clashes} overlap in the patch — see the Patch sheet.` : ''}${song} Ctrl+Z undoes it.`, { kind: clashes ? 'info' : 'ok', ms: 7000 });
}

/** A converted show (qlc.js convertShow, xlights.js convertSequence) -> timeline tracks, cues and markers. */
function addImportedShow(show, replaceCues) {
  if (replaceCues) {
    for (const t of [...engine.tracks]) engine.removeTrack(t.id);
    engine.cues.length = 0;
    engine.markers = [];
  }
  for (const t of show.tracks) {
    if (t.groupId === 'lasers') {
      // A DMX laser in QLC+ -> a laser track: beams in the cue's colour, a
      // tunnel when the QLC+ function moved it
      const track = engine.addTrack({ name: t.name, kind: 'laser', mute: t.mute });
      for (const c of t.cues) {
        const moving = c.layers.some(([k]) => k.startsWith('p-'));
        const cue = engine.addLaserCue({ pattern: moving ? 'tunnel' : 'beam-fan', start: c.start, duration: c.duration, track: track.id });
        const col = c.layers.find(([k]) => k === 'c-static' || k === 'c-two');
        if (col) cue.params.color = [...col[1].color];
      }
    } else {
      const track = engine.addTrack({ name: t.name, kind: 'fixture', groupId: t.groupId, mute: t.mute });
      for (const c of t.cues) engine.addCue({ layers: c.layers.map(([k, p]) => makeLayer(k, p)), name: c.name, start: c.start, duration: c.duration, track: track.id });
    }
  }
  if (show.markers?.length) {
    for (const m of show.markers) if (!engine.markers.some((x) => Math.abs(x.t - m.t) < 0.05)) engine.markers.push({ t: m.t, name: m.name });
    engine.markers.sort((a, b) => a.t - b.t);
  }
  if (show.bpm && !audio.buffer) { transport.bpm = show.bpm; topBar.syncBpm(); } // (recorded with the import)
}

// ---------- Commands (Ctrl+K) ----------
function commands() {
  const list = [];
  const add = (group, title, run, keys = '', when = null) => list.push({ group, title, run, keys, when });
  add('Show', 'Play / pause', () => transport.toggle(), 'Space');
  add('Show', 'Stop and go to the start', () => transport.stop());
  add('Show', 'Load a song…', () => timeline.pickAudio());
  add('File', 'Save the show', saveProject, 'Ctrl+S');
  add('File', 'Open a show…', openProject, 'Ctrl+O');
  add('Edit', 'Undo', () => history.undo(), 'Ctrl+Z');
  add('Edit', 'Redo', () => history.redo(), 'Ctrl+Y');
  add('Edit', 'Delete the selection', deleteSelection, 'Del');
  add('Edit', 'Deselect', deselectAll, 'Esc');
  for (const w of WORKSPACES) add('Go to', `${w.label} workspace`, () => shell.setWorkspace(w.id), w.keys);
  for (const t of FIXTURE_TYPES) add('Add fixture', t.label, () => { shell.setWorkspace('build'); addFixture(t.key); });
  add('File', 'Import an ILDA laser file…', importIldaFile);
  add('File', 'Import a rig (MVR)…', importRigFile);
  add('File', 'Import a QLC+ workspace…', importRigFile);
  add('File', 'Import an xLights sequence…', importRigFile);
  for (const p of allPatterns()) add('Add laser cue', p.label, () => { shell.setWorkspace('program'); timeline.addLaserCueAt(p.key); });
  for (const l of LOOKS) add('Add look', l.name, () => { shell.setWorkspace('program'); timeline.addLookAt(l.key); });
  for (const e of EFFECTS) add('Add effect', effectShortName(e) + (e.attr === 'color' ? ' (colour)' : e.attr === 'position' ? ' (movement)' : ''), () => { shell.setWorkspace('program'); timeline.addFixtureCueAt(e.key); });
  add('Timeline', 'Add a marker at the playhead', () => { shell.setWorkspace('program'); timeline.addMarker(); }, 'M');
  add('Timeline', 'Add a laser track', () => { shell.setWorkspace('program'); timeline.addTrack('laser'); });
  add('Timeline', 'Add a fixture track', () => { shell.setWorkspace('program'); timeline.addTrack('fixture'); });
  add('Timeline', 'Zoom in', () => timeline.zoom(1.5), 'Ctrl+wheel');
  add('Timeline', 'Zoom out', () => timeline.zoom(1 / 1.5));
  add('Timeline', 'Fit the whole show', () => timeline.fit());
  for (const m of engine.markers) add('Go to marker', m.name, () => transport.seek(m.t));
  add('Tools', 'Select tool', () => setTool('select'), 'V');
  add('Tools', 'Move tool', () => setTool('move'), 'X');
  add('Tools', 'Rotate tool', () => setTool('rotate'), 'C');
  add('View', 'Reset the camera', resetCamera);
  add('View', 'House light on', () => { atmosphere.setHouse(true); commit(); }, '', () => !atmosphere.house);
  add('View', 'House light off', () => { atmosphere.setHouse(false); commit(); }, '', () => atmosphere.house);
  add('View', 'Show / hide the library', () => shell.togglePanel('left'));
  add('View', 'Show / hide the inspector', () => shell.togglePanel('right'));
  add('View', 'Show / hide the timeline or patch sheet', () => shell.togglePanel('bottom'));
  add('View', 'Switch to Simple mode', () => shell.setPro(false), '', () => shell.pro);
  add('View', 'Switch to Pro mode', () => shell.setPro(true), '', () => !shell.pro);
  add('Output', 'Output settings…', () => topBar.openOutput());
  add('Live', 'Blackout on / off', () => live.toggleBlackout(), 'B');
  add('Live', 'Auto (live) on', () => { shell.setWorkspace('live'); setAuto(true); }, 'A', () => !engine.auto);
  add('Live', 'Auto (live) off', () => setAuto(false), 'A', () => !!engine.auto);
  add('Show', 'Pregenerate an Auto show…', () => autoDialog.open());
  add('Live', 'Fullscreen', () => live.toggleFullscreen(), 'F');
  add('Live', 'Reset masters', () => { Object.assign(engine.masters, { dimmer: 1, speed: 1, size: 1 }); live.syncMasters(); });
  add('Help', 'Keyboard shortcuts', () => topBar.openHelp(), '?');
  add('Help', 'Take the tour', () => tour.start());
  add('Help', 'Show the welcome screen', () => openWelcome());
  add('File', 'New show (empty venue)', () => startShow('empty'));
  add('File', 'Load the demo show', () => startShow('demo'));
  return list;
}

// ---------- Keyboard shortcuts ----------
window.addEventListener('keydown', (e) => {
  if (palette.isOpen || welcome.isOpen || tour.isOpen || autoDialog.isOpen) return; // they handle their own keys
  const typing = isTypingTarget(e.target);
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();

  if (ctrl && k === 's') { e.preventDefault(); saveProject(); return; }
  if (ctrl && k === 'o') { e.preventDefault(); openProject(); return; }
  if (ctrl && k === 'k') { e.preventDefault(); palette.open(); return; }
  if (typing) return; // let text fields keep their keys (incl. native text undo)

  if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); history.undo(); return; }
  if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); history.redo(); return; }
  const ws = ctrl && WORKSPACES[Number(k) - 1];
  if (ws) { e.preventDefault(); shell.setWorkspace(ws.id); return; }
  if (ctrl || e.altKey) return;

  // Live workspace: pads on 1–9, ← / → sections, B blackout, F fullscreen.
  if (shell.workspace === 'live') {
    if (/^[1-9]$/.test(e.key)) { live.jump(Number(e.key) - 1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); live.step(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); live.step(1); return; }
    if (k === 'f') { live.toggleFullscreen(); return; }
    if (k === 'a') { setAuto(!engine.auto); return; }
  }
  if (k === 'b') { live.toggleBlackout(); return; }

  switch (k) {
    case 'v': setTool('select'); break;
    case 'x': setTool('move'); break;
    case 'c': setTool('rotate'); break;
    case ' ': e.preventDefault(); transport.toggle(); break; // also stops a focused button re-clicking
    case 'escape': deselectAll(); break;
    case 'm': if (shell.workspace === 'program') timeline.addMarker(); else return; break;
    case '?': topBar.openHelp(); break;
    case '/': if (e.shiftKey) topBar.openHelp(); else return; break; // '?' on layouts that report the base key
    case 'delete': case 'backspace':
      if (e.target.tagName !== 'INPUT') deleteSelection(); // never from a focused slider
      break;
    default: return;
  }
});

// ---------- First run: welcome screen + tour ----------
// The demo show is built above; keep a snapshot of it so "Demo show" can come
// back later from the welcome screen (or Ctrl+K) after other edits.
const DEMO_SNAPSHOT = serializeProject(ctx);
const EMPTY_SHOW = {
  app: 'lightshow-studio', version: DEMO_SNAPSHOT.version,
  room: DEMO_SNAPSHOT.room,
  settings: { bpm: 120, beatOffset: 0, haze: DEMO_SNAPSHOT.settings.haze, brightness: DEMO_SNAPSHOT.settings.brightness, house: true },
  fixtures: [],
  tracks: [{ name: 'Laser 1', kind: 'laser', open: true }, { name: 'Lights', kind: 'fixture', groupId: 'all' }],
  cues: [], markers: [], audioName: null,
};

/**
 * Replace the current show with the demo or an empty venue. The swap is an
 * undo step (Ctrl+Z brings the old show back) — except on first run, where
 * there's nothing to go back to.
 */
function startShow(id, { firstRun = false } = {}) {
  if (id === 'open') { openProject(); return; }
  const empty = id === 'empty';
  applyProject(ctx, structuredClone(empty ? EMPTY_SHOW : DEMO_SNAPSHOT));
  project.name = empty ? 'Untitled show' : 'Demo show';
  topBar.setProject(project.name);
  topBar.syncBpm();
  resetCamera();
  if (firstRun) history.reset();
  else history.record();
  shell.setWorkspace(empty ? 'build' : 'program');
  updateInspector();
  if (!firstRun) toast(empty ? 'New empty venue — Ctrl+Z brings the last show back.' : 'Demo show loaded — Ctrl+Z brings the last show back.', { kind: 'ok', ms: 4500 });
}

const tour = new Tour({ shell, onEnd: () => prefs.set('toured', true) });
const welcome = new Welcome({
  shell,
  onStart: (id, { tour: wantTour, keep }) => {
    prefs.set('welcomed', true);
    if (!keep) startShow(id, { firstRun: welcomeFirstRun });
    welcomeFirstRun = false;
    // Opening a file shows a picker; start the tour straight away either way.
    if (wantTour) setTimeout(() => tour.start(), id === 'open' ? 0 : 60);
  },
});
let welcomeFirstRun = false;
function openWelcome() {
  if (tour.isOpen) tour.end(false);
  palette.close?.();
  welcomeFirstRun = false;
  welcome.open({ firstRun: false, dirty: history.dirty });
}
if (!prefs.get('welcomed', false)) {
  welcomeFirstRun = true;
  welcome.open({ firstRun: true });
}

// ---------- Main loop ----------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  // No track loaded: the free-running clock loops over the show (last cue end).
  transport.loopEnd = engine.cues.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
  transport.update(dt);
  // Feed the current viewport selection to the "Selection" cue group.
  const sel = editTools.selected;
  engine.setSelection(sel ? (sel.mirror ? [sel, sel.mirror] : [sel]) : []);
  engine.beatOffset = transport.beatOffset || 0;
  if (engine.auto) {
    // live Auto: hear the song or the sound input; follow the song's beat while it plays
    const input = engine.autoSettings.source === 'input' && audio.inputOn;
    autoBeat = transport.playing ? transport.beat : autoBeat + (dt * transport.bpm) / 60;
    engine.auto.update({ beat: autoBeat, bands: input ? audio.inputBands() : audio.bands(), dt, palettes: engine.palettes });
  }
  engine.update(transport.time, transport.bpm, audio.bands());
  for (const f of fixtures) f.update(dt);

  timeline.frame();
  cueInspector.frame();
  inspector.frame();
  topBar.frame();
  overlay.frame();
  live.frame();
  autoPanel.frame();
  overlay.drawLaser(engine);

  controls.update();
  resize();
  composer.render();
}
animate();
