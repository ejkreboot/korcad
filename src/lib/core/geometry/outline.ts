import { clamp, round } from '$lib/core/units.js';
import { arcPoints, point, type Point } from './primitives.js';

/**
 * Closed outlines of the basic drawn shapes, and holding tabs along an edge.
 * Shared by every workspace: a packaging cutout and a Flat Parts sheet are drawn
 * from the same outlines, so they cut identically.
 */

/** A shape drawn into an axis-aligned box, origin at its lower-left corner. */
export type ShapeBox = {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
};

export type BasicShape = 'rectangle' | 'rounded' | 'ellipse';

/**
 * The outline of a basic shape, counter-clockwise from the lower left.
 *
 * A rounded rectangle's radius is clamped to half the shorter side, and a
 * radius of zero means fully rounded, which is what makes a slot.
 */
export function shapeOutline(shape: BasicShape, box: ShapeBox, cornerRadius = 0): Point[] {
	if (shape === 'ellipse') {
		const cx = box.x + box.w / 2;
		const cy = box.y + box.h / 2;
		return Array.from({ length: 49 }, (_, index) => {
			const angle = (Math.PI * 2 * index) / 48;
			return point(cx + Math.cos(angle) * box.w * 0.5, cy + Math.sin(angle) * box.h * 0.5);
		});
	}
	if (shape === 'rounded') {
		const radius = Math.min(cornerRadius || Math.min(box.w, box.h) / 2, box.w / 2, box.h / 2);
		return [
			...arcPoints(box.x + radius, box.y + radius, radius, Math.PI, Math.PI * 1.5, 8),
			...arcPoints(
				box.x + box.w - radius,
				box.y + radius,
				radius,
				Math.PI * 1.5,
				Math.PI * 2,
				8
			).slice(1),
			...arcPoints(box.x + box.w - radius, box.y + box.h - radius, radius, 0, Math.PI / 2, 8).slice(
				1
			),
			...arcPoints(box.x + radius, box.y + box.h - radius, radius, Math.PI / 2, Math.PI, 8).slice(1)
		];
	}
	return [
		point(box.x, box.y),
		point(box.x + box.w, box.y),
		point(box.x + box.w, box.y + box.h),
		point(box.x, box.y + box.h)
	];
}

/**
 * A regular polygon inscribed in the ellipse of its box, counter-clockwise,
 * turned so one edge lies flat along the bottom.
 */
export function regularPolygon(box: ShapeBox, sides: number): Point[] {
	const count = Math.max(3, Math.round(sides));
	const cx = box.x + box.w / 2;
	const cy = box.y + box.h / 2;
	const start = -Math.PI / 2 - Math.PI / count;
	return Array.from({ length: count }, (_, index) => {
		const angle = start + (Math.PI * 2 * index) / count;
		return point(cx + Math.cos(angle) * box.w * 0.5, cy + Math.sin(angle) * box.h * 0.5);
	});
}

export type Span = { readonly points: readonly [Point, Point]; readonly tab: boolean };

/**
 * Splits an edge into alternating cut spans and holding tabs, with the tabs
 * spaced evenly along the edge. Holding tabs keep a released part attached to
 * the sheet until the operator removes it.
 */
export function splitSide(a: Point, b: Point, tabCount: number, tabWidth: number): Span[] {
	if (!tabCount || !tabWidth) return [{ points: [a, b], tab: false }];
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = Math.hypot(dx, dy);
	const ux = dx / length;
	const uy = dy / length;
	const tabs = Array.from(
		{ length: tabCount },
		(_, index) => (length * (index + 1)) / (tabCount + 1)
	);
	const spans: Span[] = [];
	let cursor = 0;
	tabs.forEach((center) => {
		const t0 = clamp(center - tabWidth / 2, cursor, length);
		const t1 = clamp(center + tabWidth / 2, t0, length);
		if (t0 > cursor) {
			spans.push({
				points: [point(a.x + ux * cursor, a.y + uy * cursor), point(a.x + ux * t0, a.y + uy * t0)],
				tab: false
			});
		}
		spans.push({
			points: [point(a.x + ux * t0, a.y + uy * t0), point(a.x + ux * t1, a.y + uy * t1)],
			tab: true
		});
		cursor = t1;
	});
	if (cursor < length) {
		spans.push({ points: [point(a.x + ux * cursor, a.y + uy * cursor), b], tab: false });
	}
	return spans;
}

/** A closed outline broken by holding tabs: open cut runs, and the gaps between them. */
export type TabbedContour = {
	readonly runs: readonly (readonly Point[])[];
	readonly tabs: readonly (readonly [Point, Point])[];
};

type ContourMeasure = {
	/** The outline with its first vertex repeated at the end. */
	readonly vertices: readonly Point[];
	readonly lengths: readonly number[];
	readonly perimeter: number;
	/** The point `distance` along the outline, and the edge it falls on. */
	readonly at: (distance: number) => { point: Point; edge: number };
};

