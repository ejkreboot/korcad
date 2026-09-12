import { describe, expect, it } from 'vitest';
import { point } from '$lib/core/geometry/primitives.js';
import { round } from '$lib/core/units.js';
import { createDefaultDesign } from '$lib/core/design/defaults.js';
import type { DesignPath, DesignState } from '$lib/core/design/types.js';
import { compensatedPoints, toolpathPoints } from '$lib/core/cam/compensation.js';
import { machiningStage, plannedToolpaths } from '$lib/core/cam/routing.js';
import { generateGcode, pathOperation } from '$lib/core/cam/gcode.js';
import { simulationMoves } from '$lib/core/cam/simulation.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { validate } from '$lib/features/packaging/validation.js';
import { view, withMachine } from '../../support/designs.js';
import { intent } from '../../support/paths.js';

const line = (
	a: ReturnType<typeof point>,
	b: ReturnType<typeof point>,
	type: DesignPath['type'],
	meta: Partial<DesignPath> = {}
): DesignPath => ({
	points: [a, b],
	type,
	closed: false,
	cam: intent(type),
	...meta
});

const gcodeFor = (design: DesignState, operation: 'all' | 'cut' | 'crease' = 'all') =>
	generateGcode(allGeometry(design).paths, view(design), operation);

describe('knife program', () => {
	const design = createDefaultDesign();

	it('is valid, keeps the spindle off, scores before cutting, and returns home', () => {
		expect(validate(design)).toEqual([]);
		const program = gcodeFor(design);
		expect(program).not.toContain('M3');
		expect(program).toContain('; SPINDLE MUST REMAIN OFF');

		const moves = simulationMoves(program, view(design));
		expect(moves.every((move) => Number.isFinite(move.end) && move.end > move.start)).toBe(true);
		expect(moves.at(-1)?.b).toEqual({ x: 0, y: 0, z: view(design).safeZ });
		expect(moves.find((move) => move.type !== 'travel')?.type).toBe('score-down');
		expect(moves.some((move) => move.b.z === -view(design).cutDepth)).toBe(true);
	});

	it('reports rapid travel that agrees with the routing plan', () => {
		const program = gcodeFor(design);
		const travelled = simulationMoves(program, view(design))
			.filter((move) => move.type === 'travel')
			.reduce((sum, move) => sum + Math.hypot(move.b.x - move.a.x, move.b.y - move.a.y), 0);
		expect(
			Math.abs(travelled - plannedToolpaths(allGeometry(design).paths, view(design)).travel)
		).toBeLessThan(1e-8);
	});
});

describe('operation split', () => {
	const foldPath = line(point(10, 10), point(30, 10), 'score', { foldDirection: 'up' });
	const downPath = line(point(10, 20), point(30, 20), 'score', { foldDirection: 'down' });
	const cutPath = line(point(40, 10), point(60, 10), 'cut');
	const paths = [foldPath, downPath, cutPath];

	it('routes up folds to the crease program and everything else to the cut program', () => {
		expect(pathOperation(foldPath)).toBe('crease');
		expect(pathOperation(downPath)).toBe('cut');

		const design = createDefaultDesign();
		const crease = generateGcode(paths, view(design), 'crease');
		const cut = generateGcode(paths, view(design), 'cut');
		expect(simulationMoves(crease, view(design)).some((move) => move.type === 'score-up')).toBe(
			true
		);
		expect(crease).not.toContain(': cut');
		expect(crease).not.toContain('[down]');
		expect(cut).toContain('[down]');
		expect(cut).not.toContain('[up]');
		expect(simulationMoves(cut, view(design)).some((move) => move.type === 'score-down')).toBe(
			true
		);
	});

	it('runs a creasing wheel on the nominal line but still offsets the knife', () => {
		const design = withMachine(createDefaultDesign(), { scoreTool: 'crease' });
		expect(toolpathPoints(foldPath, view(design), 'crease')[0]?.x).toBe(10);
		expect(toolpathPoints(downPath, view(design), 'cut')[0]!.x).toBeGreaterThan(10);
	});
});

describe('simulator', () => {
	const design = createDefaultDesign();

	it('respects modal coordinates, modal feed, and explicit dwell', () => {
		expect(simulationMoves('G1 X10 F600\nG1 Y10\nG4 P2', view(design)).at(-1)?.end).toBe(4);
		expect(simulationMoves('G1 Z-3 F60', view(design))[0]?.end).toBe(6);
	});
});

