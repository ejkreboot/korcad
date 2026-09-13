# KorCad

Local-first, browser-based 2D CAD/CAM for small CNC jobs. Each sheet is drawn in
a workspace:

- **Folded Packaging** — inserts from cardstock, cardboard, and similar sheet
  goods: folded pockets, perimeter walls and glue flanges, rolled edge joists,
  recessed trays and risers, and a 3D assembly preview.
- **Solid** — flat parts cut from a plate, with holes and slots, cut outside and
  inside their lines so both keep their drawn size.

Every sheet is cut on a named machine profile (drag knife or router), with
holding tabs, compensation, toolpath simulation, and G-code and SVG export.

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
src/lib/core/       units, geometry and outlines, design model, machine profiles, CAM, export
src/lib/features/   the workspace registry, and each workspace (packaging, solid)
src/lib/editor/     design-document ownership, history, tools, viewport, persistence
src/lib/viewer/     the Three.js scene builder
src/lib/components/ the editor shell, and each workspace's panels and canvas layer
tests/unit/         unit tests, by layer (core, features, packaging, solid, editor)
tests/fixtures/     golden designs and expected G-code
e2e/                Playwright tests for editor interaction
```

`src/lib/core` must never import Svelte, the DOM, Three.js, or any UI concern.
See `AGENTS.md` for the full architecture and migration rules.

## Golden fixtures

`tests/fixtures` holds reviewed designs and their expected output. A diff there
means the manufactured result changed. Regenerate deliberately, never to make a
test pass:

```sh
UPDATE_GOLDEN=1 npm run test:unit
```

## Migration status

This app is a migration of the single-file `insert-generator.html` prototype,
which is kept as a read-only reference until the new editor reproduces its
regression fixtures.

Ported and tested:

- design model, defaults, and validated design-file normalization
- fold allowance and bend deduction
- pocket, perimeter (plain / folded / joist), tray, riser, and platform geometry
- manufacturability validation
- drag-knife and router compensation, machining stages, route planning
- G-code generation and G-code simulation
- design-file and SVG export
- 2D SVG canvas with grid, CAD cursor, zoom and pan
- drawing, dragging, and resizing the deck, openings, and supports
- semantic opening and support types, material properties, multi-sheet designs
- inspector, sheet tabs, undo/redo, local drafts

Also built since:

- the Three.js assembly preview and the 3D assembly model
- the toolpath simulator, with per-pass playback and tool-change checkpoints
- named machine profiles, referenced per sheet
- explicit manufacturing intent on every path, so CAM is feature-agnostic
- a workspace-namespaced document (version 8): each workspace's data lives under
  `workspaces`, each sheet names its workspace, and drafts are saved as design
  files
- a workspace registry, so the editor, toolbar, export, and 3D viewer look up the
  active sheet's workspace instead of importing packaging
- the Solid workspace, a workspace switcher, and adding, duplicating, and
  deleting machine profiles

Not yet ported:

- rotate, copy/paste, and keyboard nudge of the selection
- the calibration coupon generator
- SVG profile import and multi-sheet job (.zip) export

## Canvas

The toolbar starts with the workspace switcher; the tools beside it belong to
the active sheet's workspace, and "+" on the sheet tabs adds a sheet in either.

On a packaging sheet, drag the deck body to move it with its openings, its edges
to resize it, or the outer grips to set the perimeter wall height. Draw openings
and supports with the Cutout and Support menus; the preset you pick sets the
semantic type, not just the outline.

On a Solid sheet, draw parts with the Part menu and holes or slots inside them
with the Hole menu. Moving a part carries its holes. Holding tabs are left in a
knife-cut part; a routed part is released in one cut.

Scroll to zoom, middle-drag or hold space to pan, and Snap constrains to a
quarter-inch grid. One drag is one undo step.

## Machine output

Exported programs assume a 24 x 24 inch sheet, origin at the lower left, and Z
zero at the material surface. The spindle stays off for knife and creasing work.
Export is blocked while validation reports a problem. A preview is not proof
that a program is safe to run; verify tool setup and workholding, and cut a
calibration coupon before trusting dimensions.
