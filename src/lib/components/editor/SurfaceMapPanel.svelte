<script lang="ts">
	import { MM_PER_IN } from '$lib/core/constants.js';
	import {
		MAX_SURFACE_INSET,
		resizeSurfaceMap,
		SURFACE_GRID_MAX,
		SURFACE_GRID_MIN,
		surfaceGridPoint,
		surfaceInsetValid,
		surfaceRange
	} from '$lib/core/cam/surface.js';
	import {
		pointsToResume,
		probeOrder,
		probeSettingsErrors,
		type ProbePoint,
		type ProbeSettings
	} from '$lib/core/grbl/probing.js';
	import { round } from '$lib/core/units.js';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import type { MachineLink } from '$lib/editor/machine-link.svelte.js';
	import CollapsiblePanel from './CollapsiblePanel.svelte';

	let { editor, link }: { editor: EditorState; link: MachineLink } = $props();

	const map = $derived(editor.surfaceMap);
	const units = $derived(editor.design.stock.units);
	const unitLabel = $derived(units === 'in' ? 'in' : 'mm');
	/** A table a few thousandths out matters, so heights show a place more than other lengths. */
	const shown = (mm: number) => (units === 'in' ? round(mm / MM_PER_IN, 4) : round(mm, 3));
	const sizes = Array.from(
		{ length: SURFACE_GRID_MAX - SURFACE_GRID_MIN + 1 },
		(_, index) => SURFACE_GRID_MIN + index
	);
	/** Rows from the back of the table to the front, so the grid reads as the table does from above. */
	const rows = $derived(Array.from({ length: map.rows }, (_, index) => map.rows - 1 - index));
	const columns = $derived(Array.from({ length: map.columns }, (_, index) => index));
	const range = $derived(surfaceRange(map));

	/** Where the columns and rows stand, for the grid's edges: short, so the grid fits the sidebar. */
	const axis = (mm: number) => (units === 'in' ? round(mm / MM_PER_IN, 1) : round(mm, 1));
	const columnX = (column: number) => axis(surfaceGridPoint(map, column, 0).x);
	const rowY = (row: number) => axis(surfaceGridPoint(map, 0, row).y);

	/** Moves the grid in from the edges, re-reading each point from the map as it stands. */
	function setInset(input: HTMLInputElement): void {
		const inset = typed(input.value);
		if (inset !== null && surfaceInsetValid(inset)) {
			editor.setSurfaceMap(resizeSurfaceMap(map, map.columns, map.rows, inset));
		} else {
			input.value = String(shown(map.inset));
		}
	}

	function place(column: number, row: number): string {
		const { x, y } = surfaceGridPoint(map, column, row);
		return `X${shown(x)} Y${shown(y)}`;
	}

	/** A length typed in display units, in mm; an emptied field is `null`, not zero, which is a real height. */
	function typed(raw: string): number | null {
		const value = Number(raw);
		if (raw.trim() === '' || !Number.isFinite(value)) return null;
		return units === 'in' ? value * MM_PER_IN : value;
	}

	function setHeight(index: number, height: number): void {
		const heights = [...editor.surfaceMap.heights];
		heights[index] = height;
		editor.setSurfaceMap({ ...editor.surfaceMap, heights });
	}

	/** The grid point the machine controls act on: the one last focused. */
	let selected = $state(0);
	const current = $derived(Math.min(selected, map.heights.length - 1));
	const pointOf = (index: number): ProbePoint => ({
		index,
		...surfaceGridPoint(map, index % map.columns, Math.floor(index / map.columns))
	});
	const target = $derived(pointOf(current));
	const order = $derived(probeOrder(map));
	/** Points a run of Probe every point stopped short of, while the grid is still the one it ran on. */
	const missed = $derived(pointsToResume(link.unread, order.map(pointOf)));
	const missedIndices = $derived(new Set(missed.map((point) => point.index)));

	const snapshot = $derived(link.snapshot);
	const ready = $derived(snapshot?.status?.state === 'Idle' && !snapshot.busy);
	const atTarget = $derived(link.at(target));
	const settingsErrors = $derived(probeSettingsErrors(link.probeSettings));
	const canMove = $derived(ready && snapshot?.originConfirmed === true);
	const canProbe = $derived(canMove && settingsErrors.length === 0);

	/** Records a reading at a point and moves on to the next in probing order. */
	function record(index: number, height: number): void {
		setHeight(index, height);
		link.markRead(index);
		const next = order[order.indexOf(index) + 1];
		if (next !== undefined) selected = next;
	}

	function setProbe(key: keyof ProbeSettings, raw: string): void {
		const value = typed(raw);
		if (value !== null) link.setProbeSettings({ ...link.probeSettings, [key]: value });
	}

	async function recordHere(): Promise<void> {
		const index = current;
		const reading = await link.reading();
		if (reading !== undefined) record(index, reading);
	}

	async function probeHere(): Promise<void> {
		const index = current;
		const reading = await link.probe();
		if (reading !== undefined) record(index, reading);
	}

	async function probeEvery(points: readonly ProbePoint[]): Promise<void> {
		const which =
			points.length === order.length
				? `all ${points.length} points`
				: `the ${points.length} points not yet probed`;
		if (
			!confirm(
				`Probe ${which} in turn? The probe must touch something wired to it at every point, such as a foil sheet over the whole table, since nothing pauses for a plate to be moved.`
			)
		) {
			return;
		}
		await link.probeEach(points, record);
	}
