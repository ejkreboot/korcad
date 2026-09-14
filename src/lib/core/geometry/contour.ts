import type { Point } from './primitives.js';

/**
 * Measurements on closed outlines, for manufacturability checks: how close two
 * cuts come, whether one lies inside another, and whether an outline crosses
 * itself. Outlines are vertex lists; the closing edge is implied.
 */

type Segment = readonly [Point, Point];

/**
 * The outline's edges. Repeated vertices, including a closing copy of the
 * first, are dropped first: a zero-length edge would make neighbours that only
 * share a corner look like a crossing.
 */
function edges(outline: readonly Point[]): Segment[] {
	const same = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= 1e-9;
	const vertices = outline.filter(
		(vertex, index) => index === 0 || !same(vertex, outline[index - 1]!)
	);
	if (vertices.length > 1 && same(vertices[0]!, vertices.at(-1)!)) vertices.pop();
	return vertices.map(
		(vertex, index) => [vertex, vertices[(index + 1) % vertices.length]!] as const
	);
}

function cross(o: Point, a: Point, b: Point): number {
	return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Whether two segments cross or touch, collinear overlap included. */
export function segmentsIntersect([a, b]: Segment, [c, d]: Segment): boolean {
	const onSegment = (p: Point, q: Point, r: Point) =>
		Math.min(p.x, r.x) - 1e-9 <= q.x &&
		q.x <= Math.max(p.x, r.x) + 1e-9 &&
		Math.min(p.y, r.y) - 1e-9 <= q.y &&
		q.y <= Math.max(p.y, r.y) + 1e-9;
	const d1 = cross(c, d, a);
	const d2 = cross(c, d, b);
	const d3 = cross(a, b, c);
	const d4 = cross(a, b, d);
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
		return true;
	}
	const epsilon = 1e-9;
	return (
		(Math.abs(d1) <= epsilon && onSegment(c, a, d)) ||
		(Math.abs(d2) <= epsilon && onSegment(c, b, d)) ||
		(Math.abs(d3) <= epsilon && onSegment(a, c, b)) ||
		(Math.abs(d4) <= epsilon && onSegment(a, d, b))
	);
}

function pointSegmentDistance(p: Point, [a, b]: Segment): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	const t = lengthSquared
		? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
		: 0;
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function segmentDistance(first: Segment, second: Segment): number {
	if (segmentsIntersect(first, second)) return 0;
	return Math.min(
		pointSegmentDistance(first[0], second),
		pointSegmentDistance(first[1], second),
		pointSegmentDistance(second[0], first),
		pointSegmentDistance(second[1], first)
	);
}

/** The shortest distance between two outlines' lines; zero where they touch or cross. */
export function outlineDistance(first: readonly Point[], second: readonly Point[]): number {
	const theirs = edges(second);
	let best = Infinity;
	for (const edge of edges(first)) {
		for (const other of theirs) best = Math.min(best, segmentDistance(edge, other));
		if (best === 0) return 0;
	}
	return best;
}

/** Even-odd containment of a point in an outline. */
export function pointInOutline(p: Point, outline: readonly Point[]): boolean {
	let inside = false;
	for (const [a, b] of edges(outline)) {
		if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
			inside = !inside;
		}
	}
	return inside;
}

/** Whether `inner` lies wholly inside `outer` without their lines meeting. */
export function outlineInside(inner: readonly Point[], outer: readonly Point[]): boolean {
	return (
		inner.length > 0 &&
		inner.every((vertex) => pointInOutline(vertex, outer)) &&
		outlineDistance(inner, outer) > 0
	);
}

/** Whether any two non-adjacent edges of an outline meet. */
export function selfIntersects(outline: readonly Point[]): boolean {
	const all = edges(outline);
	const count = all.length;
	for (let i = 0; i < count; i++) {
		for (let j = i + 2; j < count; j++) {
			// The first and last edges share the closing vertex.
			if (i === 0 && j === count - 1) continue;
			if (segmentsIntersect(all[i]!, all[j]!)) return true;
		}
	}
	return false;
}

/** Axis-aligned bounds of an outline. */
export function outlineBounds(outline: readonly Point[]) {
	return {
		left: Math.min(...outline.map((p) => p.x)),
		right: Math.max(...outline.map((p) => p.x)),
		bottom: Math.min(...outline.map((p) => p.y)),
		top: Math.max(...outline.map((p) => p.y))
	};
}

/** Twice the signed area: positive for a counter-clockwise outline. */
function signedArea(outline: readonly Point[]): number {
	let sum = 0;
	for (const [a, b] of edges(outline)) sum += a.x * b.y - b.x * a.y;
	return sum;
}

/**
 * Whether a point lies in a convex outline of either winding, its boundary
 * included to within `tolerance`, so a point on a shared fold line belongs to
 * both faces it separates.
 */
export function pointInConvex(p: Point, outline: readonly Point[], tolerance = 1e-6): boolean {
	const sign = signedArea(outline) < 0 ? -1 : 1;
	return edges(outline).every(([a, b]) => {
		const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		return (sign * cross(a, b, p)) / length >= -tolerance;
	});
}

/**
 * The part of `subject` inside the convex outline `clip` (Sutherland–Hodgman).
 * A concave subject may come back with zero-width bridges along the clip
 * boundary, which is harmless for filling but not for machining. Empty when
 * nothing of the subject is inside.
 */
export function clipToConvex(subject: readonly Point[], clip: readonly Point[]): Point[] {
	const sign = signedArea(clip) < 0 ? -1 : 1;
	let output: Point[] = [...subject];
	for (const [a, b] of edges(clip)) {
		if (!output.length) break;
		const input = output;
		output = [];
		const inside = (p: Point) => sign * cross(a, b, p) >= 0;
		const crossing = (p: Point, q: Point): Point => {
			const dp = sign * cross(a, b, p);
			const dq = sign * cross(a, b, q);
			const t = dp / (dp - dq);
			return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
		};
		for (let i = 0; i < input.length; i++) {
			const current = input[i]!;
			const previous = input[(i + input.length - 1) % input.length]!;
			if (inside(current)) {
				if (!inside(previous)) output.push(crossing(previous, current));
				output.push(current);
			} else if (inside(previous)) {
				output.push(crossing(previous, current));
			}
		}
	}
	return output.length >= 3 ? output : [];
}
