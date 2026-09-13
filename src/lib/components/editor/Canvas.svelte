<script lang="ts">
	import { SHEET } from '$lib/core/constants.js';
	import { clamp, snap } from '$lib/core/units.js';
	import { point, type Point } from '$lib/core/geometry/primitives.js';
	import type { DesignPath } from '$lib/core/design/types.js';
	import { perimeterBounds } from '$lib/features/packaging/perimeter.js';
	import { riserFlatBounds } from '$lib/features/packaging/supports.js';
	import { supportAssemblyOrigin } from '$lib/features/packaging/mounting.js';
	import {
		createPocketFromPreset,
		createSupportFromPreset,
		isCutoutPreset,
		isSupportPreset,
		presetDrawsOnDeck
	} from '$lib/features/packaging/presets.js';
	import {
		applyDeckDrag,
		applyPocketDrag,
		applySupportDrag,
		applySupportPlacement,
		MIN_COMPONENT,
		type Corner,
		type DeckAction,
		type DeckOriginal,
		type RectOriginal,
		type SupportOriginal
	} from '$lib/editor/manipulation.js';
	import {
		gridLineKind,
		horizontalGridLines,
		verticalGridLines,
		viewBoxAttr,
		wheelWidth
	} from '$lib/editor/viewport.js';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import { packagingActions } from '$lib/features/packaging/actions.js';
	import type { ToolState } from '$lib/editor/tools.svelte.js';

	let { editor, tools }: { editor: EditorState; tools: ToolState } = $props();
	const actions = $derived(packagingActions(editor));

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
	type Manipulation =
		| { kind: 'deck'; pointerId: number; action: DeckAction; start: Point; original: DeckOriginal }
		| {
				kind: 'pocket';
				pointerId: number;
				id: string;
				type: 'move' | 'resize';
				handle: Corner | null;
				start: Point;
				original: RectOriginal;
		  }
		| {
				kind: 'support';
				pointerId: number;
				id: string;
				type: 'move' | 'resize' | 'height';
				handle: Corner | null;
				start: Point;
				original: SupportOriginal;
		  }
		| { kind: 'placement'; pointerId: number; id: string; start: Point; origin: Point };
	type Pan = { pointerId: number; clientX: number; clientY: number };

	let draft = $state<Draft | null>(null);
	let pan = $state<Pan | null>(null);
	// Not reactive: only pointer handlers read it, never the template.
	let manipulation: Manipulation | null = null;

	const design = $derived(editor.design);
	/**
	 * The active sheet as packaging sees it: deck, perimeter, pockets, supports.
	 * Perimeter bounds, net bounds, and whether this sheet folds all depend on
	 * the machine it is cut on, so the canvas works from this sheet view.
	 */
	const packaging = $derived(actions.view);
	/** What a drag reads: the sheet view plus the snap toggle. */
	const dragView = $derived({ ...packaging, snapEnabled: tools.snapEnabled });
	const isDeckSheet = $derived(design.activeSheetId === packaging.deckSheetId);
	const screenUnit = $derived(1 / tools.scale);
	const selectedPocket = $derived(packaging.pockets.find((p) => p.id === actions.selectedPocketId));
	const selectedSupport = $derived(
		packaging.supports.find((r) => r.id === actions.selectedSupportId)
	);
	const sheetSupports = $derived(
		packaging.supports.filter((support) => support.sheetId === design.activeSheetId)
	);
	const trays = $derived(packaging.supports.filter((support) => support.kind === 'tray'));
	const outer = $derived(perimeterBounds(packaging));

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

	/** Clamped to the finished top deck, for anything that must live on it. */
	function pointerToDeck(event: PointerEvent): Point {
		const local = pointerToStock(event);
		return point(
			clamp(local.x, packaging.deckX, packaging.deckX + packaging.deckW),
			clamp(local.y, packaging.deckY, packaging.deckY + packaging.deckH)
		);
	}

	const flip = (y: number) => SHEET - y;
	const pointsAttr = (path: DesignPath) => path.points.map((p) => `${p.x},${p.y}`).join(' ');
	const pathClass = (path: DesignPath) =>
		path.type === 'cut' ? 'cut' : path.foldDirection === 'up' ? 'score-up' : 'score-down';

	// ---- deck handles ------------------------------------------------------

	const deckEdges = $derived.by(() => {
		const x = packaging.deckX;
		const y = packaging.deckY;
		const right = x + packaging.deckW;
		const top = y + packaging.deckH;
		const folded = packaging.perimeterType === 'folded';
		const wall = (side: 'left' | 'right' | 'bottom' | 'top'): DeckAction =>
			folded && packaging.perimeterSides[side] ? (`wall-${side}` as DeckAction) : side;
		const edges: { action: DeckAction; x1: number; y1: number; x2: number; y2: number }[] = [
			{ action: 'left', x1: x, y1: y, x2: x, y2: top },
			{ action: 'right', x1: right, y1: y, x2: right, y2: top },
			{ action: 'bottom', x1: x, y1: y, x2: right, y2: y },
			{ action: 'top', x1: x, y1: top, x2: right, y2: top }
		];
		if (packaging.perimeterType !== 'joist') {
			edges.push(
				{ action: wall('left'), x1: outer.left, y1: outer.bottom, x2: outer.left, y2: outer.top },
				{
					action: wall('right'),
					x1: outer.right,
					y1: outer.bottom,
					x2: outer.right,
					y2: outer.top
				},
				{
					action: wall('bottom'),
					x1: outer.left,
					y1: outer.bottom,
					x2: outer.right,
					y2: outer.bottom
				},
				{ action: wall('top'), x1: outer.left, y1: outer.top, x2: outer.right, y2: outer.top }
			);
		}
		return edges;
	});

	const deckGrips = $derived.by(() => {
		const folded = packaging.perimeterType === 'folded';
		const bounds = folded
			? outer
			: {
					left: packaging.deckX,
					right: packaging.deckX + packaging.deckW,
					bottom: packaging.deckY,
					top: packaging.deckY + packaging.deckH
				};
		const long = 22 * screenUnit;
		const short = 6 * screenUnit;
		const wall = (side: 'left' | 'right' | 'bottom' | 'top'): DeckAction =>
			folded && packaging.perimeterSides[side] ? (`wall-${side}` as DeckAction) : side;
		const midX = (bounds.left + bounds.right) / 2;
		const midY = (bounds.bottom + bounds.top) / 2;
		return [
			{ action: wall('left'), x: bounds.left - short / 2, y: midY - long / 2, w: short, h: long },
			{ action: wall('right'), x: bounds.right - short / 2, y: midY - long / 2, w: short, h: long },
			{
				action: wall('bottom'),
				x: midX - long / 2,
				y: bounds.bottom - short / 2,
				w: long,
				h: short
			},
			{ action: wall('top'), x: midX - long / 2, y: bounds.top - short / 2, w: long, h: short }
		];
	});

	const corners = (b: { left: number; right: number; bottom: number; top: number }) =>
		[
			{ name: 'sw' as Corner, x: b.left, y: b.bottom },
			{ name: 'se' as Corner, x: b.right, y: b.bottom },
			{ name: 'ne' as Corner, x: b.right, y: b.top },
			{ name: 'nw' as Corner, x: b.left, y: b.top }
		] as const;

	const supportNetBounds = $derived(
		selectedSupport && selectedSupport.sheetId === design.activeSheetId
			? riserFlatBounds(selectedSupport, packaging)
			: null
	);

	const labels = $derived([
		...(isDeckSheet
			? packaging.pockets.map((pocket) => ({
					key: `pocket-${pocket.id}`,
					name: pocket.name,
					x: pocket.x + 5 + (pocket.labelOffset?.x ?? 0),
					y: pocket.y + pocket.h - 9 - (pocket.labelOffset?.y ?? 0)
				}))
			: []),
		...(packaging.fabricationMode === 'knife'
			? sheetSupports.map((support) => {
					const bounds = riserFlatBounds(support, packaging);
					return {
						key: `support-${support.id}`,
						name: support.name,
						x: bounds.left + 5 + (support.labelOffset?.x ?? 0),
						y: bounds.top - 9 - (support.labelOffset?.y ?? 0)
					};
				})
			: [])
	]);

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

	function beginPan(event: PointerEvent): void {
		pan = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY };
		svg?.setPointerCapture(event.pointerId);
	}

	function handlePointerDown(event: PointerEvent): void {
		if (pan) return;
		if (event.button === 1 || (event.button === 0 && tools.panArmed)) {
			event.preventDefault();
			beginPan(event);
			return;
		}
		if (event.button !== 0) return;
		const target = event.target as Element;

		if (tools.tool === 'select') {
			const deckTarget = target.closest<HTMLElement>('[data-deck-action]');
			const pocketTarget = target.closest<HTMLElement>('[data-pocket]');
			const supportTarget = target.closest<HTMLElement>('[data-support]');
			const placementTarget = target.closest<HTMLElement>('[data-support-placement]');
			if (!deckTarget && !pocketTarget && !supportTarget && !placementTarget) {
				actions.selectPocket(null);
				return;
			}
			event.preventDefault();

			if (placementTarget) {
				const support = packaging.supports.find(
					(r) => r.id === placementTarget.dataset.supportPlacement
				);
				if (!support) return;
				actions.selectSupport(support.id);
				manipulation = {
					kind: 'placement',
					pointerId: event.pointerId,
					id: support.id,
					start: pointerToStock(event),
					origin: supportAssemblyOrigin(support, packaging.supports)
				};
			} else if (supportTarget) {
				const support = packaging.supports.find((r) => r.id === supportTarget.dataset.support);
				if (!support) return;
				actions.selectSupport(support.id);
				manipulation = {
					kind: 'support',
					pointerId: event.pointerId,
					id: support.id,
					type: supportTarget.dataset.supportHeight
						? 'height'
						: supportTarget.dataset.handle
							? 'resize'
							: 'move',
					handle: (supportTarget.dataset.handle as Corner | undefined) ?? null,
					start: pointerToStock(event),
					original: {
						flatX: support.flatX,
						flatY: support.flatY,
						w: support.w,
						d: support.d,
						h: support.h
					}
				};
			} else if (pocketTarget) {
				const pocket = packaging.pockets.find((p) => p.id === pocketTarget.dataset.pocket);
				if (!pocket) return;
				actions.selectPocket(pocket.id);
				manipulation = {
					kind: 'pocket',
					pointerId: event.pointerId,
					id: pocket.id,
					type: pocketTarget.dataset.handle ? 'resize' : 'move',
					handle: (pocketTarget.dataset.handle as Corner | undefined) ?? null,
					start: pointerToDeck(event),
					original: { x: pocket.x, y: pocket.y, w: pocket.w, h: pocket.h }
				};
			} else if (deckTarget) {
				actions.selectPocket(null);
				manipulation = {
					kind: 'deck',
					pointerId: event.pointerId,
					action: deckTarget.dataset.deckAction as DeckAction,
					start: pointerToStock(event),
					original: {
						x: packaging.deckX,
						y: packaging.deckY,
						w: packaging.deckW,
						h: packaging.deckH,
						wall: packaging.perimeterWall,
						pockets: packaging.pockets.map((p) => ({ id: p.id, x: p.x, y: p.y }))
					}
				};
			}
			svg?.setPointerCapture(event.pointerId);
			return;
		}

		event.preventDefault();
		const onDeck = drawsOnDeck();
		const start = onDeck ? pointerToDeck(event) : pointerToStock(event);
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

		const active = manipulation;
		if (active && event.pointerId === active.pointerId) {
			if (active.kind === 'deck') {
				actions.previewPackaging(
					applyDeckDrag(
						dragView,
						active.action,
						active.original,
						active.start,
						pointerToStock(event)
					)
				);
			} else if (active.kind === 'pocket') {
				actions.previewPocket(
					active.id,
					applyPocketDrag(
						dragView,
						active.type,
						active.handle,
						active.original,
						active.start,
						pointerToDeck(event)
					)
				);
			} else {
				const support = packaging.supports.find((r) => r.id === active.id);
				if (!support) return;
				actions.previewSupport(
					active.id,
					active.kind === 'support'
						? applySupportDrag(
								dragView,
								support,
								active.type,
								active.handle,
								active.original,
								active.start,
								pointerToStock(event)
							)
						: applySupportPlacement(
								dragView,
								support,
								active.origin,
								active.start,
								pointerToStock(event)
							)
				);
			}
			return;
		}

		if (draft && event.pointerId === draft.pointerId) {
			const onDeck = drawsOnDeck();
			draft = { ...draft, end: onDeck ? pointerToDeck(event) : pointerToStock(event) };
		}
	}

	/** An opening, and a tray's deck opening, are drawn on the deck; other supports on the sheet. */
	function drawsOnDeck(): boolean {
		return (
			tools.tool === 'cutout' ||
			(tools.tool === 'support' && isSupportPreset(tools.preset) && presetDrawsOnDeck(tools.preset))
		);
	}

	function handlePointerUp(event: PointerEvent): void {
		if (pan && event.pointerId === pan.pointerId) {
			pan = null;
			return;
		}
		if (manipulation && event.pointerId === manipulation.pointerId) {
			manipulation = null;
			editor.commit();
			return;
		}
		if (!draft || event.pointerId !== draft.pointerId) return;

		const rect = draftRect;
		draft = null;
		if (!rect || rect.w < MIN_COMPONENT || rect.h < MIN_COMPONENT) {
			tools.select();
			return;
		}
		if (tools.tool === 'cutout' && isCutoutPreset(tools.preset)) {
			actions.addPocket(
				createPocketFromPreset(
					tools.preset,
					rect,
					crypto.randomUUID(),
					packaging.pockets.length + 1
				)
			);
		} else if (tools.tool === 'support' && isSupportPreset(tools.preset)) {
			actions.addSupport(
				createSupportFromPreset(
					tools.preset,
					rect,
					crypto.randomUUID(),
					packaging.supports.length + 1,
					packaging
				)
			);
		}
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
		if (manipulation || draft) return;
		tools.setCursor(null);
	}

	const drawing = $derived(tools.tool !== 'select');
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
		aria-label="Insert design for the {design.activeSheetId} sheet"
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

			{#if isDeckSheet}
				<rect
					class="deck-area"
					x={packaging.deckX}
					y={packaging.deckY}
					width={packaging.deckW}
					height={packaging.deckH}
				/>
			{/if}

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

			{#if isDeckSheet && !drawing}
				<!-- Deck move surface sits under the openings so they win the hit test. -->
				<rect
					class="deck-move"
					data-deck-action="move"
					x={packaging.deckX}
					y={packaging.deckY}
					width={packaging.deckW}
					height={packaging.deckH}
				/>
			{/if}

			{#if isDeckSheet && !drawing}
				{#each packaging.pockets as pocket (pocket.id)}
					<rect
						class="pocket-hit"
						class:selected={pocket.id === actions.selectedPocketId}
						data-pocket={pocket.id}
						x={pocket.x}
						y={pocket.y}
						width={pocket.w}
						height={pocket.h}
					/>
				{/each}
				{#each trays as tray (tray.id)}
					{@const origin = supportAssemblyOrigin(tray, packaging.supports)}
					<rect
						class="placement-hit"
						data-support-placement={tray.id}
						x={packaging.deckX + origin.x}
						y={packaging.deckY + origin.y}
						width={tray.w}
						height={tray.d}
					/>
				{/each}
			{/if}

			{#if !isDeckSheet && !drawing}
				{#each sheetSupports as support (support.id)}
					{@const bounds = riserFlatBounds(support, packaging)}
					<rect
						class="support-hit"
						class:selected={support.id === actions.selectedSupportId}
						data-support={support.id}
						x={bounds.left}
						y={bounds.bottom}
						width={bounds.right - bounds.left}
						height={bounds.top - bounds.bottom}
					/>
				{/each}
			{/if}

			{#if isDeckSheet && !drawing}
				{#each deckEdges as edge (edge.action + edge.x1 + edge.y1 + edge.x2 + edge.y2)}
					<line
						class="deck-edge-hit"
						data-deck-action={edge.action}
						x1={edge.x1}
						y1={edge.y1}
						x2={edge.x2}
						y2={edge.y2}
					/>
				{/each}
				{#each deckGrips as grip (grip.action)}
					<rect
						class="deck-edge-handle"
						data-deck-action={grip.action}
						x={grip.x}
						y={grip.y}
						width={grip.w}
						height={grip.h}
						rx={2 * screenUnit}
					/>
				{/each}
			{/if}

			{#if selectedPocket && isDeckSheet && !drawing}
				<rect
					class="selection-box"
					x={selectedPocket.x}
					y={selectedPocket.y}
					width={selectedPocket.w}
					height={selectedPocket.h}
				/>
				{#each corners( { left: selectedPocket.x, right: selectedPocket.x + selectedPocket.w, bottom: selectedPocket.y, top: selectedPocket.y + selectedPocket.h } ) as handle (handle.name)}
					<rect
						class="resize-handle"
						data-pocket={selectedPocket.id}
						data-handle={handle.name}
						x={handle.x - 4 * screenUnit}
						y={handle.y - 4 * screenUnit}
						width={8 * screenUnit}
						height={8 * screenUnit}
						rx={screenUnit}
					/>
				{/each}
			{/if}

			{#if selectedSupport && supportNetBounds && !drawing && packaging.fabricationMode === 'knife'}
				{@const panel = {
					left: selectedSupport.flatX,
					right: selectedSupport.flatX + selectedSupport.w,
					bottom: selectedSupport.flatY,
					top: selectedSupport.flatY + selectedSupport.d
				}}
				<rect
					class="selection-box"
					x={panel.left}
					y={panel.bottom}
					width={selectedSupport.w}
					height={selectedSupport.d}
				/>
				{#each corners(panel) as handle (handle.name)}
					<rect
						class="resize-handle"
						data-support={selectedSupport.id}
						data-handle={handle.name}
						x={handle.x - 4 * screenUnit}
						y={handle.y - 4 * screenUnit}
						width={8 * screenUnit}
						height={8 * screenUnit}
						rx={screenUnit}
					/>
				{/each}
				<rect
					class="support-height-handle"
					data-support={selectedSupport.id}
					data-support-height="true"
					x={(panel.left + panel.right) / 2 - 11 * screenUnit}
					y={supportNetBounds.top + 6 * screenUnit}
					width={22 * screenUnit}
					height={6 * screenUnit}
					rx={2 * screenUnit}
				/>
			{/if}

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
		{#each labels as label (label.key)}
			<text class="component-label" x={label.x} y={flip(label.y)}>{label.name}</text>
		{/each}
	</svg>
</div>
