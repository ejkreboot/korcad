<script lang="ts">
	import { SHEET } from '$lib/core/constants.js';
	import { display } from '$lib/core/units.js';
	import { generateGcode } from '$lib/core/cam/gcode.js';
	import {
		moveLabel,
		simulationDuration,
		simulationFrame,
		simulationMoves,
		simulationPhases,
		toolChangeNote,
		type MoveType,
		type SimulationMove,
		type SimulationPoint,
		type SimulationPhase
	} from '$lib/core/cam/simulation.js';
	import Icon from '$lib/components/icons/Icon.svelte';
	import type { IconName } from '$lib/components/icons/paths.js';
	import type { EditorState } from '$lib/editor/state.svelte.js';

	let { editor, open, onClose }: { editor: EditorState; open: boolean; onClose: () => void } =
		$props();

	/** Playback speeds, from real time up to fast enough to scan a whole job. */
	const SPEEDS = [1, 5, 20, 100] as const;
	/**
	 * Longest wall-clock step credited to one frame, in seconds. Browsers stop
	 * serving animation frames to a hidden tab, so without this the first frame
	 * after coming back would advance the job by however long the operator was
	 * away and the tool would appear to teleport.
	 */
	const MAX_FRAME_STEP = 0.1;

	let dialog = $state<HTMLDialogElement>();
	let speed = $state<number>(20);
	let playing = $state(false);
	let time = $state(0);
	/** Set when a pass finishes and the operator has to change tools. */
	let awaitingToolChange = $state(false);
	let activeIndex = $state(0);

	const design = $derived(editor.design);
	/** Programs are emitted per sheet, so playback runs on that sheet's machine. */
	const view = $derived(editor.view);
	const phases = $derived(simulationPhases(editor.geometry.paths, view));
	const phase = $derived<SimulationPhase | undefined>(phases[activeIndex] ?? phases[0]);

	/**
	 * The simulation reads the emitted program rather than the planned
	 * toolpaths, so what is drawn is what the machine would be sent.
	 */
	const moves = $derived<readonly SimulationMove[]>(
		phase ? simulationMoves(generateGcode(editor.geometry.paths, view, phase.operation), view) : []
	);
	const total = $derived(simulationDuration(moves));
	const frame = $derived(simulationFrame(moves, time));

	const units = $derived(design.stock.units);
	const places = $derived(units === 'in' ? 3 : 2);
	const fixed = (mm: number) => display(mm, units).toFixed(places);

	/**
	 * Draw order for the faint underlay: travel first so that cutting and
	 * scoring read on top of it. A dwell has no extent, so it is not drawn.
	 */
	const LAYER_TYPES: readonly MoveType[] = ['travel', 'score-up', 'score-down', 'cut'];

	const segment = (move: { a: SimulationPoint; b: SimulationPoint }) =>
		`M${move.a.x} ${SHEET - move.a.y}L${move.b.x} ${SHEET - move.b.y}`;

	/**
	 * The whole programmed path, drawn faintly underneath the trail. One path
	 * per move type, so a program with thousands of moves is a handful of DOM
	 * nodes rather than thousands.
	 */
	const layers = $derived(
		LAYER_TYPES.map((type) => ({
			type,
			d: moves
				.filter((move) => move.type === type)
				.map(segment)
				.join('')
		})).filter((layer) => layer.d.length > 0)
	);

	/** What the tool has cut so far, rebuilt each frame as one path. */
	const trail = $derived((frame?.trail ?? []).map(segment).join(''));

	/** The sheet being simulated. Programs are emitted per sheet, like export. */
	const sheetName = $derived(
		design.sheets.find((sheet) => sheet.id === design.activeSheetId)?.name ?? 'sheet'
	);

	/**
	 * One line tying the animation back to the program: where in the job, which
	 * line of G-code, what the tool is doing, and where it is.
	 */
	const readoutText = $derived.by(() => {
		if (!frame || !phase) return 'No tool motion on this sheet.';
		const step = String(phase.index).padStart(2, '0');
		return [
			`${step} ${phase.label}`,
			`${time.toFixed(1)} / ${total.toFixed(1)} s`,
			`line ${frame.move.line}`,
			moveLabel(frame.move.type),
			`X ${fixed(frame.position.x)} Y ${fixed(frame.position.y)} Z ${fixed(frame.position.z)} ${units}`
		].join(' · ');
	});

	const finished = $derived(total > 0 && time >= total);
	const hasNextPhase = $derived(activeIndex < phases.length - 1);
	const playLabel = $derived(playing ? 'Pause' : finished ? 'Replay' : 'Play');
	const playIcon = $derived<IconName>(playing ? 'pause' : finished ? 'replay' : 'play_arrow');

	function selectPhase(index: number): void {
		playing = false;
		awaitingToolChange = false;
		activeIndex = index;
		time = 0;
	}

	function togglePlay(): void {
		if (awaitingToolChange) return;
		if (finished) time = 0;
		playing = !playing;
	}

	function restart(): void {
		awaitingToolChange = false;
		time = 0;
	}

	function scrub(value: number): void {
		playing = false;
		awaitingToolChange = false;
		time = total * value;
	}

	// The dialog is a modal, so `open` drives it imperatively rather than through
	// an attribute: only showModal() gives the backdrop and focus trap.
	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			activeIndex = 0;
			time = 0;
			playing = false;
			awaitingToolChange = false;
			dialog.showModal();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});

	/**
	 * Playback advances by wall-clock time multiplied by the speed, so the
	 * result is the same whatever frame rate the browser manages. Position is a
	 * pure function of `time`; this effect only moves the clock.
	 */
	$effect(() => {
		if (!playing || !open || total <= 0) return;
		let last = performance.now();
		let handle = requestAnimationFrame(step);

		function step(now: number): void {
			const elapsed = Math.min((now - last) / 1000, MAX_FRAME_STEP);
			const next = Math.min(total, time + elapsed * speed);
			last = now;
			time = next;
			if (next >= total) {
				playing = false;
				// Stop at the tool change rather than running on into a pass that
				// needs a different tool fitted.
				if (hasNextPhase) awaitingToolChange = true;
				return;
			}
			handle = requestAnimationFrame(step);
		}

		return () => cancelAnimationFrame(handle);
	});
