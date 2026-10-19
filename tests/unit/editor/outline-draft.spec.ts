import { describe, expect, it } from 'vitest';
import { addOutlineVertex, closesOutline, outlineCursor } from '$lib/editor/outline-draft.js';

const triangle = [
	{ x: 0, y: 0 },
	{ x: 40, y: 0 },
	{ x: 40, y: 30 }
];

describe('outline drafts', () => {
	it('adds a vertex at each click', () => {
		const first = addOutlineVertex([], { x: 0, y: 0 }, 2);
		expect(first).toEqual({ kind: 'open', points: [{ x: 0, y: 0 }] });
		expect(addOutlineVertex(first.points, { x: 10, y: 0 }, 2)).toEqual({
			kind: 'open',
			points: [
				{ x: 0, y: 0 },
				{ x: 10, y: 0 }
			]
		});
	});

	it('closes on a click near the first vertex, adding no vertex', () => {
		expect(addOutlineVertex(triangle, { x: 1, y: 1 }, 2)).toEqual({
			kind: 'closed',
			points: triangle
		});
	});

	it('keeps going on a click just outside the closing radius', () => {
		const step = addOutlineVertex(triangle, { x: 2, y: 2 }, 2);
		expect(step.kind).toBe('open');
		expect(step.points).toHaveLength(4);
	});

	it('never closes fewer than three vertices', () => {
		const line = triangle.slice(0, 2);
		expect(closesOutline(line, { x: 0, y: 0 }, 2)).toBe(false);
		// Back on the first vertex of a line is a new corner, not a close.
		expect(addOutlineVertex(line, { x: 0, y: 0 }, 2)).toEqual({
			kind: 'open',
			points: [...line, { x: 0, y: 0 }]
		});
	});

	it('ignores a second click on the last vertex', () => {
		expect(addOutlineVertex(triangle, { x: 40, y: 30 }, 2)).toEqual({
			kind: 'open',
			points: triangle
		});
	});

	it('draws the edge in progress to the first vertex once a click would close', () => {
		expect(outlineCursor(triangle, { x: 1.5, y: -1 }, 2)).toEqual({ x: 0, y: 0 });
		expect(outlineCursor(triangle, { x: 20, y: 20 }, 2)).toEqual({ x: 20, y: 20 });
	});
});