describe('router program', () => {
	const design = withMachine(createDefaultDesign(), { fabricationMode: 'router' });

	it('is valid, dwells for spindle spin-up, and compensates outside the deck', () => {
		expect(validate(design)).toEqual([]);
		const moves = simulationMoves(gcodeFor(design), view(design));
		expect(moves.filter((move) => move.type === 'dwell')[0]?.end).toBe(2);
		expect(moves.some((move) => move.b.x < design.deckX && move.b.x > 0)).toBe(true);
	});
});

describe('validation gates export', () => {
	it.each(['cutFeed', 'scoreFeed', 'plungeFeed', 'cornerStep', 'safeZ'] as const)(
		'blocks a zero %s on the machine profile',
		(field) => {
			const broken = withMachine(createDefaultDesign(), { [field]: 0 });
			expect(validate(broken).length).toBeGreaterThan(0);
		}
	);

	it('blocks a zero material thickness', () => {
		expect(validate({ ...createDefaultDesign(), material: 0 }).length).toBeGreaterThan(0);
	});
});

describe('routing', () => {
	const design = createDefaultDesign();

	it('shortens travel, reverses open paths safely, and never mutates the source', () => {
		const paths = [
			line(point(200, 0), point(210, 0), 'cut'),
			line(point(10, 0), point(20, 0), 'cut'),
			line(point(100, 0), point(110, 0), 'cut')
		];
		const plan = plannedToolpaths(paths, view(design));
		expect(plan.travel).toBeLessThan(plan.baselineTravel);
		expect(plan.paths).toHaveLength(3);
		expect(new Set(plan.paths.flatMap((entry) => entry.sourcePaths)).size).toBe(3);
		expect(
			plan.paths.every(
				(entry) =>
					JSON.stringify(entry.pts) ===
					JSON.stringify(
						compensatedPoints(entry.path, view(design)).map((p) => point(round(p.x), round(p.y)))
					)
			)
		).toBe(true);
		expect(paths[0]!.points).toEqual([point(200, 0), point(210, 0)]);
		expect(plan.paths[0]!.path.points[0]?.x).toBe(10);
	});

	it('merges connected contour fragments and keeps holding bridges local', () => {
		const paths = [
			// One stated chain: the fragments of a single release outline.
			...[
				[point(0, 0), point(10, 0)],
				[point(12, 0), point(20, 0)],
				[point(20, 0), point(20, 10)]
			].map(([a, b]) =>
				line(a!, b!, 'cut', {
					role: 'exterior',
					cam: intent('cut', { stage: 'sheet-release', chainKey: 'outline' })
				})
			)
		];
		const plan = plannedToolpaths(paths, view(design));
		expect(plan.paths).toHaveLength(2);
		expect(plan.baselineLifts - plan.lifts).toBe(1);
		expect(new Set(plan.paths.flatMap((entry) => entry.sourcePaths)).size).toBe(3);
		const gap = Math.hypot(
			plan.paths[1]!.pts[0]!.x - plan.paths[0]!.pts.at(-1)!.x,
			plan.paths[1]!.pts[0]!.y - plan.paths[0]!.pts.at(-1)!.y
		);
		expect(gap).toBe(2);
	});

	it('continues adjacent score edges around a shared corner', () => {
		const paths = [
			line(point(100, 0), point(100, 100), 'score', {
				role: 'perimeter-deck-fold',
				foldDirection: 'down',
				cam: intent('score', { chainKey: 'deck-folds' })
			}),
			line(point(0, 0), point(100, 0), 'score', {
				role: 'perimeter-deck-fold',
				foldDirection: 'down',
				cam: intent('score', { chainKey: 'deck-folds' })
			})
		];
		const plan = plannedToolpaths(paths, view(design));
		expect(plan.paths).toHaveLength(1);
		expect(plan.paths[0]!.sourcePaths).toHaveLength(2);
		expect(plan.paths[0]!.path.points).toHaveLength(3);
	});

	it('may start a closed contour nearer the tool without changing its winding', () => {
		const router = { ...design, fabricationMode: 'router' as const };
		const contour: DesignPath = {
			type: 'cut',
			closed: true,
			role: 'pocket-opening',
			cam: intent('cut'),
			points: [point(100, 100), point(10, 100), point(10, 10), point(100, 10)]
		};
		const signedArea = (points: readonly ReturnType<typeof point>[]) =>
			points.reduce((sum, p, index, all) => {
				const next = all[(index + 1) % all.length]!;
				return sum + p.x * next.y - next.x * p.y;
			}, 0);
		const entry = plannedToolpaths([contour], view(router)).paths[0]!;
		expect(entry.path.points[0]).toEqual(point(10, 10));
		expect(Math.sign(signedArea(entry.path.points))).toBe(Math.sign(signedArea(contour.points)));
	});

	it('never increases total travel, and design order stays selectable', () => {
		const paths = allGeometry(design).paths;
		expect(plannedToolpaths(paths, view(design)).travel).toBeLessThanOrEqual(
			plannedToolpaths(paths, view(design)).baselineTravel
		);
		const authored = { ...design, toolpathOrder: 'design' as const };
		const plan = plannedToolpaths(paths, view(authored));
		expect(plan.travel).toBe(plan.baselineTravel);
		expect(plan.strategy).toBe('design');
		expect(plannedToolpaths([], view(design)).travel).toBe(0);
	});
});

