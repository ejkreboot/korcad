# KorCad Agent Guide

## Product

KorCad is a local-first, browser-based 2D CAD/CAM app for small CNC jobs, and it is FOSS.

Each sheet is drawn in a **workspace** and cut on a named **machine profile** (drag knife or
router). Those two ideas are independent.

- **Flat Parts**: flat parts with holes and slots cut from sheet stock, usually on a router.
- **Packaging**: KorCad's origin. Inserts from cardstock and cardboard: folded pockets, perimeter
  walls, joists, trays and risers, fold allowance, and a 3D assembly preview. It stays a
  first-class workspace.

Both workspaces share compensation, holding tabs, SVG and design-file export, G-code export, and
toolpath simulation. Stock is a fixed 24 in square sheet with its origin at the lower left.

## Preferences

- **Local-first.** No backend, accounts, telemetry, or cloud storage unless a feature truly needs
  one. Drafts go in `localStorage`; durable sharing is an explicit file export. Prefer portable
  standards and transparent file formats.
- **Stack.** SvelteKit 2 with Svelte 5 runes, Vite, Vitest, Playwright, strict TypeScript
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Deploys to Vercel. No Astro.
- **Styling.** One sane, app-wide `src/app.css`, with shared styles wherever possible. No
  Tailwind, because it is too verbose. A workspace's own styles are scoped to its components.
- **The shell names no workspace.** Outside `features/<workspace>` and
  `components/workspaces/<workspace>`, code and UI text stay generic: no packaging vocabulary
  (deck, pocket, flute, board, insert) and no knife-only framing. A drag knife is one machine mode
  among others.
- **Words in the UI.** A `MachineProfile` is a **tool** to the operator (Tool panel, "Cut with",
  "New tool", "Tool name"): the cutter and how it is driven. "Machine" means the whole CNC,
  gantry and spindle included, so the UI does not use it for a profile. The code keeps
  `MachineProfile` and `machine` for now.
- **No legacy designs.** No saved files have shipped. When the document shape changes, update the
  types and regenerate the fixture. Do not add migrations or compatibility readers. A file whose
  `format` is not `korcad-design`, or whose version is not `DESIGN_VERSION`, is rejected.
- **Golden fixtures are the regression contract.** `tests/fixtures/designs/*` and
  `tests/fixtures/expected-gcode/*.nc` change only on purpose, and the reason is recorded in the
  commit. Never regenerate them just to make a test pass.
- **Behaviour first.** Keep numeric values and toolpaths unchanged unless a change is
  intentional and tested. Avoid rounding or unit-conversion cleanups that shift output. Work in
  small, testable slices.
- No `any`, and no unsafe assertions. Use `unknown` at boundaries, then validate and narrow.
  Prefer tagged unions to bags of optional fields. Store millimetres internally and convert
  only for display.
- Do not add a dependency for something a small, tested local module can do. Do not extract
  abstractions just because a file is large, and do not publish the core as a package yet.
- Comments cover manufacturing constraints, coordinate conventions, and geometric reasoning,
  not narration.

## Architecture

```text
src/lib/
  core/          framework-, DOM-, and Three-free; plain data in, plain data out
    constants.ts, units.ts
    geometry/    primitives, outline (shapes, holding-tab splitting), contour (distance, containment)
    design/      types, workspace (WorkspaceDataMap), machine (SheetView), profiles, defaults, normalize
    cam/         stages, compensation, routing, tabs (router bridges), gcode, simulation
    export/      svg, design-file (envelope)
    assembly/    model.ts: generic plates, walls, and draggable groups
  features/
    workspaces.ts  registry, plus reconcileDocument and validateDocument
    document.ts    createDefaultDesign, normalizeState, parseDesign
    packaging/     types, view, actions, geometry/perimeter/supports, folds, levels, mounting,
                   anchoring, placement, paths (CAM intent), assembly, validation, gcode
    flat-parts/    types, view, actions, geometry, validation, manipulation, presets
  editor/        state.svelte.ts (sole owner of the document), tools, history, viewport, persistence
  viewer/        assembly-scene.ts: the only module that imports Three.js
  components/
    editor/      the shell: Canvas, Inspector, Toolbar, SheetTabs, WorkspaceSwitcher,
                 AssemblyViewer, SimulationDialog, CollapsiblePanel
    workspaces/  index.ts (UI registry), packaging/, flat-parts/: inspectors, canvas layers, controllers
    icons/       vendored Material Symbols path data and Icon.svelte
routes/+page.svelte  the editor page
tests/unit/{core,features,packaging,flat-parts,editor}   tests/fixtures/   e2e/
```

Tests enforce these boundaries:

- `core` never imports `features`, `editor`, `viewer`, `components`, Svelte, the DOM, or Three.js.
  Only `core/cam` has a guard test (`cam-boundary.spec.ts`), so check imports by hand elsewhere.
