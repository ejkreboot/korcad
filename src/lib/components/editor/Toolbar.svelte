<script lang="ts">
	import Icon from '$lib/components/icons/Icon.svelte';
	import MaskIcon from '$lib/components/icons/MaskIcon.svelte';
	import WorkspaceSwitcher from './WorkspaceSwitcher.svelte';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import type { ToolState } from '$lib/editor/tools.svelte.js';
	import type { WorkspaceId } from '$lib/core/design/workspace.js';
	import { WORKSPACES } from '$lib/features/workspaces.js';

	let {
		editor,
		tools,
		onNewProject,
		onImport,
		onWorkspaceImport,
		onSaveDesign,
		onExportSvg,
		onExportGcode,
		onSimulate
	}: {
		editor: EditorState;
		tools: ToolState;
		onNewProject: (workspaceId: WorkspaceId) => void;
		onImport: () => void;
		onWorkspaceImport: (importId: string) => void;
		onSaveDesign: () => void;
		onExportSvg: () => void;
		onExportGcode: () => void;
		onSimulate: () => void;
	} = $props();

	const NEW_PROJECT_MENU = 'new-project';
	/** The toolbar menu that is open: a drawing tool's presets, or the new project menu. */
	let openMenu = $state<string | null>(null);
	const blocked = $derived(editor.diagnostics.length > 0);
	// Drawing happens on the flat sheet, so those tools are unavailable in 3D.
	const assembling = $derived(tools.viewMode === 'assembly');

	function choose(toolId: string, presetId: string): void {
		openMenu = null;
		tools.draw(toolId, presetId);
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
		<WorkspaceSwitcher {editor} />
	</div>

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

		{#each editor.workspace.tools as tool (tool.id)}
			{@const unavailable = tool.unavailable(editor.machine)}
			<div class="menu-host">
				<button
					class="button icon split"
					class:active={tools.tool === tool.id}
					aria-haspopup="menu"
					aria-expanded={openMenu === tool.id}
					aria-label={tool.label}
					title={unavailable ?? tool.title}
					disabled={unavailable !== null || assembling}
					onclick={() => (openMenu = openMenu === tool.id ? null : tool.id)}
				>
					<Icon name={tool.icon} />
					<Icon name="expand_more" size={14} />
				</button>
				{#if openMenu === tool.id}
					<div class="menu" role="menu">
						{#each tool.presets as preset (preset.id)}
							<button role="menuitem" onclick={() => choose(tool.id, preset.id)}>
								<Icon name={preset.icon} />
								<span>
									<strong>{preset.label}</strong>
									<small>{preset.description}</small>
								</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/each}

		{#each editor.workspace.imports as entry (entry.id)}
			<button
				class="button icon"
				aria-label={entry.label}
				title={entry.title}
				disabled={assembling}
				onclick={() => onWorkspaceImport(entry.id)}
			>
				<Icon name={entry.icon} />
			</button>
		{/each}
	</div>

	{#if editor.workspace.capabilities.assembly}
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
	{/if}

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
		<div class="menu-host">
			<button
				class="button icon split"
				aria-haspopup="menu"
				aria-expanded={openMenu === NEW_PROJECT_MENU}
				aria-label="New project"
				title="Start a new project"
				onclick={() => (openMenu = openMenu === NEW_PROJECT_MENU ? null : NEW_PROJECT_MENU)}
			>
				<Icon name="note_add" />
				<Icon name="expand_more" size={14} />
			</button>
			{#if openMenu === NEW_PROJECT_MENU}
				<div class="menu" role="menu">
					{#each WORKSPACES as workspace (workspace.id)}
						<button
							role="menuitem"
							onclick={() => {
								openMenu = null;
								onNewProject(workspace.id);
							}}
						>
							<Icon name={workspace.icon} />
							<span>
								<strong>{workspace.label}</strong>
								<small>A new project with one empty sheet</small>
							</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
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
			<MaskIcon src="/SVG_download.svg" />
		</button>
		<button
			class="button icon"
			aria-label="G-code"
			title={blocked
				? 'Resolve validation issues before exporting machine output'
				: 'Export G-code'}
			disabled={blocked}
			onclick={onExportGcode}
		>
			<MaskIcon src="/G_code_download.svg" />
		</button>
	</div>
</div>
