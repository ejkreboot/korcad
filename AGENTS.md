# KorCad Agent Guide

## Product

KorCad is a local-first, browser-based 2D CAD/CAM application for small CNC jobs.

Its first feature is a packaging-insert generator for cardstock, cardboard, and similar sheet goods. It supports cut paths, drag-knife and router compensation, scoring and creasing, fold allowances, tabs, packaging supports, SVG/design export, G-code export, toolpath simulation, and an optional 3D assembly preview.

The product may grow into a general-purpose tool for straightforward 2D CNC work, but it must retain the packaging workflow that made it useful.

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
      design/
        types.ts                 DesignDocument and every domain type
        machine.ts               machine profiles and per-sheet views
        migrate.ts               version-stepped document migrations
        defaults.ts
        fold.ts                  bend deduction, flat panel widths
        normalize.ts             untrusted JSON -> DesignState, with migrations
      cam/
        compensation.ts
        routing.ts
        gcode.ts
        simulation.ts
      export/
        svg.ts
        design-file.ts
      assembly/model.ts          plain-data description of an assembled design

    features/packaging/          packaging domain, built on core
      model.ts                   allGeometry: flat geometry for a sheet
      geometry.ts                pocket openings, walls, finger pulls
      perimeter.ts               folded walls and rolled joists
      supports.ts                riser and tray nets
      folds.ts                   fold identity, direction, labels
      levels.ts                  Z levels, mount planes, spanning heights
      mounting.ts                mount chain: parents, origins, limits
      anchoring.ts               what a dropped support becomes anchored to
      placement.ts               finding room for a net on a sheet
      presets.ts                 cutout and support presets
      assembly.ts                buildAssembly: design -> assembly description
      validation.ts              manufacturability diagnostics

    editor/                      transient editor state; may use browser APIs
      state.svelte.ts            the single owner of the design document
      tools.svelte.ts            active tool, viewport, view mode, deck opacity
      history.ts
      viewport.ts
      manipulation.ts            pointer deltas -> design changes
      persistence.ts             local drafts and design-file import/export

    viewer/assembly-scene.ts     the only module that imports Three.js

    components/
      icons/
        paths.ts                 vendored Material Symbols path data
        Icon.svelte              inline SVG glyph
      editor/
        Canvas.svelte            2D SVG editor
        AssemblyViewer.svelte    3D viewer lifecycle and gestures
        SimulationDialog.svelte  toolpath playback
        Inspector.svelte
        Toolbar.svelte
        CollapsiblePanel.svelte
        SheetTabs.svelte

  routes/+page.svelte            the editor shell

tests/
  unit/{core,packaging,editor}/
  fixtures/{designs,expected-gcode}/
e2e/
  helpers.ts                     shared navigation that waits for hydration
  editor.e2e.ts                  2D editor interactions
  assembly-viewer.e2e.ts         3D rendering, controls, mobile layout
  support-mounting.e2e.ts        anchors and spanning heights
  simulation.e2e.ts              toolpath playback and tool changes
  machine-profiles.e2e.ts        profile editing and per-sheet machines
```

Two layering rules matter more than the tree itself:

- `core` may not import from `features`, `editor`, `viewer`, or `components`. When a packaging rule has to run at an import boundary, apply it in `editor/persistence.ts`, not in `core/design/normalize.ts`.
- `viewer/` owns Three.js. `features/packaging/assembly.ts` produces the plain-data assembly description; `viewer/assembly-scene.ts` turns it into meshes. Geometry decisions belong in the former so they can be unit-tested without a browser.

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

Document migrations are version-stepped in `core/design/migrate.ts`: each
`MigrationStep` turns a raw document of one version into the raw shape of the
next, and `normalizeState` runs the chain before reading fields. Steps only
move data; defaulting and validating values stays normalization's job. Bump
`DESIGN_VERSION` in `core/constants.ts` and add a step — a test asserts the two
agree and that the chain has no gaps.

Documents older than version 6 are not stepped. Fields that changed shape
before the pipeline existed — a support's `{ target, face }` mount, `assemblyZ`,
pre-v2 riser nets — are still recognised by shape inside `normalizeState`. That
is the pipeline's backlog, not a gap in it.

Every design-file migration must be explicit and tested. Older files should normalize into the newest supported document shape without silently changing the intended manufactured result.

Validate untrusted design-file JSON at the import boundary. TypeScript types do not validate runtime data.

### Machine Profiles

The thirteen machine settings — fabrication mode, feeds, depths, blade offset,
bit width, spindle speed — are not document settings. They live in a named
`MachineProfile`, and each `Sheet` references one by id. Programs are emitted
per sheet, so the machine is a property of the sheet, and one job can hold a
creased deck and a routed plate.

Consequences for anything that reads a machine setting:

- **Take a `SheetView`, not a `DesignState`.** A view is the document plus the
  machine settings of one sheet's profile; build one with `sheetView(design,
sheetId)` from `core/design/machine.ts`. Every CAM settings type
  (`CompensationSettings`, `RoutingSettings`, `GcodeSettings`,
  `SimulationSettings`) and every packaging settings type now picks from
  `SheetView` or `MachineSettings`.
- **Geometry is answered per sheet.** `allGeometry(document, sheetId)` resolves
  that sheet's profile itself, because a routed sheet does not fold.
- **Assembly-wide questions use `packagingView`.** Deck height, support
  heights, and validation describe the whole box, and answer against the deck
  sheet's machine. Validation rejects a document whose packaging sheets
  disagree on fabrication mode, so for any exportable design the choice of
  sheet cannot change the answer.
- The editor exposes `editor.view` (the active sheet's view) and
  `editor.machine` (its profile). Components read those rather than resolving
  profiles themselves.

### Vertical Placement Is Relational

A support never stores a bare Z height. It stores an anchor naming a real surface, so changing the perimeter wall moves everything anchored to the deck with it.

```ts
type SupportMount =
	| { anchor: 'box-floor'; offset: number }
	| { anchor: 'deck-top'; offset: number }
	| { anchor: 'deck-underside'; offset: number }
	| { anchor: 'support-top'; supportId: string; offset: number };
