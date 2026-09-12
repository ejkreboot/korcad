<script lang="ts">
	import { ICON_PATHS, ICON_VIEW_BOX, type IconName } from './paths.js';

	/**
	 * A single Material Symbol, drawn inline.
	 *
	 * Decorative by default: an icon button carries its meaning in the button's
	 * accessible name, so the glyph is hidden from assistive technology rather
	 * than read out twice. Pass a `label` only where the icon is the sole
	 * carrier of meaning.
	 */
	let { name, size = 20, label }: { name: IconName; size?: number; label?: string } = $props();
</script>

<svg
	class="icon"
	viewBox={ICON_VIEW_BOX}
	width={size}
	height={size}
	role={label ? 'img' : 'presentation'}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	focusable="false"
>
	<path d={ICON_PATHS[name]} />
</svg>

<style>
	/* Fills with the button's own colour, so state changes need no icon rules. */
	.icon {
		display: block;
		flex: none;
		fill: currentColor;
	}
</style>
