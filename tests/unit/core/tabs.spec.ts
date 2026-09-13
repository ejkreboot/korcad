import { describe, expect, it } from 'vitest';
import { point } from '$lib/core/geometry/primitives.js';
import { bridgeTabbedContour, bridgeTabZ, type ToolpathPoint } from '$lib/core/cam/tabs.js';

/** A 100 x 50 rectangle as a closed programmed contour, counter-clockwise from the origin. */
const RECT = [point(0, 0), point(100, 0), point(100, 50), point(0, 50), point(0, 0)];

const settings = {
	tabWidth: 4,
	tabHeight: 1,
	material: 3,
	bitWidth: 6,
	cutDepth: 3.2
};

const round = (moves: readonly ToolpathPoint[]) =>
	moves.map((move) => ({ x: +move.x.toFixed(6), y: +move.y.toFixed(6), z: move.z }));

/** Lengths of travel at each depth, and the XY path ignoring depth. */
function spans(moves: readonly ToolpathPoint[]) {
	const byZ = new Map<number, number>();
	for (let index = 1; index < moves.length; index++) {
		const a = moves[index - 1]!;
		const b = moves[index]!;
		const length = Math.hypot(b.x - a.x, b.y - a.y);
		if (length) byZ.set(b.z, (byZ.get(b.z) ?? 0) + length);
		if (length && a.z !== b.z) throw new Error('depth changed during an XY move');
	}
	return byZ;
}

describe('bridge holding tabs', () => {
	it('puts the bridge a tab thickness above the underside of the board', () => {
		expect(bridgeTabZ(settings)).toBe(-2);
	});

	it('cuts the whole contour at depth when there are no tabs', () => {
		const moves = bridgeTabbedContour(RECT, { ...settings, centres: [] });
		expect(moves).toEqual(RECT.map((p) => ({ ...p, z: -3.2 })));
	});

	it('raises the bit for the tab width plus the bit width, with vertical moves only', () => {
		const moves = bridgeTabbedContour(RECT, {
			...settings,
			centres: [point(50, 0), point(50, 50)]
		});
		const travel = spans(moves);
		expect(travel.get(-2)).toBeCloseTo(2 * (4 + 6));
		expect(travel.get(-3.2)).toBeCloseTo(300 - 20);
		expect(round(moves.filter((move) => move.z === -2))).toEqual([
			{ x: 45, y: 0, z: -2 },
			{ x: 55, y: 0, z: -2 },
			{ x: 55, y: 50, z: -2 },
			{ x: 45, y: 50, z: -2 }
		]);
	});

	it('projects a centre drawn off the compensated contour onto it', () => {
		const moves = bridgeTabbedContour(RECT, { ...settings, centres: [point(50, -3)] });
		expect(round(moves.filter((move) => move.z === -2)).map((move) => move.x)).toEqual([45, 55]);
	});

	it('starts after a tab that covers the start point, and closes the contour', () => {
		const moves = bridgeTabbedContour(RECT, { ...settings, centres: [point(0, 0)] });
		expect(round(moves)[0]).toEqual({ x: 5, y: 0, z: -3.2 });
		// It ends on that tab, retracting from it rather than dropping back first.
		expect(round(moves).at(-1)).toEqual({ x: 5, y: 0, z: -2 });
		const travel = spans(moves);
		expect(travel.get(-2)).toBeCloseTo(10);
		expect(travel.get(-3.2)).toBeCloseTo(290);
		// The raised span turns the corner at the origin.
		expect(round(moves.filter((move) => move.z === -2))).toEqual([
			{ x: 0, y: 5, z: -2 },
			{ x: 0, y: 0, z: -2 },
			{ x: 5, y: 0, z: -2 }
		]);
	});

	it('merges overlapping tabs rather than dropping between them', () => {
		const moves = bridgeTabbedContour(RECT, { ...settings, centres: [point(50, 0), point(55, 0)] });
		expect(spans(moves).get(-2)).toBeCloseTo(15);
	});

	it('refuses tabs that the cut would go through, or that leave nothing to cut', () => {
		expect(() =>
			bridgeTabbedContour(RECT, { ...settings, cutDepth: 1.5, centres: [point(50, 0)] })
		).toThrow(/cut through/);
		expect(() =>
			bridgeTabbedContour(RECT, { ...settings, tabHeight: 3, centres: [point(50, 0)] })
		).toThrow(/thinner/);
		expect(() =>
			bridgeTabbedContour(RECT, { ...settings, tabWidth: 300, centres: [point(50, 0)] })
		).toThrow(/nothing to cut/);
		expect(() => bridgeTabbedContour(RECT.slice(0, -1), { ...settings, centres: [] })).toThrow(
			/closed/
		);
	});
});
