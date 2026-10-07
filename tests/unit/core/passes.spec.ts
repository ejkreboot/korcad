import { describe, expect, it } from 'vitest';
import {
	generateGcode,
	knifePassDepths,
	passDepths,
	programOperations
} from '$lib/core/cam/gcode.js';
import { simulationMoves } from '$lib/core/cam/simulation.js';
import { sheetView } from '$lib/core/design/machine.js';
import { point } from '$lib/core/geometry/primitives.js';
import type { DesignPath, DesignState, MachineSettings } from '$lib/core/design/types.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { flatPartsGeometry } from '$lib/features/flat-parts/geometry.js';
import {
	foldedDesign,
	routerDesign,
	flatPartsDesign,
	supportDesign,
	withMachine
} from '../../support/designs.js';
import { intent } from '../../support/paths.js';

/** The program split into its paths, each the lines after its `; N:` comment. */
function sections(program: string): string[][] {
	const result: string[][] = [];
	for (const line of program.split('\n')) {
		if (/^; \d+: /.test(line)) result.push([line]);
		else if (line === 'M5' && result.length) break;
		else result.at(-1)?.push(line);
	}
	return result;
}

/** Plunges into a pass, as opposed to the drop at the end of a holding tab. */
const plunges = (lines: readonly string[]) =>
	lines.filter((line) => /^G1 Z-[\d.]+ F[\d.]+$/.test(line));
const tabRises = (lines: readonly string[]) =>
	lines.filter((line) => line.endsWith('; holding tab'));

function sheetProgram(design: DesignState): string {
	return generateGcode(flatPartsGeometry(design, 'sheet').paths, sheetView(design, 'sheet'), 'cut');
}

describe('depth per pass', () => {
	it('splits a cut into the fewest equal passes none deeper than the limit', () => {
		expect(passDepths(3.2, 3)).toEqual([1.6, 3.2]);
		expect(passDepths(6, 3)).toEqual([3, 6]);
		expect(passDepths(2, 3)).toEqual([2]);
		expect(passDepths(3.2, 1.1)).toHaveLength(3);
		expect(() => passDepths(3.2, 0)).toThrow(/Depth per pass/);
	});

	it('routes a closed contour in passes, plunging where the last pass ended', () => {
		const design = withMachine(flatPartsDesign('router'), { cutDepth: 3.2, passDepth: 1.1 });
		const program = sheetProgram(design);
		expect(program).toContain('; Cut in equal passes of at most 1.1 mm');
		for (const section of sections(program)) {
			expect(plunges(section).map((line) => line.split(' ')[1])).toEqual([
				'Z-1.067',
				'Z-2.133',
				'Z-3.2'
			]);
			// One approach, one retract: the passes never leave the contour.
			expect(section.filter((line) => line.startsWith('G0'))).toHaveLength(2);
		}
	});

	it('bridges holding tabs only on the passes that reach them', () => {
		// Tabs stand 1 mm above the underside of 3 mm board, so their tops are at Z-2.
		const single = sheetProgram(withMachine(flatPartsDesign('router'), { passDepth: 5 }));
		const passes = sheetProgram(withMachine(flatPartsDesign('router'), { passDepth: 1.1 }));
		const bracket = (program: string) =>
			sections(program).find((section) => section[0]!.includes('(Bracket)'))!;
		const once = tabRises(bracket(single)).length;
		expect(once).toBeGreaterThan(0);
		// Z-1.067 runs over the tabs; Z-2.133 and Z-3.2 rise over them.
		expect(tabRises(bracket(passes))).toHaveLength(2 * once);
		expect(tabRises(bracket(passes)).every((line) => line.startsWith('G1 Z-2 '))).toBe(true);
	});

	it('retracts and returns to the start between passes of an open path', () => {
		const path: DesignPath = {
			points: [point(100, 100), point(200, 100)],
			type: 'cut',
			closed: false,
			cam: intent('cut', { offsetSide: 'on' })
		};
		const design = withMachine(flatPartsDesign('router'), { passDepth: 2 });
		const program = generateGcode([path], sheetView(design, 'sheet'), 'cut');
		const [section] = sections(program);
		expect(plunges(section!)).toHaveLength(2);
		expect(section!.filter((line) => line.startsWith('G0 X'))).toHaveLength(2);
		const moves = simulationMoves(program, sheetView(design, 'sheet'));
		expect(moves.filter((move) => move.type === 'cut' && move.b.z === -1.6)).not.toHaveLength(0);
	});

	it('cuts in one pass on a knife, whatever the limit', () => {
		const design = foldedDesign();
		const paths = allGeometry(design).paths;
		expect(generateGcode(paths, sheetView(withMachine(design, { passDepth: 0.5 })), 'cut')).toBe(
			generateGcode(paths, sheetView(withMachine(design, { passDepth: 50 })), 'cut')
		);
	});
});

