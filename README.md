# KorCad

Local-first, browser-based 2D CAD/CAM for small CNC jobs. The first feature is a
packaging-insert generator for cardstock, cardboard, and similar sheet goods:
folded pockets, perimeter walls and glue flanges, rolled edge joists, recessed
trays and risers, holding tabs, drag-knife and router compensation, and G-code
and SVG export.

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
src/lib/core/       constants, units, geometry primitives, design model, CAM, export
src/lib/features/   packaging geometry, folds, supports, perimeter, validation
src/lib/editor/     design-document ownership, history, viewport, manipulation, persistence
src/lib/components/ Svelte editor UI
tests/unit/         unit tests, by layer (core, packaging, editor)
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
- a workspace-namespaced document (version 8): packaging data lives under
  `workspaces.packaging`, each sheet names its workspace, and drafts are saved
  as design files

Not yet ported:

- rotate, copy/paste, and keyboard nudge of the selection
- the calibration coupon generator
- SVG profile import and multi-sheet job (.zip) export

## Canvas

Drag the deck body to move it with its openings, its edges to resize it, or the
outer grips to set the perimeter wall height. Draw openings and supports with
the Cutout and Support menus; the preset you pick sets the semantic type, not
just the outline. Scroll to zoom, middle-drag or hold space to pan, and Snap
constrains to a quarter-inch grid. One drag is one undo step.

## Machine output

Exported programs assume a 24 x 24 inch sheet, origin at the lower left, and Z
zero at the material surface. The spindle stays off for knife and creasing work.
Export is blocked while validation reports a problem. A preview is not proof
that a program is safe to run; verify tool setup and workholding, and cut a
calibration coupon before trusting dimensions.
