<script lang="ts">
	/**
	 * Turns a selection: a quarter turn either way, or any angle typed in, which
	 * is applied once when the field is committed and then cleared, since a turn
	 * is baked into the geometry rather than kept as a setting to edit later.
	 * Positive degrees turn counter-clockwise, as angles do on a Y-up sheet.
	 */
	let { onrotate }: { onrotate: (degrees: number) => void } = $props();
	const uid = $props.id();
	const labelId = `${uid}-rotate`;

	function commit(input: HTMLInputElement): void {
		const degrees = Number(input.value);
		if (input.value !== '' && Number.isFinite(degrees) && degrees % 360 !== 0) onrotate(degrees);
		input.value = '';
	}
</script>

<div class="field wide">
	<span id={labelId}>Rotate</span>
	<div class="rotate">
		<button
			type="button"
			class="button"
			aria-label="Rotate 90° counter-clockwise"
			title="Rotate 90° counter-clockwise"
			onclick={() => onrotate(90)}>↺ 90°</button
		>
		<input
			type="number"
			step="any"
			placeholder="Degrees, + is CCW"
			aria-labelledby={labelId}
			onchange={(e) => commit(e.currentTarget)}
		/>
		<button
			type="button"
			class="button"
			aria-label="Rotate 90° clockwise"
			title="Rotate 90° clockwise"
			onclick={() => onrotate(-90)}>↻ 90°</button
		>
	</div>
</div>

<style>
	.rotate {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 6px;
	}
</style>
