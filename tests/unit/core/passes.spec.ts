import { describe, expect, it } from 'vitest';
import { generateGcode, passDepths, programOperations } from '$lib/core/cam/gcode.js';
import { simulationMoves } from '$lib/core/cam/simulation.js';
import { sheetView } from '$lib/core/design/machine.js';
import { point } from '$lib/core/geometry/primitives.js';
import type { DesignPath, DesignState } from '$lib/core/design/types.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { solidGeometry } from '$lib/features/solid/geometry.js';
import {
	foldedDesign,
	routerDesign,
	solidDesign,
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

function plateProgram(design: DesignState): string {
	return generateGcode(solidGeometry(design, 'plate').paths, sheetView(design, 'plate'), 'cut');
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
		const design = withMachine(solidDesign('router'), { cutDepth: 3.2, passDepth: 1.1 });
		const program = plateProgram(design);
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
		const single = plateProgram(withMachine(solidDesign('router'), { passDepth: 5 }));
		const passes = plateProgram(withMachine(solidDesign('router'), { passDepth: 1.1 }));
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
		const design = withMachine(solidDesign('router'), { passDepth: 2 });
		const program = generateGcode([path], sheetView(design, 'plate'), 'cut');
		const [section] = sections(program);
		expect(plunges(section!)).toHaveLength(2);
		expect(section!.filter((line) => line.startsWith('G0 X'))).toHaveLength(2);
		const moves = simulationMoves(program, sheetView(design, 'plate'));
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

describe('exported programs', () => {
	it('adds a crease program only when something is creased from the back', () => {
		const trays = supportDesign();
		expect(programOperations(allGeometry(trays, 'parts').paths)).toEqual(['crease', 'cut']);
		// The deck folds only downward, so it is scored in the cut program.
		expect(programOperations(allGeometry(trays, 'deck').paths)).toEqual(['cut']);
		expect(programOperations(allGeometry(routerDesign()).paths)).toEqual(['cut']);
		expect(programOperations(solidGeometry(solidDesign('knife'), 'plate').paths)).toEqual(['cut']);
	});
});
