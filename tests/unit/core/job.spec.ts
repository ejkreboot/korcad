import { describe, expect, it } from 'vitest';
import { createSurfaceMap } from '$lib/core/cam/surface.js';
import { SHEET } from '$lib/core/constants.js';
import { jobPrograms, needsZero, workTopAt } from '$lib/core/grbl/job.js';

const program = (tool: string, operation: 'crease' | 'cut' = 'cut') => ({
	operation,
	tool,
	spindle: false,
	text: `; ${operation}\nG21 ; millimeters\nG0 Z3\nM2\n`
});

describe('running a sheet', () => {
	it('sends each program as GRBL takes it', () => {
		expect(jobPrograms([program('drag knife')])).toEqual([
			{ operation: 'cut', tool: 'drag knife', spindle: false, lines: ['G21', 'G0 Z3', 'M2'] }
		]);
		expect(() => jobPrograms([{ ...program('drag knife'), text: 'G0 Z3' }])).toThrow(/M2/);
	});

	it('sets Z0 before the first program and after every change of tool, not otherwise', () => {
		const same = [{ tool: 'drag knife' }, { tool: 'drag knife' }];
		const changed = [{ tool: 'creasing wheel' }, { tool: 'drag knife' }];
		expect(needsZero(same, 0)).toBe(true);
		expect(needsZero(same, 1)).toBe(false);
		expect(needsZero(changed, 1)).toBe(true);
	});

	it('finds the work top where the tool stands from the map, or Z0 without one', () => {
		// A map 1 mm higher at the back right than at the front left, all grid points read.
		const tilted = {
			...createSurfaceMap(2, 2, 0),
			enabled: true,
			heights: [5, 5.5, 5.5, 6]
		};
		expect(workTopAt(tilted, { x: 0, y: 0 })).toBe(0);
		expect(workTopAt(tilted, { x: SHEET, y: SHEET })).toBeCloseTo(1, 12);
		expect(workTopAt({ ...tilted, enabled: false }, { x: SHEET, y: SHEET })).toBe(0);
	});
});
