<script lang="ts">
	import { onMount } from 'svelte';
	import { generateGcode } from '$lib/core/cam/gcode.js';
	import { designSvg } from '$lib/core/export/svg.js';
	import { createEditorState } from '$lib/editor/state.svelte.js';
	import { createToolState } from '$lib/editor/tools.svelte.js';
	import { display } from '$lib/core/units.js';
	import {
		designFileText,
		download,
		loadDraft,
		readDesignFile,
		saveDraft,
		slugify
	} from '$lib/editor/persistence.js';
	import Canvas from '$lib/components/editor/Canvas.svelte';
	import { workspaceUi } from '$lib/components/workspaces/index.js';
	import Icon from '$lib/components/icons/Icon.svelte';
	import Inspector from '$lib/components/editor/Inspector.svelte';
	import SheetTabs from '$lib/components/editor/SheetTabs.svelte';
	import SimulationDialog from '$lib/components/editor/SimulationDialog.svelte';
	import Toolbar from '$lib/components/editor/Toolbar.svelte';

	const editor = createEditorState();
	const tools = createToolState();
	let importInput = $state<HTMLInputElement>();
	let simulating = $state(false);
	let notice = $state('Local-first. Nothing leaves this browser.');
	let error = $state('');

	const ui = $derived(workspaceUi(editor.workspace.id));
	const baseName = $derived(
		`${slugify(editor.design.sheets.find((s) => s.id === editor.design.activeSheetId)?.name ?? 'sheet')}`
	);

	// Restoring runs once, outside the reactive graph, so it cannot re-enter
	// the autosave effect below.
	onMount(() => {
		const draft = loadDraft();
		if (draft) {
			editor.setDesign(draft);
			notice = 'Local draft restored.';
		}
	});

	$effect(() => {
		saveDraft(editor.design);
	});

	/** Frames the current selection, or the whole sheet when nothing is selected. */
	function zoomFit(event: MouseEvent): void {
		const bounds =
			event.shiftKey && editor.selection
				? editor.workspace.selectionBounds(
						editor.design,
						editor.selection,
						editor.design.activeSheetId
					)
				: null;
		if (bounds) tools.frame(bounds);
		else tools.fit();
	}

	function saveDesign(): void {
		download(
			`${slugify(editor.design.sheets[0]?.name ?? 'insert')}.voisee.json`,
			designFileText(editor.design),
			'application/json'
		);
		notice = 'Design file exported.';
	}

	function exportSvg(): void {
		const labels = editor.workspace.labels(editor.design, editor.design.activeSheetId);
		download(`${baseName}.svg`, designSvg(editor.geometry, labels), 'image/svg+xml');
		notice = 'Design SVG exported.';
	}

	function exportGcode(): void {
		if (editor.diagnostics.length) {
			error = 'Resolve validation issues before generating machine output.';
			return;
		}
		const paths = editor.geometry.paths;
		const options = editor.workspace.gcodeOptions(editor.design, editor.design.activeSheetId);
		const program = (operation: 'crease' | 'cut') =>
			generateGcode(paths, editor.view, operation, options);
		if (!editor.workspace.capabilities.folding) {
			// Nothing folds, so there is no crease pass: one program cuts the sheet.
			download(`${baseName}.nc`, program('cut'), 'text/plain');
			error = '';
			notice = 'Cut program exported.';
			return;
		}
		download(`${baseName}-01-crease.nc`, program('crease'), 'text/plain');
		download(`${baseName}-02-cut.nc`, program('cut'), 'text/plain');
		error = '';
		notice = 'Crease and cut programs exported. Run the crease program first, spindle off.';
	}

	/**
	 * The simulation runs the emitted program, so it is only meaningful once the
	 * design passes the same validation that gates export.
	 */
	function openSimulation(): void {
		if (editor.diagnostics.length) {
			error = 'Resolve validation issues before simulating machine output.';
			return;
		}
		error = '';
		simulating = true;
	}

	async function importDesign(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			editor.setDesign(readDesignFile(await file.text()));
			notice = 'Design imported.';
			error = '';
		} catch (reason) {
			error = reason instanceof Error ? reason.message : 'The design could not be imported.';
		} finally {
			input.value = '';
		}
	}
