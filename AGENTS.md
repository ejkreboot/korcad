# KorCad Agent Guide

## Product

KorCad is a local-first, browser-based 2D CAD/CAM application for small CNC jobs.

Work is organised into workspaces chosen per sheet, each cut on a named machine profile. The **Solid** workspace cuts flat parts with holes and slots from sheet stock. The **Packaging** workspace, where KorCad started, generates inserts for cardstock, cardboard, and similar sheet goods: scoring and creasing, fold allowances, folded walls, trays and risers, and an optional 3D assembly preview. Both share drag-knife and router compensation, holding tabs, SVG/design export, G-code export, and toolpath simulation.

KorCad is a general-purpose tool for straightforward 2D CNC work, and it must retain the packaging workflow that made it useful.

KorCad is FOSS. Favor portable browser standards, transparent file formats, documented machine output, and workflows that users can run without a hosted account.

## Stack And Defaults

- SvelteKit 2 and Svelte 5 runes
- Vite and Vitest
- TypeScript with strict compiler options
- Vercel-compatible deployment, but browser-first and local-first by default
- SVG for the primary 2D editor canvas
- Three.js only for the optional assembly preview, imported dynamically so the 2D editor never loads it
- No backend, authentication, telemetry, or cloud persistence unless a feature has a concrete user need
- `localStorage` for local drafts and explicit import/export for durable sharing
- Please develop a sane, application wide app.css and rely on site-wide styles wherever possible. I prefer not to use tailwind because it is too verbose.

Do not introduce Astro. KorCad is a cohesive, stateful editor rather than a content site with isolated interactive islands.

## Architecture Rule

Keep the computational core independent from the application framework and browser APIs.

The core must not import or depend on:

- Svelte or SvelteKit
- `window`, `document`, `localStorage`, `FileReader`, download helpers, or DOM events
- Three.js, SVG elements, CSS, or UI components
- Vercel APIs or server-only modules

The core accepts plain design data and returns plain data: validation results, geometric paths, toolpaths, export strings, assembly descriptions, and simulation moves.

```text
Design document
  -> normalization and validation
  -> geometry paths
  -> machining operations
  -> planned toolpaths
  -> G-code / SVG / design-file exports

Geometry and assembly descriptions
  -> SVG editor renderer
  -> Three.js assembly viewer
```

A UI component may adapt DOM pointer events to plain editor actions. Core modules must never receive DOM events directly.

## Current Layout

This is the layout as built, not a proposal. Prefer extending these modules over inventing parallel ones.