</script>

<CollapsiblePanel title="Table surface">
	<label class="check surface-toggle" class:on={map.enabled}>
		<input
			type="checkbox"
			checked={map.enabled}
			onchange={(e) => editor.setSurfaceMap({ ...map, enabled: e.currentTarget.checked })}
		/>
		Cut following this map
	</label>
	<div class="form-grid">
		<label class="field">
			Columns
			<select
				value={map.columns}
				onchange={(e) =>
					editor.setSurfaceMap(resizeSurfaceMap(map, Number(e.currentTarget.value), map.rows))}
			>
				{#each sizes as size (size)}
					<option value={size}>{size}</option>
				{/each}
			</select>
		</label>
		<label class="field">
			Rows
			<select
				value={map.rows}
				onchange={(e) =>
					editor.setSurfaceMap(resizeSurfaceMap(map, map.columns, Number(e.currentTarget.value)))}
			>
				{#each sizes as size (size)}
					<option value={size}>{size}</option>
				{/each}
			</select>
		</label>
		<label
			class="field"
			title="How far in from the sheet's edges the outermost points stand, to keep them inside the machine's travel. Programs hold the edge points' heights out to the sheet's edge."
		>
			Inset from edges ({unitLabel})
			<input
				type="number"
				min="0"
				max={shown(MAX_SURFACE_INSET)}
				step="any"
				value={shown(map.inset)}
				onchange={(e) => setInset(e.currentTarget)}
			/>
		</label>
	</div>
	<p class="field-label">Z at each point ({unitLabel}), back of the table at the top</p>
	<div
		class="surface-grid"
		style:grid-template-columns={`auto repeat(${map.columns}, minmax(62px, 1fr))`}
		role="group"
		aria-label="Table heights"
	>
		<!-- Each field names its own point, so the edges are for the eye only. -->
		<span class="surface-axis" aria-hidden="true"></span>
		{#each columns as column (column)}
			<span class="surface-axis column" aria-hidden="true">{columnX(column)}</span>
		{/each}
		{#each rows as row (row)}
			<span class="surface-axis row" aria-hidden="true">{rowY(row)}</span>
			{#each columns as column (column)}
				{@const index = row * map.columns + column}
				<input
					type="number"
					step="0.001"
					class:selected={snapshot && index === current}
					class:missed={missedIndices.has(index)}
					value={shown(map.heights[index] ?? 0)}
					aria-label={`Z at ${place(column, row)}`}
					title={place(column, row)}
					onfocus={() => (selected = index)}
					oninput={(e) => {
						const height = typed(e.currentTarget.value);
						if (height !== null) setHeight(index, height);
					}}
				/>
			{/each}
		{/each}
	</div>
	<p class="help">
		Jog the tool to each point, lower it until a slip of paper just drags, and enter the Z it reads.
		Programs follow the table relative to X0 Y0 at the bottom left, so set Z zero there before
		cutting; between the outer points and the sheet's edges they hold the nearest point's height.
		This table runs from {shown(range.low)} to {shown(range.high)}
		{unitLabel} against X0 Y0. The map is kept in this browser, not in the design.
	</p>

	{#if snapshot}
		<p class="field-label">Measure with the machine</p>
		<div class="form-grid">
			<label class="field" title="0 for foil or a thin sheet laid over the table">
				Plate thickness ({unitLabel})
				<input
					type="number"
					min="0"
					step="0.001"
					value={shown(link.probeSettings.plateThickness)}
					oninput={(e) => setProbe('plateThickness', e.currentTarget.value)}
				/>
			</label>
			<label
				class="field"
				title="Height above Z0 the tool crosses the table at, clear of the plate"
			>
				Travel height ({unitLabel})
				<input
					type="number"
					min="0"
					step="0.001"
					value={shown(link.probeSettings.travelHeight)}
					oninput={(e) => setProbe('travelHeight', e.currentTarget.value)}
				/>
			</label>
		</div>
		{#each settingsErrors as problem (problem)}
			<p class="help surface-problem" role="alert">{problem}</p>
		{/each}
		<p class="surface-point">
			Point <strong
				>{place(target.index % map.columns, Math.floor(target.index / map.columns))}</strong
			>
			{atTarget ? '· the tool is here' : ''}
		</p>
		<div class="profile-actions" role="group" aria-label="Measure the point">
			<button
				class="button"
				type="button"
				disabled={!canMove}
				title="Rise to travel height, then go over the point"
				onclick={() => link.moveTo(target)}>Go to point</button
			>
			<button
				class="button"
				type="button"
				disabled={!ready || !atTarget}
				title="Record the tool's Z, after lowering it until a slip of paper just drags"
				onclick={recordHere}>Record Z</button
			>
			<button
				class="button primary"
				type="button"
				disabled={!canProbe || !atTarget}
				title="Probe down to the plate under the tool, record the table's height, and rise again"
				onclick={probeHere}>Probe</button
			>
			<button
				class="button"
				type="button"
				disabled={!canProbe}
				title="Go to and probe every point, for a conductive sheet over the whole table"
				onclick={() => probeEvery(order.map(pointOf))}>Probe every point</button
			>
			{#if missed.length > 0}
				<button
					class="button"
					type="button"
					disabled={!canProbe}
					title="Go to and probe the points the last run of Probe every point did not reach, outlined in the grid"
					onclick={() => probeEvery(missed)}>Finish the {missed.length} missed</button
				>
			{/if}
		</div>
		<p class="help">
			Click a point's field, go to it, then lower the tool to a slip of paper and record Z, or place
			the plate under it and probe. Each reading moves on to the next point.
		</p>
	{:else}
		<p class="help">
			Connect the machine in the Machine panel to go to each point and record or probe it there.
		</p>
	{/if}
</CollapsiblePanel>

<style>
	.surface-toggle {
		justify-content: flex-start;
		margin-bottom: 10px;
		padding: 4px 9px;
		text-transform: none;
	}

	/* A fine grid is wider than the sidebar, so it scrolls within the panel, not the page. */
	.surface-grid {
		display: grid;
		gap: 4px;
		overflow-x: auto;
		padding-bottom: 2px;
	}

	.surface-axis {
		align-self: center;
		font: 10px var(--mono);
		color: var(--ink-soft);
		white-space: nowrap;
	}

	.surface-axis.column {
		text-align: center;
	}

	.surface-axis.row {
		padding-right: 2px;
		text-align: right;
	}

	/* Each field holds a reading such as -0.0125 in full, with no spinner taking its room. */
	.surface-grid input {
		min-width: 0;
		padding: 5px 4px;
		font-size: 12px;
		appearance: textfield;
	}

	.surface-grid input.missed {
		border-style: dashed;
		border-color: var(--ink-soft);
	}

	.surface-grid input.selected {
		border-color: var(--accent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}

	.surface-point {
		margin: 12px 0 8px;
		font-size: 12px;
	}

	.surface-problem {
		margin-top: 10px;
		background: var(--error-bg);
		color: var(--error-ink);
	}

	.surface-grid input::-webkit-inner-spin-button,
	.surface-grid input::-webkit-outer-spin-button {
		appearance: none;
		margin: 0;
	}
</style>
