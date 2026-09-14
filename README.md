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
  passes, and bridge tabs
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
with the Hole menu. Moving a part carries its holes. With "Keep proportions and scale
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
(a part turns with its holes), and stay disabled for shapes drawn in KorCad.
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
A router cuts in equal passes no deeper than the tool's depth per pass. A
sheet gets a separate crease program only when something on it is creased from
the back. Export is blocked while validation reports a problem, including an
unsafe setting on any tool a sheet uses. A preview is not proof
that a program is safe to run; verify tool setup and workholding, and cut a
calibration coupon before trusting dimensions.