```

`offset` always measures away from the anchoring surface along the support's own build direction, so it reads positive downward for `deck-underside` and positive upward everywhere else. The union is discriminated deliberately: only `support-top` carries an id, and a face for the box floor cannot be written down. Earlier files used a `{ target, face }` pair, migrated in `normalizeSupport`.

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

Do not mutate a nominal design or source path while generating compensated geometry or optimizing routes. Prefer read-only inputs and newly created output objects in core modules.

## Packaging Is A Feature Module

Packaging remains a first-class feature, not a collection of optional fields in a generic shape object.

Keep packaging-specific concepts inside `features/packaging`:

- decks and exterior perimeters
- folded walls and flanges
- trays, risers, and platforms
- fold direction and bend deduction
- finger pulls and relief slots
- joists and locking tabs
- assembly relationships
- calibration coupons

General 2D tools should share the core path and CAM APIs, but should not need to understand packaging roles, fold direction, or assembly hierarchy.

Add new capabilities as feature modules, for example:

```text
features/
  packaging/
  panel-cutouts/
  vinyl/
  templates/
```

Only promote a concept from a feature module into `core` after at least two independent features genuinely require it.

## Machine Output Safety

Manufacturing output is safety-critical. Prefer conservative behavior over clever behavior.

- Validate before allowing export.
- Return structured validation diagnostics with stable codes.
- Never silently clamp or discard invalid manufacturing geometry.
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

- design normalization and version migrations
- unit conversion and numeric rounding
- bounds and validation
- nominal versus compensated geometry
- fold directions and bend deductions
- packaging geometry and assembly relationships
- path ordering and stage preservation
- travel optimization without source mutation
- open-path reversal and closed-contour start-point selection
- router and drag-knife compensation
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
- In the e2e tests the SVG sheet is drawn centred inside a much wider box, so only the middle of the pane lands on the deck. Drag through the shared `dragOnCanvas` helper rather than guessing pixels, and derive any fixed point from the measured box: the toolbar rewraps as controls are added and shifts everything below it.
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

Not yet ported from the reference implementation:

- the calibration coupon workflow
- fold-direction editing by selecting a fold in the canvas

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

Prefer action-oriented updates. The state module exposes them, and they are the only way the document changes:

```ts
editor.addPocket(...);
editor.updateSupport(id, values);   // one undo step
editor.previewSupport(id, values);  // mid-gesture, no history
editor.commit();                    // ends a gesture: one gesture, one undo step
editor.setSetting(key, value);
editor.undo();
```

Do not let multiple components independently mutate the design document. Every change funnels through `apply` or `preview`, which is also where spanning support heights are re-resolved — add derived-document work there rather than in a component.

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

## Definition Of Done

A change is complete only when:

- moved or added behavior has direct automated tests
- representative saved designs still load, and any document-shape change has an explicit, tested migration
- reviewed SVG and G-code fixtures remain equivalent unless a deliberate behavior change is documented here
- the editor preserves local-first use and explicit file export
- machine output is validated before export
- no `core` module has gained framework, DOM, feature, or Three.js dependencies
- `npm run check`, `npm run lint`, the unit suite, the production build, and the e2e suite all succeed
- a UI change has been looked at in a browser at desktop and phone widths, not just asserted in tests