describe('stated CAM intent', () => {
	const design = createDefaultDesign();
	const router = withMachine(design, { fabricationMode: 'router', bitWidth: 6 });
	const square = (cam: DesignPath['cam']): DesignPath => ({
		type: 'cut',
		closed: true,
		cam,
		points: [point(0, 0), point(100, 0), point(100, 100), point(0, 100)]
	});

	it('orders machining by the stated stage, whatever the role says', () => {
		// A role that once meant "release last" carries no weight on its own.
		const misleading = line(point(0, 0), point(10, 0), 'cut', {
			role: 'exterior',
			cam: intent('cut', { stage: 'interior' })
		});
		expect(machiningStage(misleading)).toBe(1);
		expect(machiningStage(line(point(0, 0), point(1, 0), 'score'))).toBe(0);
		expect(
			machiningStage(
				line(point(0, 0), point(1, 0), 'cut', { cam: intent('cut', { stage: 'sheet-release' }) })
			)
		).toBe(4);
	});

	it('cuts a part outline outside the line and a hole inside it', () => {
		const bounds = (points: readonly { x: number; y: number }[]) => ({
			minX: Math.min(...points.map((p) => p.x)),
			maxX: Math.max(...points.map((p) => p.x))
		});
		// Half of a 6 mm bit either side of a 100 mm square.
		expect(
			bounds(toolpathPoints(square(intent('cut', { offsetSide: 'outside' })), view(router)))
		).toEqual({
			minX: -3,
			maxX: 103
		});
		expect(
			bounds(toolpathPoints(square(intent('cut', { offsetSide: 'inside' })), view(router)))
		).toEqual({
			minX: 3,
			maxX: 97
		});
	});

	it('leaves a path cut on the line where it was drawn', () => {
		const closed = toolpathPoints(square(intent('cut', { offsetSide: 'on' })), view(router));
		expect(closed[0]).toEqual(point(0, 0));
		expect(closed.at(-1)).toEqual(point(0, 0));
		expect(closed).toHaveLength(5);
		// An open engraving is not closed back to its start.
		const open = toolpathPoints(
			line(point(0, 0), point(50, 0), 'cut', { cam: intent('cut', { offsetSide: 'on' }) }),
			view(router)
		);
		expect(open).toEqual([point(0, 0), point(50, 0)]);
	});

	it('chains paths only when they share a stated key', () => {
		const touching = (chainKey: string | null) => [
			line(point(0, 0), point(10, 0), 'cut', { cam: intent('cut', { chainKey }) }),
			line(point(10, 0), point(20, 0), 'cut', { cam: intent('cut', { chainKey }) })
		];
		expect(plannedToolpaths(touching('edge'), view(design)).paths).toHaveLength(1);
		expect(plannedToolpaths(touching(null), view(design)).paths).toHaveLength(2);
	});

	it('names the owner in the program comment without knowing what it is', () => {
		const program = generateGcode(
			[
				line(point(10, 10), point(60, 10), 'cut', {
					role: 'slot',
					owner: { kind: 'bracket', id: 'b1', name: 'Left bracket' }
				})
			],
			view(design),
			'cut'
		);
		expect(program).toContain('; 1: cut slot (Left bracket)');
	});
});
