<script lang="ts">
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import { WORKSPACES, workspaceById } from '$lib/features/workspaces.js';

	let { editor }: { editor: EditorState } = $props();

	let renaming = $state<string | null>(null);
	let adding = $state(false);

	function commitRename(id: string, value: string): void {
		const name = value.trim();
		if (name) editor.renameSheet(id, name);
		renaming = null;
	}
</script>

<svelte:window
	onpointerdown={(event) => {
		if (!(event.target as HTMLElement)?.closest('.menu-host')) adding = false;
	}}
/>

<div class="sheet-tabs" role="tablist" aria-label="Manufacturing sheets">
	{#each editor.design.sheets as sheet (sheet.id)}
		{@const active = sheet.id === editor.design.activeSheetId}
		<div class="sheet-tab" class:active>
			{#if renaming === sheet.id}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="sheet-rename"
					autofocus
					value={sheet.name}
					onblur={(event) => commitRename(sheet.id, event.currentTarget.value)}
					onkeydown={(event) => {
						if (event.key === 'Enter') event.currentTarget.blur();
						if (event.key === 'Escape') renaming = null;
					}}
				/>
			{:else}
				<button
					role="tab"
					aria-selected={active}
					title="{sheet.name} · {workspaceById(sheet.workspace).label}"
					onclick={() => editor.setActiveSheet(sheet.id)}
					ondblclick={() => editor.canEditSheet(sheet.id) && (renaming = sheet.id)}
				>
					{sheet.name}
				</button>
				{#if editor.canEditSheet(sheet.id) && active}
					<button
						class="sheet-close"
						aria-label="Delete {sheet.name} and the supports cut from it"
						title="Delete sheet"
						onclick={() => editor.removeSheet(sheet.id)}
					>
						×
					</button>
				{/if}
			{/if}
		</div>
	{/each}
	<div class="menu-host">
		<button
			class="sheet-add"
			aria-haspopup="menu"
			aria-expanded={adding}
			aria-label="Add a sheet"
			title="Add sheet"
			onclick={() => (adding = !adding)}
		>
			+
		</button>
		{#if adding}
			<div class="menu" role="menu">
				{#each WORKSPACES as workspace (workspace.id)}
					<button
						role="menuitem"
						onclick={() => {
							adding = false;
							editor.addSheet(workspace.id);
						}}
					>
						<span>
							<strong>{workspace.label} sheet</strong>
							<small>{workspace.newSheetName(editor.design)}</small>
						</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>
</div>
