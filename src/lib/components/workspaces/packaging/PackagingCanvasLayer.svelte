<script lang="ts">
	import { SHEET } from '$lib/core/constants.js';
	import { packagingActions } from '$lib/features/packaging/actions.js';
	import type { Corner, DeckAction } from '$lib/features/packaging/manipulation.js';
	import { supportAssemblyOrigin } from '$lib/features/packaging/mounting.js';
	import { perimeterBounds } from '$lib/features/packaging/perimeter.js';
	import { pocketLabels } from '$lib/features/packaging/workspace.js';
	import { pocketSheetId } from '$lib/features/packaging/regions.js';
	import { riserFlatBounds } from '$lib/features/packaging/supports.js';
	import type { CanvasLayerProps } from '../index.js';

	/**
	 * Packaging on the 2D canvas: the deck, hit targets for the deck, openings,
	 * and supports, their grips and handles, and their names. The attributes on
	 * hit targets are what `createPackagingCanvas` reads when one is pressed.
	 */
	let { editor, plane, drawing, screenUnit }: CanvasLayerProps = $props();

	const actions = $derived(packagingActions(editor));
	const design = $derived(editor.design);
	/**
	 * The active sheet as packaging sees it. Perimeter bounds, net bounds, and
	 * whether this sheet folds all depend on the machine it is cut on.
	 */
	const packaging = $derived(actions.view);
	const isDeckSheet = $derived(design.activeSheetId === packaging.deckSheetId);
	/** Openings cut into a region of this sheet: the deck's, or a support's net here. */
	const sheetPockets = $derived(
		packaging.pockets.filter((pocket) => pocketSheetId(packaging, pocket) === design.activeSheetId)
	);
	const selectedPocket = $derived(sheetPockets.find((p) => p.id === actions.selectedPocketId));
	const selectedGroup = $derived(actions.selectedPocketGroup);
	const pocketGroup = $derived(
		selectedGroup?.members.some((member) => sheetPockets.includes(member)) ? selectedGroup : null
	);
	const selectedSupport = $derived(
		packaging.supports.find((r) => r.id === actions.selectedSupportId)
	);
	const sheetSupports = $derived(
		packaging.supports.filter((support) => support.sheetId === design.activeSheetId)
	);
	const trays = $derived(packaging.supports.filter((support) => support.kind === 'tray'));
	const outer = $derived(perimeterBounds(packaging));
	const flip = (y: number) => SHEET - y;

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
		...pocketLabels(design, design.activeSheetId),
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
</script>

{#if plane === 'under'}
	{#if isDeckSheet}
		<rect
			class="deck-area"
			x={packaging.deckX}
			y={packaging.deckY}
			width={packaging.deckW}
			height={packaging.deckH}
		/>
	{/if}
{:else if plane === 'over'}
	{#if isDeckSheet && !drawing}
		<!-- Deck move surface sits under the openings so they win the hit test. -->
		<rect
			class="hit-target"
			data-deck-action="move"
			x={packaging.deckX}
			y={packaging.deckY}
			width={packaging.deckW}
			height={packaging.deckH}
		/>
	{/if}

	{#if isDeckSheet && !drawing}
		{#each trays as tray (tray.id)}
			{@const origin = supportAssemblyOrigin(tray, packaging.supports)}
			<rect
				class="hit-target"
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
				class="hit-target"
				class:selected={support.id === actions.selectedSupportId}
				data-support={support.id}
				x={bounds.left}
				y={bounds.bottom}
				width={bounds.right - bounds.left}
				height={bounds.top - bounds.bottom}
			/>
		{/each}
	{/if}

	{#if !drawing}
		<!-- Openings sit above the regions they are cut into, so they win the hit test. -->
		{#each sheetPockets as pocket (pocket.id)}
			<rect
				class="hit-target"
				class:selected={pocket.id === actions.selectedPocketId ||
					(pocketGroup !== null && pocket.groupId === pocketGroup.group.id)}
				data-pocket={pocket.id}
				x={pocket.x}
				y={pocket.y}
				width={pocket.w}
				height={pocket.h}
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

	{#if selectedPocket && !drawing}
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

	{#if pocketGroup && !drawing}
		{@const box = pocketGroup.box}
		<rect class="selection-box" x={box.x} y={box.y} width={box.w} height={box.h} />
		{#each corners( { left: box.x, right: box.x + box.w, bottom: box.y, top: box.y + box.h } ) as handle (handle.name)}
			<rect
				class="resize-handle"
				data-pocket-group={pocketGroup.group.id}
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
{:else}
	{#each labels as label (label.key)}
		<text class="component-label" x={label.x} y={flip(label.y)}>{label.name}</text>
	{/each}
{/if}

<style>
	/* Transparent, like the flaps, so the grid reads through the deck. */
	.deck-area {
		fill: none;
		stroke: var(--ink-faint);
		stroke-width: 0.8;
		stroke-dasharray: 4 3;
		vector-effect: non-scaling-stroke;
		pointer-events: none;
	}

	.deck-edge-hit {
		stroke: transparent;
		stroke-width: calc(9px / var(--vs));
		vector-effect: none;
	}

	.deck-edge-handle {
		fill: var(--surface);
		stroke: var(--accent);
		stroke-width: 1.1;
		vector-effect: non-scaling-stroke;
	}

	[data-deck-action$='left'],
	[data-deck-action$='right'] {
		cursor: ew-resize;
	}

	[data-deck-action$='top'],
	[data-deck-action$='bottom'],
	.support-height-handle {
		cursor: ns-resize;
	}

	.support-height-handle {
		fill: var(--surface);
		stroke: var(--accent);
		stroke-width: 1.2;
		vector-effect: non-scaling-stroke;
	}

	:global(.drawing.panning) [data-deck-action],
	:global(.drawing.panning) [data-pocket],
	:global(.drawing.panning) [data-support],
	:global(.drawing.draw-mode) [data-deck-action] {
		pointer-events: none;
	}
</style>
