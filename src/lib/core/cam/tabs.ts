import type { Point } from '$lib/core/geometry/primitives.js';

/** A programmed position with its depth. Z is zero at the material surface. */
export type ToolpathPoint = { readonly x: number; readonly y: number; readonly z: number };

export type BridgeTabSettings = {
	/** Tab centres, on or near the contour; each is projected onto it. */
	readonly centres: readonly Point[];
	/** Width of material the bridge leaves on the part edge, in mm. */
	readonly tabWidth: number;
	/** Thickness of material the bridge leaves above the underside of the board. */
	readonly tabHeight: number;
	readonly material: number;
	readonly bitWidth: number;
	/** The depth the rest of the contour is cut to, positive. */
	readonly cutDepth: number;
};

/** The depth of the tool over a bridge: the board's underside plus the tab's thickness. */
export function bridgeTabZ(settings: Pick<BridgeTabSettings, 'material' | 'tabHeight'>): number {
	return -(settings.material - settings.tabHeight);
}

/**
 * Raises the tool over holding tabs on a closed, compensated router contour.
 *
 * A router tab is a bridge, not a gap: the bit keeps cutting the contour but
 * rises to leave `tabHeight` of board over a short span, so the part stays
 * attached without the operator having to find and restart a broken path.
 *
 * Tabs are applied here, to the programmed points after compensation and route
 * planning, rather than to the drawn outline. Compensation needs a closed
 * contour to offset, and routing may rotate its start point; a tab placed by
 * position rather than by point index is unaffected by either.
 *
 * The raised span runs along the bit centre for `tabWidth + bitWidth`: the bit
 * cuts a radius beyond its centre at each end, so that leaves exactly
 * `tabWidth` of full-width bridge on the part edge. Each rise and drop is a
 * vertical move at the ends of the span.
 *
 * The contour is started outside every tab, so the plunge never lands on one;
 * when that moves the start to the end of a tab, the program ends on the tab.
 * Overlapping tabs are merged. Throws rather than emit a program that would
 * cut through its own tabs or leave nothing to cut between them; validation
 * rejects both before export.
 */
export function bridgeTabbedContour(
	pts: readonly Point[],
	settings: BridgeTabSettings
): ToolpathPoint[] {
	const cutZ = -settings.cutDepth;
	const tabZ = bridgeTabZ(settings);
	const closed = pts.length > 2 && samePoint(pts[0]!, pts.at(-1)!);
	if (!closed) throw new Error('Bridge tabs need a closed contour');
	if (!(tabZ > cutZ))
		throw new Error('Holding tabs would be cut through: the cut stops above them');
	if (!(tabZ < 0)) throw new Error('Holding tabs must be thinner than the board');

	const stations = [0];
	for (let index = 1; index < pts.length; index++) {
		stations.push(stations[index - 1]! + distanceBetween(pts[index - 1]!, pts[index]!));
	}
	const perimeter = stations.at(-1)!;
	const half = (settings.tabWidth + settings.bitWidth) / 2;
	if (!settings.centres.length || settings.tabWidth <= 0) {
		return pts.map((p) => ({ x: p.x, y: p.y, z: cutZ }));
	}

	const spans = mergedSpans(
		settings.centres.map((centre) => projectedStation(pts, stations, centre)),
		half,
		perimeter
	);
	const raised = spans.reduce((sum, [start, end]) => sum + end - start, 0);
	if (raised >= perimeter) throw new Error('Holding tabs leave nothing to cut between them');

	// Start where the contour already starts unless that is on a tab; then start
	// at the end of that tab. Spans are sorted, unrolled from that start.
	const containing = spans.find(([start, end]) => inSpan(0, start, end, perimeter));
	const origin = containing ? containing[1] % perimeter : 0;
	const unrolled = spans
		.map(([start, end]) => {
			const offset = (((start - origin) % perimeter) + perimeter) % perimeter;
			return [offset, offset + (end - start)] as const;
		})
		.sort((a, b) => a[0] - b[0]);

	type Break = { at: number; kind: 'vertex' | 'rise' | 'drop' };
	const breaks: Break[] = [];
	// Every vertex but the closing duplicate, including the original start when
	// the contour has been started somewhere else.
	for (let index = 0; index < stations.length - 1; index++) {
		const at = (((stations[index]! - origin) % perimeter) + perimeter) % perimeter;
		breaks.push({ at, kind: 'vertex' });
	}
	for (const [start, end] of unrolled) {
		breaks.push({ at: start, kind: 'rise' }, { at: end, kind: 'drop' });
	}
	breaks.push({ at: perimeter, kind: 'vertex' });
	// At equal stations a drop comes before a vertex before a rise, so a tab
	// ending on a corner drops before turning and one starting there turns first.
	const order = { drop: 0, vertex: 1, rise: 2 } as const;
	breaks.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);

	const pointAt = (offset: number): Point =>
		pointAtStation(pts, stations, (origin + offset) % perimeter);
	const start = pointAt(0);
	const result: ToolpathPoint[] = [{ x: start.x, y: start.y, z: cutZ }];
	const push = (p: Point, z: number) => {
		const last = result.at(-1)!;
		if (samePoint(last, p) && last.z === z) return;
		result.push({ x: p.x, y: p.y, z });
	};
	let z = cutZ;
	for (const entry of breaks) {
		const p = entry.at >= perimeter ? start : pointAt(entry.at);
		push(p, z);
		if (entry.kind === 'rise') z = tabZ;
		if (entry.kind === 'drop') z = cutZ;
		push(p, z);
	}
	// A tab that ends where the contour started leaves nothing to cut after its
	// drop, so the tool retracts from the tab rather than plunging to go up.
	const [beforeLast, last] = result.slice(-2);
	if (beforeLast && last && samePoint(beforeLast, last) && last.z < beforeLast.z) result.pop();
	return result;
}

