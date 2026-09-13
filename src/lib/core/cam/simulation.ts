import { clamp, display } from '$lib/core/units.js';
import type { DesignPath, MachineSettings, SheetView } from '$lib/core/design/types.js';
import { pathOperation, programOperations } from './gcode.js';

export type SimulationSettings = Pick<MachineSettings, 'safeZ' | 'cutFeed'>;

export type SimulationPoint = { readonly x: number; readonly y: number; readonly z: number };

export type MoveType = 'travel' | 'dwell' | 'cut' | 'score-up' | 'score-down';

export type SimulationMove = {
	readonly a: SimulationPoint;
	readonly b: SimulationPoint;
	readonly type: MoveType;
	/** 1-indexed line in the source program. */
	readonly line: number;
	readonly start: number;
	readonly end: number;
};

/** Rapid rate assumed for G0 moves, in mm/min. */
const RAPID_FEED = 3000;

/**
 * Parses an emitted program back into timed moves. This reads the generated
 * G-code rather than the planned toolpaths on purpose: it is the closest
 * available check that what we emit is what we meant to emit. It is a
 * verification aid, not a proof that the program is safe to run.
 */
export function simulationMoves(
	program: string,
	settings: SimulationSettings
): readonly SimulationMove[] {
	let position: SimulationPoint = { x: 0, y: 0, z: settings.safeZ };
	let feed = settings.cutFeed;
	let type: MoveType = 'travel';
	let elapsed = 0;
	const moves: SimulationMove[] = [];

	program.split('\n').forEach((raw, index) => {
		const fold = raw.match(/^; \d+: score \[(up|down)\]/);
		if (fold) type = `score-${fold[1] as 'up' | 'down'}`;
		else if (/^; \d+: score/.test(raw)) type = 'score-down';
		if (/^; \d+: cut/.test(raw)) type = 'cut';

		const code = raw.split(';')[0]!.trim();
		const words: Record<string, number> = Object.fromEntries(
			[...code.matchAll(/([A-Z])(-?\d+(?:\.\d+)?)/g)].map((match) => [match[1]!, Number(match[2])])
		);

		if (words.G === 4) {
			const seconds = words.P ?? 0;
			moves.push({
				a: { ...position },
				b: { ...position },
				type: 'dwell',
				line: index + 1,
				start: elapsed,
				end: elapsed + seconds
			});
			elapsed += seconds;
			return;
		}
		if (words.G !== 0 && words.G !== 1) return;
		if (words.F !== undefined) feed = words.F;

		const next: SimulationPoint = {
			x: words.X ?? position.x,
			y: words.Y ?? position.y,
			z: words.Z ?? position.z
		};
		const distance = Math.hypot(next.x - position.x, next.y - position.y, next.z - position.z);
		if (!distance) return;
		const seconds = (distance / (words.G === 0 ? RAPID_FEED : feed)) * 60;
		moves.push({
			a: position,
			b: next,
			type: words.G === 0 ? 'travel' : type,
			line: index + 1,
			start: elapsed,
			end: elapsed + seconds
		});
		elapsed += seconds;
		position = next;
	});
	return moves;
}

/** Total run time of a program, in seconds. */
export function simulationDuration(moves: readonly SimulationMove[]): number {
	return moves.at(-1)?.end ?? 0;
}

/** A cutting or scoring segment already travelled, for drawing the trail. */
export type TrailSegment = {
	readonly a: SimulationPoint;
	readonly b: SimulationPoint;
	readonly type: MoveType;
};

export type SimulationFrame = {
	/** Interpolated tool position at this instant. */
	readonly position: SimulationPoint;
	readonly move: SimulationMove;
	/**
	 * Everything cut or scored so far, with the move in progress truncated to
	 * the current position. Travel and dwell are excluded: they leave no mark.
	 */
	readonly trail: readonly TrailSegment[];
};

/**
 * Where the tool is at `seconds`, and what it has cut up to that point.
 *
 * Pure, so playback is a function of elapsed time rather than of how many
 * animation frames happened to fire. A renderer can scrub, replay, or run at
 * any speed multiplier without the result drifting.
 */
