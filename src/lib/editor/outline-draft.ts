import { distance, type Point } from '$lib/core/geometry/primitives.js';

/**
 * An outline drawn one vertex at a click. Nothing closes it automatically: a
 * click back on the first vertex does, and a click near enough to it counts,
 * so the last edge meets the first exactly rather than leaving a sliver of a
 * gap or a crossing.
 */

/** How near the first vertex, in screen pixels, a click closes the outline. */
export const CLOSE_RADIUS_PX = 10;

/** A closed outline needs three corners to enclose anything. */
export const MIN_OUTLINE_VERTICES = 3;

export type OutlineStep =
	| { readonly kind: 'open'; readonly points: readonly Point[] }
	| { readonly kind: 'closed'; readonly points: readonly Point[] };

/** Whether a click at `at` would close the outline: on its first vertex, with enough corners. */
export function closesOutline(points: readonly Point[], at: Point, radius: number): boolean {
	const first = points[0];
	return (
		points.length >= MIN_OUTLINE_VERTICES && first !== undefined && distance(first, at) <= radius
	);
}

/**
 * The outline after a click at `at`: closed when the click lands on the first
 * vertex, otherwise open with one more vertex. A click on the last vertex, as
 * the second press of a double-click is, adds nothing.
 */
export function addOutlineVertex(points: readonly Point[], at: Point, radius: number): OutlineStep {
	if (closesOutline(points, at, radius)) return { kind: 'closed', points };
	const last = points.at(-1);
	if (last && distance(last, at) < 1e-6) return { kind: 'open', points };
	return { kind: 'open', points: [...points, at] };
}

/** Where the edge being drawn ends: the cursor, or the first vertex when a click there would close. */
export function outlineCursor(points: readonly Point[], cursor: Point, radius: number): Point {
	return closesOutline(points, cursor, radius) ? points[0]! : cursor;
}