```text
src/
  lib/
    core/                        framework-free, DOM-free, Three-free
      constants.ts
      units.ts                   mm internally; display/parse for the UI
      geometry/primitives.ts
      geometry/outline.ts        shape outlines, regular polygons, holding tabs (splitSide, splitClosedContour, holdingTabCentres)
      geometry/contour.ts        outline distance, containment, self-intersection
      design/
        types.ts                 DesignState, sheets, stock, paths, machine settings
        workspace.ts             WorkspaceDataMap, augmented by each feature
        machine.ts               machine profiles and per-sheet views
        profiles.ts              add, duplicate, assign, and delete profiles
        defaults.ts              generic defaults: stock, machine profile
        normalize.ts             generic document reading; workspaces read their own
      cam/
        compensation.ts
        routing.ts
        tabs.ts                  router bridge tabs over a compensated, routed contour
        gcode.ts
        simulation.ts
      export/
        svg.ts
        design-file.ts           envelope: serialize, and unwrap before normalizing
      assembly/model.ts          plain-data assembled model: plates, walls, draggable groups

    features/
      workspaces.ts              the workspace registry, and document-wide reconcile/validate
      document.ts                createDefaultDesign, normalizeState, parseDesign
    features/packaging/          packaging domain, built on core
      types.ts                   Pocket, Support, PackagingData; augments the map
      workspace.ts               PACKAGING_WORKSPACE: packaging's registry entry
      actions.ts                 packaging's verbs, pure and bound to the editor
      view.ts                    PackagingView, packagingData, withPackaging
      defaults.ts                packaging, pocket, and support defaults
      normalize.ts               reads workspaces.packaging from a saved file
      fold.ts                    bend deduction, flat panel widths, MIN_FLAT_PANEL
      gcode.ts                   packagingGcode: the program plus the fold header
      paths.ts                   path builders, owners, and the CAM intent each path states
      model.ts                   allGeometry: flat geometry for a sheet
      geometry.ts                pocket openings, walls, finger pulls
      perimeter.ts               folded walls and rolled joists
      supports.ts                riser and tray nets
      folds.ts                   fold identity, direction, labels
      levels.ts                  Z levels, mount planes, spanning heights
      mounting.ts                mount chain: parents, origins, limits
      anchoring.ts               what a dropped support becomes anchored to
      placement.ts               finding room for a net on a sheet
      presets.ts                 cutout and support presets, with their icons
      manipulation.ts            pointer deltas -> deck, opening, and support changes
      assembly.ts                buildAssembly: design -> assembly description
      validation.ts              manufacturability diagnostics
    features/solid/              flat parts with holes and slots, built on core
      types.ts                   SolidEntity, SolidData (per sheet); augments the map
      view.ts                    SolidView, solidData, withSolidSheet
      defaults.ts, normalize.ts  entity defaults; reads workspaces.solid
      geometry.ts                entityOutline, solidGeometry: holes inside, parts outside
      validation.ts              fits the sheet, minimum web, containment, self-intersection
      actions.ts                 Solid's verbs, pure and bound to the editor
      manipulation.ts            move and corner-resize of an entity box
      presets.ts                 part and hole presets, with their icons
      workspace.ts               SOLID_WORKSPACE: Solid's registry entry

    editor/                      transient editor state; may use browser APIs
      state.svelte.ts            the single owner of the design document
      tools.svelte.ts            active tool, snap, viewport, view mode, deck opacity
      history.ts
      viewport.ts
      persistence.ts             local drafts and design-file import/export

    viewer/assembly-scene.ts     the only module that imports Three.js

    components/
      icons/
        paths.ts                 vendored Material Symbols path data
        Icon.svelte              inline SVG glyph
      editor/                    the shell: no workspace imports (workspace-boundary.spec.ts)
        Canvas.svelte            2D sheet: grid, zoom/pan, paths, draft rectangle
        AssemblyViewer.svelte    3D renderer, camera, orbit, drag; builds via workspace.assembly
        SimulationDialog.svelte  toolpath playback
        Inspector.svelte         Material and Machine panels, then the workspace's
        Toolbar.svelte           the active workspace's tools
        WorkspaceSwitcher.svelte shows a sheet of the chosen workspace, adding one if needed
        CollapsiblePanel.svelte
        SheetTabs.svelte
      workspaces/
        index.ts                 UI registry: inspector, canvas layer and controller, assembly controller
        packaging/
          canvas.ts              what a press or a drawn rectangle does
          PackagingCanvasLayer.svelte     deck, hit targets, handles, labels
          PackagingInspector.svelte       opening, support, and deck panels
          PackagingMaterialFields.svelte  fold allowance
          assembly.svelte.ts     support drags and the readout in the 3D viewer
        solid/
          canvas.ts              press and draft; moving a part carries its holes
          SolidCanvasLayer.svelte         hit targets, handles, part labels
          SolidInspector.svelte           the selected part or hole, or the plate

  routes/+page.svelte            the editor shell

tests/
  unit/{core,features,packaging,solid,editor}/
  fixtures/{designs,expected-gcode}/
e2e/
  helpers.ts                     shared navigation that waits for hydration
  editor.e2e.ts                  2D editor interactions
  assembly-viewer.e2e.ts         3D rendering, controls, mobile layout
  support-mounting.e2e.ts        anchors and spanning heights
  simulation.e2e.ts              toolpath playback and tool changes
  machine-profiles.e2e.ts        profile editing and per-sheet machines
  document-format.e2e.ts         the saved shape, unreadable drafts, selection outside it
  solid-workspace.e2e.ts         Solid tools, cut-only export, parts carrying holes, router tabs
  workspace-switcher.e2e.ts      switching workspace; adding, duplicating, deleting profiles
```

Two layering rules matter more than the tree itself:

- `core` may not import from `features`, `editor`, `viewer`, or `components`. Only `core/cam` is guarded by a test (`tests/unit/core/cam-boundary.spec.ts`); the rest of `core` is kept clean by review, so check imports when adding to it. When a workspace rule has to run at an import boundary, put it in that workspace's `reconcile` or reader — `editor/persistence.ts` runs every workspace's `reconcile` on import — not in `core/design/normalize.ts`.
- The editor shell (`editor/`, `components/editor/`, `routes/`) reaches a workspace only through `features/workspaces.ts` and `components/workspaces/index.ts`; `tests/unit/editor/workspace-boundary.spec.ts` enforces it. Feature modules (`features/workspaces.ts`, each workspace's `presets.ts`) type-import `IconName` from `components/icons/paths.ts` so a tool carries its own icon; that is a type-only edge to plain path data, and nothing else in `features` may import from `components`.
- `viewer/` owns Three.js. A workspace's `assembly` (packaging's `buildAssembly`) produces the plain-data description in `core/assembly/model.ts`, which names no workspace's parts; `viewer/assembly-scene.ts` turns it into meshes, and `components/editor/AssemblyViewer.svelte` owns the renderer and hands drags to the workspace's assembly controller. Geometry decisions belong in the workspace's builder so they can be unit-tested without a browser.

Do not create a package workspace or publish a package prematurely. Keep the core as an internal module until its public API has stabilized through real use.

## TypeScript Requirements

Use strict TypeScript from the start. Configure at least:

```json
{
	"compilerOptions": {
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"exactOptionalPropertyTypes": true,
		"noImplicitOverride": true
	}
}
```

Use explicit domain types at module boundaries. Define and share types for:

- `DesignDocument` and its versioned persisted form
- stock, machine, tool, and operation settings
- points, bounds, paths, contours, and operation metadata
- validation diagnostics and stable diagnostic codes
- planned routes and generated program metadata
- packaging components, folds, mounting relationships, and assembly parts
- transient editor state and editor actions

