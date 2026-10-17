import { describe, expect, it } from 'vitest';
import { compensatedPoints, knifeToolpath } from '$lib/core/cam/compensation.js';
import { generateGcode } from '$lib/core/cam/gcode.js';
import { sheetView } from '$lib/core/design/machine.js';
import { validateMachineSettings } from '$lib/core/design/validation.js';
import { point, type Point } from '$lib/core/geometry/primitives.js';
import type { DesignPath, MachineSettings } from '$lib/core/design/types.js';
import { flatPartsDesign, withMachine } from '../../support/designs.js';
import { intent } from '../../support/paths.js';

const knife = (settings: Partial<MachineSettings> = {}) =>
	sheetView(
		withMachine(flatPartsDesign('knife'), {
			bladeOffset: 0.25,
			overcut: 0,
			cornerStep: 10,
			swivelDepth: 0.3,
			liftAngle: 30,
			liftRadius: 3,
			...settings
		}),
		'sheet'
	);

const open = (points: Point[]): DesignPath => ({
	points,
	type: 'cut',
	closed: false,
	cam: intent('cut')
});

/** An open arc of `radius` turning `sweep` degrees in `step` degree segments. */
function arc(radius: number, sweep: number, step: number): DesignPath {
	const count = Math.round(sweep / step);
	return open(
		Array.from({ length: count + 1 }, (_, index) => {
			const angle = (index * step * Math.PI) / 180;
			return point(100 + radius * Math.cos(angle), 100 + radius * Math.sin(angle));
		})
	);
}

/**
 * Whether each interior vertex of an open path is turned lifted. The axis
 * reaches a vertex a blade offset past it along the incoming edge, and a
 * lifted swing starts there.
 */
function liftedVertices(path: DesignPath, settings: ReturnType<typeof knife>): boolean[] {
	const { points, lifts } = knifeToolpath(path, settings);
	const starts = lifts.map((turn) => points[turn.from]!);
	return path.points.slice(1, -1).map((vertex, index) => {
		const before = path.points[index]!;
		const length = Math.hypot(vertex.x - before.x, vertex.y - before.y);
		const arrival = point(
			vertex.x + ((vertex.x - before.x) / length) * 0.25,
			vertex.y + ((vertex.y - before.y) / length) * 0.25
		);
		return starts.some((p) => Math.hypot(p.x - arrival.x, p.y - arrival.y) < 1e-9);
	});
}

/** An open path from the origin along `[heading in degrees, length]` legs. */
function legs(...steps: readonly (readonly [number, number])[]): DesignPath {
	const points = [point(0, 0)];
	for (const [heading, length] of steps) {
		const last = points.at(-1)!;
		const angle = (heading * Math.PI) / 180;
		points.push(point(last.x + Math.cos(angle) * length, last.y + Math.sin(angle) * length));
	}
	return open(points);
}

describe('knife lifts', () => {
	const square = open([point(0, 0), point(50, 0), point(50, 50), point(0, 50), point(0, 0)]);

	it('lifts at a corner sharper than the lift angle', () => {
		expect(liftedVertices(square, knife())).toEqual([true, true, true]);
		expect(knifeToolpath(square, knife({ liftAngle: 90 })).lifts).toEqual([]);
		expect(knifeToolpath(square, knife({ liftAngle: 89 })).lifts).toHaveLength(3);
	});

	it('lifts at every acute corner, whatever the lift angle allowed', () => {
		const acute = legs([0, 20], [135, 20], [-90, 20]);
		expect(liftedVertices(acute, knife({ liftAngle: 90, liftRadius: 0 }))).toEqual([true, true]);
	});

	it('never lifts without a swivel depth, which validation refuses for a trailing blade', () => {
		expect(knifeToolpath(square, knife({ swivelDepth: 0 })).lifts).toEqual([]);
	});

	it('leaves the axis path where it was in XY', () => {
		const tight = arc(1, 270, 5);
		for (const path of [square, tight]) {
			expect(knifeToolpath(path, knife()).points).toEqual(
				compensatedPoints(path, knife({ swivelDepth: 0 }))
			);
		}
	});

	it('follows a curve wider than the lift radius at depth', () => {
		expect(knifeToolpath(arc(10, 270, 5), knife()).lifts).toEqual([]);
	});

	it('rocks the blade round a curve tighter than the lift radius', () => {
		// Every vertex turns 5 degrees: six fit within 30 at depth, and the seventh is lifted.
		const lifted = liftedVertices(arc(1, 270, 5), knife());
		expect(lifted.filter(Boolean).length).toBeGreaterThan(5);
		let atDepth = 0;
		for (const turn of lifted) {
			atDepth = turn ? 0 : atDepth + 5;
			expect(atDepth).toBeLessThanOrEqual(30);
		}
		expect(lifted.slice(0, 7)).toEqual([false, false, false, false, false, false, true]);
	});

	it('turns a corner of exactly the lift angle at depth', () => {
		expect(liftedVertices(legs([0, 20], [30, 20]), knife())).toEqual([false]);
	});

	it('counts close corners together, as one sharper turn', () => {
		// Two 20 degree turns 1 mm apart turn the blade 40 degrees inside the 1.57 mm window.
		const close = legs([0, 20], [20, 1], [40, 20]);
		expect(liftedVertices(close, knife())).toEqual([false, true]);
		// Far apart, or with no window, neither is sharper than the lift angle on its own.
		expect(liftedVertices(legs([0, 20], [20, 20], [40, 20]), knife())).toEqual([false, false]);
		expect(liftedVertices(close, knife({ liftRadius: 0 }))).toEqual([false, false]);
	});

	it('counts turns closer than two blade offsets together, whatever the lift radius', () => {
		// 1.8 mm apart: outside the 1.57 mm lift radius window, inside two 1 mm offsets.
		const close = legs([0, 20], [20, 1.8], [40, 20]);
		expect(liftedVertices(close, knife())).toEqual([false, false]);
		const offset = (path: DesignPath, settings: ReturnType<typeof knife>) =>
			knifeToolpath(path, settings).lifts.length;
		expect(offset(close, knife({ bladeOffset: 1 }))).toBe(1);
		expect(offset(close, knife({ bladeOffset: 1, liftRadius: 0 }))).toBe(1);
		// 2.2 mm apart clears two offsets as well, so both turns are made at depth.
		expect(offset(legs([0, 20], [20, 2.2], [40, 20]), knife({ bladeOffset: 1 }))).toBe(0);
	});
});

