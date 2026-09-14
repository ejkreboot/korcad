<script lang="ts">
	import { SHEET } from '$lib/core/constants.js';
	import { flatPartsActions } from '$lib/features/flat-parts/actions.js';
	import { entityOutline } from '$lib/features/flat-parts/geometry.js';
	import { flatPartsLabels } from '$lib/features/flat-parts/workspace.js';
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
	const group = $derived(actions.selectedGroup);
	/** The box handles are drawn on: the selected entity's, or the selected group's. */
	const box = $derived(group?.box ?? selected);
	const pointsAttr = (points: readonly { x: number; y: number }[]) =>
		points.map((p) => `${p.x},${p.y}`).join(' ');
	const corners = $derived(
		box
			? ([
					{ name: 'sw', x: box.x, y: box.y },
					{ name: 'se', x: box.x + box.w, y: box.y },
					{ name: 'ne', x: box.x + box.w, y: box.y + box.h },
					{ name: 'nw', x: box.x, y: box.y + box.h }
				] as const)
			: []
	);
	const labels = $derived(flatPartsLabels(editor.design, editor.design.activeSheetId));
</script>

{#if plane === 'over' && !drawing}
	{#each entities as entity (entity.id)}
		<polygon
			class="hit-target"
			class:selected={entity.id === selected?.id ||
				(group !== null && entity.groupId === group.group.id)}
			data-flat-parts-entity={entity.id}
			points={pointsAttr(entityOutline(entity))}
		/>
	{/each}
	{#if box}
		<rect class="selection-box" x={box.x} y={box.y} width={box.w} height={box.h} />
		{#each corners as handle (handle.name)}
			<rect
				class="resize-handle"
				data-flat-parts-entity={group ? undefined : selected?.id}
				data-flat-parts-group={group?.group.id}
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
	{#each labels as label, index (index)}
		<text class="component-label" x={label.x} y={SHEET - label.y}>{label.name}</text>
	{/each}
{/if}