Keep model types narrowly discriminated. Prefer tagged unions over optional fields that combine unrelated component kinds.

```ts
type Component = Pocket | Riser | Tray | Platform;

type Pocket = {
	kind: 'pocket';
	id: string;
	// pocket-only fields
};

type Tray = {
	kind: 'tray';
	id: string;
	// tray-only fields
};
```

Do not use `any`. Do not use unsafe type assertions to bypass incomplete migrations or DOM integration. Use `unknown` at external boundaries, validate it, then narrow it into a typed domain object.

Keep browser and rendering types out of `core`. A `Point` is domain data, not `DOMPoint`; a path is domain data, not `SVGPathElement`.

## Domain Model

Use a versioned, JSON-serializable design document.

Separate durable design data from transient editor state.

Durable design data includes:

- document format and version
- stock dimensions, units, material, and machine settings
- sheets
- geometric components
- feature-specific properties
- operation settings
- semantic metadata necessary for manufacturing

Transient editor state includes:

- selection
- active tool
- hover state
- viewport pan and zoom
- open dialogs and menus
- undo/redo stacks
- temporary drawing and manipulation state

Do not serialize transient UI state into an interchange design file unless there is a clearly documented reason.

### The Document Is Namespaced By Workspace

```ts
type DesignState = {
	stock: StockSettings; // units, material, finish, grain, minimum web, tabs
	toolpathOrder: ToolpathOrder;
	machineProfiles: MachineProfile[];
	sheets: Sheet[]; // { id, name, workspace, machineProfileId }
	activeSheetId: string;
	workspaces: WorkspaceData; // { packaging?: PackagingData, solid?: SolidData }
};
```

Generic concerns live at the top level. Everything a workspace invents lives
under `workspaces[id]`, present only when the document uses that workspace.

- **Core names workspace data without importing it.** `core/design/workspace.ts`
  declares an empty `WorkspaceDataMap`; `features/packaging/types.ts` augments it
  with `packaging: PackagingData`, `features/solid/types.ts` with `solid:
SolidData`. `WorkspaceId` is the map's keys. A new workspace adds its own
  augmentation and registers in both registries: a `Workspace` entry in
  `features/workspaces.ts` and a `WorkspaceUi` entry in
  `components/workspaces/index.ts` (the compiler requires the second once the
  id exists).
- **An unknown workspace tag is re-tagged `packaging`** by normalization. There
  are no files from other builds, so this is a fallback for hand-edited input,
  not a compatibility promise; leave it unless it gets in the way.
- **Each workspace reads its own saved data.** `normalizeDocument` in core reads
  stock, profiles, and sheets, then hands `workspaces[id]` to each registered
  reader. `normalizeState` and `parseDesign` live in `features/document.ts`,
  because only that layer knows every workspace; import them from there.
- **Solid data is sheet-scoped.** `workspaces.solid.sheets[sheetId].entities`
  holds one plate's parts (`kind: 'profile'`, cut `outside`, stage
  `part-release`) and holes (`kind: 'hole'`, cut `inside`, stage `interior`).
  Normalization gives every Solid sheet an entry and drops data for any other
  sheet. On a drag knife a part's release cut is broken by holding tabs into
  open runs chained with `solid-profile:<id>`; on a router it stays one closed
  contour carrying `holdingTabs` (see Router Holding Tabs Are Bridges).
- **A workspace keeps to its own sheets.** Packaging's tray placement, support
  sheet validation, and sheet picker only consider sheets tagged `packaging`.
- **Packaging data is document-scoped.** One `PackagingData` spans every sheet
  tagged `packaging`: the deck sheet (named by `deckSheetId`, never assumed to be
  `'deck'`) carries pockets and tray openings, and each support is cut from the
  sheet its `sheetId` names. Read it flat through `PackagingView`
  (`packagingSheetView(design, sheetId)`, or `packagingView(design)` for the deck
  sheet), and write it with `withPackaging(design, update)`.