export function simulationFrame(
	moves: readonly SimulationMove[],
	seconds: number
): SimulationFrame | null {
	if (!moves.length) return null;
	const time = Math.max(0, seconds);
	const move = moves.find((candidate) => candidate.end > time) ?? moves[moves.length - 1]!;
	const span = move.end - move.start;
	// A dwell has no length, so its progress is meaningless: hold the position.
	const progress = span > 0 ? clamp((time - move.start) / span, 0, 1) : 1;
	const position: SimulationPoint = {
		x: move.a.x + (move.b.x - move.a.x) * progress,
		y: move.a.y + (move.b.y - move.a.y) * progress,
		z: move.a.z + (move.b.z - move.a.z) * progress
	};

	const trail: TrailSegment[] = [];
	for (const candidate of moves) {
		if (candidate.start > time) break;
		if (candidate.type === 'travel' || candidate.type === 'dwell') continue;
		const b = candidate.end <= time ? candidate.b : position;
		// A move that has not travelled yet has left no mark, so it is omitted
		// rather than emitted as a degenerate segment for a renderer to handle.
		if (b.x === candidate.a.x && b.y === candidate.a.y && b.z === candidate.a.z) continue;
		trail.push({ a: candidate.a, b, type: candidate.type });
	}
	return { position, move, trail };
}

/** Human-readable name for a move, for the operator-facing readout. */
export function moveLabel(type: MoveType): string {
	if (type === 'score-up') return 'up fold';
	if (type === 'score-down') return 'down fold';
	return type;
}

export type PhaseSettings = Pick<SheetView, 'scoreTool' | 'fabricationMode' | 'bitWidth' | 'units'>;

/**
 * One pass of the job: a program run with a single tool. Crease work is a
 * separate program precisely because it needs a different tool, so the phases
 * are also the tool-change plan.
 */
export type SimulationPhase = {
	readonly operation: 'crease' | 'cut';
	/** 1-based position in the running order, as the operator sees it. */
	readonly index: number;
	readonly label: string;
	readonly tool: string;
};

/** The tool a given operation runs with, named as the operator would name it. */
export function phaseTool(operation: 'crease' | 'cut', settings: PhaseSettings): string {
	if (operation === 'crease') {
		return settings.scoreTool === 'crease' ? 'Creasing wheel' : 'Drag knife';
	}
	return settings.fabricationMode === 'router'
		? `${display(settings.bitWidth, settings.units)} ${settings.units} bit`
		: 'Drag knife';
}

/**
 * The phases a design actually needs, in running order.
 *
 * A design with no up-folds has nothing to crease, so it runs as a single
 * pass and the cut phase is numbered 01. The cut pass is named "Score + cut"
 * when it also carries down-folds, because that is what the operator will see
 * the machine do.
 */
export function simulationPhases(
	paths: readonly DesignPath[],
	settings: PhaseSettings
): readonly SimulationPhase[] {
	const hasCrease = programOperations(paths).includes('crease');
	const hasDownScore = paths.some((path) => path.type === 'score' && pathOperation(path) === 'cut');
	const phases: SimulationPhase[] = [];
	if (hasCrease) {
		phases.push({
			operation: 'crease',
			index: 1,
			label: 'Crease',
			tool: phaseTool('crease', settings)
		});
	}
	phases.push({
		operation: 'cut',
		index: hasCrease ? 2 : 1,
		label: hasDownScore ? 'Score + cut' : 'Cut',
		tool: phaseTool('cut', settings)
	});
	return phases;
}

/**
 * What the operator must do between the crease pass and the cut pass. The
 * machine cannot do this itself, so the simulation stops and says so rather
 * than running straight through a tool change that has not happened.
 */
export function toolChangeNote(settings: Pick<MachineSettings, 'scoreTool'>): string {
	return settings.scoreTool === 'crease'
		? 'Up-fold creasing complete. Install the drag knife before running the score-and-cut program.'
		: 'Up-fold operation complete. Confirm the drag knife and cutting depth before continuing.';
}
