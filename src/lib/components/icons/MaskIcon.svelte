<script lang="ts">
	/**
	 * A custom glyph drawn from an image's alpha channel.
	 *
	 * The image is used as a mask over the button's own colour, so it follows the
	 * same states as a vendored `Icon` (white on a primary button, darker on hover,
	 * faded when disabled) whatever colour it was drawn in. Like `Icon`, it is
	 * decorative: the button carries the name.
	 */
	let { src, size = 20 }: { src: string; size?: number } = $props();
</script>

<span
	class="icon"
	aria-hidden="true"
	style:width="{size}px"
	style:height="{size}px"
	style:--icon-mask="url({src})"
></span>

<style>
	.icon {
		display: block;
		flex: none;
		background-color: currentColor;
		-webkit-mask: var(--icon-mask) center / contain no-repeat;
		mask: var(--icon-mask) center / contain no-repeat;
	}
</style>