- **Selection and snap are not in the document.** Selection is one generic slot,
  `{ kind, id }`, in `editor/state.svelte.ts`, reported only while the active
  workspace's `selectionExists` says the entity is still there; each workspace's
  bound actions read it in their own terms (`selectedPocketId`,
  `selectedEntity`). Snap is in `editor/tools.svelte.ts` and reaches drags as
  `tools.snapEnabled` (packaging's `DragView = PackagingView & { snapEnabled }`).
- **Drafts are design files.** `saveDraft` writes through `serializeDesign`, and
  `loadDraft` reads through `parseDesign`; a draft it cannot read is dropped and
  the editor starts fresh.

**There are no legacy designs.** KorCad has never shipped saved files to users,
so loading or upgrading old document versions is not a requirement. When the
document shape changes, change the types and regenerate the serialization
fixture (`tests/fixtures/designs/folded-pocket.voisee.json`, with
`UPDATE_GOLDEN=1`); do not add a migration step or a compatibility reader.

`unwrapDesignFile` requires the `format` and a `version` equal to
`DESIGN_VERSION`, and rejects anything else — a bare document, an older or newer
file — with a clear error. Past the envelope, `normalizeState` still reads the
document field by field, because imported JSON is untrusted input.

Validate untrusted design-file JSON at the import boundary. TypeScript types do not validate runtime data.

### Machine Profiles

The thirteen machine settings — fabrication mode, feeds, depths, blade offset,
bit width, spindle speed — are not document settings. They live in a named
`MachineProfile`, and each `Sheet` references one by id. Programs are emitted
per sheet, so the machine is a property of the sheet, and one job can hold a
creased deck and a routed plate.

Consequences for anything that reads a machine setting:

- **Take a view, not a `DesignState`.** A `SheetView` is the stock, the sheet
  list, and the machine settings of one sheet's profile; build one with
  `sheetView(design, sheetId)` from `core/design/machine.ts`. Every CAM settings
  type picks from `SheetView` or `MachineSettings`; every packaging settings type
  picks from `PackagingView`, which adds the packaging data.
- **Geometry is answered per sheet.** `allGeometry(document, sheetId)` resolves
  that sheet's profile itself, because a routed sheet does not fold.
- **Assembly-wide questions use `packagingView`.** Deck height, support
  heights, and validation describe the whole box, and answer against the deck
  sheet's machine. Validation rejects a document whose packaging sheets
  disagree on fabrication mode, so for any exportable design the choice of
  sheet cannot change the answer.
- The editor exposes `editor.view` (the active sheet's `SheetView`),
  `editor.workspace` (its registry entry), and `editor.machine` (its profile).
  Components read those rather than resolving profiles themselves. Packaging
  components get `PackagingView` from `packagingActions(editor).view`, which
  throws without packaging data — so only packaging UI, mounted for a packaging
  sheet through `components/workspaces/index.ts`, may call it.
- **Export asks the workspace for its G-code options.** The shell calls core
  `generateGcode` with `workspace.gcodeOptions(design, sheetId)`; packaging's
  returns its fold-allowance line in `headerNotes`, printed where it always was.
  `packagingGcode` is the same call wrapped for tests and goldens. A workspace
  with the `folding` capability exports a crease and a cut program; one without
  exports a single cut program.

### Vertical Placement Is Relational

A support never stores a bare Z height. It stores an anchor naming a real surface, so changing the perimeter wall moves everything anchored to the deck with it.

```ts
type SupportMount =
	| { anchor: 'box-floor'; offset: number }
	| { anchor: 'deck-top'; offset: number }
	| { anchor: 'deck-underside'; offset: number }
	| { anchor: 'support-top'; supportId: string; offset: number };
```

`offset` always measures away from the anchoring surface along the support's own build direction, so it reads positive downward for `deck-underside` and positive upward everywhere else. The union is discriminated deliberately: only `support-top` carries an id, and a face for the box floor cannot be written down.

Height is either `fixed` or a `span` derived from the gap between the anchor and the deck underside. A riser box exists to hold the deck up, so it spans by default and its flat net follows the wall height. `resolveSupportHeights` writes the derived value back into `h`, and runs on every editor mutation and at the design-file import boundary — so every geometry consumer reads one concrete number and never has to know how it was decided.

When adding a gesture that moves a support, resolve it through `features/packaging/anchoring.ts`. A drop picks a _relationship_, never a raw height: landing on another support stacks on it, and dragging clear falls back to the base that stack stood on. The floor/deck-top choice stays an explicit inspector control, because a camera looking down at a closed box cannot distinguish them.

## Geometry And CAM Contracts

Use a small, explicit path contract rather than leaking packaging-specific object shapes into CAM code.

A path should carry:

- ordered points in millimeters
- open or closed status
- operation type, such as `cut`, `score`, `crease`, `engrave`, or `drill`
- stable source identifier
- optional semantic role for feature-level behavior
- operation-relevant metadata only

Keep these layers distinct:

1. Nominal geometry: the user’s intended dimensions.
2. Manufacturing geometry: geometry after fold allowance, kerf/bit/blade compensation, tabs, relief slots, and tool-specific changes.
3. Toolpath planning: legal ordering, reversible open paths, closed-contour start points, travel optimization, retracts, and machining stages.
4. Postprocessing: machine-specific G-code or other output formats.

**Scoring and fold direction are process concepts, and belong in core.**
`DesignPath.foldDirection`, the `score` path type, and the `score` stage are
read by core CAM, G-code, simulation, and SVG export because they decide how a
path is machined: up-folds are creased from the back in their own program with
their own tool, and the simulator stops for that tool change. That is not
packaging leaking into core. What stays in packaging is deciding _which_ lines
fold and in which direction (`folds.ts`, `foldDirections`) and the bend
deduction. `foldKey`/`foldLabel` on `DesignPath` are packaging bookkeeping for
fold editing and display only; CAM must not branch on them.

### Router Holding Tabs Are Bridges

A drag knife leaves a holding tab as a gap: the release cut is split into open
runs. A router cannot do that, because compensation offsets closed outlines and
routing reverses and rotates paths. So a routed outline stays closed and
carries `DesignPath.holdingTabs` — tab centres on the drawn outline — and
`generateGcode` hands the compensated, routed points to `bridgeTabbedContour`
in `core/cam/tabs.ts`, which:

- projects each centre onto the programmed contour, so rotation and reversal
  cannot move a tab;
- raises the bit for `tabWidth + bitWidth` along its centre, which leaves
  exactly `tabWidth` of bridge on the part edge, to
  `Z = -(material - tabHeight)`, with vertical rises and drops at plunge feed
  and `; holding tab` / `; end of tab` comments;
- starts the contour outside every tab, so the plunge never lands on one, and
  ends on the tab if that start is a tab's end;
- throws on a tab the cut would go through, one thicker than the board, or tabs
  that leave nothing to cut. Solid validation rejects all three before export.

`tabHeight` is a stock setting beside `tabWidth`. A program with bridges says so
in its header; Solid also names any routed part left without tabs there.
Packaging's routed deck outline does not carry tabs yet; it can adopt the same
field.

Do not mutate a nominal design or source path while generating compensated geometry or optimizing routes. Prefer read-only inputs and newly created output objects in core modules.

## Packaging Is A Feature Module

Packaging remains a first-class feature, not a collection of optional fields in a generic shape object.

Keep packaging-specific concepts inside `features/packaging`:

- decks and exterior perimeters
- folded walls and flanges
- trays, risers, and platforms
- which lines fold, their direction, and bend deduction (the `score` path type and `foldDirection` on a path are core process concepts; see Geometry And CAM Contracts)
- the manufacturing intent of each of its paths, stated where the path is drawn
- finger pulls and relief slots
- joists and locking tabs
- assembly relationships
- calibration coupons

General 2D tools should share the core path and CAM APIs, but should not need to understand packaging roles, fold layout, or assembly hierarchy.

Add new capabilities as feature modules, for example:

```text
features/
  packaging/
  panel-cutouts/
  vinyl/
  templates/
```

Only promote a concept from a feature module into `core` after at least two independent features genuinely require it.

### Packaging States Its Own CAM Intent

Every packaging path constructor (`geometry.ts`, `perimeter.ts`, `supports.ts`,
`model.ts`) states the path's `cam` and `owner` where it draws it, through the
builders and intent helpers in `features/packaging/paths.ts` — the same
contract Solid follows. There is no role table and no derivation pass; `role`
is for display, fold labels, and G-code comments only.

- **Owners.** A pocket's paths carry `{ kind: 'pocket' }`, a support's
  `{ kind: 'support' }`, and perimeter paths none. `pathGroup` turns that into
  the `pocket:`/`riser:`/`sheet:` prefix shared by chain keys and persisted fold
  keys; the `riser:` spelling is saved in `foldDirections`, so do not rename it.
- **Adding a path.** Decide its stage and side and pick the matching helper
  (`foldIntent`, `INTERIOR_HOLE`, `partReleaseIntent`, `frameIntent`,
  `sheetReleaseIntent`, `DECK_OUTLINE`), then add its role to the reviewed
  vocabulary in `tests/unit/packaging/cam-intent.spec.ts`, which fails on any
  role it does not list and checks each emitted path against it.

## Machine Output Safety

Manufacturing output is safety-critical. Prefer conservative behavior over clever behavior.

- Validate before allowing export.
- Return structured validation diagnostics with stable codes.
- Never silently clamp or discard invalid manufacturing geometry.
- A routed part freed by its last cut can be caught by the bit. Keep holding tabs on by default, and name any routed part without them in the program header.
- Never start a spindle, laser, or other machine tool unless the selected postprocessor explicitly requires it and the user has configured it.
- Include safe-Z moves, feed rates, coordinate mode, units, and a final safe/home move in generated programs where supported.
- Keep machine profiles and postprocessors separate from geometry and routing.
- Treat drag-knife compensation, router kerf compensation, scoring, and creasing as distinct operations with explicit semantics.
- Preserve machining dependency stages: interior operations before exterior release cuts, and any feature-specific dependencies before route optimization.
- Document postprocessor assumptions in generated output and project documentation.

A visual simulation is useful but is not proof that machine output is safe. Maintain test coverage around emitted G-code.

### The Simulator

The simulator parses the **emitted program** rather than the planned toolpaths. That is deliberate: it is the closest available check that what we emit is what we meant to emit. It follows that the simulator is gated on the same validation as export, and that it runs one sheet at a time, because programs are emitted per sheet — the dialog names the sheet it is running.

Playback is a pure function of elapsed time: `simulationFrame(moves, seconds)` returns the interpolated position and the trail. The component owns only the clock and the animation frames. That split is what makes scrubbing, replaying, and any speed multiplier agree with each other, and it is why the interesting parts are unit-tested rather than asserted through the DOM.

Two things to know before touching it:

- A job is split into passes by tool, not by convenience. Up-folds are creased in their own program, so playback **stops** at the end of the crease pass and waits, rather than running on through a tool change the operator has not made.
- Animation frames do not fire in a hidden tab, so per-frame time deltas are clamped (`MAX_FRAME_STEP`). Without that, returning to a backgrounded tab advances the job by however long the operator was away and the head appears to teleport.

## Testing Requirements

Every extracted or added core function should be directly importable and unit-tested. Do not test core logic by parsing a Svelte component, extracting an inline script, or recreating its implementation inside tests.

Prioritize tests for:

- design normalization of untrusted imported JSON
- unit conversion and numeric rounding
- bounds and validation
- nominal versus compensated geometry
- fold directions and bend deductions
- packaging geometry and assembly relationships
- path ordering and stage preservation
- travel optimization without source mutation
- open-path reversal and closed-contour start-point selection
- router and drag-knife compensation
- holding tabs: knife gaps, and router bridges that survive route rotation and reversal
- G-code headers, operations, retracts, safe return, and spindle/tool behavior
- G-code simulation parsing, including that move types come from the `; N: cut` / `; N: score [up|down]` comments the generator emits before each path — a bare `G1` with no such comment ahead of it is read as travel

Maintain representative golden fixtures:

```text
tests/fixtures/designs/*.voisee.json
tests/fixtures/expected-gcode/*.nc
```

Golden outputs must be reviewed intentionally. Do not update them merely to make a test pass.

Use browser-level tests for editor interactions that cannot be tested in the core:

- draw, select, move, resize, and rotate
- keyboard commands and undo/redo
- pan and zoom
- import/export UI
- SVG and Three.js rendering
- responsive desktop and mobile layouts

Before considering a 3D-viewer change complete, verify that it renders nonblank, supports its advertised interaction, and does not overlap editor controls at desktop and mobile viewport sizes.

Notes from building the viewer, all of which cost real debugging time:

- The canvas must stay out of flow (`position: absolute; inset: 0`). A canvas has an intrinsic size from its drawing buffer, so an in-flow one feeds its own height back into the grid row that the resize handler measures, and the viewer shrinks on every pass.
- Size the drawing buffer from the canvas box, never from its wrapper. `canvas-wrap` carries padding at mobile widths, and a buffer sized to the padding box renders stretched.
- The shell stacks and scrolls below 860px, where the canvas row has no height to give. The 2D sheet sets its own floor with `min-height`; the 3D viewer needs the same.
- Fit the camera by solving the distance from the model's bounding sphere against the narrower of the two fields of view. A fixed camera distance crops the deck as soon as the pane is not square.
- In the e2e tests the SVG sheet is drawn centred inside a much wider box, so only the middle of the pane lands on the deck. Drag through the shared `dragOnCanvas` helper rather than guessing pixels, and derive any fixed point from the measured box: the toolbar rewraps as controls are added and shifts everything below it. Opening a sidebar panel also moves the canvas, so collapse it again before drawing. On a router, draw Solid parts well inside the sheet: a drag past the edge is clamped to it, and a part flush with the edge fails validation because the bit runs outside the line.
- Navigate with `gotoEditor` from `e2e/helpers.ts`, never a bare `page.goto('/')`. The page is server-rendered, so a button is painted, enabled, and clickable before hydration wires up its handler; a click landing in that window satisfies every actionability check and is then silently swallowed, surfacing later as a dialog that never opened. The helper waits for the autosaved draft key, which only an effect can write.
- A WebGL canvas does not preserve its drawing buffer, so a blank-render check reads the PNG size of a Playwright element screenshot rather than pixels.

## Migration Status

The monolithic `insert-generator.html` has been modularized. It stays in the repository as a **read-only reference** — consult it for behaviour questions, never edit it, and do not import from it.

Done:

1. Constants, units, types, normalization, and geometry primitives extracted to `core`.
2. Packaging geometry, perimeter, supports, folds, and validation extracted to `features/packaging`.
3. CAM compensation, routing, and G-code generation extracted, with golden fixtures.
4. Logic tests converted to direct TypeScript module imports.
5. The Svelte editor built around the stable core: 2D SVG canvas, inspector, toolbar, sheet tabs.
6. SVG, design-file, and G-code export.
7. The 3D assembly viewer, split into a pure assembly description and a Three.js renderer.
8. Vertical placement reworked from a bare `assemblyZ` to named anchors and spanning heights.
9. The toolpath simulator: per-pass playback of the emitted program, with tool-change checkpoints.
10. CAM generalization: paths state their own manufacturing intent, and core CAM no longer
    reads packaging role strings.
11. Machine profiles: the thirteen machine settings moved into named profiles referenced per
    sheet, on a version-stepped migration pipeline (document version 7).
12. Workspace namespace: packaging data under `workspaces.packaging`, a workspace tag per
    sheet, `stock` grouped, selection and snap moved out of the document, drafts written
    as design files, and a registry seam in `features/workspaces.ts` (document version 8).
13. Compatibility cleanup: the migration pipeline, old-shape readers, `netVersion`, and the
    bare-draft fallback removed; a file of any other version is rejected.
14. Registry wiring (slice 4): the editor state, toolbar, export, persistence, inspector,
    and canvas reach a workspace only through `features/workspaces.ts` and
    `components/workspaces/index.ts`; packaging's verbs are pure functions in
    `features/packaging/actions.ts`.
15. The Solid workspace (slice 5): parts, holes, and slots on sheet-scoped plates, chosen when
    adding a sheet; `splitSide` and the shape outlines promoted to `core/geometry/outline.ts`;
    cut-only export and no fold legend or 3D on a workspace without those capabilities.
16. Workspace switcher and profiles UI: the toolbar names the active workspace and switches to
    a sheet of another, adding one when there is none, and disarms a tool left from the old
    workspace; the Machine panel adds, duplicates, assigns, and deletes profiles, and a
    deletion names the sheets that move to another machine before it happens.
17. Slice 6 cleanup: `core/assembly/model.ts` names no workspace's parts (`plate`, `fades`,
    `draggableId`, `extent`, `dragPlaneZ`); the 3D viewer is a generic editor component
    that builds through `workspace.assembly` and hands drags to a workspace assembly
    controller; `MIN_FLAT_PANEL` lives with packaging's fold allowance.

18. Packaging intent cleanup: every packaging constructor states its own `cam` and `owner`;
    `pocketId`/`riserId` are gone from `DesignPath`, and `cam-intent.ts`, its role tables,
    and `PackagingPath` are deleted, with goldens and CAM snapshots byte-identical.

19. Router holding tabs: a routed Solid part keeps its tabs as bridges the bit rises over
    (`core/cam/tabs.ts`), with `tabHeight` in stock and tab width and thickness in the
    Material panel. Deliberate golden change: `solid-plate-router.nc` gains the bridge
    moves and a header line, and the design-file fixture gains `tabHeight`.

Not yet ported from the reference implementation:

- the calibration coupon workflow
- fold-direction editing by selecting a fold in the canvas

## Roadmap

The goal is a general 2D CAD/CAM app for hobbyist CNC in which packaging stays a
first-class workspace. Two orthogonal concepts: a **workspace** (vocabulary,
entities, material behaviour — `packaging` and `solid`) chosen per
sheet, and a **machine profile** (process and postprocessor) referenced per
sheet. Stock size is fixed at 24 in for now.

This round of the roadmap is complete: compatibility cleanup, registry wiring,
the Solid workspace, the workspace switcher and profiles UI, the slice 6
cleanup, and packaging's intent cleanup. Router holding tabs for Solid followed. Whatever comes next keeps check, lint, unit, build, and e2e green,
with goldens byte-identical unless a change is deliberate and documented here.

Sheet nesting (`features/packaging/placement.ts`) stays in packaging: only
tray nets are auto-placed, and it moves to shared code when a second workspace
places parts automatically. `mounting.ts` and `anchoring.ts` stay in packaging
for good.

Deferred beyond this round: configurable stock size; laser and vinyl profiles
and `engrave`/`mark`/`drill` operations; geometric canvas hit testing (dataset
hit targets stay); a third workspace.

Not yet scheduled: bridge tabs on packaging's routed deck outline, and multi-pass
step-down cutting (tabs would then affect only the passes below their top).

Decisions already taken in v8 that later work should not undo:

- Selection is one slot in `editor/state.svelte.ts`, not in `tools.svelte.ts`,
  because the add actions select what they create. Snap lives in tools.
- `fold.ts` already moved to `features/packaging`; core `generateGcode` prints
  workspace header lines passed in `GcodeOptions.headerNotes`.
- When the saved active sheet is missing, the first sheet becomes active.

Still true for anything remaining: behaviour preservation first. Retain the original values and numerical behaviour unless a change is intentional and covered by updated tests, and avoid numeric cleanup that shifts toolpaths through rounding or unit-conversion differences. Migrate one behaviorally testable slice at a time rather than changing the data model, geometry, and UI together.

### Intentional Departures From The Reference

These are deliberate and covered by tests. Do not "restore" them to match `insert-generator.html`.

- A newly drawn riser box spans to the deck underside instead of taking a fixed 40mm height. Saved files keep the height they recorded.
- Mounts are named anchors rather than a `{ target, face }` pair, and `assemblyZ` is gone from the document.
- Validation rejects a fixed-height support taller than the space under the deck, with 0.5mm of assembly slop allowed.
- The 3D camera fit is solved from the bounding sphere rather than a fixed distance.
- `PCFShadowMap` replaces the removed `PCFSoftShadowMap`; softness comes from the light's `shadow.radius`.

## Svelte Editor Guidance

Use Svelte 5 runes for editor-local reactivity. Keep the canonical design document in a dedicated editor-state module and make state transitions explicit.

Prefer action-oriented updates. The editor exposes generic ones and a single document-change primitive; each workspace binds its own verbs to that primitive, and they are the only way the document changes:

```ts
const actions = packagingActions(editor); // features/packaging/actions.ts
actions.addPocket(pocket); // one undo step, selects it
actions.updateSupport(id, values); // one undo step
actions.previewSupport(id, values); // mid-gesture, no history
editor.commit(); // ends a gesture: one gesture, one undo step
editor.update((design) => change(design)); // the primitive the verbs use
editor.setStock(key, value);
editor.undo();
```

Do not let multiple components independently mutate the design document. Every change funnels through `update` or `preview`, which is also where every present workspace's `reconcile` runs (spanning support heights, for packaging) — add derived-document work to a workspace's `reconcile` rather than to a component. The editor never learns a workspace's vocabulary; keep verbs pure in the feature's actions module so they are unit-tested without Svelte.

A drag calls `preview*` on every pointer move and `commit()` once at the end. Both the 2D canvas and the 3D viewer follow this, which is what keeps a drag from filling the undo stack.

Render SVG declaratively where possible. Imperative DOM work is appropriate only for:

- pointer capture and coordinate conversion
- focus management
- file downloads/uploads
- canvas-based simulation
- Three.js initialization, resize, disposal, and render-loop ownership

Load Three.js client-side only. It must not execute during server-side rendering.

## Code Quality

- Use millimeters internally. Convert for display only.
- Give functions names that describe domain behavior.
- Prefer immutable transformations in core logic.
- Use `readonly` inputs and return types where practical to make non-mutation contracts visible.
- Keep comments for manufacturing constraints, coordinate-system conventions, and non-obvious geometric reasoning.
- Do not add abstractions merely because a file is large; extract around stable data and behavior boundaries.
- Keep UI styling component-scoped or organized in a small number of intentional global layers.
- Prefer accessible native controls and keyboard-operable editor actions.
- Do not add dependencies for helpers that fit clearly in a small, tested local module.

### Chrome And Icons

Icons are Material Symbols Rounded, vendored as SVG path data in
`components/icons/paths.ts` and drawn by `Icon.svelte`. Do not add a webfont or
a CDN `<link>` for them: the editor is local-first and loads no web fonts, and
an icon font that fails to load leaves every button showing its raw ligature
text. To add a glyph, fetch the 24px Rounded SVG, confirm it uses the set's
`0 -960 960 960` viewBox, and add its path. Attribution lives in `LICENSE-ICONS`.

An icon-only control must carry its name in `aria-label` and repeat it in
`title`, and its glyph stays `aria-hidden`, so the name is announced once and
is discoverable on hover. A toggle reports state with `aria-pressed`, never
with colour alone.

Group a toolbar by proximity — a wide gap between groups, a tight gap within
one — rather than by drawing a divider on each group's leading edge. The row
wraps at narrow widths, and CSS cannot tell which group starts a new line, so a
border there strands a rule at the beginning of the wrapped row.

Settings configured once per job (material, machine) live in
`CollapsiblePanel`s at the top of the sidebar, collapsed by default, so they
stay reachable without pushing the selection panel off a short screen. The
panel owns its open state; the prop is an initial value, not a binding.

## Commands

```bash
npm run dev          # vite dev server
npm run build        # production build
npm run check        # svelte-kit sync && svelte-check (strict)
npm run lint         # prettier --check && eslint
npm run format       # prettier --write
npm run test:unit    # vitest (add -- --run for a single pass)
npm run test:e2e     # playwright; builds and previews on port 4173
npm test             # unit then e2e
```

Run the narrowest relevant test after each core change. Before declaring a phase complete, run the full unit suite, `npm run check`, `npm run lint`, the production build, and the e2e suite.

`npm run lint` fails on formatting alone, so run `npm run format` before it rather than hand-fixing Prettier complaints.

### Working Efficiently

Every command's output and every file read stays in the session's context and
is paid for again on each later turn. Be deliberate about both.

**Run targeted tests while iterating; run the full gates once.**

- During a change, run only the specs that cover it:
  `npx vitest run tests/unit/core/golden.spec.ts`, or filter by name with `-t`.
  Run `npx playwright test e2e/<file>.e2e.ts` only when the change touches that
  flow.
- Any CAM, geometry, or packaging change always includes `golden.spec.ts`: it
  is cheap, and it is the regression contract.
- Run the full unit suite, `npm run check`, `npm run lint`, the build, and the
  whole e2e suite once, when a slice is finished — not after every edit. The
  e2e suite is the most expensive step, because it builds the app first.
- Pipe noisy output through a filter (`| tail`, `| grep -E "×|Tests |Error"`)
  so a passing run costs a few lines, not hundreds.

**Read only the parts of large files you need.**

- Several modules are hundreds of lines (`Inspector.svelte`, `Canvas.svelte`,
  `AssemblyViewer.svelte`, `PackagingInspector.svelte`, `SimulationDialog.svelte`,
  `features/packaging/assembly.ts`, `perimeter.ts`, `validation.ts`). Locate
  the relevant symbol with `grep -n` first, then read that range with an offset
  and limit rather than the whole file.
- The Current Layout above says which module owns what; use it to go straight
  to the right file instead of opening several to find out.
- Do not re-read a file you just edited to confirm the edit landed; the type
  check and the targeted test are the confirmation.
- Never read `insert-generator.html` whole. It is a large read-only reference;
  search it for the behaviour in question and read around the match.

## Definition Of Done

A change is complete only when:

- moved or added behavior has direct automated tests
- a document-shape change updates the types and the serialization fixture; no migration or compatibility reader is added (there are no legacy designs)
- reviewed SVG and G-code fixtures remain equivalent unless a deliberate behavior change is documented here
- the editor preserves local-first use and explicit file export
- machine output is validated before export
- no `core` module has gained framework, DOM, feature, or Three.js dependencies
- `npm run check`, `npm run lint`, the unit suite, the production build, and the e2e suite all succeed
- a UI change has been looked at in a browser at desktop and phone widths, not just asserted in tests
