<script lang="ts">
	import { programSpindle, programTool } from '$lib/core/cam/gcode.js';
	import { needsZero, type JobProgram } from '$lib/core/grbl/job.js';
	import { PROBE_Z_SEARCH } from '$lib/core/grbl/probing.js';
	import type { Override } from '$lib/core/grbl/protocol.js';
	import { display } from '$lib/core/units.js';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import type { MachineLink } from '$lib/editor/machine-link.svelte.js';
	import { sheetPrograms } from '$lib/editor/programs.js';
	import CollapsiblePanel from './CollapsiblePanel.svelte';

	let { editor, link }: { editor: EditorState; link: MachineLink } = $props();

	const units = $derived(editor.design.stock.units);
	const sheet = $derived(
		editor.design.sheets.find((candidate) => candidate.id === editor.design.activeSheetId)
	);
	const snapshot = $derived(link.snapshot);
	const job = $derived(link.job);
	const program = $derived(job?.programs[job.index] ?? null);
	const idle = $derived(snapshot?.status?.state === 'Idle' && !snapshot.busy);
	const blocked = $derived(editor.diagnostics.length > 0);
	const zeroNeeded = $derived(job !== null && needsZero(job.programs, job.index));
	/** The operator's word that Z0 already holds for this tool, asked afresh for each program. */
	let zeroKept = $state(false);
	const canStart = $derived(
		idle && snapshot?.originConfirmed === true && (!zeroNeeded || job?.zeroSet === true || zeroKept)
	);
	const searchDepth = $derived(`${display(PROBE_Z_SEARCH, units)} ${units}`);
	/**
	 * What running this sheet would look like, before a machine is connected:
	 * its programs and tools, or the cut program's alone while the design does
	 * not validate, since its programs cannot be generated then.
	 */
	const preview = $derived.by((): JobProgram[] => {
		if (snapshot) return [];
		const cut = (): JobProgram[] => [
			{
				operation: 'cut',
				tool: programTool(editor.view, 'cut'),
				spindle: programSpindle(editor.view, 'cut'),
				lines: []
			}
		];
		if (blocked) return cut();
		try {
			return sheetPrograms(editor).map(({ operation, tool, spindle }) => ({
				operation,
				tool,
				spindle,
				lines: []
			}));
		} catch {
			return cut();
		}
	});
	const percent = (value: number | undefined) => (value === undefined ? '…' : `${value}%`);

	function prepare(): void {
		if (blocked || !sheet) return;
		zeroKept = false;
		link.prepareJob(sheet.name, sheetPrograms(editor), editor.surfaceMap);
	}

	async function start(): Promise<void> {
		if (!program) return;
		if (
			program.spindle &&
			!confirm(
				`Start the ${program.operation} program? The spindle starts at ${editor.view.spindleSpeed} rpm. Clear the machine and keep hands away.`
			)
		) {
			return;
		}
		const kept = zeroKept;
		zeroKept = false;
		await link.startProgram(kept);
	}

	const OVERRIDES: readonly { which: Override; label: string }[] = [
		{ which: 'feed', label: 'Feed' },
		{ which: 'spindle', label: 'Spindle' }
	];
</script>

