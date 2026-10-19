<script lang="ts">
	import { MM_PER_IN } from '$lib/core/constants.js';
	import { JOG_SPEEDS, MAX_Z_JOG } from '$lib/core/grbl/probing.js';
	import type { Position } from '$lib/core/grbl/protocol.js';
	import { round } from '$lib/core/units.js';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import type { MachineLink } from '$lib/editor/machine-link.svelte.js';
	import CollapsiblePanel from './CollapsiblePanel.svelte';

	let { editor, link }: { editor: EditorState; link: MachineLink } = $props();

	const units = $derived(editor.design.stock.units);
	const unitLabel = $derived(units === 'in' ? 'in' : 'mm');
	const shown = (mm: number) => (units === 'in' ? round(mm / MM_PER_IN, 4) : round(mm, 3));
	const toMm = (value: number) => (units === 'in' ? value * MM_PER_IN : value);
	/** Jog steps in display units, from a paper-test nudge to most of the way across the table. */
	const steps = $derived(units === 'in' ? [0.001, 0.01, 0.1, 1, 5] : [0.01, 0.1, 1, 10, 100]);
	let step = $state<number | null>(null);
	const jogStep = $derived(step !== null && steps.includes(step) ? step : steps[2]!);
	const zStepAllowed = $derived(toMm(jogStep) <= MAX_Z_JOG + 1e-9);
	const speeds = $derived(JOG_SPEEDS[units]);

	const snapshot = $derived(link.snapshot);
	const machineState = $derived(snapshot?.status?.state ?? null);
	const idle = $derived(machineState === 'Idle' && !snapshot?.busy);
	const canJog = $derived((machineState === 'Idle' || machineState === 'Jog') && !snapshot?.busy);

	function jog(axis: keyof Position, direction: 1 | -1): void {
		void link.jog({ [axis]: direction * toMm(jogStep) });
	}

	/** Where Go to goes, as typed in display units; it starts at the origin. */
	let goX = $state<number | null>(0);
	let goY = $state<number | null>(0);
	/** An emptied number field binds as null, which is no coordinate rather than zero. */
	const typed = (value: number | null) => (typeof value === 'number' ? value : NaN);
	const goTarget = $derived({ x: toMm(typed(goX)), y: toMm(typed(goY)) });
	const goValid = $derived(Number.isFinite(goTarget.x) && Number.isFinite(goTarget.y));

	const JOGS: readonly {
		axis: keyof Position;
		direction: 1 | -1;
		label: string;
		area: string;
	}[] = [
		{ axis: 'y', direction: 1, label: 'Y+', area: 'y-plus' },
		{ axis: 'x', direction: -1, label: 'X−', area: 'x-minus' },
		{ axis: 'x', direction: 1, label: 'X+', area: 'x-plus' },
		{ axis: 'y', direction: -1, label: 'Y−', area: 'y-minus' },
		{ axis: 'z', direction: 1, label: 'Z+', area: 'z-plus' },
		{ axis: 'z', direction: -1, label: 'Z−', area: 'z-minus' }
	];
</script>

