import { describe, expect, it } from 'vitest';
import { DEFAULT_MACHINE_PROFILE_ID } from '$lib/core/design/defaults.js';
import { supportDefaults } from '$lib/features/packaging/defaults.js';
import { createDefaultDesign } from '$lib/features/document.js';
import type { DesignPath, DesignState } from '$lib/core/design/types.js';
import type { Support } from '$lib/features/packaging/types.js';
import { point } from '$lib/core/geometry/primitives.js';
import { packagingGcode } from '$lib/features/packaging/gcode.js';
import {
	moveLabel,
	phaseTool,
	simulationDuration,
	simulationFrame,
	simulationMoves,
	simulationPhases,
	toolChangeNote,
	type SimulationMove
} from '$lib/core/cam/simulation.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { view, withMachine, patchDesign, type DesignPatch } from '../../support/designs.js';
import { intent } from '../../support/paths.js';

const design = (overrides: DesignPatch = {}): DesignState =>
	patchDesign(createDefaultDesign(), overrides);

const score = (direction: 'up' | 'down'): DesignPath => ({
	points: [point(10, 10), point(60, 10)],
	type: 'score',
	closed: false,
	foldDirection: direction,
	role: 'test-fold',
	cam: intent('score')
});

const cut: DesignPath = {
	points: [point(10, 20), point(60, 20)],
	type: 'cut',
	closed: false,
	role: 'exterior',
	cam: intent('cut', { stage: 'sheet-release' })
};

/**
 * Parses a program the way the generator emits one: every path is introduced
 * by an operation comment, which is what tells the parser whether the moves
 * that follow are cutting, scoring, or travel.
 */
const movesFor = (program: string) => simulationMoves(program, { safeZ: 5, cutFeed: 600 });

/** A cutting leg, prefixed the way `generateGcode` prefixes one. */
const cutting = (body: string) => `; 1: cut exterior\n${body}`;

/**
 * A design whose net carries up-folds, so it is a two-pass job. A tray's walls
 * fold up out of the sheet, and its net is cut from a parts sheet.
 */
const trayDesign = (): DesignState =>
	patchDesign(createDefaultDesign(), {
		sheets: [
			{
				id: 'deck',
				name: 'Deck',
				workspace: 'packaging',
				machineProfileId: DEFAULT_MACHINE_PROFILE_ID
			},
			{
				id: 'parts',
				name: 'Parts 1',
				workspace: 'packaging',
				machineProfileId: DEFAULT_MACHINE_PROFILE_ID
			}
		],
		activeSheetId: 'parts',
		supports: [
			{
				...supportDefaults(),
				kind: 'tray',
				id: 'tray',
				name: 'Tablet tray',
				w: 120,
				d: 80,
				h: 25,
				heightMode: 'fixed',
				overlap: 6,
				taper: 8,
				flange: 12,
				openSide: 'none',
				sheetId: 'parts',
				flatX: 100,
				flatY: 100,
				assemblyX: 40,
				assemblyY: 50,
				mount: { anchor: 'deck-underside', offset: 0 },
				netVersion: 3
			} satisfies Support
		]
	});

describe('playback timing', () => {
	// 60mm at 600mm/min is 6 seconds; 60mm at G0 rapid (3000mm/min) is 1.2.
	const moves = movesFor(cutting('G1 X60 F600\nG0 X0'));

	it('totals the program run time', () => {
		expect(simulationDuration(moves)).toBeCloseTo(7.2, 6);
		expect(simulationDuration([])).toBe(0);
	});

	it('interpolates the tool position within the move in progress', () => {
		const frame = simulationFrame(moves, 3);
		expect(frame?.position.x).toBeCloseTo(30, 6);
		expect(frame?.move.type).toBe('cut');
	});

	it('starts at the beginning of the first move', () => {
		expect(simulationFrame(moves, 0)?.position).toEqual({ x: 0, y: 0, z: 5 });
	});

	it('holds the end of the program rather than running past it', () => {
		const frame = simulationFrame(moves, 999);
		expect(frame?.position.x).toBeCloseTo(0, 6);
		expect(frame?.move).toBe(moves.at(-1));
	});

	it('treats a negative time as the start', () => {
		expect(simulationFrame(moves, -5)?.position.x).toBe(0);
	});

	it('has nothing to show for a program with no motion', () => {
		expect(simulationFrame([], 1)).toBeNull();
	});

	it('is a pure function of elapsed time, not of frame count', () => {
		// Scrubbing straight to a time must match stepping up to it.
		const direct = simulationFrame(moves, 4.5);
		const stepped = [1, 2, 3, 4, 4.5].map((t) => simulationFrame(moves, t)).at(-1);
		expect(stepped?.position).toEqual(direct?.position);
	});

	it('holds position through a dwell, which has no length', () => {
		const dwelling = movesFor(cutting('G1 X10 F600\nG4 P2'));
		const frame = simulationFrame(dwelling, 1.5);
		expect(frame?.move.type).toBe('dwell');
		expect(frame?.position.x).toBeCloseTo(10, 6);
	});
});

