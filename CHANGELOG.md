# Changelog

Each `## vX.Y.Z` section below becomes the notes of that version's GitHub
Release (see `.github/workflows/release.yml`). Newest first.

## v0.10.0 — 2026-11-15

Laser Stage 3c: **Auto**. The music can drive the lasers in two ways: live in
the Live workspace, or as a pregenerated show written onto the timeline that
you can then edit.

**Install:** download `LightshowStudio-Setup-0.10.0.exe` below and run it. It
updates an existing install. Windows may say "Windows protected your PC" (the
installer isn't code-signed yet); click **More info → Run anyway**.

### Live Auto (Live workspace)
- A big **Auto** pad at the top of the Sections panel (or press **A**). While
  it's on, Auto drives every laser projector from what it hears; turning it
  off hands the lasers back to the timeline. Leaving Live turns it off.
- It picks patterns by energy (calm / medium / high), changes them on the
  bar, jumps straight to a high-energy pattern when a drop hits, and calms
  down when the music breaks down. The bass pulses size and brightness, the
  highs drive the spin, and colours cycle through a palette on the beat.
- **Listen to** the song loaded in Program, or a **sound input** (a
  microphone or line-in) for music playing from somewhere else. The input is
  only listened to; it isn't played through the speakers. With no sound it
  keeps going on the beat.
- A level meter and a status line show what Auto is doing ("High · Beam fan").
- With two or more projectors, **Pairs** gives odd and even projectors
  different patterns spinning opposite ways.

### Pregenerated Auto show
- **Auto show** in the timeline toolbar (or "Pregenerate a show…" in Live, or
  Ctrl+K) reads the **whole song** first, so it can plan ahead: it finds the
  sections (Intro, Verse, Build, Drop, Break, Outro) and shows them over the
  song's energy before you generate.
- It writes ordinary, editable laser cues onto an **Auto** track (or **Auto A**
  / **Auto B** for projector pairs) at the top of the timeline: builds ramp up
  in size, brightness and spin; there's a short blackout right before each
  drop; drops change pattern every couple of bars, and the brightness pulses
  on every kick; calm parts get slow, long looks.
- A marker is added for each section, so the sections become pads in Live.
- Generating again makes a **new take** and replaces the earlier Auto tracks.
  Ctrl+Z undoes it.

### Settings (shared by both modes, saved with the show)
- Intensity (Calm / Balanced / Wild), how often to change (with the music, or
  every 1–8 bars), colours (by mood or one palette), which pattern groups to
  use (plus your imported ILDA patterns), Pairs, and section markers.
- Older show files open with the default settings. The file version stays 5;
  the new fields are optional.

## v0.9.0 — 2026-11-14

Laser Stage 3b: a much bigger pattern library, a Text pattern, and import of
ILDA laser files from other laser programs.

**Install:** download `LightshowStudio-Setup-0.9.0.exe` below and run it. It
updates an existing install. Windows may say "Windows protected your PC" (the
installer isn't code-signed yet); click **More info → Run anyway**.

### More patterns, in groups
- **25 built-in patterns** (was 10). New: split fan, ray burst, cross, light
  sheet, liquid sky, double tunnel, hexagon, star, heart, double wave, wave
  stack, zigzag, figure 8, Lissajous and Text.
- The Program library shows them in **groups**: Beams & sheets, Shapes,
  Waves & curves, Graphics & text, and Imported. Click a group to fold it;
  the app remembers which are open. Searching looks inside every group.
- The inspector's pattern list uses the same groups.

### Text pattern
- Drag **Text** onto the timeline and type a word in the inspector (up to 12
  characters: letters, numbers and simple punctuation). It's drawn in a
  laser-style segment font, and the clip reads "Text: YOUR WORD".

### ILDA import
- **Import ILDA file…** (in the Imported group, or Ctrl+K) loads `.ild` files
  exported by BEYOND, QuickShow, LaserOS and most other laser software.
  Formats 0, 1, 2, 4 and 5 are read: 2D and 3D frames, palette and true colour.
- Imported patterns keep **their own colours** and **animation**. The cue's
  colour tints them; white leaves them unchanged. Set the **Frame rate** in the
  inspector (it shows the frame count and loop length).
- Imports are **saved inside the show file**, so a show stays one file. An
  imported pattern that cues still use can't be removed (you're told how many
  use it); removing an unused one can be undone with Ctrl+Z.
- Limits: 20 MB per file, 600 frames, 4000 points per frame. Anything cut is
  listed in the import message.

### Under the hood
- Show files are now **version 5** (adds the imported patterns and each cue's
  text and frame rate). Older files open as before.

## v0.8.0 — 2026-11-14

Laser Stage 3a: real laser projectors you can aim tracks at, per-projector
output settings, and colour palettes that can cycle on the beat.

**Install:** download `LightshowStudio-Setup-0.8.0.exe` below and run it. It
updates an existing install. Windows may say "Windows protected your PC" (the
installer isn't code-signed yet); click **More info → Run anyway**.

### Laser projectors
- Every **Laser projector** fixture you place in Build now draws laser cues
  itself: its own beams, from where it hangs. The demo show has one.
- **Tracks choose their projectors.** Select a laser track: **Projectors**
  in the inspector plays it on all of them (the default) or only the ones you
  tick. The timeline header says where it plays ("plays on Laser projector 2").
  Each projector shows the top active cue among the tracks aimed at it.
- **Output settings per projector** (select the fixture): **Size**,
  **Brightness limit**, **Flip left–right / up–down**, and in Pro, **Position**.
  **Reset** puts them back. Placing a mirrored pair flips the twin for you.
- The **laser preview** on the 3D view now has a switcher: **All projectors**
  or one at a time.
- A show with no laser projectors still plays its laser cues from a **default
  projector** over the stage, so nothing goes dark.
- The fixture type is now called **Laser projector** (new ones are named
  "Laser projector 1", 2, …) so it doesn't get mixed up with laser tracks.

### Colour palettes
- A laser cue's colour can come from a **palette**: **Its own colour**,
  **Pick from a palette** (click a swatch) or **Cycle through a palette** on the
  beat — every ½, 1, 2, 4 or 8 beats, with an optional fade between colours.
  The swatch playing right now has a ring.
- Starts with three palettes (Ice, Fire, Club RGB). **New palette…** copies
  the current one; **Edit palette** renames it, changes, adds or removes
  colours (up to 8) or deletes it. Editing a palette updates every cue that
  uses it. Deleting one keeps each cue's current colour.
- Works in Simple mode too. Everything is undoable.

### Files
- Show files are now version 4 (projector targets, output settings, palettes).
  Older shows open as before: tracks play on all projectors, cues keep their
  own colours.

## v0.7.0 — 2026-11-14

A friendlier first start: a welcome screen, a short tour, and hints that say
what to do next. This finishes the interface remake.

**Install:** download `LightshowStudio-Setup-0.7.0.exe` below and run it. It
updates an existing install. Windows may say "Windows protected your PC" (the
installer isn't code-signed yet); click **More info → Run anyway**.

### Welcome screen
- Shows the first time you open the app (existing users see it once after
  updating).
- **How to start:** the **Demo show**, an **Empty venue** (a bare room, an
  empty timeline with a laser track and a lights track, house light on), or
  **Open a show…**.
- **Simple or Pro:** pick how much of the interface you see. You can still
  switch any time in the top bar.
- **Show me around** starts the tour when you begin.
- Reopen it any time from **Help (?) → Welcome screen** or **Ctrl+K**. From
  there, Demo and Empty replace the current show, and **Ctrl+Z** brings the
  old one back.

### The tour
- Five short steps that each light up one part of the window — the
  workspaces, adding fixtures, the timeline, the inspector and Live — and
  switch workspace as they go. At the end it puts you back where you were.
- **Next / Back**, the arrow keys or **Enter**; **Esc** skips. Restart it from
  **Help (?) → Take the tour** or **Ctrl+K**.

### Hints when things are empty
- **Timeline:** with no cues, a "Program your show in three steps" card floats
  over the empty tracks: load a song (with a button), drag a pattern or look
  onto a track, press Space and add markers. Drops go straight through the card
  to the track underneath.
- **3D view:** an empty venue says what to do in the workspace you're in. In
  Program and Live it explains that laser cues still draw, with a **Go to
  Build** button.
- New **Ctrl+K** commands: *New show (empty venue)*, *Load the demo show*,
  *Take the tour*, *Show the welcome screen*.

## v0.6.0 — 2026-10-22

The Live workspace: perform the show you programmed.

**Install:** download `LightshowStudio-Setup-0.6.0.exe` below and run it. It
updates an existing install. Windows may say "Windows protected your PC" (the
installer isn't code-signed yet); click **More info → Run anyway**.

### Live workspace (Ctrl+3)
- **Section pads:** one pad for each timeline marker, plus Start. Click a pad
  or press **1–9** to jump there; **← / →** step between sections. The playing
  section is highlighted.
- **Jump on the music (Pro):** set jumps to happen *Now*, on the *Next beat*
  or on the *Next bar*. A queued pad blinks until the jump lands.
- **Masters:**
  - **Brightness** scales every light and the laser.
  - **Speed** speeds effects up or slows them down smoothly, without jumps.
  - **Size** scales the laser and how far moving heads swing.
  - Double-click a master to reset it.
- **Blackout** (**B**, anywhere in the app) kills all light, laser and spark
  output, with a clear BLACKOUT banner on the view.
- **Hold for sparks** and **Fullscreen** (**F**).
- **Now / next strip:** big play/pause and previous/next buttons, the current
  section, a countdown to the next one, and a song overview with the section
  marks (click to jump).

Masters are performance controls: they aren't saved in the show and don't go
through undo.

## v0.5.0 — 2026-10-22

Looks: one clip is now a complete look for your fixtures.

**Install:** download `LightshowStudio-Setup-0.5.0.exe` below and run it. It
updates an existing install. Windows may say "Windows protected your PC" (the
installer isn't code-signed yet); click **More info → Run anyway**.

### Looks
- A fixture cue is now a **look** with up to three layers: **Intensity**,
  **Colour** and **Movement**. Each layer has its own effect and settings, and
  can be set to None.
- Click a look to edit it on the right: rename it, then pick and tune each
  layer. Advanced waveform settings sit under "More" in Pro mode.
- The **Looks** section of the library has seven ready-made looks: Rainbow
  wave, Bass hits, Circle chase, Pulse sweep, Warm wash, White strobe and
  Spark burst. Drag one onto a fixture track, or double-click it.
- Drop a **single effect onto a look** to swap that layer (for example, drop
  Two-colour onto a look to replace its colour).
- Coloured dots on each clip show which layers a look uses.
- The demo's three "Movers · …" tracks are now one Movers track playing a
  single look.

### Also
- When no track has room at the playhead, a new clip goes onto a new track
  instead of hiding on top of another clip.
- New fixture tracks are named after their fixtures ("Movers", "Movers 2").
- Show files are now version 3. Older files open automatically: each old
  fixture cue becomes a one-layer look.

## v0.4.0 — 2026-10-22

A new timeline built like a music app: named tracks, keyframe curves under
the music, section markers, and zoom.

**Install:** download `LightshowStudio-Setup-0.4.0.exe` below and run it. It
updates an existing install. Windows may say "Windows protected your PC" (the
installer isn't code-signed yet); click **More info → Run anyway**.

### Named tracks
- The timeline is now a list of **tracks** ("Laser 1", "Movers · Colour"…).
  Each track has a name, a kind (laser or fixture) and, for fixture tracks,
  the fixtures it drives.
- **Mute (M) and solo (S)** on every track. With any track soloed, only the
  soloed tracks play.
- Click a track's name to edit it in the inspector: rename it, change its
  fixtures, move it up or down (higher tracks win), or delete it.
  Double-click the name to rename it right there.
- Drag a pattern or effect onto a track to add a cue, or below the tracks to
  start a new track. Double-clicking a library item picks a sensible track
  for you.
- Drag clips between tracks of the same kind. Clips snap to beats; hold
  Shift for free placement.

### Keyframe curves under the music
- Laser tracks open (the ▸ arrow) to show a curve lane for every animated
  Key Effect, lined up with the song.
- In a lane: click to add a keyframe, drag to move it (half-beat snapping,
  Shift for free), double-click or press Del to remove it. Clicking a lane
  selects the cue under the pointer.
- Pressing ◆ or clicking a Key Effect's name in the inspector opens its
  lane.

### Markers, zoom and scrolling
- **Section markers** on the ruler (Intro, Drop…). Press M or use the Marker
  button to add one at the playhead, or double-click the ruler. Drag a marker
  to move it; click it to rename or delete it in the inspector. They'll
  become pads in the Live workspace.
- **Zoom** with Ctrl+wheel or the − / + buttons; **Fit** shows the whole show.
  Scroll with Shift+wheel, the scrollbar, or the wheel over the ruler. The
  view follows the playhead while playing.
- The ruler shows bar numbers. The waveform keeps its detail as you zoom in.
- Click empty space on a track to move the playhead there.

### Show files
- Show files are now version 2 (tracks and markers). Files from v0.3.0 and
  earlier open automatically: each old lane becomes a named track.

## v0.3.0 — 2026-10-21

The first installable release: a redesigned interface, laser keyframes, and a
new logo.

**Install:** download `LightshowStudio-Setup-0.3.0.exe` below and run it. It
installs for your Windows user (no admin needed), adds Start-menu and desktop
shortcuts, and opens the app. Windows may show "Windows protected your PC"
because the installer isn't code-signed yet; click **More info → Run anyway**.

### New interface
- **Workspaces.** *Build* is for setting up the venue, fixtures and patch.
  *Program* is for the timeline and cues. Switch with the tabs in the top bar
  or Ctrl+1 / Ctrl+2.
- **One inspector.** Whatever you select (a fixture, a cue, or nothing) is
  edited in the panel on the right. With nothing selected it shows the venue
  (Build) or the show (Program).
- **Libraries you drag from.**
  - Fixtures drag into the venue (as mirrored pairs by default).
  - Laser patterns (with real thumbnails) and fixture effects drag onto the
    timeline.
  - Double-click any library item to add it at the playhead.
- **Simple and Pro.** Simple shows just the essentials. Pro adds DMX
  addresses, extra rotation and effect details, with advanced controls under
  "More".
- **Ctrl+K command search.** Find any action by name ("add tunnel", "house
  light", "save").
- **Transport in the top bar.** Play/pause, stop, the clock and the tempo are
  always visible, along with the output status (click it for the Art-Net and
  sACN settings).
- **Tools on the 3D view.** Select, Move and Rotate float on the view, next to
  haze, room light, house light, a camera reset, the laser preview and the
  cold-spark button.
- **Edit fixtures by number.** Name, position, facing, rotation, mirror twin
  and DMX patch are all editable in the inspector.
- **Resizable panels.** Drag the dividers to resize; double-click one to hide
  its panel. Sizes are remembered per workspace.
- **Small comforts.**
  - "Edited" appears in the top bar when you have unsaved changes.
  - Notifications confirm when a show is saved or opened.
  - The window title shows the show's name.
  - Undo keeps your playhead, selected cue and selected fixture.

### Laser keyframes
- Every laser Key Effect (size, rotation, position, colour, brightness,
  tilt, visible points, scan rate) can be animated across a cue. Press ◆ to set
  a keyframe at the playhead, or turn on Auto-key.
- A curve editor for each effect:
  - Click to add a keyframe, drag to move it (snaps to half-beats; hold Shift
    for free placement).
  - Double-click or press Del to remove a keyframe.
  - Choose linear, smooth or step easing.
- The demo laser now spins and swells.

### Fixes
- The demo no longer goes dark after 16 seconds: without a song, the show
  loops.
- Laser Position no longer moves with Size in the 3D view (it already didn't
  in the preview).
- Space and Ctrl+Z work right after dragging a slider.
- Opening a show with a different room size now moves the house light up to
  the new ceiling.

### Under the hood
- Logo and app icons. The colourful beam fan is the window, taskbar and
  installer icon.
- Releases are built and published automatically when a version tag is
  pushed.