{#snippet programList(programs: readonly JobProgram[], current: number, done: boolean)}
	<ol class="run-programs" aria-label="Programs">
		{#each programs as each, index (index)}
			<li class:current={index === current && !done} class:finished={index < current || done}>
				<span class="run-step">{index + 1}</span>
				{each.operation} · {each.tool}{each.spindle ? ' · spindle on' : ''}
			</li>
		{/each}
	</ol>
{/snippet}

<!-- `live` is false for the preview shown before a machine is connected: every control off. -->
{#snippet setupStep(program: JobProgram, first: boolean, needed: boolean, live: boolean)}
	{@const touching = live && snapshot?.status?.probeTouching === true}
	{@const mapOn = live && job ? job.map.enabled : editor.surfaceMap.enabled}
	<div class="run-setup" role="group" aria-label="Set up the tool">
		<p class="run-instruction">
			{#if needed}
				{first ? 'Load' : 'Change to'} the <strong>{program.tool}</strong>, then set Z0 on top of
				the work.
			{:else}
				Same tool as the last program, so Z0 holds; set it again if you changed anything.
			{/if}
		</p>
		<div class="profile-actions">
			<button
				class="button"
				type="button"
				disabled={!live || !idle}
				title="Make Z0 where the tool's tip just touches the work, as when a slip of paper just drags"
				onclick={() => link.setJobZero('touch')}>Touch off here</button
			>
			<button
				class="button"
				type="button"
				disabled={!live || !idle}
				title={`Probe the touch plate on the work under the tool, no more than ${searchDepth} below it, and make Z0 the work's top`}
				onclick={() => link.setJobZero('plate')}>Probe Z0</button
			>
			<span class="run-probe" class:on={touching}>Probe {touching ? 'touching' : 'open'}</span>
		</div>
		<p class="help">
			Touch off with the tip just touching the work. To probe, lay the plate on the work, jog the
			tool to within {searchDepth} above it, and touch the clip to the plate: the probe should read touching.
			Jog with the Machine panel.{mapOn
				? ' Z0 is worked out from the surface map wherever you set it.'
				: ''}
		</p>
		{#if live && job?.zeroSet}
			<p class="run-zeroed">Z0 is set for this tool.</p>
		{:else if needed}
			<label class="check run-kept">
				<input type="checkbox" disabled={!live} bind:checked={zeroKept} />
				Z0 is already set on the work for this tool
			</label>
		{/if}
		<div class="profile-actions">
			<button class="button primary" type="button" disabled={!live || !canStart} onclick={start}>
				Start {program.operation}{program.spindle ? ' (spindle on)' : ''}
			</button>
			<button class="button" type="button" disabled={!live} onclick={() => link.closeJob()}
				>Cancel</button
			>
		</div>
		{#if live && !snapshot?.originConfirmed}
			<p class="help">Confirm the origin in the Machine panel to start.</p>
		{/if}
	</div>
{/snippet}

{#snippet runControls(program: JobProgram, answered: number, paused: boolean, live: boolean)}
	<p class="run-progress-label">
		{paused ? 'Paused' : 'Running'}
		{program.operation}{live ? `: line ${answered} of ${program.lines.length}` : ''}
	</p>
	<progress class="run-progress" max={Math.max(program.lines.length, 1)} value={answered}
	></progress>
	<div class="profile-actions">
		{#if paused}
			<button class="button primary" type="button" disabled={!live} onclick={() => link.resumeJob()}
				>Resume</button
			>
		{:else}
			<button
				class="button"
				type="button"
				disabled={!live}
				title="Hold motion where it is; the spindle keeps turning"
				onclick={() => link.pauseJob()}>Pause</button
			>
		{/if}
	</div>
	{#each OVERRIDES as override (override.which)}
		{#if override.which === 'feed' || program.spindle}
			<div class="run-override" role="group" aria-label={`${override.label} override`}>
				<span
					>{override.label}
					{live ? percent(snapshot?.overrides?.[override.which]) : '100%'}</span
				>
				<button
					class="button"
					type="button"
					disabled={!live}
					aria-label={`${override.label} down 10%`}
					title={`${override.label} down 10%`}
					onclick={() => link.override(override.which, 'down')}>−</button
				>
				<button
					class="button"
					type="button"
					disabled={!live}
					aria-label={`${override.label} up 10%`}
					title={`${override.label} up 10%`}
					onclick={() => link.override(override.which, 'up')}>+</button
				>
				<button
					class="button"
					type="button"
					disabled={!live}
					aria-label={`${override.label} back to 100%`}
					title={`${override.label} back to 100%`}
					onclick={() => link.override(override.which, 'reset')}>100%</button
				>
			</div>
		{/if}
	{/each}
	<p class="help">
		Keep this tab open and the computer awake until the job ends. Stop, at the bottom of the screen,
		halts the machine and the spindle and ends the job.
	</p>
{/snippet}

<CollapsiblePanel title="Run">
	{#if !snapshot}
		<p class="help run-offline">
			Connect the machine in the Machine panel to run this sheet's programs from here, with a stop
			to change tools between them. Until then, its controls are shown switched off.
		</p>
		<p class="run-sheet">Sheet <strong>{sheet?.name ?? ''}</strong></p>
		{@render programList(preview, 0, false)}
		<button class="button primary" type="button" disabled>Prepare to run</button>
		{#if preview[0]}
			<p class="field-label">Before each program</p>
			{@render setupStep(preview[0], true, true, false)}
			<p class="field-label">While a program runs</p>
			{@render runControls(preview[0], 0, false, false)}
		{/if}
	{:else if !job}
		<p class="run-sheet">Sheet <strong>{sheet?.name ?? ''}</strong></p>
		<button
			class="button primary"
			type="button"
			disabled={blocked || !idle || !snapshot.originConfirmed}
			onclick={prepare}>Prepare to run</button
		>
		<p class="help">
			{#if blocked}
				Resolve validation issues first; the same checks gate export.
			{:else if !snapshot.originConfirmed}
				Set and confirm the origin in the Machine panel first.
			{:else}
				Runs the programs G-code export writes for this sheet, following the surface map if it is
				on. Each program stops first for you to load its tool and set Z0.
			{/if}
		</p>
	{:else}
		{@render programList(job.programs, job.index, job.phase === 'done')}
		{#if job.phase === 'setup' && program}
			{@render setupStep(program, job.index === 0, zeroNeeded, true)}
		{:else if job.phase === 'running' && program}
			{@render runControls(program, job.answered, job.paused, true)}
		{:else if job.phase === 'done'}
			<p class="run-zeroed" role="status">Job finished: {job.sheet}.</p>
			<button class="button" type="button" onclick={() => link.closeJob()}>Close</button>
		{:else if job.phase === 'failed'}
			<p class="help run-failed" role="alert">{job.message}</p>
			<p class="help">
				A job is not picked up partway. Check the work, then prepare it again to start over.
			</p>
			<button class="button" type="button" onclick={() => link.closeJob()}>Close</button>
		{/if}
	{/if}
</CollapsiblePanel>

<style>
	.run-offline {
		margin-bottom: 10px;
	}

	.run-sheet,
	.run-instruction,
	.run-progress-label {
		margin: 0 0 10px;
		font-size: 12px;
	}

	.run-programs {
		display: grid;
		gap: 4px;
		margin: 0 0 12px;
		padding: 0;
		list-style: none;
		font-size: 12px;
		color: var(--ink-soft);
	}

	.run-programs li {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.run-programs li.current {
		font-weight: 600;
		color: var(--ink);
	}

	.run-programs li.finished {
		text-decoration: line-through;
	}

	.run-step {
		display: inline-grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border: 1px solid currentColor;
		border-radius: 50%;
		font-size: 10px;
	}

	.run-setup {
		display: grid;
		gap: 10px;
	}

	.run-setup .help,
	.run-setup .run-instruction {
		margin: 0;
	}

	.run-probe {
		align-self: center;
		font: 11px var(--mono);
		color: var(--ink-soft);
	}

	.run-probe.on {
		color: var(--accent);
		font-weight: 600;
	}

	.run-zeroed {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--accent);
	}

	.run-kept {
		justify-content: flex-start;
		padding: 6px 9px;
		text-align: left;
		text-transform: none;
	}

	.run-progress {
		width: 100%;
		margin-bottom: 10px;
	}

	.run-override {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 40px 40px 56px;
		gap: 4px;
		align-items: center;
		margin-top: 8px;
		font: 12px var(--mono);
	}

	.run-override .button {
		padding: 5px 0;
	}

	.run-failed {
		margin-bottom: 8px;
		background: var(--error-bg);
		color: var(--error-ink);
	}
</style>