describe('the cut trail', () => {
	const moves = movesFor(cutting('G1 X60 F600\nG0 X0\nG1 X60 F600'));

	it('is empty before anything has been cut', () => {
		expect(simulationFrame(moves, 0)?.trail).toEqual([]);
	});

	it('truncates the move in progress at the tool', () => {
		const trail = simulationFrame(moves, 3)?.trail ?? [];
		expect(trail).toHaveLength(1);
		expect(trail[0]?.b.x).toBeCloseTo(30, 6);
	});

	it('keeps completed segments whole', () => {
		const trail = simulationFrame(moves, 6)?.trail ?? [];
		expect(trail[0]?.b.x).toBeCloseTo(60, 6);
	});

	it('leaves no mark for travel, which happens above the board', () => {
		// By the end, both cutting legs are drawn but the rapid between is not.
		const trail = simulationFrame(moves, simulationDuration(moves))?.trail ?? [];
		expect(trail).toHaveLength(2);
		expect(trail.every((segment) => segment.type === 'cut')).toBe(true);
	});

	it('carries the move type so folds can be drawn differently from cuts', () => {
		const program = packagingGcode(allGeometry(design()).paths, view(design()), 'all');
		const trail = simulationFrame(
			simulationMoves(program, view(design())),
			simulationDuration(simulationMoves(program, view(design())))
		)?.trail;
		expect(new Set(trail?.map((segment) => segment.type)).has('score-down')).toBe(true);
	});
});

describe('phases', () => {
	it('runs a single cut pass when there is nothing to crease', () => {
		const phases = simulationPhases([cut], view(design()));
		expect(phases).toEqual([{ operation: 'cut', index: 1, label: 'Cut', tool: 'Drag knife' }]);
	});

	it('puts creasing first and numbers the passes in running order', () => {
		const phases = simulationPhases([score('up'), cut], view(design()));
		expect(phases.map((phase) => [phase.index, phase.operation])).toEqual([
			[1, 'crease'],
			[2, 'cut']
		]);
	});

	it('names the cut pass for what the machine will do', () => {
		// Down-folds are scored in the same pass as the cutting.
		expect(simulationPhases([score('down'), cut], view(design()))[0]?.label).toBe('Score + cut');
		expect(simulationPhases([cut], view(design()))[0]?.label).toBe('Cut');
	});

	it('names the tool each pass needs', () => {
		expect(phaseTool('crease', view(withMachine(design(), { scoreTool: 'crease' })))).toBe(
			'Creasing wheel'
		);
		expect(phaseTool('crease', view(withMachine(design(), { scoreTool: 'knife' })))).toBe(
			'Drag knife'
		);
		expect(phaseTool('cut', view(design()))).toBe('Drag knife');
	});

	it('names the router bit by its width, in the display units', () => {
		const router = view(
			withMachine(design({ units: 'mm' }), { fabricationMode: 'router', bitWidth: 3.175 })
		);
		expect(phaseTool('cut', router)).toBe('3.17 mm bit');
		expect(phaseTool('cut', { ...router, units: 'in' })).toBe('0.125 in bit');
	});

	it('tells the operator what to change between passes', () => {
		expect(toolChangeNote({ scoreTool: 'crease' })).toContain('Install the drag knife');
		expect(toolChangeNote({ scoreTool: 'knife' })).toContain('Confirm the drag knife');
	});

	it('derives its phases from the design that will actually be run', () => {
		// The stock design folds everything down, so it needs no creasing pass.
		expect(
			simulationPhases(allGeometry(design()).paths, view(design())).map((p) => p.operation)
		).toEqual(['cut']);
		// A tray's walls fold up, which does need a separate creasing pass.
		const tray = trayDesign();
		expect(simulationPhases(allGeometry(tray).paths, view(tray)).map((p) => p.operation)).toEqual([
			'crease',
			'cut'
		]);
	});
});

describe('move labels', () => {
	it('reads folds the way the inspector names them', () => {
		expect(moveLabel('score-up')).toBe('up fold');
		expect(moveLabel('score-down')).toBe('down fold');
		expect(moveLabel('cut')).toBe('cut');
		expect(moveLabel('travel')).toBe('travel');
	});
});

describe('simulating the emitted program', () => {
	it('walks each phase of a two-pass job to completion', () => {
		const base = trayDesign();
		const paths = allGeometry(base).paths;
		for (const phase of simulationPhases(paths, view(base))) {
			const moves: readonly SimulationMove[] = simulationMoves(
				packagingGcode(paths, view(base), phase.operation),
				view(base)
			);
			expect(moves.length).toBeGreaterThan(0);
			const finish = simulationFrame(moves, simulationDuration(moves));
			// Every program ends parked at the origin at safe Z.
			expect(finish?.position).toEqual({ x: 0, y: 0, z: view(base).safeZ });
			expect(finish?.trail.length).toBeGreaterThan(0);
		}
	});

	it('creases only up-folds and never cuts in the crease program', () => {
		const base = trayDesign();
		const paths = allGeometry(base).paths;
		const moves = simulationMoves(packagingGcode(paths, view(base), 'crease'), view(base));
		const marks = new Set(
			moves.filter((move) => move.type !== 'travel' && move.type !== 'dwell').map((m) => m.type)
		);
		expect(marks).toEqual(new Set(['score-up']));
	});
});
