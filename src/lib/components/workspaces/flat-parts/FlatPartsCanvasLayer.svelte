<script lang="ts">
	import { SHEET } from '$lib/core/constants.js';
	import { flatPartsActions } from '$lib/features/flat-parts/actions.js';
	import { entityOutline } from '$lib/features/flat-parts/geometry.js';
	import type { CanvasLayerProps } from '../index.js';

	/**
	 * Flat Parts on the 2D canvas: a hit target on every part and hole, handles on
	 * the selected one, and part names. Holes are drawn over parts so a hole
	 * inside a part can still be grabbed.
	 */
	let { editor, plane, drawing, screenUnit }: CanvasLayerProps = $props();

	const actions = $derived(flatPartsActions(editor));
	const entities = $derived([
		...actions.view.entities.filter((entity) => entity.kind === 'profile'),
		...actions.view.entities.filter((entity) => entity.kind === 'hole')
	]);
	const selected = $derived(
		actions.view.entities.find((entity) => entity.id === actions.selectedEntity?.id) ?? null
	);
	const pointsAttr = (points: readonly { x: number; y: number }[]) =>
		points.map((p) => `${p.x},${p.y}`).join(' ');
	const corners = $derived(
		selected
			? ([
					{ name: 'sw', x: selected.x, y: selected.y },
					{ name: 'se', x: selected.x + selected.w, y: selected.y },
					{ name: 'ne', x: selected.x + selected.w, y: selected.y + selected.h },
					{ name: 'nw', x: selected.x, y: selected.y + selected.h }
				] as const)
			: []
	);
</script>

{#if plane === 'over' && !drawing}
	{#each entities as entity (entity.id)}
		<polygon
			class="hit-target"
			class:selected={entity.id === selected?.id}
			data-flat-parts-entity={entity.id}
			points={pointsAttr(entityOutline(entity))}
		/>
	{/each}
	{#if selected}
		<rect
			class="selection-box"
			x={selected.x}
			y={selected.y}
			width={selected.w}
			height={selected.h}
		/>
		{#each corners as handle (handle.name)}
			<rect
				class="resize-handle"
				data-flat-parts-entity={selected.id}
				data-handle={handle.name}
				x={handle.x - 4 * screenUnit}
				y={handle.y - 4 * screenUnit}
				width={8 * screenUnit}
				height={8 * screenUnit}
				rx={screenUnit}
			/>
		{/each}
	{/if}
{:else if plane === 'labels'}
	{#each entities.filter((entity) => entity.kind === 'profile') as entity (entity.id)}
		<text class="component-label" x={entity.x + 5} y={SHEET - (entity.y + entity.h - 9)}>
			{entity.name}
		</text>
	{/each}
{/if}
