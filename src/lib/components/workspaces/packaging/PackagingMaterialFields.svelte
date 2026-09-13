<script lang="ts">
	import { display, parseDisplay } from '$lib/core/units.js';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import { packagingActions } from '$lib/features/packaging/actions.js';
	import type { StockSettings } from '$lib/core/design/types.js';
	import type { PackagingData } from '$lib/features/packaging/types.js';

	/** Packaging's part of the Material panel: how the board looks and how folds are allowed for. */
	let { editor }: { editor: EditorState } = $props();

	const actions = $derived(packagingActions(editor));
	const packaging = $derived(actions.view);
	const units = $derived(editor.design.stock.units);
	const unitLabel = $derived(units === 'in' ? 'in' : 'mm');
	const mm = (value: number) => display(value, units);

	type NumericKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

	function setPackaging(key: NumericKey<PackagingData>, raw: string): void {
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value)) actions.setPackaging(key, value);
	}
</script>

<label class="field wide">
	Board appearance
	<select
		value={editor.design.stock.boardFinish}
		onchange={(e) =>
			editor.setStock('boardFinish', e.currentTarget.value as StockSettings['boardFinish'])}
	>
		<option value="kraft">Natural kraft</option>
		<option value="white">White board</option>
		<option value="printed">Printed</option>
	</select>
</label>
<label class="field wide">
	Fold allowance
	<select
		value={packaging.foldCompensation}
		onchange={(e) =>
			actions.setPackaging(
				'foldCompensation',
				e.currentTarget.value as PackagingData['foldCompensation']
			)}
	>
		<option value="none">None (cut to drawn size)</option>
		<option value="computed">Computed from radius and K factor</option>
		<option value="manual">Measured deduction</option>
	</select>
</label>
{#if packaging.foldCompensation === 'manual'}
	<label class="field wide">
		Deduction per fold ({unitLabel})
		<input
			type="number"
			step="0.001"
			value={mm(packaging.foldDeduction)}
			oninput={(e) => setPackaging('foldDeduction', e.currentTarget.value)}
		/>
	</label>
{/if}
{#if packaging.foldCompensation === 'computed'}
	<label class="field">
		Radius factor
		<input
			type="number"
			step="0.05"
			value={packaging.foldRadiusFactor}
			oninput={(e) => actions.setPackaging('foldRadiusFactor', Number(e.currentTarget.value))}
		/>
	</label>
	<label class="field">
		K factor
		<input
			type="number"
			step="0.05"
			value={packaging.foldKFactor}
			oninput={(e) => actions.setPackaging('foldKFactor', Number(e.currentTarget.value))}
		/>
	</label>
{/if}
