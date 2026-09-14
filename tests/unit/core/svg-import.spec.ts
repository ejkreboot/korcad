import { describe, expect, it } from 'vitest';
import { MM_PER_IN } from '$lib/core/constants.js';
import { outlineBounds } from '$lib/core/geometry/contour.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import { readSvgOutlines } from '$lib/core/import/svg.js';

const TOLERANCE = 0.05;
const read = (body: string, root = 'width="100mm" height="100mm" viewBox="0 0 100 100"') =>
	readSvgOutlines(`<svg xmlns="http://www.w3.org/2000/svg" ${root}>${body}</svg>`, {
		tolerance: TOLERANCE
	});

const size = (points: readonly Point[]) => {
	const box = outlineBounds(points);
	return { w: box.right - box.left, h: box.top - box.bottom, box };
};

/** Largest distance of any vertex, or any edge midpoint, from a circle. */
function circleError(points: readonly Point[], cx: number, cy: number, r: number): number {
	return Math.max(
		...points.flatMap((p, index) => {
			const q = points[(index + 1) % points.length]!;
			const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
			return [p, mid].map((v) => Math.abs(Math.hypot(v.x - cx, v.y - cy) - r));
		})
	);
}

describe('reading SVG outlines', () => {
	it('scales the viewBox to the stated size and flips Y up', () => {
		const { closed } = read(
			'<rect x="10" y="10" width="20" height="40"/>',
			'width="100mm" height="50mm" viewBox="0 0 200 100"'
		);
		expect(closed).toHaveLength(1);
		const { w, h, box } = size(closed[0]!);
		expect(w).toBeCloseTo(10);
		expect(h).toBeCloseTo(20);
		// The rect's top edge in SVG (y = 10) is its highest point on the sheet.
		expect(box.top).toBeCloseTo(-5);
		expect(box.bottom).toBeCloseTo(-25);
	});

	it('reads a unitless drawing in CSS pixels, and absolute units as stated', () => {
		const pixels = read('<rect width="96" height="48"/>', '');
		expect(size(pixels.closed[0]!).w).toBeCloseTo(MM_PER_IN);
		const inches = read(
			'<rect width="1" height="1"/>',
			'width="2in" height="2in" viewBox="0 0 2 2"'
		);
		expect(size(inches.closed[0]!).w).toBeCloseTo(MM_PER_IN);
		const points = read(
			'<rect width="72" height="72"/>',
			'width="72pt" height="72pt" viewBox="0 0 72 72"'
		);
		expect(size(points.closed[0]!).h).toBeCloseTo(MM_PER_IN);
	});

	it('applies nested transforms in order', () => {
		const { closed } = read(
			'<g transform="translate(50 0)"><rect transform="rotate(90) scale(2 1)" width="10" height="5"/></g>'
		);
		// scale makes it 20 x 5, rotating 90° makes it 5 wide and 20 tall.
		const { w, h, box } = size(closed[0]!);
		expect(w).toBeCloseTo(5);
		expect(h).toBeCloseTo(20);
		expect(box.left).toBeCloseTo(45);
		expect(box.right).toBeCloseTo(50);
	});

	it('flattens arcs and circles within tolerance', () => {
		const { closed } = read(
			'<circle cx="50" cy="50" r="40"/><path d="M10 80 A10 10 0 0 0 30 80 A10 10 0 0 0 10 80 Z"/>'
		);
		expect(closed).toHaveLength(2);
		expect(circleError(closed[0]!, 50, -50, 40)).toBeLessThanOrEqual(TOLERANCE);
		expect(circleError(closed[1]!, 20, -80, 10)).toBeLessThanOrEqual(TOLERANCE);
		// Flat enough, but not absurdly dense.
		expect(closed[0]!.length).toBeLessThan(200);
	});

	it('scales arc radii up when they cannot reach the endpoint', () => {
		const { closed } = read('<path d="M0 0 A1 1 0 0 1 20 0 A1 1 0 0 1 0 0 Z"/>');
		expect(circleError(closed[0]!, 10, 0, 10)).toBeLessThanOrEqual(TOLERANCE);
	});

	it('parses compact path data: signs, bare decimals, and run-together arc flags', () => {
		const compact = read('<path d="M0,0C0-10,10-10,10,0z"/>');
		expect(size(compact.closed[0]!).h).toBeCloseTo(7.5, 1);
		const flags = read('<path d="M10 50a10 10 0 1010 0z"/>');
		expect(flags.closed).toHaveLength(1);
		const decimals = read('<path d="M.5.5h10v10H.5z"/>');
		expect(size(decimals.closed[0]!)).toMatchObject({ w: 10, h: 10 });
	});

	it('reflects smooth curve controls and handles relative commands after a close', () => {
		const smooth = read('<path d="M0 0 Q10 10 20 0 T40 0 L40 -20 L0 -20 Z"/>');
		// T mirrors the control below the chord, so the path dips to y = -5.
		const box = size(smooth.closed[0]!).box;
		expect(box.top).toBeCloseTo(20);
		expect(box.bottom).toBeCloseTo(-5, 1);

		const two = read('<path d="M0 0 h30 v30 h-30 z m10 10 h10 v10 h-10 z"/>');
		expect(two.closed).toHaveLength(2);
		expect(size(two.closed[1]!).box.left).toBeCloseTo(10);
	});

	it('counts open paths, but closes one whose ends meet', () => {
		const result = read(
			'<line x1="0" y1="0" x2="10" y2="10"/><polyline points="0 0 20 0 20 20"/><polyline points="0 0 20 0 20 20 0.01 0"/>'
		);
		expect(result.openCount).toBe(2);
		expect(result.closed).toHaveLength(1);
		expect(result.closed[0]).toHaveLength(3);
	});

	it('skips what is not drawn, follows use, and names what it cannot read', () => {
		const result = read(`
			<!-- a comment <rect width="5" height="5"/> -->
			<defs><rect id="square" width="10" height="10"/></defs>
			<use href="#square" x="40" y="0"/>
			<use xlink:href="#square" transform="translate(0 40)"/>
			<rect width="10" height="10" style="display: none"/>
			<g visibility="hidden"><rect width="10" height="10"/><rect visibility="visible" x="70" width="10" height="10"/></g>
			<text x="0" y="0">Label</text>
			<image href="x.png" width="10" height="10"/>
			<sodipodi:namedview/>
		`);
		expect(result.closed.map((points) => size(points).box.left)).toEqual([40, 0, 70]);
		expect(result.unsupported).toEqual(['image', 'text']);
	});

	it('reads rounded rectangles, polygons, and ellipses', () => {
		const { closed } = read(
			'<rect width="40" height="20" rx="5"/><polygon points="0,0 10,0 5,8"/><ellipse cx="50" cy="50" rx="20" ry="10"/>'
		);
		expect(closed).toHaveLength(3);
		expect(size(closed[0]!)).toMatchObject({ w: 40, h: 20 });
		expect(closed[1]).toHaveLength(3);
		expect(size(closed[2]!).w).toBeCloseTo(40);
		expect(size(closed[2]!).h).toBeCloseTo(20);
	});

	it('rejects a file that is not well-formed SVG', () => {
		expect(() => readSvgOutlines('<svg><g></svg>', { tolerance: TOLERANCE })).toThrow(
			/not well-formed/
		);
		expect(() => readSvgOutlines('<html></html>', { tolerance: TOLERANCE })).toThrow(/not an SVG/);
		expect(() =>
			readSvgOutlines('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "b">]><svg/>', {
				tolerance: TOLERANCE
			})
		).not.toThrow();
	});
});
