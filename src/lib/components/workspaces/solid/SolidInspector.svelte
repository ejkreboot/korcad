<script lang="ts">
	import { display, parseDisplay } from '$lib/core/units.js';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import { solidActions } from '$lib/features/solid/actions.js';
	import { HOLE_PRESETS, PROFILE_PRESETS } from '$lib/features/solid/presets.js';
	import type { SolidEntity, SolidShape } from '$lib/features/solid/types.js';

	/** The selected part or hole, or a summary of the plate when nothing is selected. */
	let { editor }: { editor: EditorState } = $props();

	const actions = $derived(solidActions(editor));
	const entity = $derived(actions.selectedEntity);
	const units = $derived(editor.design.stock.units);
	const unitLabel = $derived(units === 'in' ? 'in' : 'mm');
	const mm = (value: number) => display(value, units);
	const router = $derived(editor.machine.fabricationMode === 'router');
	const parts = $derived(actions.view.entities.filter((item) => item.kind === 'profile').length);
	const holes = $derived(actions.view.entities.length - parts);

	const shapes = (item: SolidEntity) => (item.kind === 'profile' ? PROFILE_PRESETS : HOLE_PRESETS);
	const shapeLabel = (item: SolidEntity) =>
		shapes(item).find((preset) => preset.id === item.shape)?.label ?? item.shape;

	function setLength(key: 'x' | 'y' | 'w' | 'h' | 'cornerRadius', raw: string): void {
		if (!entity) return;
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value)) actions.updateEntity(entity.id, { [key]: value });
	}

	function setCount(key: 'sides' | 'tabCount', raw: string, minimum: number): void {
		if (!entity) return;
		const value = Math.round(Number(raw));
		if (Number.isFinite(value) && value >= minimum)
			actions.updateEntity(entity.id, { [key]: value });
	}
</script>

{#if entity}
	<section class="panel">
		<div class="panel-head">
			<h2>{entity.name}</h2>
			<button class="link danger" onclick={() => actions.removeEntity(entity.id)}>Delete</button>
		</div>
		<p class="badge">{entity.kind === 'profile' ? 'Part' : 'Hole'} · {shapeLabel(entity)}</p>

		<div class="form-grid">
			<label class="field wide">
				Name
				<input
					value={entity.name}
					oninput={(e) => actions.updateEntity(entity.id, { name: e.currentTarget.value })}
				/>
			</label>
			<label class="field wide">
				Shape
				<select
					value={entity.shape}
					onchange={(e) =>
						actions.updateEntity(entity.id, { shape: e.currentTarget.value as SolidShape })}
				>
					{#each shapes(entity) as preset (preset.id)}
						<option value={preset.id}>{preset.label}</option>
					{/each}
				</select>
			</label>
			<label class="field">
				X from left ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(entity.x)}
					oninput={(e) => setLength('x', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Y from bottom ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(entity.y)}
					oninput={(e) => setLength('y', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Width ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(entity.w)}
					oninput={(e) => setLength('w', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Height ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(entity.h)}
					oninput={(e) => setLength('h', e.currentTarget.value)}
				/>
			</label>
			{#if entity.shape === 'rounded'}
				<label class="field">
					Corner radius ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(entity.cornerRadius)}
						oninput={(e) => setLength('cornerRadius', e.currentTarget.value)}
					/>
				</label>
			{/if}
			{#if entity.shape === 'polygon'}
				<label class="field">
					Sides
					<input
						type="number"
						min="3"
						step="1"
						value={entity.sides}
						oninput={(e) => setCount('sides', e.currentTarget.value, 3)}
					/>
				</label>
			{/if}
			{#if entity.kind === 'profile' && !router}
				<label class="field">
					Holding tabs
					<input
						type="number"
						min="0"
						step="1"
						value={entity.tabCount}
						oninput={(e) => setCount('tabCount', e.currentTarget.value, 0)}
					/>
				</label>
			{/if}
		</div>
		<p class="help">
			{#if entity.kind === 'profile'}
				A part is cut outside its line, so it keeps its drawn size. Moving it carries the holes
				inside it.
				{#if router}
					Holding tabs are not available on a router yet; the part is released in one cut.
				{/if}
			{:else}
				A hole is cut inside its line, before the part around it is released. It must lie inside a
				part.
			{/if}
		</p>
	</section>
{:else}
	<section class="panel">
		<h2>Plate</h2>
		<p class="help">
			{parts}
			{parts === 1 ? 'part' : 'parts'} and {holes}
			{holes === 1 ? 'hole' : 'holes'} on this sheet. Draw a part, then holes inside it; select one to
			edit it.
		</p>
	</section>
{/if}