function measureContour(outline: readonly Point[]): ContourMeasure {
	const vertices = [...outline, outline[0]!];
	const lengths = vertices.slice(1).map((vertex, index) => {
		const previous = vertices[index]!;
		return Math.hypot(vertex.x - previous.x, vertex.y - previous.y);
	});
	const perimeter = lengths.reduce((sum, length) => sum + length, 0);
	const at = (distance: number): { point: Point; edge: number } => {
		let remaining = distance;
		for (let edge = 0; edge < lengths.length; edge++) {
			const length = lengths[edge]!;
			if (remaining <= length || edge === lengths.length - 1) {
				const a = vertices[edge]!;
				const b = vertices[edge + 1]!;
				const t = length ? clamp(remaining / length, 0, 1) : 0;
				return { point: point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t), edge };
			}
			remaining -= length;
		}
		return { point: vertices[0]!, edge: 0 };
	};
	return { vertices, lengths, perimeter, at };
}

/** Whether `tabCount` tabs of `tabWidth` leave material to cut between them. */
function tabsFit(perimeter: number, count: number, tabWidth: number): boolean {
	return count > 0 && tabWidth > 0 && count * tabWidth < perimeter;
}

/**
 * The centre of each of `tabCount` holding tabs spaced evenly around a closed
 * outline, the first half a spacing from the first vertex — the same places
 * `splitClosedContour` leaves its gaps. Empty when the tabs would not fit.
 */
export function holdingTabCentres(
	outline: readonly Point[],
	tabCount: number,
	tabWidth: number
): Point[] {
	const count = Math.max(0, Math.floor(tabCount));
	const { perimeter, at } = measureContour(outline);
	if (!tabsFit(perimeter, count, tabWidth)) return [];
	const spacing = perimeter / count;
	return Array.from({ length: count }, (_, index) => at(spacing * (index + 0.5)).point);
}

/**
 * Breaks a closed outline into cut runs separated by `tabCount` holding tabs of
 * `tabWidth`, measured along the outline and spaced evenly around it, the first
 * centred half a spacing from the first vertex. Each run keeps the outline's
 * direction and every vertex it passes, so a curved outline stays curved.
 *
 * Returns the whole outline as one closed run when there are no tabs, or when
 * the tabs would not leave material to cut between them.
 */
export function splitClosedContour(
	outline: readonly Point[],
	tabCount: number,
	tabWidth: number
): TabbedContour {
	const count = Math.max(0, Math.floor(tabCount));
	const { vertices, lengths, perimeter, at } = measureContour(outline);
	if (!tabsFit(perimeter, count, tabWidth)) {
		return { runs: [vertices], tabs: [] };
	}

	const spacing = perimeter / count;
	const gaps = Array.from({ length: count }, (_, index) => {
		const centre = spacing * (index + 0.5);
		return [centre - tabWidth / 2, centre + tabWidth / 2] as const;
	});
	const tabs = gaps.map(([start, end]) => [at(start).point, at(end).point] as const);
	// A run goes from the end of one tab to the start of the next; the last run
	// wraps past the first vertex to reach the first tab.
	const runs = gaps.map(([, end], index) => {
		const last = index === count - 1;
		const from = at(end);
		const to = at(gaps[(index + 1) % count]![0]);
		const edges = last ? to.edge + lengths.length : to.edge;
		const points: Point[] = [from.point];
		for (let edge = from.edge; edge < edges; edge++) {
			points.push(vertices[(edge % lengths.length) + 1]!);
		}
		points.push(to.point);
		return points.filter(
			(vertex, position) =>
				position === 0 ||
				Math.hypot(vertex.x - points[position - 1]!.x, vertex.y - points[position - 1]!.y) > 1e-9
		);
	});
	return { runs, tabs };
}

/**
 * A box scaled by `factor` about `anchor`: its corner moves away from the
 * anchor in proportion and its size grows with it, so a shape drawn in the box
 * keeps its proportions and its place relative to the others scaled with it.
 */
export function scaleBox(box: ShapeBox, anchor: Point, factor: number): ShapeBox {
	return {
		x: round(anchor.x + (box.x - anchor.x) * factor),
		y: round(anchor.y + (box.y - anchor.y) * factor),
		w: round(box.w * factor),
		h: round(box.h * factor)
	};
}

/** The smallest box holding every box given; `null` for none. */
export function boxAround(boxes: readonly ShapeBox[]): ShapeBox | null {
	if (!boxes.length) return null;
	const left = Math.min(...boxes.map((box) => box.x));
	const bottom = Math.min(...boxes.map((box) => box.y));
	const right = Math.max(...boxes.map((box) => box.x + box.w));
	const top = Math.max(...boxes.map((box) => box.y + box.h));
	return { x: left, y: bottom, w: right - left, h: top - bottom };
}

export type BoxCorner = 'nw' | 'ne' | 'sw' | 'se';

/**
 * One scale factor for a box that must keep its proportions, from a free
 * resize of it: whichever axis changed more, so dragging a corner mostly
 * sideways still scales by the sideways drag. The anchor is the corner
 * opposite the dragged one, which stays still.
 */
export function proportionalResize(
	original: ShapeBox,
	resized: ShapeBox,
	handle: BoxCorner
): { factor: number; anchor: Point } {
	const sx = original.w > 0 ? resized.w / original.w : 1;
	const sy = original.h > 0 ? resized.h / original.h : 1;
	const factor = Math.abs(Math.log(sx)) >= Math.abs(Math.log(sy)) ? sx : sy;
	const anchor = point(
		handle.includes('w') ? original.x + original.w : original.x,
		handle.includes('s') ? original.y + original.h : original.y
	);
	return { factor, anchor };
}
