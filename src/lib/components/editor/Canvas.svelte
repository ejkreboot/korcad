<script lang="ts">
	import { SHEET } from '$lib/core/constants.js';
	import { clamp, snap } from '$lib/core/units.js';
	import { point, type Point } from '$lib/core/geometry/primitives.js';
	import type { DesignPath } from '$lib/core/design/types.js';
	import {
		gridLineKind,
		horizontalGridLines,
		verticalGridLines,
		viewBoxAttr,
		wheelWidth
	} from '$lib/editor/viewport.js';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import type { ToolState } from '$lib/editor/tools.svelte.js';
	import { workspaceUi, type CanvasGesture } from '$lib/components/workspaces/index.js';

	/**
	 * The 2D sheet: grid, zoom and pan, toolpaths, and the draft rectangle.
	 * Everything a workspace draws or lets the operator grab comes from its
	 * canvas layer, and what a press or a drawn rectangle does from its canvas
	 * controller.
	 */
	let { editor, tools }: { editor: EditorState; tools: ToolState } = $props();

	let svg = $state<SVGSVGElement>();

	/** The zoom anchor math needs the painted size, so track it. */
	$effect(() => {
		if (!svg) return;
		const measure = () => svg && tools.setViewportBox(svg.getBoundingClientRect());
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(svg);
		return () => observer.disconnect();
	});

	type Draft = { pointerId: number; start: Point; end: Point };
	type Pan = { pointerId: number; clientX: number; clientY: number };

	let draft = $state<Draft | null>(null);
	let pan = $state<Pan | null>(null);
	// Not reactive: only pointer handlers read it, never the template.
	let gesture: { pointerId: number; active: CanvasGesture } | null = null;

	const design = $derived(editor.design);
	const ui = $derived(workspaceUi(editor.workspace.id));
	const controller = $derived(ui.canvasController(editor, tools));
	const screenUnit = $derived(1 / tools.scale);
	const drawing = $derived(tools.tool !== 'select');

	// ---- coordinate mapping ------------------------------------------------
	// The drawing group is flipped once, so everything inside it is authored in
	// CAM coordinates (origin lower-left, y up). Pointer mapping goes through
	// the root SVG's CTM, which zoom and pan already move.

	function pointerToStock(event: PointerEvent): Point {
		if (!svg) return point(0, 0);
		const ctm = svg.getScreenCTM();
		if (!ctm) return point(0, 0);
		const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
		const snapping = tools.snapEnabled;
		return point(
			snap(clamp(local.x, 0, SHEET), snapping),
			snap(clamp(SHEET - local.y, 0, SHEET), snapping)
		);
	}

	const pointsAttr = (path: DesignPath) => path.points.map((p) => `${p.x},${p.y}`).join(' ');
	const pathClass = (path: DesignPath) =>
		path.type === 'cut' ? 'cut' : path.foldDirection === 'up' ? 'score-up' : 'score-down';

	const draftRect = $derived.by(() => {
		if (!draft) return null;
		return {
			x: Math.min(draft.start.x, draft.end.x),
			y: Math.min(draft.start.y, draft.end.y),
			w: Math.abs(draft.end.x - draft.start.x),
			h: Math.abs(draft.end.y - draft.start.y)
		};
	});

	// ---- pointer handling --------------------------------------------------

	function handlePointerDown(event: PointerEvent): void {
		if (pan) return;
		if (event.button === 1 || (event.button === 0 && tools.panArmed)) {
			event.preventDefault();
			pan = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
			svg?.setPointerCapture(event.pointerId);
			return;
		}
		if (event.button !== 0) return;

		if (!drawing) {
			const active = controller.press(event.target as Element, pointerToStock(event));
			if (!active) {
				editor.select(null);
				return;
			}
			event.preventDefault();
			gesture = { pointerId: event.pointerId, active };
			svg?.setPointerCapture(event.pointerId);
			return;
		}

		event.preventDefault();
		const start = controller.draftPoint(pointerToStock(event));
		draft = { pointerId: event.pointerId, start, end: start };
		svg?.setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent): void {
		if (pan && event.pointerId === pan.pointerId) {
			const ctm = svg?.getScreenCTM();
			const scale = ctm?.a || 1;
			tools.setView({
				...tools.view,
				x: tools.view.x - (event.clientX - pan.clientX) / scale,
				y: tools.view.y - (event.clientY - pan.clientY) / scale
			});
			pan.clientX = event.clientX;
			pan.clientY = event.clientY;
			return;
		}

		tools.setCursor(pointerToStock(event));

		if (gesture && event.pointerId === gesture.pointerId) {
			gesture.active.move(pointerToStock(event));
			return;
		}

		if (draft && event.pointerId === draft.pointerId) {
			draft = { ...draft, end: controller.draftPoint(pointerToStock(event)) };
		}
	}

	function handlePointerUp(event: PointerEvent): void {
		if (pan && event.pointerId === pan.pointerId) {
			pan = null;
			return;
		}
		if (gesture && event.pointerId === gesture.pointerId) {
			gesture = null;
			editor.commit();
			return;
		}
		if (!draft || event.pointerId !== draft.pointerId) return;

		const rect = draftRect;
		draft = null;
		if (rect) controller.finishDraft(rect);
		tools.select();
	}

	function handleWheel(event: WheelEvent): void {
		event.preventDefault();
		if (!svg) return;
		const rect = svg.getBoundingClientRect();
		tools.setViewportBox(rect);
		tools.zoomAt(wheelWidth(tools.view, event.deltaY, event.deltaMode), {
			x: event.clientX - rect.left,
			y: event.clientY - rect.top
		});
	}

	function handlePointerLeave(): void {
		if (gesture || draft) return;
		tools.setCursor(null);
	}
