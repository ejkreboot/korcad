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

	const FILE_MENU = 'file';
	/** The toolbar menu that is open: a drawing tool's presets, or the File menu. */
	let openMenu = $state<string | null>(null);
	const blocked = $derived(editor.diagnostics.length > 0);
	// Drawing happens on the flat sheet, so those tools are unavailable in 3D.
	const assembling = $derived(tools.viewMode === 'assembly');

	/** Each press turns the selection this far; a turn is baked into its geometry, so steps stay coarse. */
	const ROTATE_STEP = 15;
	const rotatable = $derived(
		editor.selection !== null && editor.workspace.canRotate(editor.design, editor.selection)
	);

	function rotate(degrees: number): void {
		const selection = editor.selection;
		if (selection)
			editor.update((design) => editor.workspace.rotateSelection(design, selection, degrees));
	}

	function fileCommand(command: () => void): void {
		openMenu = null;
		command();
	}

	function choose(toolId: string, presetId: string): void {
		openMenu = null;
		tools.draw(toolId, presetId);
	}
</script>

<svelte:window
	onpointerdown={(event) => {
		// Any press outside the open menu's own host closes it, including one on
		// another menu, such as the workspace chooser, which keeps its own state.
		const host = (event.target as HTMLElement)?.closest('[data-menu]');
		if (host?.getAttribute('data-menu') !== openMenu) openMenu = null;
	}}
/>

<!--
	An icon toolbar: every control carries its name in `aria-label` and repeats
	it in `title`, so the label is available to assistive technology and to
	anyone hovering, without the row growing wide enough to wrap.

	Controls sit in boxed groups, named for assistive technology: what you draw
	with, editing and viewing, and export. File is a menu-bar item and stands
	unboxed at the head of the row; the workspace chooser leads the tool box,
	because it decides which tools are in it. Boxes rather than dividers,
	because a wrapped row would otherwise start with a stray divider.
-->
<div class="toolbar" role="toolbar" aria-label="Editor commands">
	<!-- File comes first, as in any application; words, because a new-document glyph reads here as "add a sheet". -->
	<div class="group plain">
		<div class="menu-host" data-menu={FILE_MENU}>
			<button
				class="button menubar"
				aria-haspopup="menu"
				aria-expanded={openMenu === FILE_MENU}
				aria-label="File"
				title="New, open, and save designs"
				onclick={() => (openMenu = openMenu === FILE_MENU ? null : FILE_MENU)}
			>
				<span>File</span>
				<Icon name="expand_more" size={16} />
			</button>
			{#if openMenu === FILE_MENU}
				<div class="menu wide" role="menu">
					{#each WORKSPACES as workspace (workspace.id)}
						<button role="menuitem" onclick={() => fileCommand(() => onNewProject(workspace.id))}>
							<Icon name={workspace.icon} />
							<span>
								<strong>New {workspace.label} project…</strong>
								<small>Start over with one empty sheet</small>
							</span>
						</button>
					{/each}
					<div class="menu-separator" role="separator"></div>
					<button role="menuitem" onclick={() => fileCommand(onImport)}>
						<Icon name="folder_open" />
						<span>
							<strong>Open design file…</strong>
							<small>Replace this design with a saved one</small>
						</span>
					</button>
					<button role="menuitem" onclick={() => fileCommand(onSaveDesign)}>
						<Icon name="save" />
						<span>
							<strong>Save design file</strong>
							<small>Download this design to keep or share</small>
						</span>
					</button>
				</div>
			{/if}
		</div>
	</div>

	<div class="group" role="group" aria-label="Workspace and drawing tools">
		<WorkspaceSwitcher {editor} />
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
			<div class="menu-host" data-menu={tool.id}>
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
						{#each editor.workspace.imports.filter((entry) => entry.toolId === tool.id) as entry (entry.id)}
							<button
								role="menuitem"
								onclick={() => {
									openMenu = null;
									onWorkspaceImport(entry.id);
								}}
							>
								<Icon name={entry.icon} />
								<span>
									<strong>{entry.label}…</strong>
									<small>{entry.description}</small>
								</span>
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{/each}
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
		<button
			class="button icon"
			aria-label="Rotate left"
			title={rotatable
				? `Rotate the selection ${ROTATE_STEP}° counter-clockwise`
				: 'Select an imported drawing to rotate it'}
			disabled={!rotatable}
			onclick={() => rotate(ROTATE_STEP)}
		>
			<Icon name="rotate_left" />
		</button>
		<button
			class="button icon"
			aria-label="Rotate right"
			title={rotatable
				? `Rotate the selection ${ROTATE_STEP}° clockwise`
				: 'Select an imported drawing to rotate it'}
			disabled={!rotatable}
			onclick={() => rotate(-ROTATE_STEP)}
		>
			<Icon name="rotate_right" />
		</button>
	</div>

	<div class="group" role="group" aria-label="Edit and view">
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

		{#if editor.workspace.capabilities.assembly}
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
		{/if}
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

	<div class="group" role="group" aria-label="Export">
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