</script>

<dialog bind:this={dialog} class="simulation" aria-labelledby="sim-title" onclose={onClose}>
	<header class="sim-head">
		<h2 id="sim-title">
			CNC toolpath simulation <span class="sim-sheet-name">{sheetName}</span>
		</h2>
		<button class="button" onclick={onClose}>
			<Icon name="close" size={16} />
			Close
		</button>
	</header>

	<div class="sim-phases" role="group" aria-label="Manufacturing operations">
		{#each phases as item, index (item.operation)}
			<button
				type="button"
				class="sim-phase"
				class:active={index === activeIndex}
				aria-current={index === activeIndex ? 'step' : 'false'}
				onclick={() => selectPhase(index)}
			>
				<span class="sim-phase-index">{String(item.index).padStart(2, '0')}</span>
				<strong>{item.label}</strong>
				<span class="sim-phase-tool">{item.tool}</span>
			</button>
		{/each}
	</div>

	{#if awaitingToolChange}
		<p class="sim-checkpoint">
			<Icon name="build" size={18} />
			<span>{toolChangeNote(view)}</span>
			<button class="button primary" onclick={() => selectPhase(activeIndex + 1)}>
				Continue to {phases[activeIndex + 1]?.label}
			</button>
		</p>
	{/if}

	<svg
		class="sim-canvas"
		viewBox="-15 -15 {SHEET + 30} {SHEET + 30}"
		role="img"
		aria-label="Compensated cutting head path"
	>
		<rect x="0" y="0" width={SHEET} height={SHEET} class="sim-sheet" />
		{#each layers as layer (layer.type)}
			<path d={layer.d} class="sim-layer {layer.type}" />
		{/each}
		<path d={trail} class="sim-trail" />
		{#if frame}
			<circle
				class="sim-head {frame.move.type}"
				cx={frame.position.x}
				cy={SHEET - frame.position.y}
				r="7"
			/>
		{/if}
	</svg>

	<div class="sim-controls">
		<button class="button primary" onclick={togglePlay} disabled={awaitingToolChange || !total}>
			<Icon name={playIcon} size={16} />
			{playLabel}
		</button>
		<button class="button" onclick={restart} disabled={!total}>
			<Icon name="restart_alt" size={16} />
			Restart
		</button>
		<label class="sim-speed">
			Speed
			<select value={speed} onchange={(event) => (speed = Number(event.currentTarget.value))}>
				{#each SPEEDS as option (option)}
					<option value={option}>{option}&times;</option>
				{/each}
			</select>
		</label>
		<input
			class="sim-scrub"
			type="range"
			min="0"
			max="1"
			step="0.001"
			aria-label="Toolpath progress"
			value={total ? time / total : 0}
			disabled={!total}
			oninput={(event) => scrub(Number(event.currentTarget.value))}
		/>
	</div>

	<output class="sim-readout">{readoutText}</output>

	<p class="sim-legend">
		<span class="key cut">Cut</span>
		<span class="key score-down">Down fold</span>
		<span class="key score-up">Up fold</span>
		<span class="key travel">Raised travel</span>
	</p>
	<p class="sim-disclaimer">
		A motion preview of the emitted program. It is not a collision, hold-down, or machine-limit
		check.
	</p>
</dialog>

<style>
	.simulation {
		width: min(92vw, 760px);
		max-height: 92vh;
		overflow: auto;
		padding: 18px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--surface);
		color: inherit;
	}

	.simulation::backdrop {
		background: rgb(16 22 28 / 0.55);
	}

	.sim-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
	}

	.sim-head h2 {
		margin: 0;
		font-size: 1rem;
	}

	/* Labelled buttons in the dialog put the glyph before the word. */
	.sim-head .button,
	.sim-controls .button {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.sim-sheet-name {
		margin-left: 6px;
		font-weight: 400;
		opacity: 0.7;
	}

	.sim-phases {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 12px;
	}

	.sim-phase {
		display: grid;
		flex: 1 1 180px;
		gap: 2px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: 8px;
		background: var(--surface);
		text-align: left;
		cursor: pointer;
		font: inherit;
		color: inherit;
	}

	.sim-phase.active {
		border-color: var(--accent, #2474a6);
		background: color-mix(in srgb, var(--accent, #2474a6) 10%, transparent);
	}

	.sim-phase-index {
		font-size: 0.7rem;
		letter-spacing: 0.08em;
		opacity: 0.6;
	}

	.sim-phase-tool {
		font-size: 0.78rem;
		opacity: 0.75;
	}

	.sim-checkpoint {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin: 0 0 12px;
		padding: 10px 12px;
		border-radius: 8px;
		background: color-mix(in srgb, #d9a43a 18%, transparent);
		font-size: 0.85rem;
	}

	/* Capped so the controls and the readout stay visible without scrolling:
	   the numbers are the point of the simulation, not decoration. */
	.sim-canvas {
		display: block;
		width: 100%;
		height: auto;
		max-height: 52vh;
		border-radius: 8px;
		background: var(--canvas, #fafaf7);
	}

	.sim-sheet {
		fill: #fafaf7;
		stroke: #cdd5dc;
		stroke-width: 1;
	}

	/* The full programmed path, laid down faintly under the live trail. */
	.sim-layer {
		fill: none;
		stroke-width: 1.2;
		opacity: 0.45;
	}

	.sim-layer.cut {
		stroke: #d44a36;
	}
	.sim-layer.score-down {
		stroke: #2474a6;
	}
	.sim-layer.score-up {
		stroke: #84527d;
	}
	.sim-layer.travel {
		stroke: #adb5bd;
		stroke-dasharray: 4 4;
	}

	.sim-trail {
		fill: none;
		stroke: #263d4c;
		stroke-width: 2.4;
		stroke-linecap: round;
	}

	.sim-head.cut {
		fill: #d44a36;
	}
	.sim-head.score-down {
		fill: #2474a6;
	}
	.sim-head.score-up {
		fill: #84527d;
	}
	.sim-head.travel,
	.sim-head.dwell {
		fill: #69737d;
	}

	circle.sim-head {
		stroke: #fff;
		stroke-width: 2;
	}

	.sim-controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 10px;
		margin-top: 12px;
	}

	.sim-speed {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.85rem;
	}

	.sim-scrub {
		flex: 1 1 160px;
		min-width: 120px;
	}

	.sim-readout {
		display: block;
		margin-top: 10px;
		font-family: var(--mono, ui-monospace, monospace);
		font-size: 0.78rem;
	}

	.sim-legend {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		margin: 10px 0 4px;
		font-size: 0.78rem;
	}

	.sim-legend .key::before {
		content: '';
		display: inline-block;
		width: 14px;
		height: 3px;
		margin-right: 5px;
		vertical-align: middle;
		background: currentColor;
	}

	.sim-legend .cut {
		color: #d44a36;
	}
	.sim-legend .score-down {
		color: #2474a6;
	}
	.sim-legend .score-up {
		color: #84527d;
	}
	.sim-legend .travel {
		color: #8d959d;
	}

	.sim-disclaimer {
		margin: 0;
		font-size: 0.75rem;
		opacity: 0.7;
	}

	@media (max-width: 640px) {
		.simulation {
			width: 96vw;
			padding: 12px;
		}
	}
</style>
