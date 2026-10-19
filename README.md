# KorCad

Local-first, browser-based 2D CAD/CAM for small CNC jobs. Each sheet is drawn in
a workspace:

- **Folded Packaging** — inserts from cardstock, cardboard, and similar sheet
  goods: folded pockets, perimeter walls and glue flanges, rolled edge joists,
  recessed trays and risers, and a 3D assembly preview.
- **Flat Parts** — flat parts cut from a sheet, with holes and slots, cut outside and
  inside their lines so both keep their drawn size.

Every sheet is cut with a named tool (drag knife or router), with holding tabs,
compensation, toolpath simulation, and G-code and SVG export.

Nothing is uploaded. Drafts live in `localStorage`; durable sharing is an
explicit file export.

## Commands

```sh
npm run dev       # development server
npm run build     # production build
npm run check     # svelte-check + strict TypeScript
npm run lint      # prettier + eslint
npm run test:unit # vitest
npm run test:e2e  # playwright
```

## Layout

The computational core is framework- and DOM-free, and is unit-tested by direct
module import.

```text
src/lib/core/       units, geometry and outlines, design model, tools, CAM, export
src/lib/features/   the workspace registry, and each workspace (packaging, flat-parts)
src/lib/editor/     design-document ownership, history, tools, viewport, persistence
src/lib/viewer/     the Three.js scene builder
src/lib/components/ the editor shell, and each workspace's panels and canvas layer
tests/unit/         unit tests, by layer (core, features, packaging, flat-parts, editor)
tests/fixtures/     golden designs and expected G-code
e2e/                Playwright tests for editor interaction
```

`src/lib/core` must never import Svelte, the DOM, Three.js, or any UI concern.
See `AGENTS.md` for the full architecture and project conventions.

## Golden fixtures

`tests/fixtures` holds reviewed designs and their expected output. A diff there
means the manufactured result changed. Regenerate deliberately, never to make a
test pass:

```sh
UPDATE_GOLDEN=1 npm run test:unit
```

## Features

- design files: versioned, validated on import, with local drafts
- Folded Packaging: fold allowance and bend deduction; pocket, perimeter (plain,
  folded, joist), tray, riser, and platform geometry; supports anchored to real
  surfaces; a Three.js assembly preview
- Flat Parts: parts, holes, and slots on independent sheets, with holding tabs;
  SVG import that turns closed outlines into parts and holes by how they nest
- manufacturability validation, including every tool a sheet uses
- drag-knife and router compensation, machining stages, route planning, router
  and knife passes, blade swivel before each plunge, knife lifts at sharp corners
  and tight curves, and bridge tabs
- a table surface map, entered by hand or probed over USB, which programs follow
  so that cut depth stays true on a table that is not flat
- a machine link to a GRBL controller over USB (Chrome or Edge), to jog, set the
  origin, probe the table, and run a sheet's programs with a stop for each tool
  change, with an always-visible Stop
- G-code export and a toolpath simulator that plays the emitted program, pass by
  pass, with tool-change stops
- design-file and SVG export
- 2D SVG canvas with grid, CAD cursor, zoom and pan; drawing, dragging, and
  resizing
- multi-sheet designs, a workspace switcher, named tools, undo/redo, and New
  project

## To do

- rotate the selection
- copy and paste
- keyboard nudge
- calibration coupon generator
- DXF import; parts nested inside another part's hole; clearance offset for imported
  openings
- multi-sheet job export

## Canvas

The toolbar starts with the File menu: New Flat Parts project and New Folded
Packaging project start over with one empty sheet (undo brings the previous design
back), and Open and Save read and write design files. Next comes a box led by the
workspace chooser; the drawing tools beside it belong to the active sheet's workspace, and
"+" on the sheet tabs adds a sheet in either. SVG and G-code export sit at the end.

On a packaging sheet, drag the deck body to move it with its openings, its edges
to resize it, or the outer grips to set the perimeter wall height. Draw openings
and supports with the Cutout and Support menus; the preset you pick sets the
semantic type, not just the outline.

On a Flat Parts sheet, draw parts with the Part menu and holes or slots inside them
with the Hole menu. Both menus end with **Freeform outline**: click each corner in
turn, and click the first again to close it (a click within 10 pixels of it snaps
there, and its marker fills when it will). Nothing closes the outline for you;
Backspace takes back the last corner and Escape abandons it. Moving a part carries its holes. With "Keep proportions and scale
holes" ticked, a width or height typed into the inspector scales the part and every hole
inside it about its lower-left corner; untick it to stretch the part alone. Each part keeps holding tabs
(four by default): gaps in a knife cut, or on a router bridges the bit rises
over, leaving the tab thickness set in the Material panel. A routed part with no
tabs is named in the program header, because its last cut frees it.

**Import SVG…** sits at the end of the Part menu (Flat Parts) and the Cutout menu
(packaging). It reads every path and basic shape in the file, with transforms and
real units, and flattens curves to within 0.05 mm. Fill and stroke are ignored: a
cut follows the geometry. Open paths, text, images, specks under 1 mm, and
duplicate outlines are skipped, and the footer says what came in, at what size,
and what was left out.

- On a Flat Parts sheet, each closed outline's nesting depth decides what cutting
  it frees: outlines inside an even number of others are parts, cut outside the
  line and given up to four tabs; those inside an odd number are holes. The
  drawing lands with its lower-left corner half an inch in from the sheet's.
  Outlines that cross, and parts nested inside another part's hole, import but
  fail validation.
