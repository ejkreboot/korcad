<script lang="ts">
	import { display, parseDisplay } from '$lib/core/units.js';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import { flatPartsActions } from '$lib/features/flat-parts/actions.js';
	import { HOLE_PRESETS, PROFILE_PRESETS } from '$lib/features/flat-parts/presets.js';
	import type { FlatPartsEntity, FlatPartsShape } from '$lib/features/flat-parts/types.js';

	/** The selected part or hole, or a summary of the sheet when nothing is selected. */
	let { editor }: { editor: EditorState } = $props();

	const actions = $derived(flatPartsActions(editor));
	const entity = $derived(actions.selectedEntity);
	const units = $derived(editor.design.stock.units);
	const unitLabel = $derived(units === 'in' ? 'in' : 'mm');
	const mm = (value: number) => display(value, units);
	const router = $derived(editor.machine.fabricationMode === 'router');
	const parts = $derived(actions.view.entities.filter((item) => item.kind === 'profile').length);
	const holes = $derived(actions.view.entities.length - parts);

	const shapes = (item: FlatPartsEntity) =>
		item.kind === 'profile' ? PROFILE_PRESETS : HOLE_PRESETS;
	const shapeLabel = (item: FlatPartsEntity) =>
		item.shape === 'path'
			? 'Imported outline'
			: (shapes(item).find((preset) => preset.id === item.shape)?.label ?? item.shape);

	function setLength(key: 'x' | 'y' | 'w' | 'h' | 'cornerRadius', raw: string): void {
		if (!entity) return;
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value)) actions.updateEntity(entity.id, { [key]: value });
	}

	/**
	 * While on, a width or height typed in scales the whole entity to it, and a
	 * part's holes with it. It applies when the field is committed rather than
	 * on each keystroke, so typing 150 does not first shrink the part to 1 mm
	 * and lose its holes' positions to rounding. Not saved; it is a way of editing.
	 */
	let proportional = $state(false);

	function scaleTo(key: 'w' | 'h', raw: string): void {
		if (!entity) return;
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value) && value > 0) actions.scaleEntity(entity.id, value / entity[key]);
	}

	function setSize(key: 'w' | 'h', raw: string, committed: boolean): void {
		if (proportional === committed) {
			if (proportional) scaleTo(key, raw);
			else setLength(key, raw);
		}
	}

	const group = $derived(actions.selectedGroup);
	const groupParts = $derived(group?.members.filter((item) => item.kind === 'profile') ?? []);
	/** Every part's tab count when they agree; `null` when they differ. */
	const groupTabs = $derived(
		groupParts.every((item) => item.tabCount === groupParts[0]?.tabCount)
			? (groupParts[0]?.tabCount ?? 0)
			: null
	);

	function moveGroupTo(key: 'x' | 'y', raw: string): void {
		if (!group) return;
		const value = parseDisplay(raw, units);
		if (!Number.isFinite(value)) return;
		const { x, y } = group.box;
		actions.moveGroup(group.group.id, key === 'x' ? value : x, key === 'y' ? value : y);
	}

	/** A group always keeps its proportions; applied on commit, like a proportional entity size. */
	function scaleGroupTo(key: 'w' | 'h', raw: string): void {
		if (!group) return;
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value) && value > 0) {
			actions.scaleGroup(group.group.id, value / group.box[key]);
		}
	}

	function setGroupTabs(raw: string): void {
		if (!group || raw === '') return;
		const value = Math.round(Number(raw));
		if (Number.isFinite(value) && value >= 0) actions.setGroupTabs(group.group.id, value);
	}

	function setCount(key: 'sides' | 'tabCount', raw: string, minimum: number): void {
		if (!entity) return;
		const value = Math.round(Number(raw));
		if (Number.isFinite(value) && value >= minimum)
			actions.updateEntity(entity.id, { [key]: value });
	}
</script>

{#if group}
	<section class="panel">
		<div class="panel-head">
			<h2>{group.group.name}</h2>
			<button class="link danger" onclick={() => actions.removeGroup(group.group.id)}>Delete</button
			>
		</div>
		<p class="badge">
			Imported group · {groupParts.length}
			{groupParts.length === 1 ? 'part' : 'parts'}, {group.members.length - groupParts.length}
			{group.members.length - groupParts.length === 1 ? 'hole' : 'holes'}
		</p>

		<div class="form-grid">
			<label class="field wide">
				Name
				<input
					value={group.group.name}
					oninput={(e) => actions.renameGroup(group.group.id, e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				X from left ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(group.box.x)}
					onchange={(e) => moveGroupTo('x', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Y from bottom ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(group.box.y)}
					onchange={(e) => moveGroupTo('y', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Width ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(group.box.w)}
					onchange={(e) => scaleGroupTo('w', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Height ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(group.box.h)}
					onchange={(e) => scaleGroupTo('h', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Holding tabs
				<input
					type="number"
					min="0"
					step="1"
					placeholder="Mixed"
					value={groupTabs ?? ''}
					onchange={(e) => setGroupTabs(e.currentTarget.value)}
				/>
			</label>
		</div>
		<p class="help">
			An imported drawing moves, scales, rotates, and is deleted as one. A new width or height
			scales every part and hole in it together, keeping its proportions, and a rotation turns it
			about the centre of its box. Holding tabs apply to each part.
		</p>
	</section>
{:else if entity}
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
			<!-- An imported outline has no parameters to redraw it from, so it keeps its shape. -->
			{#if entity.shape !== 'path'}
				<label class="field wide">
					Shape
					<select
						value={entity.shape}
						onchange={(e) =>
							actions.updateEntity(entity.id, { shape: e.currentTarget.value as FlatPartsShape })}
					>
						{#each shapes(entity) as preset (preset.id)}
							<option value={preset.id}>{preset.label}</option>
						{/each}
					</select>
				</label>
			{/if}
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
					oninput={(e) => setSize('w', e.currentTarget.value, false)}
					onchange={(e) => setSize('w', e.currentTarget.value, true)}
				/>
			</label>
			<label class="field">
				Height ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(entity.h)}
					oninput={(e) => setSize('h', e.currentTarget.value, false)}
					onchange={(e) => setSize('h', e.currentTarget.value, true)}
				/>
			</label>
			<label class="check proportional" class:on={proportional}>
				<input type="checkbox" bind:checked={proportional} />
				{entity.kind === 'profile' ? 'Keep proportions and scale holes' : 'Keep proportions'}
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
			{#if entity.kind === 'profile'}
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
				inside it, and so does a new width or height while proportions are kept.
				{#if router}
					Each holding tab is a bridge the bit rises over, leaving the tab thickness set under
					Material.
					{#if entity.tabCount === 0}
						With no tabs the last cut frees the part, so hold it down some other way.
					{/if}
				{:else}
					Each holding tab is a gap left in the cut.
				{/if}
			{:else}
				A hole is cut inside its line, before the part around it is released. It must lie inside a
				part.
			{/if}
		</p>
	</section>
{:else}
	<section class="panel">
		<h2>Sheet</h2>
		<p class="help">
			{parts}
			{parts === 1 ? 'part' : 'parts'} and {holes}
			{holes === 1 ? 'hole' : 'holes'} on this sheet. Draw a part, then holes inside it, or import an
			SVG from the Part menu, whose outlines become parts and holes by how they nest; select one to edit
			it.
		</p>
	</section>
{/if}

<style>
	.proportional {
		grid-column: 1 / -1;
		justify-content: flex-start;
		text-transform: none;
	}
</style>