const samePoint = (a: Point, b: Point, tolerance = 1e-6) =>
	Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

const distanceBetween = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

function inSpan(at: number, start: number, end: number, perimeter: number): boolean {
	const offset = (((at - start) % perimeter) + perimeter) % perimeter;
	return offset > 0 && offset < end - start;
}

/** Distance along the contour of the point on it nearest `target`. */
function projectedStation(
	pts: readonly Point[],
	stations: readonly number[],
	target: Point
): number {
	let best = { distance: Infinity, station: 0 };
	for (let index = 1; index < pts.length; index++) {
		const a = pts[index - 1]!;
		const b = pts[index]!;
		const length = stations[index]! - stations[index - 1]!;
		if (!length) continue;
		const t = Math.min(
			1,
			Math.max(0, ((target.x - a.x) * (b.x - a.x) + (target.y - a.y) * (b.y - a.y)) / length ** 2)
		);
		const distance = Math.hypot(a.x + (b.x - a.x) * t - target.x, a.y + (b.y - a.y) * t - target.y);
		if (distance < best.distance) best = { distance, station: stations[index - 1]! + t * length };
	}
	return best.station;
}

function pointAtStation(pts: readonly Point[], stations: readonly number[], at: number): Point {
	for (let index = 1; index < pts.length; index++) {
		if (at <= stations[index]! || index === pts.length - 1) {
			const a = pts[index - 1]!;
			const b = pts[index]!;
			const length = stations[index]! - stations[index - 1]!;
			const t = length ? Math.min(1, Math.max(0, (at - stations[index - 1]!) / length)) : 0;
			return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		}
	}
	return pts[0]!;
}

/**
 * Raised spans `[start, end]` around the contour, merged where they overlap. A
 * start may be negative or an end past the perimeter: a span can straddle the
 * contour's first point.
 */
function mergedSpans(
	centres: readonly number[],
	half: number,
	perimeter: number
): (readonly [number, number])[] {
	const sorted = [...centres].sort((a, b) => a - b).map((c) => [c - half, c + half] as const);
	const merged: [number, number][] = [];
	for (const [start, end] of sorted) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	// The last span may wrap into the first.
	if (merged.length > 1 && merged.at(-1)![1] - perimeter >= merged[0]![0]) {
		const last = merged.pop()!;
		merged[0] = [last[0] - perimeter, Math.max(merged[0]![1], last[1] - perimeter)];
	}
	return merged;
}