</script>

<svelte:head>
	<title>Insert generator</title>
	<meta
		name="description"
		content="Local-first packaging insert CAD/CAM for drag-knife and router work."
	/>
</svelte:head>

<main class="app-shell">
	<Inspector {editor} />

	<section class="workspace">
		<header class="workspace-bar">
			<Toolbar
				{editor}
				{tools}
				onImport={() => importInput?.click()}
				onSaveDesign={saveDesign}
				onExportSvg={exportSvg}
				onExportGcode={exportGcode}
				onSimulate={openSimulation}
			/>
		</header>

		<SheetTabs {editor} />

		{#if tools.viewMode === 'assembly' && ui.AssemblyViewer}
			<ui.AssemblyViewer {editor} {tools} />
		{:else}
			<Canvas {editor} {tools} />
		{/if}

		<footer class="workspace-foot">
			<div class="legend">
				<span><i class="swatch cut"></i>Through cut</span>
				{#if editor.workspace.capabilities.folding}
					<span><i class="swatch score-down"></i>Down fold</span>
					<span><i class="swatch score-up"></i>Up fold</span>
				{/if}
				<span><i class="swatch tab"></i>Holding tab</span>
			</div>
			<div class="foot-right">
				{#if tools.viewMode === 'flat'}
					<div class="zoom" role="group" aria-label="Zoom">
						<button
							class="button icon"
							aria-label="Zoom out"
							title="Zoom out"
							onclick={() => tools.zoomBy(1 / 1.35)}
						>
							<Icon name="remove" size={18} />
						</button>
						<span class="zoom-readout">{Math.round(tools.scale * 100)}%</span>
						<button
							class="button icon"
							aria-label="Zoom in"
							title="Zoom in"
							onclick={() => tools.zoomBy(1.35)}
						>
							<Icon name="add" size={18} />
						</button>
						<button
							class="button icon"
							aria-label="Fit sheet; hold shift to frame the selection"
							title="Fit sheet (shift: frame selection)"
							onclick={zoomFit}
						>
							<Icon name="fit_screen" size={18} />
						</button>
					</div>
				{/if}
				<p class="readout">
					{#if tools.viewMode === 'assembly'}
						Drag to orbit &middot; scroll to zoom
					{:else if tools.cursor}
						X {display(tools.cursor.x, editor.design.stock.units).toFixed(
							editor.design.stock.units === 'in' ? 3 : 1
						)} &middot; Y {display(tools.cursor.y, editor.design.stock.units).toFixed(
							editor.design.stock.units === 'in' ? 3 : 1
						)}
						{editor.design.stock.units}
					{:else}
						X &mdash; &middot; Y &mdash;
					{/if}
				</p>
				{#if error}
					<p class="status error">{error}</p>
				{:else if editor.diagnostics.length}
					<p class="status error">
						{editor.diagnostics[0]}{editor.diagnostics.length > 1
							? ` (+${editor.diagnostics.length - 1} more)`
							: ''}
					</p>
				{:else}
					<p class="status ok">geometry valid</p>
				{/if}
			</div>
		</footer>

		<p class="disclaimer">
			The preview shows design geometry; exported G-code additionally offsets the spindle axis for
			the trailing blade tip. Dimensions are not substitutes for a material calibration cut.
		</p>
	</section>

	<SimulationDialog {editor} open={simulating} onClose={() => (simulating = false)} />

	<input
		bind:this={importInput}
		hidden
		type="file"
		accept=".json,.voisee.json"
		onchange={importDesign}
	/>
	<p aria-live="polite" class="sr-only">{notice}</p>
</main>
