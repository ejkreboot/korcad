<script lang="ts">
	import { display, parseDisplay } from '$lib/core/units.js';
	import type { MachineSettings, StockSettings } from '$lib/core/design/types.js';
	import { profileDeletion } from '$lib/core/design/profiles.js';
	import { workspaceUi } from '$lib/components/workspaces/index.js';
	import CollapsiblePanel from './CollapsiblePanel.svelte';
	import type { EditorState } from '$lib/editor/state.svelte.js';

	let { editor }: { editor: EditorState } = $props();

	const design = $derived(editor.design);
	/** The active sheet's workspace supplies its own panels. */
	const ui = $derived(workspaceUi(editor.workspace.id));
	/** The profile the active sheet is cut on; the Machine panel edits it. */
	const machine = $derived(editor.machine);
	const sheetName = $derived(
		design.sheets.find((sheet) => sheet.id === design.activeSheetId)?.name ?? 'sheet'
	);
	const units = $derived(design.stock.units);

	const unitLabel = $derived(units === 'in' ? 'in' : 'mm');
	const mm = (value: number) => display(value, units);

	type NumericKey<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

	function setStock(key: NumericKey<StockSettings>, raw: string): void {
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value)) editor.setStock(key, value);
	}
	/**
	 * Deleting a profile moves its sheets onto another machine, which changes
	 * what they cut, so the operator is told which sheets and which machine
	 * before it happens.
	 */
	function deleteProfile(): void {
		const deletion = profileDeletion(design, machine.id);
		if (!deletion) return;
		const sheets = deletion.movedSheets.join(', ');
		if (
			confirm(
				`Delete the ${machine.name} profile? ${sheets} will be cut on ${deletion.replacement.name} instead.`
			)
		) {
			editor.deleteMachineProfile();
		}
	}
	/** Writes a machine setting onto the profile the active sheet is cut on. */
	function setMachine(key: keyof MachineSettings, raw: string): void {
		const value = parseDisplay(raw, units);
		if (Number.isFinite(value)) editor.setMachineSetting(key, value as never);
	}
</script>

<aside class="sidebar">
	<header class="brand">
		<p class="brand-eyebrow">VOISEE</p>
		<h1>Insert generator <span>drag-knife CAM</span></h1>
	</header>

	<CollapsiblePanel title="Material">
		<div class="form-grid">
			<label class="field">
				Thickness ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(design.stock.material)}
					oninput={(e) => setStock('material', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Minimum web ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(design.stock.minimumWeb)}
					oninput={(e) => setStock('minimumWeb', e.currentTarget.value)}
				/>
			</label>
			<label class="field wide">
				Board appearance
				<select
					value={design.stock.boardFinish}
					onchange={(e) =>
						editor.setStock('boardFinish', e.currentTarget.value as StockSettings['boardFinish'])}
				>
					<option value="kraft">Natural kraft</option>
					<option value="white">White board</option>
					<option value="printed">Printed</option>
				</select>
			</label>
			<label class="field wide">
				Grain / flute direction
				<select
					value={design.stock.grainDirection}
					onchange={(e) =>
						editor.setStock(
							'grainDirection',
							e.currentTarget.value as StockSettings['grainDirection']
						)}
				>
					<option value="y">Along Y</option>
					<option value="x">Along X</option>
					<option value="unknown">Unspecified</option>
				</select>
			</label>
			{#if ui.MaterialFields}
				<ui.MaterialFields {editor} />
			{/if}
		</div>
		<p class="help">
			Grain direction and thickness are recorded in the G-code header.
			{ui.materialHelp ?? ''}
		</p>
	</CollapsiblePanel>

	<CollapsiblePanel title="Machine">
		<p class="help">
			These settings belong to the <strong>{machine.name}</strong> profile, which
			{sheetName} is cut on. Sheets sharing this profile change with it.
		</p>
		<div class="form-grid">
			<label class="field wide">
				Cut on
				<select
					value={machine.id}
					onchange={(e) => editor.assignMachineProfile(e.currentTarget.value)}
				>
					{#each design.machineProfiles as profile (profile.id)}
						<option value={profile.id}>{profile.name}</option>
					{/each}
				</select>
			</label>
			<div class="field wide profile-actions" role="group" aria-label="Machine profiles">
				<button class="button" onclick={() => editor.addMachineProfile()}>New</button>
				<button class="button" onclick={() => editor.duplicateMachineProfile()}>Duplicate</button>
				<button
					class="button"
					disabled={design.machineProfiles.length < 2}
					title={design.machineProfiles.length < 2
						? 'A design always keeps one profile'
						: `Delete ${machine.name}`}
					onclick={deleteProfile}>Delete</button
				>
			</div>
			<label class="field wide">
				Profile name
				<input
					type="text"
					value={machine.name}
					oninput={(e) => editor.renameMachineProfile(e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Units
				<select
					value={design.stock.units}
					onchange={(e) =>
						editor.setStock('units', e.currentTarget.value as StockSettings['units'])}
				>
					<option value="in">Inches</option>
					<option value="mm">Millimeters</option>
				</select>
			</label>
			<label class="field">
				Fabrication
				<select
					value={machine.fabricationMode}
					onchange={(e) =>
						editor.setMachineSetting(
							'fabricationMode',
							e.currentTarget.value as MachineSettings['fabricationMode']
						)}
				>
					<option value="knife">Drag knife</option>
					<option value="router">Router</option>
				</select>
			</label>
			<label class="field">
				Safe Z ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(machine.safeZ)}
					oninput={(e) => setMachine('safeZ', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Cut depth ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(machine.cutDepth)}
					oninput={(e) => setMachine('cutDepth', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Score depth ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(machine.scoreDepth)}
					oninput={(e) => setMachine('scoreDepth', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Blade offset ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(machine.bladeOffset)}
					oninput={(e) => setMachine('bladeOffset', e.currentTarget.value)}
				/>
			</label>
			<label class="field">
				Overcut ({unitLabel})
				<input
					type="number"
					step="0.001"
					value={mm(machine.overcut)}
					oninput={(e) => setMachine('overcut', e.currentTarget.value)}
				/>
			</label>
			{#if machine.fabricationMode === 'router'}
				<label class="field">
					Bit diameter ({unitLabel})
					<input
						type="number"
						step="0.001"
						value={mm(machine.bitWidth)}
						oninput={(e) => setMachine('bitWidth', e.currentTarget.value)}
					/>
				</label>
			{/if}
		</div>
	</CollapsiblePanel>

	<ui.Inspector {editor} />
</aside>
