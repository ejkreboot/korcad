import { describe, expect, it } from 'vitest';
import {
	bestVariants,
	sequenceStops,
	sequenceTravel,
	type Stop
} from '$lib/core/cam/sequencing.js';
import { point, type Point } from '$lib/core/geometry/primitives.js';

/** A fixed-seed generator, so every instance here is the same on every run. */
function random(seed: number): () => number {
	let state = seed;
	return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

/** An open path from `a` to `b` that may be cut either way. */
const reversible = (a: Point, b: Point): Stop => ({
	variants: [
		{ start: a, end: b, internalTravel: 0 },
		{ start: b, end: a, internalTravel: 0 }
	]
});

/** A closed contour that can start, and so end, at any of its corners. */
const closed = (corners: readonly Point[]): Stop => ({
	variants: corners.map((corner) => ({ start: corner, end: corner, internalTravel: 0 }))
});

const identity = (count: number) => Array.from({ length: count }, (_, index) => index);

function permutations(count: number): number[][] {
	if (count === 1) return [[0]];
	return permutations(count - 1).flatMap((shorter) =>
		Array.from({ length: count }, (_, at) => [
			...shorter.slice(0, at),
			count - 1,
			...shorter.slice(at)
		])
	);
}

describe('sequencing stops', () => {
	it('finds the shortest route of small random jobs, directions included', () => {
		const next = random(11);
		for (let trial = 0; trial < 12; trial++) {
			const stops = Array.from({ length: 6 }, () => {
				const a = point(next() * 300, next() * 300);
				return reversible(a, point(a.x + next() * 60 - 30, a.y + next() * 60 - 30));
			});
			let shortest = Infinity;
			for (const order of permutations(stops.length)) {
				for (let mask = 0; mask < 1 << stops.length; mask++) {
					const variants = stops.map((_, stop) => (mask >> stop) & 1);
					shortest = Math.min(shortest, sequenceTravel(stops, order, variants));
				}
			}
			const found = sequenceStops(stops, [stops.length], identity(stops.length));
			expect(found.travel).toBeCloseTo(shortest, 9);
			expect(sequenceTravel(stops, found.order, found.variants)).toBeCloseTo(found.travel, 9);
		}
	});

	it('untangles a shuffled ring into one loop around it', () => {
		const count = 24;
		const angles = identity(count).map((index) => (Math.PI * 2 * index) / count);
		const ring = angles.map((angle) =>
			closed([point(300 + Math.cos(angle) * 200, 300 + Math.sin(angle) * 200)])
		);
		const next = random(5);
		const shuffled = [...identity(count)].sort(() => next() - 0.5);
		const found = sequenceStops(ring, [count], shuffled);
		// Around the ring from the stop nearest the origin, which is optimal for points on a circle.
		const nearest = 15;
		const around = identity(count).map((index) => (nearest + index) % count);
		const loop = sequenceTravel(
			ring,
			around,
			ring.map(() => 0)
		);
		expect(found.travel).toBeCloseTo(loop, 6);
	});

	it('never moves a stop out of its block, even when that would be shorter', () => {
		// Two blocks drawn interleaved along a line: the shortest route ignoring
		// blocks would alternate between them.
		const stops = identity(12).map((index) => closed([point(index * 10 + 10, 0)]));
		const first = identity(12).filter((index) => index % 2 === 0);
		const second = identity(12).filter((index) => index % 2 === 1);
		const found = sequenceStops(stops, [6, 6], [...first, ...second]);
		expect(new Set(found.order.slice(0, 6))).toEqual(new Set(first));
		expect(new Set(found.order.slice(6))).toEqual(new Set(second));
	});

	it('enters a closed contour at the start point nearest the route', () => {
		const square = closed([point(100, 100), point(200, 100), point(200, 200), point(100, 200)]);
		const found = sequenceStops([square], [1], [0]);
		expect(found.variants).toEqual([0]);
		expect(bestVariants([square], [0])).toEqual([0]);
	});

	it('repeats itself exactly and never returns a route longer than it was given', () => {
		const next = random(3);
		const stops = identity(60).map(() => {
			const a = point(next() * 600, next() * 600);
			return next() < 0.5
				? reversible(a, point(a.x + 20, a.y))
				: closed([a, point(a.x + 15, a.y), point(a.x + 15, a.y + 15)]);
		});
		const seed = identity(60);
		const blocks = [20, 25, 15];
		const found = sequenceStops(stops, blocks, seed);
		expect(sequenceStops(stops, blocks, seed)).toEqual(found);
		expect(found.travel).toBeLessThan(sequenceTravel(stops, seed, bestVariants(stops, seed)));
		expect([...found.order].sort((a, b) => a - b)).toEqual(seed);
	});

	it('routes nothing to nowhere', () => {
		expect(sequenceStops([], [], [])).toEqual({ order: [], variants: [], travel: 0 });
	});
});
