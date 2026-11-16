# Troubleshooting

## Installing

**Windows says "Windows protected your PC".**
The installer isn't code-signed yet. Click **More info → Run anyway**.

## Seeing the show

**I can't see any beams.**
Beams only show where there's haze. Turn **Haze** up in the 3D view's
toolbar. If the room is too bright to see them, turn **House light** off
and **Room light** down.

**I can't see the rig.**
Turn **House light** on, or reset the camera with the camera button.

**A cue doesn't play.**
Check, in this order:
- Is its track muted (**M**)?
- Is another track soloed (**S**)? Then only soloed tracks play.
- For a laser track: does it play on any projector? The track inspector
  warns "Plays on no projector".
- Is a higher laser track playing at the same time on the same projector?
  The higher track wins.
- Is **Blackout** on (**B**)?
- Is **Brightness** down in Live's masters?

**The laser draws nothing on my real laser.**
Laser cues are visual only for now. See [DMX output](10-dmx-output.md).

## Songs and timing

**I opened a show and there's no music.**
The song isn't stored in the show file. Load the same song again in Program
with **Load song**. The message shown on opening names the file.

**The bar lines don't match the beat.**
The detected tempo is off. Type the right BPM in the top bar. If the first
beat isn't at 0:00, set **First beat at** in the show inspector (Pro: click
empty timeline space).

**Auto found the wrong sections.**
First check the BPM. Then click the wrong sections in the Pregenerate dialog
and change their type or mood (see [Auto](07-auto.md#correcting-the-sections)).

**Live Auto says "No sound from the input".**
Check that Windows lets the app use the microphone (Settings → Privacy →
Microphone), and that the right input device is the default one. Auto follows
the BPM until it hears something.

## Live

**Live has no section pads.**
Pads come from markers. Add them in Program with **M**, or let
[Auto](07-auto.md) add them (its **Markers** setting).

## DMX

**No DMX reaches my lights or QLC+.**
- Allow the app through Windows Firewall. Windows asks on first launch; if
  you said no, allow "Lightshow Studio" in the firewall settings.
- Check the IP address in the output settings (click the output pill).
- Check the mode: it must be **Plays the show**, not **Follows a console**.
- Check the patch: your fixtures' universe and addresses (Pro, patch sheet)
  must match the real fixtures.

**The patch sheet says fixtures share DMX channels.**
Two fixtures overlap. Give one of them a free address in the patch sheet
(Pro). If they're the same type on exactly the same address, like the demo's
two cold sparks, that can be on purpose: they always do the same thing.

## Undo

**I generated an Auto show over my edits.**
Press **Ctrl+Z**. A generate is one undo step.

## Still stuck?

Report a problem on the
[project's GitHub page](https://github.com/Royalkiller2222/Lightshow-Studio/issues).
