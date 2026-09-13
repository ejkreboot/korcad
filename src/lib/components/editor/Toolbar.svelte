<script lang="ts">
	import {
		CUTOUT_PRESETS,
		SUPPORT_PRESETS,
		type CutoutPreset,
		type SupportPreset
	} from '$lib/features/packaging/presets.js';
	import Icon from '$lib/components/icons/Icon.svelte';
	import type { IconName } from '$lib/components/icons/paths.js';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import type { ToolState } from '$lib/editor/tools.svelte.js';

	let {
		editor,
		tools,
		onImport,
		onSaveDesign,
		onExportSvg,
		onExportGcode,
		onSimulate
	}: {
		editor: EditorState;
		tools: ToolState;
		onImport: () => void;
		onSaveDesign: () => void;
		onExportSvg: () => void;
		onExportGcode: () => void;
		onSimulate: () => void;
	} = $props();

	let openMenu = $state<'cutout' | 'support' | null>(null);
	const blocked = $derived(editor.diagnostics.length > 0);
	// Drawing happens on the flat sheet, so those tools are unavailable in 3D.
	const assembling = $derived(tools.viewMode === 'assembly');
	const router = $derived(editor.machine.fabricationMode === 'router');

	/**
	 * Icons for the drawing presets, matching the reference implementation's
	 * choices so the menus stay recognisable to anyone who used it.
	 */
	const CUTOUT_ICONS: Readonly<Record<CutoutPreset, IconName>> = {
		rectangle: 'rectangle',
		folded: 'move_to_inbox',
		rounded: 'rounded_corner',
		ellipse: 'circle',
		slot: 'horizontal_rule',
		cable: 'cable',
		registration: 'my_location'
	};

	const SUPPORT_ICONS: Readonly<Record<SupportPreset, IconName>> = {
		'riser-glue': 'inventory_2',
		'riser-lock': 'lock',
		platform: 'stairs_2',
		tray: 'system_update_alt'
	};

	function choose(menu: 'cutout' | 'support', id: string): void {
		openMenu = null;
		if (menu === 'cutout') tools.drawCutout(id as never);
		else tools.drawSupport(id as never);
	}
</script>

<svelte:window
	onpointerdown={(event) => {
		if (!(event.target as HTMLElement)?.closest('.menu-host')) openMenu = null;
	}}
/>

<!--
	An icon toolbar: every control carries its name in `aria-label` and repeats
	it in `title`, so the label is available to assistive technology and to
	anyone hovering, without the row growing wide enough to wrap.
-->
<div class="toolbar" role="toolbar" aria-label="Editor commands">
	<div class="group">
		<button
			class="button icon"
			class:active={tools.tool === 'select'}
			aria-pressed={tools.tool === 'select'}
			aria-label="Select"
			title="Select"
			disabled={assembling}
			onclick={() => tools.select()}
		>
			<Icon name="arrow_selector_tool" />
		</button>

		<div class="menu-host">
			<button
				class="button icon split"
				class:active={tools.tool === 'cutout'}
				aria-haspopup="menu"
				aria-expanded={openMenu === 'cutout'}
				aria-label="Cutout"
				title="Draw a cutout"
				disabled={assembling}
				onclick={() => (openMenu = openMenu === 'cutout' ? null : 'cutout')}
			>
				<Icon name="activity_zone" />
				<Icon name="expand_more" size={14} />
			</button>
			{#if openMenu === 'cutout'}
				<div class="menu" role="menu">
					{#each CUTOUT_PRESETS as preset (preset.id)}
						<button role="menuitem" onclick={() => choose('cutout', preset.id)}>
							<Icon name={CUTOUT_ICONS[preset.id]} />
							<span>
								<strong>{preset.label}</strong>
								<small>{preset.description}</small>
							</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="menu-host">
			<button
				class="button icon split"
				class:active={tools.tool === 'support'}
				aria-haspopup="menu"
				aria-expanded={openMenu === 'support'}
				aria-label="Support"
				title={router
					? 'Supports are folded parts; switch to drag knife to add them'
					: 'Draw a support'}
				disabled={router || assembling}
				onclick={() => (openMenu = openMenu === 'support' ? null : 'support')}
			>
				<Icon name="brick" />
				<Icon name="expand_more" size={14} />
			</button>
			{#if openMenu === 'support'}
				<div class="menu" role="menu">
					{#each SUPPORT_PRESETS as preset (preset.id)}
						<button role="menuitem" onclick={() => choose('support', preset.id)}>
							<Icon name={SUPPORT_ICONS[preset.id]} />
							<span>
								<strong>{preset.label}</strong>
								<small>{preset.description}</small>
							</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<div class="group">
		<button
			class="button icon"
			class:active={tools.viewMode === 'flat'}
			aria-pressed={tools.viewMode === 'flat'}
			aria-label="2D"
			title="Flat cutting sheet"
			onclick={() => tools.setViewMode('flat')}
		>
			<Icon name="crop_square" />
		</button>
		<button
			class="button icon"
			class:active={tools.viewMode === 'assembly'}
			aria-pressed={tools.viewMode === 'assembly'}
			aria-label="3D"
			title="Assembled 3D preview"
			onclick={() => tools.setViewMode('assembly')}
		>
			<Icon name="view_in_ar" />
		</button>
	</div>

	<div class="group">
		<button
			class="button icon"
			aria-label="Undo"
			title="Undo"
			disabled={!editor.canUndo}
			onclick={() => editor.undo()}
		>
			<Icon name="undo" />
		</button>
		<button
			class="button icon"
			aria-label="Redo"
			title="Redo"
			disabled={!editor.canRedo}
			onclick={() => editor.redo()}
		>
			<Icon name="redo" />
		</button>
		<button
			class="button icon"
			class:active={tools.snapEnabled}
			aria-pressed={tools.snapEnabled}
			aria-label="Snap"
			title="Snap to a quarter-inch grid"
			onclick={() => tools.setSnap(!tools.snapEnabled)}
		>
			<Icon name="grid_4x4" />
		</button>
	</div>

	<div class="group">
		<button
			class="button icon"
			aria-label="Simulate"
			title={blocked
				? 'Resolve validation issues before simulating'
				: 'Simulate the emitted toolpath'}
			disabled={blocked}
			onclick={onSimulate}
		>
			<Icon name="slideshow" />
		</button>
	</div>

	<div class="group">
		<button
			class="button icon"
			aria-label="Save design"
			title="Save design file"
			onclick={onSaveDesign}
		>
			<Icon name="save" />
		</button>
		<button class="button icon" aria-label="Open" title="Open a design file" onclick={onImport}>
			<Icon name="folder_open" />
		</button>
		<button class="button icon" aria-label="SVG" title="Export design SVG" onclick={onExportSvg}>
			<Icon name="timeline" />
		</button>
		<button
			class="button icon primary"
			aria-label="G-code"
			title={blocked
				? 'Resolve validation issues before exporting machine output'
				: 'Export G-code'}
			disabled={blocked}
			onclick={onExportGcode}
		>
			<Icon name="content_cut" />
		</button>
	</div>
</div>