<CollapsiblePanel title="Machine">
	{#if !link.available}
		<p class="help">
			Connecting to the machine needs Chrome or Edge on a computer, which can reach a USB serial
			port. Exported programs work from any browser.
		</p>
	{:else if !snapshot}
		<button class="button primary" type="button" disabled={link.connecting} onclick={link.connect}>
			{link.connecting ? 'Connecting…' : 'Connect'}
		</button>
		<p class="help">
			Connects to a GRBL controller over USB, to jog it, measure the table, and run jobs. Disconnect
			your sender first, since only one program can hold the port. Run a sheet's programs from the
			Run panel.
		</p>
	{:else}
		<p class="machine-state" aria-live="polite">
			<strong>{machineState ?? 'Waiting'}</strong>
			{#if snapshot.work}
				<span>
					X{shown(snapshot.work.x)} Y{shown(snapshot.work.y)} Z{shown(snapshot.work.z)}
					{unitLabel}
				</span>
			{:else}
				<span>Reading position…</span>
			{/if}
		</p>
		{#if snapshot.alarm}
			<p class="help machine-alarm" role="alert">{snapshot.alarm}</p>
		{/if}
		{#if machineState === 'Alarm'}
			<div class="profile-actions" role="group" aria-label="Clear the alarm">
				<button
					class="button"
					type="button"
					title="Run the homing cycle, if the machine has switches"
					onclick={() => link.recover('home')}>Home</button
				>
				<button
					class="button"
					type="button"
					title="Clear the alarm without homing; check the machine first, and set zero again"
					onclick={() => link.recover('unlock')}>Unlock</button
				>
			</div>
		{/if}

		<p class="field-label">Jog</p>
		<div class="jog">
			<div class="jog-pad" role="group" aria-label="Jog the tool">
				{#each JOGS as move (move.area)}
					{@const blocked = move.axis === 'z' && !zStepAllowed}
					<button
						class="button"
						type="button"
						style:grid-area={move.area}
						disabled={!canJog || blocked}
						aria-label={`Jog ${move.label}`}
						title={blocked
							? `Z jogs at most ${shown(MAX_Z_JOG)} ${unitLabel} at a time`
							: `Move ${move.label} by ${jogStep} ${unitLabel}`}
						onclick={() => jog(move.axis, move.direction)}>{move.label}</button
					>
				{/each}
			</div>
			<div class="jog-settings">
				<label class="field">
					Step ({unitLabel})
					<select
						value={jogStep}
						onchange={(e) => (step = Number(e.currentTarget.value))}
						aria-label="Jog step"
					>
						{#each steps as option (option)}
							<option value={option}>{option}</option>
						{/each}
					</select>
				</label>
				<label
					class="field"
					title="How fast jogs and Go to cross the table; Z always moves gently. The controller caps it at its own maximum rate."
				>
					Speed ({unitLabel}/min)
					<select
						value={link.jogSpeed}
						onchange={(e) => link.setJogSpeed(Number(e.currentTarget.value))}
						aria-label="Jog speed"
					>
						{#each speeds as option, index (option)}
							<option value={index}>{option}</option>
						{/each}
					</select>
				</label>
			</div>
		</div>

		<p class="field-label">Go to</p>
		<form
			class="machine-goto"
			aria-label="Go to a point"
			onsubmit={(e) => {
				e.preventDefault();
				if (goValid) void link.goTo(goTarget);
			}}
		>
			<label class="field">
				X ({unitLabel})
				<input type="number" step="any" bind:value={goX} aria-label="Go to X" />
			</label>
			<label class="field">
				Y ({unitLabel})
				<input type="number" step="any" bind:value={goY} aria-label="Go to Y" />
			</label>
			<button
				class="button"
				type="submit"
				disabled={!idle || !goValid}
				title="Rise to the travel height if lower, then cross to this point in work coordinates"
				>Go to</button
			>
		</form>

		<div class="profile-actions machine-zero" role="group" aria-label="Set the work origin">
			<button
				class="button"
				type="button"
				disabled={!idle}
				title="Make where the tool stands X0 Y0: the sheet's lower-left corner"
				onclick={() => link.setZero('xy')}>Set X0 Y0 here</button
			>
			<button
				class="button"
				type="button"
				disabled={!idle}
				title="Make the tool's height Z0: the tip just touching the table"
				onclick={() => link.setZero('z')}>Set Z0 here</button
			>
		</div>
		<label class="check machine-origin" class:on={snapshot.originConfirmed}>
			<input
				type="checkbox"
				checked={snapshot.originConfirmed}
				disabled={!snapshot.work}
				onchange={(e) => link.confirmOrigin(e.currentTarget.checked)}
			/>
			X0 Y0 is the sheet's lower-left corner, and Z0 is on the table
		</label>
		<p class="help">
			Go to rises to the travel height set under Table surface, if the tool is lower, before it
			crosses. Nothing goes to a grid point until the origin is confirmed. A reset or an alarm that
			may have lost the position clears it. The Stop button stays at the bottom of the screen while
			connected.
		</p>
		<button class="button machine-disconnect" type="button" onclick={link.disconnect}>
			Disconnect
		</button>
	{/if}
	{#if link.problem}
		<p class="help machine-problem" role="alert">{link.problem}</p>
	{/if}
</CollapsiblePanel>

<style>
	.machine-state {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 10px;
		margin: 0;
		font: 12px var(--mono);
	}

	.machine-alarm,
	.machine-problem {
		margin-top: 10px;
		background: var(--error-bg);
		color: var(--error-ink);
	}

	.jog {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 96px;
		gap: 10px;
		align-items: end;
	}

	/* X and Y as a compass, with Z beside it, as a pendant lays them out. */
	.jog-pad {
		display: grid;
		grid-template-areas:
			'. y-plus . z-plus'
			'x-minus . x-plus .'
			'. y-minus . z-minus';
		grid-template-columns: repeat(4, minmax(0, 44px));
		gap: 4px;
	}

	.jog-settings {
		display: grid;
		gap: 8px;
	}

	.machine-goto {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
		gap: 8px;
		align-items: end;
	}

	.jog-pad .button {
		padding: 5px 0;
		font-family: var(--mono);
	}

	.machine-zero {
		margin-top: 12px;
	}

	.machine-origin {
		justify-content: flex-start;
		margin-top: 10px;
		padding: 6px 9px;
		text-align: left;
		text-transform: none;
	}

	.machine-disconnect {
		margin-top: 12px;
	}
</style>