- The shell (`editor/`, `components/editor/`, `routes/`) reaches a workspace only through
  `features/workspaces.ts` and `components/workspaces/index.ts` (`workspace-boundary.spec.ts`).
  The one exception is a type-only import of `IconName` from the icons in `features`.
- Workspace ids are camelCase, because they key the saved document (`packaging`, `flatParts`);
  their folders are kebab-case (`features/flat-parts`).
- A new workspace augments `WorkspaceDataMap`, registers a `Workspace` in
  `features/workspaces.ts`, and registers a `WorkspaceUi` in `components/workspaces/index.ts`.

### Document

```ts
type DesignState = {
	stock: StockSettings; // units, material, finish, grain, minimum web, tab width/count/height
	toolpathOrder: ToolpathOrder;
	machineProfiles: MachineProfile[];
	sheets: Sheet[]; // { id, name, workspace, machineProfileId }
	activeSheetId: string;
	workspaces: WorkspaceData; // { packaging?: PackagingData, flatParts?: FlatPartsData }
};
```

- Generic concerns sit at the top level. A workspace's data sits under `workspaces[id]`, and
  each workspace reads its own section. `normalizeState` and `parseDesign` live in
  `features/document.ts`.
- **Machine settings belong to profiles, and each sheet picks a profile.** Anything that reads a
  machine setting takes a `SheetView` (`sheetView(design, sheetId)`), not a `DesignState`.
  Programs are emitted one sheet at a time.
- **Packaging data covers the whole document.** The deck sheet is `deckSheetId` (never assume
  it is `'deck'`). Read it through `packagingView` or `packagingSheetView`, and write it with
  `withPackaging`. Every packaging sheet must use the same fabrication mode.
- **Flat Parts data belongs to one sheet**, at `workspaces.flatParts.sheets[sheetId].entities`: parts
  (`profile`, cut outside) and holes (`hole`, cut inside).
- Selection is one generic `{ kind, id }` slot in `editor/state.svelte.ts`, and snap lives in
  `tools.svelte.ts`. Neither is saved. Drafts are full design files.
- A support's height is relational: it names an anchor (`box-floor`, `deck-top`,
  `deck-underside`, or `support-top`) plus an offset, and its height is `fixed` or `span`.
  `resolveSupportHeights` runs in packaging's `reconcile` on every mutation and on import. A drop
  gesture picks a relationship through `anchoring.ts`, never a raw Z.

### Editor state

Every change goes through `editor.update` (one undo step) or `editor.preview` (mid-gesture), and
then `editor.commit()`. That is where each workspace's `reconcile` runs. Workspace verbs are pure
functions in `features/<workspace>/actions.ts`, so they can be tested without Svelte. A drag
calls `preview` on each move and `commit` once, in both the 2D canvas and the 3D viewer.

## CAM And Machine Output

This output is safety-critical. Choose conservative behaviour over clever behaviour.

Pipeline: nominal geometry, then manufacturing geometry (fold allowance, compensation, tabs),
then planned toolpaths (stages, ordering, start points, travel), then the G-code postprocessor.
Never mutate inputs along the way.

- **Paths state their own intent.** Each `DesignPath` carries `cam` (stage and side) and
  `owner`. Core CAM never branches on `role`, `foldKey`, or `foldLabel`; those are only for
  display and comments. Packaging builders pick intent helpers from `features/packaging/paths.ts`,
  and any new role must be added to the vocabulary in `cam-intent.spec.ts`.
- **Scoring and fold direction are process concepts, so they live in core.** Up-folds are
  creased from the back in their own program. Deciding _which_ lines fold, and the bend
  deduction, stays in packaging.
- **Stage order:** score, interior, part-release, frame, sheet-release. Interior cuts always
  come before release cuts.
- **Holding tabs.** On a knife a tab is a gap, and the release cut splits into open runs. On a
  router the contour stays closed and carries `holdingTabs`. `bridgeTabbedContour`
  (`core/cam/tabs.ts`) raises the bit over each tab, for `tabWidth + bitWidth`, to
  `Z = -(material - tabHeight)`. Tabs stay on by default. Any routed part without tabs is
  named in the program header.
- **Router passes.** A router cuts each path in the fewest equal passes no deeper than the
  profile's `passDepth` (`passDepths` in `core/cam/gcode.ts`). A closed contour plunges to its
  next pass where it started; an open path retracts and returns first. A pass above a tab's top
  runs straight over it. A knife and every crease cut in one pass.
- **Export requires validation.** Validation returns structured diagnostics, and nothing is
  silently clamped or dropped. The simulator uses the same gate. `validateDocument` checks
  every profile a sheet uses (`core/design/validation.ts`) before asking each workspace, so
  machine settings are never left to a workspace to check.
- **Programs** use mm, G90, and G17, with the safe-Z moves stated in the header. The spindle
  starts only for router cutting, and the header says `SPINDLE MUST REMAIN OFF` otherwise.
  Each program ends with M5, a return to X0 Y0, safe Z, and M2. A workspace adds header lines
  through `gcodeOptions().headerNotes`. A sheet exports a crease program and a cut program only
  when something on it is creased from the back (`programOperations`); otherwise it exports
  one cut program.