describe('lifted turns in G-code', () => {
	const square = open([point(10, 10), point(60, 10), point(60, 60)]);
	const program = (settings: Partial<MachineSettings> = {}) =>
		generateGcode([square], { ...knife(settings), toolpathOrder: 'design' }, 'cut');

	it('rises to swivel depth for the swing and plunges back to the pass', () => {
		const lines = program().split('\n');
		const lift = lines.indexOf('G1 Z-0.3 F250 ; lift');
		const end = lines.indexOf('G1 Z-3.2 F250 ; end of lift');
		expect(lift).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(lift);
		// The swing between them moves only in XY.
		expect(lines.slice(lift + 1, end).every((line) => /^G1 X[\d.]+ Y[\d.]+ F800$/.test(line))).toBe(
			true
		);
		expect(program()).toContain(
			'; Blade lifts to Z-0.3 to turn more than 30 deg, and round curves tighter than 3 mm radius'
		);
	});

	it('returns each pass to its own depth after a lift', () => {
		const text = program({ knifePasses: 2, cutDepth: 3.2 });
		expect(text.split('\n').filter((line) => line.endsWith('; end of lift'))).toEqual([
			'G1 Z-1.6 F250 ; end of lift',
			'G1 Z-3.2 F250 ; end of lift'
		]);
	});

	it('emits no lifts when nothing turns sharply enough', () => {
		const text = program({ liftAngle: 90, liftRadius: 0 });
		expect(text).not.toContain('lift');
	});

	it('states the curve radius two blade offsets impose when it passes the lift radius', () => {
		// Two 1 mm offsets spread over 30 degrees is a 3.82 mm radius.
		expect(program({ bladeOffset: 1 })).toContain(
			'; Blade lifts to Z-0.3 to turn more than 30 deg, and round curves tighter than 3.82 mm radius'
		);
	});
});

describe('lift settings validation', () => {
	const errors = (settings: Partial<MachineSettings>) =>
		validateMachineSettings(withMachine(flatPartsDesign('knife'), settings));

	it('accepts a lift angle up to 90 degrees and any radius from zero', () => {
		expect(errors({ liftAngle: 90, liftRadius: 0 })).toEqual([]);
	});

	it('refuses a lift angle outside (0, 90], which would cut an acute corner at depth', () => {
		for (const liftAngle of [0, 91, 180, Number.NaN]) {
			expect(errors({ liftAngle })).toEqual([
				'Drag knife: lift angle must be more than 0° and at most 90°'
			]);
		}
		expect(errors({ liftRadius: -1 })).toEqual(['Drag knife: lift radius must be zero or more']);
	});

	it('refuses a trailing blade with no swivel depth to turn or lift at', () => {
		expect(errors({ swivelDepth: 0 })).toEqual([
			'Drag knife: swivel depth must be more than zero for a blade with an offset'
		]);
		// A blade with no offset cuts under the axis and has no heading to turn.
		expect(errors({ swivelDepth: 0, bladeOffset: 0 })).toEqual([]);
	});

	it('does not check lift settings on a router', () => {
		const router = withMachine(flatPartsDesign('router'), { liftAngle: 0, liftRadius: -1 });
		expect(validateMachineSettings(router)).toEqual([]);
	});
});
