<script lang="ts">
	import type { EditorState } from '$lib/editor/state.svelte.js';

	let { editor }: { editor: EditorState } = $props();

	let renaming = $state<string | null>(null);

	function commitRename(id: string, value: string): void {
		const name = value.trim();
		if (name) editor.renameSheet(id, name);
		renaming = null;
	}
</script>

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
	<button
		class="sheet-add"
		aria-label="Add a parts sheet"
		title="Add sheet"
		onclick={() => editor.addSheet()}
	>
		+
	</button>
</div>