- **The simulator parses the emitted program**, not the planned paths. The move type comes from
  the `; N: cut` and `; N: score [up|down]` comments, and a bare `G1` counts as travel. Playback
  is the pure function `simulationFrame(moves, seconds)`. It stops at the end of the crease pass
  for the tool change, and clamps frame steps (`MAX_FRAME_STEP`) for hidden tabs. A simulation
  does not prove a program is safe.

## Hard-Won Notes

- **3D viewer:** keep the canvas out of flow (`position: absolute; inset: 0`), and size its
  drawing buffer from the canvas box rather than its padded wrapper. Below 860px the viewer
  needs a `min-height`. Fit the camera from the bounding sphere against the narrower field of
  view. Three.js loads client-side only, through a dynamic import.
- **e2e:** navigate with `gotoEditor` (it waits for hydration through the draft key), not
  `page.goto('/')`. Drag with `dragOnCanvas`, and derive coordinates from measured boxes.
  Collapse any sidebar panel you open before drawing. On a router, draw flat parts well
  inside the sheet. A WebGL blank-render check compares screenshot PNG sizes.
- **Chrome:** icons are vendored Material Symbols Rounded paths (no icon font or CDN). Custom
  glyphs (the SVG and G-code export buttons) are black-on-transparent SVGs in `static/`, drawn
  by `MaskIcon.svelte` as a mask over `currentColor`, so stroke and fill alike follow button
  states like any other icon. Keep their text converted to paths: a mask image can only use
  fonts installed on the viewer's machine. An
  icon-only control gets `aria-label` and `title`, and toggles use `aria-pressed`. Group toolbar
  items by spacing, not dividers. Material and Tool panels are `CollapsiblePanel`s,
  collapsed by default.
- **The reference prototype:** `insert-generator.html` is a local, gitignored, read-only
  reference for packaging behaviour. Search it; never read it whole, edit it, or import it.
  Deliberate departures from it: risers span to the deck by default, mounts are named anchors,
  fixed supports taller than the space under the deck are rejected (0.5 mm slop), the camera
  fit uses the bounding sphere, and shadows use `PCFShadowMap`.

## Priorities

Essential: none known. Machine settings are validated for every sheet, routers cut in passes,
and the empty crease program is gone.

Next directions:

- Configurable stock size and origin, with the header generated from them instead of the fixed
  24 in text.
- Ramped or helical plunges for routers, a choice of climb or conventional milling, and a
  finishing pass.
- Postprocessor profiles (GRBL, LinuxCNC, Mach3), including optional G2/G3 arc output.
- Import SVG and DXF profiles into Flat Parts. Export a multi-sheet job as a zip.
- Rotate, copy, paste, and keyboard nudge for the selection.
- A first-run choice of workspace. New project (toolbar) already starts a project in either
  workspace, but a fresh browser still opens a packaging deck.
- Move `stock.boardFinish` into `PackagingData`: only the packaging 3D preview reads it (a
  document shape change).
- Packaging: port the calibration coupon, edit fold direction by clicking a fold on the canvas,
  and add bridge tabs on the routed deck outline.
- Later: laser and vinyl profiles, with `engrave`, `mark`, and `drill` operations. Geometric hit
  testing. Shared nesting once a second workspace needs it (it lives in
  `packaging/placement.ts` for now). Offline PWA support (the manifest is already there).

## Commands

```bash
npm run dev          # vite dev server
npm run build        # production build
npm run check        # svelte-kit sync && svelte-check (strict)
npm run format       # prettier --write; run before lint, which fails on formatting alone
npm run lint         # prettier --check && eslint
npx vitest run       # unit suite; UPDATE_GOLDEN=1 regenerates fixtures, deliberately
npm run test:e2e     # playwright; builds and previews on port 4173
```

To work efficiently, run only the specs that cover a change while iterating. Any change to CAM,
geometry, packaging, or Flat Parts also runs `tests/unit/core/golden.spec.ts` and
`tests/unit/flat-parts`. Filter noisy output (`| grep -E "×|Tests |Error"`). In large files
(`Inspector.svelte`, `Canvas.svelte`, `AssemblyViewer.svelte`, `PackagingInspector.svelte`,
`SimulationDialog.svelte`, `packaging/assembly.ts`, `routing.ts`), `grep -n` first and read only
the range you need.

## Definition Of Done

- New or moved behaviour has direct tests. Core logic is tested by importing it, never through
  a component.
- Goldens are unchanged unless the change is deliberate and explained.
- A shape change updates the types and the fixture, with no migration added.
- Machine output is validated before export, and `core` has gained no framework or feature
  imports.
- `check`, `lint`, the unit suite, the build, and the e2e suite all pass.
- A UI change has been viewed in a browser at desktop and phone widths.
