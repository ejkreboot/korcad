import { describe, expect, it } from 'vitest';
import {
	outlineDistance,
	outlineInside,
	pointInOutline,
	selfIntersects
} from '$lib/core/geometry/contour.js';
import { regularPolygon, shapeOutline, splitClosedContour } from '$lib/core/geometry/outline.js';
import { point, type Point } from '$lib/core/geometry/primitives.js';

const length = (points: readonly Point[]) =>
	points
		.slice(1)
		.reduce((sum, p, i) => sum + Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y), 0);
const signedArea = (points: readonly Point[]) =>
	points.reduce((sum, p, i) => {
		const next = points[(i + 1) % points.length]!;
		return sum + p.x * next.y - next.x * p.y;
	}, 0) / 2;

const square = shapeOutline('rectangle', { x: 0, y: 0, w: 100, h: 100 });

describe('shape outlines', () => {
	it('wind counter-clockwise', () => {
		for (const shape of ['rectangle', 'rounded', 'ellipse'] as const) {
			expect(
				signedArea(shapeOutline(shape, { x: 0, y: 0, w: 80, h: 40 }, 5)),
				shape
			).toBeGreaterThan(0);
		}
		expect(signedArea(regularPolygon({ x: 0, y: 0, w: 80, h: 80 }, 6))).toBeGreaterThan(0);
	});

	it('draws a regular polygon with a flat bottom edge inside its box', () => {
		const hexagon = regularPolygon({ x: 10, y: 10, w: 80, h: 80 }, 6);
		expect(hexagon).toHaveLength(6);
		expect(hexagon[0]!.y).toBeCloseTo(hexagon[1]!.y, 9);
		for (const vertex of hexagon) {
			expect(Math.hypot(vertex.x - 50, vertex.y - 50)).toBeCloseTo(40, 9);
		}
		expect(regularPolygon({ x: 0, y: 0, w: 10, h: 10 }, 1)).toHaveLength(3);
	});
});

describe('holding tabs around a closed outline', () => {
	it('leaves an untabbed outline as one closed run', () => {
		expect(splitClosedContour(square, 0, 6)).toEqual({ runs: [[...square, square[0]]], tabs: [] });
		// Tabs that would eat the whole outline are refused rather than cutting nothing.
		expect(splitClosedContour(square, 100, 6).tabs).toEqual([]);
	});

	it('leaves evenly spaced gaps of the tab width and cuts everything else', () => {
		const { runs, tabs } = splitClosedContour(square, 4, 6);
		expect(tabs).toHaveLength(4);
		expect(runs).toHaveLength(4);
		for (const [a, b] of tabs) expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(6, 9);
		expect(runs.reduce((sum, run) => sum + length(run), 0)).toBeCloseTo(400 - 24, 9);
		// Each run starts where a tab ends, and ends where the next begins.
		runs.forEach((run, index) => {
			expect(run[0]).toEqual(tabs[index]![1]);
			expect(run.at(-1)).toEqual(tabs[(index + 1) % 4]![0]);
		});
		// One tab centred on each side of the square.
		expect(tabs.map(([a, b]) => point((a.x + b.x) / 2, (a.y + b.y) / 2))).toEqual([
			point(50, 0),
			point(100, 50),
			point(50, 100),
			point(0, 50)
		]);
	});

	it('keeps every vertex a run passes, so curves stay curved', () => {
		const circle = shapeOutline('ellipse', { x: 0, y: 0, w: 100, h: 100 });
		const { runs } = splitClosedContour(circle, 3, 5);
		const perimeter = length([...circle, circle[0]!]);
		expect(runs.reduce((sum, run) => sum + length(run), 0)).toBeCloseTo(perimeter - 15, 6);
		expect(runs.every((run) => run.length > 10)).toBe(true);
	});
});

describe('contour measurements', () => {
	const inner = shapeOutline('rectangle', { x: 20, y: 20, w: 10, h: 10 });

	it('measures the gap between outlines, and zero where they meet', () => {
		expect(outlineDistance(square, inner)).toBeCloseTo(20, 9);
		expect(outlineDistance(square, shapeOutline('rectangle', { x: 90, y: 90, w: 20, h: 20 }))).toBe(
			0
		);
		expect(
			outlineDistance(square, shapeOutline('rectangle', { x: 105, y: 0, w: 5, h: 5 }))
		).toBeCloseTo(5, 9);
	});

	it('knows when one outline lies wholly inside another', () => {
		expect(pointInOutline(point(50, 50), square)).toBe(true);
		expect(pointInOutline(point(150, 50), square)).toBe(false);
		expect(outlineInside(inner, square)).toBe(true);
		expect(outlineInside(square, inner)).toBe(false);
		expect(outlineInside(shapeOutline('rectangle', { x: 90, y: 20, w: 20, h: 20 }), square)).toBe(
			false
		);
	});

	it('finds an outline that crosses itself', () => {
		expect(selfIntersects(square)).toBe(false);
		expect(selfIntersects(shapeOutline('ellipse', { x: 0, y: 0, w: 50, h: 20 }))).toBe(false);
		expect(selfIntersects([point(0, 0), point(10, 10), point(10, 0), point(0, 10)])).toBe(true);
	});
});