</script>

<svelte:window
	onkeydown={(event) => {
		if (
			event.code === 'Space' &&
			!event.repeat &&
			!(event.target as HTMLElement)?.closest('input, select, textarea, button')
		) {
			tools.armPan(true);
			event.preventDefault();
		}
		if (event.key === 'Escape') tools.select();
	}}
	onkeyup={(event) => event.code === 'Space' && tools.armPan(false)}
	onblur={() => tools.armPan(false)}
/>

<div class="canvas-wrap">
	<svg
		bind:this={svg}
		class="drawing"
		class:draw-mode={drawing}
		class:pan-ready={tools.panArmed && !pan}
		class:panning={Boolean(pan)}
		viewBox={viewBoxAttr(tools.view)}
		style="--vs: {tools.scale}"
		role="application"
		aria-label="Design for the {design.activeSheetId} sheet"
		onpointerdown={handlePointerDown}
		onpointermove={handlePointerMove}
		onpointerup={handlePointerUp}
		onpointercancel={handlePointerUp}
		onpointerleave={handlePointerLeave}
		onwheel={handleWheel}
		onauxclick={(event) => event.button === 1 && event.preventDefault()}
	>
		<!-- One flip, so everything below is authored in CAM coordinates. -->
		<g transform="translate(0 {SHEET}) scale(1 -1)">
			<rect class="sheet-outline" x="0" y="0" width={SHEET} height={SHEET} />

			{#each verticalGridLines(tools.view, tools.viewportBox) as line (line.index)}
				<line
					class="grid-line {gridLineKind(line.position)}"
					x1={line.position}
					y1="0"
					x2={line.position}
					y2={SHEET}
				/>
			{/each}
			{#each horizontalGridLines(tools.view, tools.viewportBox) as line (line.index)}
				<line
					class="grid-line {gridLineKind(line.position)}"
					x1="0"
					y1={line.position}
					x2={SHEET}
					y2={line.position}
				/>
			{/each}

			<ui.CanvasLayer {editor} {tools} plane="under" {drawing} {screenUnit} />

			{#each editor.geometry.paths as path, index (index)}
				{#if path.closed}
					<polygon class={pathClass(path)} points={pointsAttr(path)} />
				{:else}
					<polyline class={pathClass(path)} points={pointsAttr(path)} />
				{/if}
			{/each}
			{#each editor.geometry.tabs as tab, index (index)}
				<line
					class="tab-mark"
					x1={tab.points[0].x}
					y1={tab.points[0].y}
					x2={tab.points[1].x}
					y2={tab.points[1].y}
				/>
			{/each}

			<ui.CanvasLayer {editor} {tools} plane="over" {drawing} {screenUnit} />

			{#if draftRect}
				<rect
					class="draft"
					x={draftRect.x}
					y={draftRect.y}
					width={draftRect.w}
					height={draftRect.h}
				/>
			{/if}

			{#if tools.cursor}
				<line class="cursor-guide" x1="0" y1={tools.cursor.y} x2={SHEET} y2={tools.cursor.y} />
				<line class="cursor-guide" x1={tools.cursor.x} y1="0" x2={tools.cursor.x} y2={SHEET} />
			{/if}

			<circle class="origin" cx="0" cy="0" r={3.4 * screenUnit} />
		</g>

		<!-- Labels live outside the flip so their glyphs are not mirrored. -->
		<ui.CanvasLayer {editor} {tools} plane="labels" {drawing} {screenUnit} />
	</svg>
</div>
