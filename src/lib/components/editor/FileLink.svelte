<script lang="ts">
	/**
	 * The file a panel's settings were last opened from or saved to, whether
	 * they have changed since, and the buttons that open and save one. A
	 * file that cannot be read is reported here, beside the button that
	 * opened it.
	 */
	let {
		label,
		file,
		unsaved,
		empty,
		onOpen,
		onSave
	}: {
		/** Names the button group, such as "Material preset file". */
		label: string;
		file: { readonly name: string } | null;
		unsaved: boolean;
		/** What is said when no file is linked. */
		empty: string;
		onOpen: () => Promise<void>;
		onSave: (saveAs: boolean) => Promise<void>;
	} = $props();

	let error = $state('');
	let busy = $state(false);

	async function attempt(action: () => Promise<void>): Promise<void> {
		busy = true;
		try {
			await action();
			error = '';
		} catch (reason) {
			error = reason instanceof Error ? reason.message : 'The file could not be read or written.';
		} finally {
			busy = false;
		}
	}
</script>

<div class="file-link">
	<p class="file-link-name">
		{#if file}
			<span class="file-link-file" title={file.name}>{file.name}</span>
			{#if unsaved}<span class="file-link-unsaved">Unsaved changes</span>{/if}
		{:else}
			<span class="file-link-none">{empty}</span>
		{/if}
	</p>
	<div class="profile-actions" role="group" aria-label={label}>
		<button class="button" type="button" disabled={busy} onclick={() => attempt(onOpen)}
			>Open…</button
		>
		<button
			class="button"
			type="button"
			disabled={busy}
			title={file ? `Save to ${file.name}` : 'Save to a new file'}
			onclick={() => attempt(() => onSave(file === null))}>Save</button
		>
		<button class="button" type="button" disabled={busy} onclick={() => attempt(() => onSave(true))}
			>Save as…</button
		>
	</div>
	{#if error}
		<p class="help file-link-error" role="alert">{error}</p>
	{/if}
</div>
