<script lang="ts">
	import Icon from '$lib/components/icons/Icon.svelte';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import { WORKSPACES } from '$lib/features/workspaces.js';

	/**
	 * Which workspace the editor is in, named in words at the head of the
	 * toolbar the way a CAD package names its environment. The workspace belongs
	 * to the sheet, so switching shows that workspace's first sheet, or adds one
	 * when the design has none.
	 */
	let { editor }: { editor: EditorState } = $props();

	let open = $state(false);

	function sheetsIn(id: string): string {
		const names = editor.design.sheets
			.filter((sheet) => sheet.workspace === id)
			.map((sheet) => sheet.name);
		return names.length ? names.join(', ') : 'No sheets yet';
	}
</script>

<svelte:window
	onpointerdown={(event) => {
		if (!(event.target as HTMLElement)?.closest('.workspace-switcher')) open = false;
	}}
	onkeydown={(event) => event.key === 'Escape' && (open = false)}
/>

<div class="menu-host workspace-switcher">
	<button
		class="button switcher"
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="Workspace: {editor.workspace.label}"
		title="Switch workspace"
		onclick={() => (open = !open)}
	>
		<Icon name={editor.workspace.icon} size={18} />
		<span>{editor.workspace.label}</span>
		<Icon name="expand_more" size={16} />
	</button>
	{#if open}
		<div class="menu" role="menu">
			{#each WORKSPACES as workspace (workspace.id)}
				<button
					role="menuitemradio"
					aria-checked={workspace.id === editor.workspace.id}
					onclick={() => {
						open = false;
						editor.switchWorkspace(workspace.id);
					}}
				>
					<Icon name={workspace.icon} />
					<span>
						<strong>{workspace.label}</strong>
						<small>{sheetsIn(workspace.id)}</small>
					</span>
				</button>
			{/each}
		</div>
	{/if}
</div>