describe('knife passes', () => {
	const knifeProgram = (settings: Partial<MachineSettings>) =>
		sheetProgram(withMachine(flatPartsDesign('knife'), settings));

	it('splits a knife cut into equal passes by count', () => {
		expect(knifePassDepths(3.2, 1)).toEqual([3.2]);
		expect(knifePassDepths(3, 3)).toEqual([1, 2, 3]);
		expect(() => knifePassDepths(3.2, 0)).toThrow(/whole number/);
		expect(() => knifePassDepths(3.2, 1.5)).toThrow(/whole number/);
	});

	it('cuts every knife path in the given number of passes, retracting between them', () => {
		const program = knifeProgram({ knifePasses: 2, cutDepth: 3.2 });
		expect(program).toContain('; Knife cuts in 2 equal passes');
		for (const section of sections(program)) {
			expect(plunges(section).map((line) => line.split(' ')[1])).toEqual(['Z-1.6', 'Z-3.2']);
			// A knife contour ends past its start on the overcut, so each pass returns to it.
			expect(section.filter((line) => line === 'G0 Z3')).toHaveLength(2);
		}
	});

	it('scores in one pass whatever the count', () => {
		const design = withMachine(foldedDesign(), { knifePasses: 3 });
		const program = generateGcode(allGeometry(design).paths, sheetView(design), 'cut');
		const scores = sections(program).filter((section) => section[0]!.includes(': score'));
		expect(scores.length).toBeGreaterThan(0);
		for (const section of scores) {
			expect(plunges(section).map((line) => line.split(' ')[1])).toEqual(['Z-0.9']);
		}
	});

	it('leaves a one-pass knife program without a passes note', () => {
		expect(knifeProgram({ knifePasses: 1 })).not.toContain('equal passes');
	});
});

describe('blade swivel', () => {
	const trail = 0.25;
	const settings = { bladeOffset: trail, swivelDepth: 0.3, cornerStep: 10 };
	/** Two cuts at right angles to each other, the second leaving the way the first did not. */
	const paths: DesignPath[] = [
		{ points: [point(100, 100), point(200, 100)], type: 'cut', closed: false, cam: intent('cut') },
		{ points: [point(300, 100), point(300, 200)], type: 'cut', closed: false, cam: intent('cut') }
	];
	const program = (overrides: Partial<MachineSettings> = {}) => {
		const design = withMachine(flatPartsDesign('knife'), { ...settings, ...overrides });
		return generateGcode(paths, { ...sheetView(design, 'sheet'), toolpathOrder: 'design' }, 'cut');
	};
	const xy = (line: string) => {
		const [, x, y] = line.match(/X(-?[\d.]+) Y(-?[\d.]+)/)!;
		return point(Number(x), Number(y));
	};
	/** The axis positions of a section's swivel: its approach and every swing step. */
	const swivel = (section: readonly string[]) => {
		const lower = section.findIndex((line) => line.endsWith('; swivel'));
		const plunge = section.findIndex((line, index) => index > lower && line.startsWith('G1 Z-'));
		return [section[lower - 1]!, ...section.slice(lower + 1, plunge)].map(xy);
	};

	it('swivels about the start of each cut at swivel depth, before plunging to depth', () => {
		const text = program();
		expect(text).toContain('; Blade swivels at Z-0.3 to face each cut before plunging');
		const [first, second] = sections(text);
		for (const [section, tip] of [
			[first!, point(100, 100)],
			[second!, point(300, 100)]
		] as const) {
			const lower = section.findIndex((line) => line.endsWith('; swivel'));
			expect(section[lower]).toBe('G1 Z-0.3 F250 ; swivel');
			// The axis circles the tip, so the tip pivots on the start of the cut.
			for (const p of swivel(section)) {
				expect(Math.hypot(p.x - tip.x, p.y - tip.y)).toBeCloseTo(trail, 2);
			}
			expect(plunges(section)).toEqual(['G1 Z-3.2 F250']);
		}
	});

	it('turns a full circle where the heading is unknown, and only the turn needed after', () => {
		const [first, second] = sections(program());
		// The heading at the start of a program is unknown: 36 steps of 10 degrees.
		expect(swivel(first!)).toHaveLength(1 + 36);
		// The first cut leaves the blade facing +X; the second runs +Y, a quarter turn.
		const second_ = swivel(second!);
		expect(second_).toHaveLength(1 + 9);
		expect(second_[0]).toEqual(point(300.25, 100));
		expect(second_.at(-1)).toEqual(point(300, 100.25));
	});

	it('does not swivel when the blade already faces the cut', () => {
		const straight: DesignPath[] = [
			{ points: [point(0, 50), point(100, 50)], type: 'cut', closed: false, cam: intent('cut') },
			{ points: [point(150, 50), point(250, 50)], type: 'cut', closed: false, cam: intent('cut') }
		];
		const design = withMachine(flatPartsDesign('knife'), settings);
		const view = { ...sheetView(design, 'sheet'), toolpathOrder: 'design' as const };
		const [, second] = sections(generateGcode(straight, view, 'cut'));
		expect(second!.some((line) => line.endsWith('; swivel'))).toBe(false);
	});

	it('swivels each pass that has to turn, never deeper than the pass', () => {
		const text = program({ knifePasses: 4, cutDepth: 1 });
		for (const section of sections(text)) {
			expect(section.filter((line) => line === 'G1 Z-0.25 F250 ; swivel')).toHaveLength(1);
		}
	});

	it('plunges straight in with a swivel depth of zero', () => {
		const text = program({ swivelDepth: 0 });
		expect(text).not.toContain('swivel');
		for (const section of sections(text)) {
			expect(section.slice(1, 3)).toEqual([expect.stringMatching(/^G0 X/), 'G1 Z-3.2 F250']);
		}
	});

	it('never swivels a router bit', () => {
		const design = withMachine(flatPartsDesign('router'), settings);
		expect(sheetProgram(design)).not.toContain('swivel');
	});
});

describe('exported programs', () => {
	it('adds a crease program only when something is creased from the back', () => {
		const trays = supportDesign();
		expect(programOperations(allGeometry(trays, 'parts').paths)).toEqual(['crease', 'cut']);
		// The deck folds only downward, so it is scored in the cut program.
		expect(programOperations(allGeometry(trays, 'deck').paths)).toEqual(['cut']);
		expect(programOperations(allGeometry(routerDesign()).paths)).toEqual(['cut']);
		expect(programOperations(flatPartsGeometry(flatPartsDesign('knife'), 'sheet').paths)).toEqual([
			'cut'
		]);
	});
});
