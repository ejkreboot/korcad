import { outlineBounds, pointInOutline } from '$lib/core/geometry/contour.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import { round } from '$lib/core/units.js';
import { readSvgOutlines } from './svg.js';

/**
 * Turning a drawing's outlines into something a workspace can cut: specks and
 * duplicates dropped, and each outline's nesting depth measured.
 *
 * Depth is what cutting an outline means. A closed cut through the board
 * frees whatever it encloses, so an outline inside an even number of others
 * frees a piece of kept material and one inside an odd number frees a slug
 * of waste. Each workspace decides what those pieces are for; this module
 * only measures. Outlines that cross or touch have no single depth, and are
 * left for the workspace's validation to name.
 */

/** Largest deviation, in mm, of a flattened curve from the drawing: well under a router's accuracy. */
export const OUTLINE_IMPORT_TOLERANCE = 0.05;

export type NestedOutline = {
	/** Counter-clockwise, in sheet millimetres, as the drawing placed it. */
	readonly points: readonly Point[];
	/** How many other outlines enclose this one. */
	readonly depth: number;
};

export type ImportedOutlines = {
	readonly outlines: readonly NestedOutline[];
	/** What was left out, as phrases for the operator: "2 open paths". */
	readonly skipped: readonly string[];
};

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** Signed area, positive counter-clockwise. */
export function signedArea(points: readonly Point[]): number {
	return (
		points.reduce((sum, vertex, index) => {
			const next = points[(index + 1) % points.length]!;
			return sum + vertex.x * next.y - next.x * vertex.y;
		}, 0) / 2
	);
}

export function perimeter(points: readonly Point[]): number {
	return points.reduce((sum, vertex, index) => {
		const next = points[(index + 1) % points.length]!;
		return sum + Math.hypot(next.x - vertex.x, next.y - vertex.y);
	}, 0);
}

/**
 * Each outline's nesting depth. An outline is inside another when a vertex of
 * it is; for outlines that do not cross, any vertex gives the same answer.
 */
export function nestingDepths(outlines: readonly (readonly Point[])[]): NestedOutline[] {
	const bounds = outlines.map(outlineBounds);
	return outlines.map((points, index) => {
		const box = bounds[index]!;
		const probe = points[0]!;
		const depth = outlines.filter((other, otherIndex) => {
			if (otherIndex === index) return false;
			const around = bounds[otherIndex]!;
			const encloses =
				box.left >= around.left &&
				box.right <= around.right &&
				box.bottom >= around.bottom &&
				box.top <= around.top;
			return encloses && pointInOutline(probe, other);
		}).length;
		return { points, depth };
	});
}

/**
 * The same outline drawn twice, as a filled shape and its stroke often are.
 * Cutting both would cut the line twice and leave no single nesting.
 */
function sameOutline(a: readonly Point[], b: readonly Point[]): boolean {
	const first = outlineBounds(a);
	const second = outlineBounds(b);
	const close = (x: number, y: number) => Math.abs(x - y) <= OUTLINE_IMPORT_TOLERANCE;
	return (
		close(first.left, second.left) &&
		close(first.right, second.right) &&
		close(first.bottom, second.bottom) &&
		close(first.top, second.top) &&
		Math.abs(Math.abs(signedArea(a)) - Math.abs(signedArea(b))) <=
			OUTLINE_IMPORT_TOLERANCE * Math.max(perimeter(a), perimeter(b))
	);
}

/**
 * The closed outlines of an SVG drawing, ready to cut: counter-clockwise, at
 * least `minSize` mm across both ways, without duplicates, with their depths.
 * Throws with a message for the operator when the file is not an SVG or
 * holds no closed outline.
 */
export function importSvgOutlines(
	text: string,
	fileName: string,
	minSize: number,
	/** What the workspace makes from outlines, for the error: "parts and holes". */
	noun: string
): ImportedOutlines {
	const read = readSvgOutlines(text, { tolerance: OUTLINE_IMPORT_TOLERANCE });
	const skipped: string[] = [];
	if (read.openCount) skipped.push(plural(read.openCount, 'open path'));

	const sized = read.closed.filter((points) => {
		const box = outlineBounds(points);
		return box.right - box.left >= minSize && box.top - box.bottom >= minSize;
	});
	if (sized.length < read.closed.length) {
		skipped.push(`${plural(read.closed.length - sized.length, 'outline')} under ${minSize} mm`);
	}
	const distinct = sized.filter(
		(points, index) => !sized.slice(0, index).some((earlier) => sameOutline(points, earlier))
	);
	if (distinct.length < sized.length) {
		skipped.push(plural(sized.length - distinct.length, 'duplicate outline'));
	}
	skipped.push(...read.unsupported.map((name) => `${name} elements`));

	if (!distinct.length) {
		const reason = skipped.length ? ` Skipped ${skipped.join(', ')}.` : '';
		throw new Error(
			`No closed outlines to cut in ${fileName}: ${noun} need closed outlines.${reason}`
		);
	}
	const wound = distinct.map((points) => (signedArea(points) < 0 ? [...points].reverse() : points));
	return { outlines: nestingDepths(wound), skipped };
}

/** An outline as a box and its vertices as fractions of that box, which is how workspaces store one. */
export function boxedOutline(points: readonly Point[]): {
	x: number;
	y: number;
	w: number;
	h: number;
	fractions: Point[];
} {
	const box = outlineBounds(points);
	const x = round(box.left);
	const y = round(box.bottom);
	const w = round(box.right - box.left);
	const h = round(box.top - box.bottom);
	return {
		x,
		y,
		w,
		h,
		fractions: points.map((vertex) => ({ x: (vertex.x - x) / w, y: (vertex.y - y) / h }))
	};
}

/** The drawing's overall size, for the import notice, so a wrong scale is obvious. */
export function drawingSize(outlines: readonly NestedOutline[]): string {
	const box = outlineBounds(outlines.flatMap((outline) => outline.points));
	return `${round(box.right - box.left, 1)} × ${round(box.top - box.bottom, 1)} mm`;
}
