<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import Icon from '$lib/components/icons/Icon.svelte';

	/**
	 * A sidebar panel that folds away.
	 *
	 * Used for the settings that are configured once per job — material and
	 * machine — so they stay reachable at the top of the sidebar without
	 * pushing the selection they are above off the screen.
	 */
	let {
		title,
		status = '',
		badge = '',
		initiallyOpen = false,
		children
	}: {
		title: string;
		/** A word on the panel's state, shown beside its title so it is seen while folded. */
		status?: string;
		/** A short flag after the status, such as "unsaved", that is never cut short. */
		badge?: string;
		initiallyOpen?: boolean;
		children: Snippet;
	} = $props();

	// The panel owns its open state from here on: the prop is a starting point,
	// not a binding, so a re-render never folds a panel the operator opened.
	let expanded = $state(untrack(() => initiallyOpen));
</script>

<section class="panel collapsible" class:is-collapsed={!expanded}>
	<h2>
		<button
			class="collapse-toggle"
			type="button"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			<Icon name="expand_more" size={18} />
			<span>{title}</span>
		</button>
		<!-- Beside the toggle rather than in it, so the toggle keeps the panel's name. -->
		{#if status}<span class="panel-status">{status}</span>{/if}
		{#if badge}<span class="panel-badge">{badge}</span>{/if}
	</h2>
	{#if expanded}
		<div class="panel-body">{@render children()}</div>
	{/if}
</section>

<style>
	/* A collapsed panel is just its header, so it loses the body's spacing. */
	.collapsible h2 {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin: 0;
	}

	.collapsible:not(.is-collapsed) h2 {
		margin-bottom: 12px;
	}

	.collapse-toggle {
		display: flex;
		align-items: center;
		/* The toggle takes what the status leaves, so the status is only cut short when it must be. */
		flex: 1 1 0;
		gap: 6px;
		min-width: max-content;
		padding: 0;
		border: 0;
		background: none;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}

	.collapse-toggle:hover {
		color: var(--accent);
	}

	/* The chevron points down when open and at the title when closed. */
	.collapse-toggle :global(.icon) {
		transition: transform 120ms ease;
	}

	.is-collapsed .collapse-toggle :global(.icon) {
		transform: rotate(-90deg);
	}
</style>