- On the packaging deck, each outermost outline becomes an opening of that shape,
  named after the file and centred on the deck. Outlines inside it would fall out
  with its slug, so they are skipped. The opening is cut inside its line at the
  drawn size, so draw or scale in any clearance the product needs.

A drawing that yields two or more parts or openings, such as a logo, arrives as one
**imported group**. Clicking any letter selects the whole group, which moves as one
box, and its corner handles and Width and Height fields scale it proportionally.
The rotate buttons in the toolbar, beside Snap, turn it 15° at a time about the
centre of its box; a turn that carries it off the sheet is flagged like any other,
so move it back. They work on any imported drawing, a single outline or a group
(a part turns with its holes) or freeform outline, and stay disabled for the
other shapes drawn in KorCad.
Its members are named after the file (`logo part 3`), so a validation message says
where to look. Groups are imported as they are: there is no ungrouping or editing
of one member, so fix the drawing and import it again. Holding tabs on a Flat Parts
group apply to every part; Delete removes the whole group. On the deck, openings in
a group are checked for overlap by their outlines rather than their boxes, so kerned
letters are allowed.

Scroll to zoom, middle-drag or hold space to pan, and Snap constrains to a
quarter-inch grid. One drag is one undo step.

## Machine output

Exported programs assume a 24 x 24 inch sheet, origin at the lower left, and Z
zero at the material surface. The spindle stays off for knife and creasing work.
A router cuts in equal passes no deeper than the tool's depth per pass; a drag
knife cuts in the tool's number of passes and scores in one. Before a knife
plunges, it lowers its blade to the swivel depth and turns it about the start of
the cut to face along it, so it does not tear round at full depth; a blade with
an offset must have a swivel depth. The knife also lifts to the swivel depth to
turn any corner sharper than its lift angle (30° by default, at most 90°, so
every acute corner is lifted), to make a turn that follows another within two
blade offsets when the two add up past the lift angle, and to rock up and down
round curves tighter than its lift radius (3 mm), like a slow oscillating knife.
The path in X and Y does not change.

A table that is not flat can be measured into the Table surface panel: jog the
tool to each point of a grid over the sheet, lower it until a slip of paper just
drags, and enter the Z reading. The numbers along the grid's edges show where
each column (X, across the top) and row (Y, down the side) stands. It stands half an inch in from the sheet's edges by default, so
its far corners stay inside a machine whose travel is just the sheet; set the
inset from 0 to 2 in, and programs hold the outer points' heights out to the
edges. With the map on, every depth in an exported or
simulated program follows the table relative to X0 Y0, so set Z zero there
before cutting; cuts are split into short moves so their depth follows the table
between points. The map is kept in the browser rather than in the design, and
export is blocked if it spans more than 3 mm, which is likelier a typo than a
table, or if the table rises into a tool's safe Z.

In Chrome or Edge, the Machine panel can connect to a GRBL 1.1 controller over
USB instead (disconnect your sender first; only one program can hold the port).
Jog the tool, in steps up to 5 in (100 mm) across the table and 1 in (25.4 mm)
up and down, at a speed you pick (the controller caps it at its own maximum
rate; Z always moves gently), or type an X and Y and Go to it: the tool rises to
the travel height first if it is lower, and this works before the origin is
confirmed, to bring the tool near it. Set X0 Y0 at the sheet's lower-left corner
and Z0 on the table, and confirm the origin. Then, for each point of the grid, Go to point, and
either lower the tool to a slip of paper and Record Z, or put the touch plate
under it and Probe; Probe every point does the whole grid when a foil sheet
wired to the probe covers the table. If that run stops short (an alarm, Stop,
or a lost connection), the points it missed are outlined, and Finish the …
missed probes just those once the machine is ready again. Each probe seeks the plate at 200 mm/min,
backs off 2 mm, and touches it again at 25 mm/min for the reading; if the two
touches disagree by more than 0.1 mm, it rises and asks you to clear the plate
and probe again. KorCad rises to the travel height before
crossing the table, probes no more than 3 mm below the plate before GRBL gives
up with an alarm, and shows a Stop button at all times while connected.

The Run panel runs the active sheet's programs from there, the same ones G-code
export writes, following the surface map if it is on. Prepare to run lists the
programs and the tool each uses. Before each one, load its tool and set Z0 on
the work: Touch off here with the tip just touching, or put the touch plate on
the work, jog the tool to within 10 mm above it, and Probe Z0. Z0 must be set
before the first program and after every change of tool; with the surface map
on, it can be set anywhere and is worked out from the map. While a program runs
you can pause (motion holds; the spindle keeps turning), resume, and nudge the
feed and spindle overrides. A refused line, an alarm, Stop, or a lost
connection ends the job; it is started over rather than resumed partway. Keep
the tab open: the screen stays awake while a program runs, and leaving asks
first. Export still works for running a job from another sender.

Feeds, plunge feed, and spindle speed are set in the Tool
panel, in the document's units per minute. Cuts go through the material: the
Tool panel sets how far past it they reach (Cut past material, into the mat or
spoilboard), so cut depth follows the material thickness set in the Material
panel. A
sheet gets a separate crease program only when something on it is creased from
the back. Export is blocked while validation reports a problem, including an
unsafe setting on any tool a sheet uses. A preview is not proof
that a program is safe to run; verify tool setup and workholding, and cut a
calibration coupon before trusting dimensions.
