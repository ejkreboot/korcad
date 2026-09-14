import type { DesignPath } from '$lib/core/design/types.js';
import {
	closedPath,
	foldIntent,
	INTERIOR_HOLE,
	line,
	ownerGroup,
	pocketOwner,
	type PathMeta
} from './paths.js';
import { arcPoints, point, type Point } from '$lib/core/geometry/primitives.js';
import { shapeOutline, splitSide } from '$lib/core/geometry/outline.js';
import { clamp } from '$lib/core/units.js';
import { flatPanel, bendDeduction, type FoldSettings } from './fold.js';
import type { Side } from '$lib/core/design/types.js';
import type { Pocket } from './types.js';

type Bounds = {
	readonly left: number;
	readonly right: number;
	readonly bottom: number;
	readonly top: number;
};

// ---- fold allowance ------------------------------------------------------

/** A pocket with its folded panels reduced to their flat widths. */
function flatPocket(pocket: Pocket, settings: FoldSettings): Pocket {
	if (!bendDeduction(settings)) return pocket;
	return {
		...pocket,
		wallDepth: flatPanel(pocket.wallDepth, settings),
		flange: flatPanel(pocket.flange, settings)
	};
}

// ---- shared edge helpers -------------------------------------------------

export { splitSide, type Span } from '$lib/core/geometry/outline.js';

/**
 * A narrow slot running from `outer` to `inner`, clipped to `bounds`. Corner
 * relief lets two adjacent walls fold up without their material colliding.
 */
function boundedReliefSlot(
	outer: Point,
	inner: Point,
	width: number,
	bounds: Bounds,
	meta: PathMeta
): DesignPath {
	const dx = inner.x - outer.x;
	const dy = inner.y - outer.y;
	const length = Math.hypot(dx, dy) || 1;
	const nx = ((-dy / length) * width) / 2;
	const ny = ((dx / length) * width) / 2;
	const inside = (p: Point) =>
		point(clamp(p.x, bounds.left, bounds.right), clamp(p.y, bounds.bottom, bounds.top));
	return closedPath(
		[
			inside(point(outer.x + nx, outer.y + ny)),
			inside(point(inner.x + nx, inner.y + ny)),
			inside(point(inner.x - nx, inner.y - ny)),
			inside(point(outer.x - nx, outer.y - ny))
		],
		'cut',
		meta
	);
}

function reliefSlot(outer: Point, inner: Point, width: number, pocket: Pocket): DesignPath {
	return boundedReliefSlot(
		outer,
		inner,
		width,
		{ left: pocket.x, right: pocket.x + pocket.w, bottom: pocket.y, top: pocket.y + pocket.h },
		{ cam: INTERIOR_HOLE, role: 'corner-relief', owner: pocketOwner(pocket) }
	);
}

// ---- pocket geometry -----------------------------------------------------

/**
 * The central opening outline, with a half-round finger scallop cut into any
 * side that has a pull but no wall to carry it.
 */
export function openingCutPoints(inner: Bounds, pocket: Pocket): Point[] {
	const radius = pocket.pullDiameter / 2;
	const points: Point[] = [point(inner.left, inner.bottom)];
	if (pocket.pulls.bottom && !pocket.sides.bottom) {
		const cx = (inner.left + inner.right) / 2;
		points.push(point(cx - radius, inner.bottom));
		points.push(...arcPoints(cx, inner.bottom, radius, Math.PI, Math.PI * 2).slice(1));
	}
	points.push(point(inner.right, inner.bottom));
	if (pocket.pulls.right && !pocket.sides.right) {
		const cy = (inner.bottom + inner.top) / 2;
		points.push(point(inner.right, cy - radius));
		points.push(...arcPoints(inner.right, cy, radius, -Math.PI / 2, Math.PI / 2).slice(1));
	}
	points.push(point(inner.right, inner.top));
	if (pocket.pulls.top && !pocket.sides.top) {
		const cx = (inner.left + inner.right) / 2;
		points.push(point(cx + radius, inner.top));
		points.push(...arcPoints(cx, inner.top, radius, 0, Math.PI).slice(1));
	}
	points.push(point(inner.left, inner.top));
	if (pocket.pulls.left && !pocket.sides.left) {
		const cy = (inner.bottom + inner.top) / 2;
		points.push(point(inner.left, cy + radius));
		points.push(...arcPoints(inner.left, cy, radius, Math.PI / 2, (Math.PI * 3) / 2).slice(1));
	}
	return points;
}

/**
 * A finger pull cut into a folded wall. The scallop is centred on the pocket
 * edge and continues `pullDepth` into the wall, stopping short of the flange
 * fold so the wall keeps a continuous hinge.
 */
export function wallFingerPull(pocket: Pocket, side: Side): DesignPath {
	const radius = pocket.pullDiameter / 2;
	const depth = clamp(pocket.pullDepth, 1, Math.max(1, pocket.wallDepth - pocket.relief / 2));
	const centers: Record<Side, Point> = {
		top: point(pocket.x + pocket.w / 2, pocket.y + pocket.h),
		right: point(pocket.x + pocket.w, pocket.y + pocket.h / 2),
		bottom: point(pocket.x + pocket.w / 2, pocket.y),
		left: point(pocket.x, pocket.y + pocket.h / 2)
	};
	const tangents: Record<Side, Point> = {
		top: point(1, 0),
		right: point(0, 1),
		bottom: point(1, 0),
		left: point(0, 1)
	};
	const inward: Record<Side, Point> = {
		top: point(0, -1),
		right: point(-1, 0),
		bottom: point(0, 1),
		left: point(1, 0)
	};
	const c = centers[side];
	const t = tangents[side];
	const n = inward[side];
	const local = (u: number, v: number) => point(c.x + t.x * u + n.x * v, c.y + t.y * u + n.y * v);

	const points: Point[] = [local(-radius, 0)];
	for (let i = 1; i <= 12; i++) {
		const angle = Math.PI - (Math.PI * i) / 12;
		points.push(local(radius * Math.cos(angle), -radius * Math.sin(angle)));
	}
	points.push(local(radius, depth), local(-radius, depth));
	return closedPath(points, 'cut', {
		cam: INTERIOR_HOLE,
		role: `finger-pull-${side}`,
		owner: pocketOwner(pocket)
	});
}

/** The outline of a non-folded cutout, by shape. */
export function cutoutPoints(pocket: Pocket): Point[] {
	if (pocket.shape === 'profile' && pocket.profile) {
		const points = pocket.profile.map((vertex) =>
			point(pocket.x + vertex.x * pocket.w, pocket.y + vertex.y * pocket.h)
		);
		const area = points.reduce((sum, current, index) => {
			const next = points[(index + 1) % points.length]!;
			return sum + current.x * next.y - next.x * current.y;
		}, 0);
		// Imported profiles are wound consistently so compensation offsets inward.
		return area >= 0 ? points : points.reverse();
	}
	// Every other shape is a basic outline, shared with the other workspaces.
	return shapeOutline(
		pocket.shape === 'profile' ? 'rectangle' : pocket.shape,
		pocket,
		pocket.cornerRadius
	);
}

const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

/**
 * Flat geometry for one pocket. A non-rectangular pocket is a single through
 * cut; a rectangular one may additionally carry inward-folding walls, glue
 * flanges, corner relief slots, and finger pulls.
 */
export function pocketPaths(nominalPocket: Pocket, settings: FoldSettings): DesignPath[] {
	const p = flatPocket(nominalPocket, settings);
	if (p.shape !== 'rectangle') {
		return [
			closedPath(cutoutPoints(p), 'cut', {
				cam: INTERIOR_HOLE,
				role: 'central-cutout',
				owner: pocketOwner(p)
			})
		];
	}
	const f = p.flangeEnabled ? p.flange : 0;
	const inset = {
		top: p.sides.top ? p.wallDepth + f : 0,
		right: p.sides.right ? p.wallDepth + f : 0,
		bottom: p.sides.bottom ? p.wallDepth + f : 0,
		left: p.sides.left ? p.wallDepth + f : 0
	};
	const inner: Bounds = {
		left: p.x + inset.left,
		right: p.x + p.w - inset.right,
		bottom: p.y + inset.bottom,
		top: p.y + p.h - inset.top
	};
	if (inner.right <= inner.left || inner.top <= inner.bottom) return [];

	const owner = pocketOwner(p);
	const fold = (role: string): PathMeta => ({
		cam: foldIntent(ownerGroup(owner), role),
		role,
		owner
	});
	const paths: DesignPath[] = [];
	paths.push(
		closedPath(openingCutPoints(inner, p), 'cut', {
			cam: INTERIOR_HOLE,
			role: 'central-cutout',
			owner: pocketOwner(p)
		})
	);
	for (const side of SIDES) {
		if (p.pulls[side] && p.sides[side]) paths.push(wallFingerPull(p, side));
	}

	const corners: readonly (readonly [Point, Point])[] = [
		[point(p.x, p.y), point(inner.left, inner.bottom)],
		[point(p.x + p.w, p.y), point(inner.right, inner.bottom)],
		[point(p.x + p.w, p.y + p.h), point(inner.right, inner.top)],
		[point(p.x, p.y + p.h), point(inner.left, inner.top)]
	];
	for (const [a, b] of corners) {
		if (Math.hypot(b.x - a.x, b.y - a.y) > 0.01) paths.push(reliefSlot(a, b, p.relief, p));
	}

	// Wall folds stop short of the corners by `r` so the relief slots stay clear.
	const r = Math.max(p.relief * 0.8, 0.5);
	const addTopFold = (a: Point, b: Point, side: Side) => {
		const spans = p.pulls[side]
			? splitSide(a, b, 1, p.pullDiameter).filter((span) => !span.tab)
			: [{ points: [a, b] as const, tab: false }];
		spans.forEach((span) =>
			paths.push(line(span.points[0]!, span.points[1]!, 'score', fold('top-fold')))
		);
	};
	const flangeFold = (a: Point, b: Point) => paths.push(line(a, b, 'score', fold('flange-fold')));

	if (p.sides.top) {
		addTopFold(point(p.x + r, p.y + p.h), point(p.x + p.w - r, p.y + p.h), 'top');
		if (p.flangeEnabled) {
			flangeFold(
				point(p.x + p.wallDepth + r, p.y + p.h - p.wallDepth),
				point(p.x + p.w - p.wallDepth - r, p.y + p.h - p.wallDepth)
			);
		}
	}
	if (p.sides.bottom) {
		addTopFold(point(p.x + r, p.y), point(p.x + p.w - r, p.y), 'bottom');
		if (p.flangeEnabled) {
			flangeFold(
				point(p.x + p.wallDepth + r, p.y + p.wallDepth),
				point(p.x + p.w - p.wallDepth - r, p.y + p.wallDepth)
			);
		}
	}
	if (p.sides.left) {
		addTopFold(point(p.x, p.y + r), point(p.x, p.y + p.h - r), 'left');
		if (p.flangeEnabled) {
			flangeFold(
				point(p.x + p.wallDepth, p.y + p.wallDepth + r),
				point(p.x + p.wallDepth, p.y + p.h - p.wallDepth - r)
			);
		}
	}
	if (p.sides.right) {
		addTopFold(point(p.x + p.w, p.y + r), point(p.x + p.w, p.y + p.h - r), 'right');
		if (p.flangeEnabled) {
			flangeFold(
				point(p.x + p.w - p.wallDepth, p.y + p.wallDepth + r),
				point(p.x + p.w - p.wallDepth, p.y + p.h - p.wallDepth - r)
			);
		}
	}

	return paths.filter((path) =>
		path.points.every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y))
	);
}

/** The outline an opening removes from its board: its full box, finger pulls included. */
export function openingOutline(pocket: Pocket): Point[] {
	return pocket.shape !== 'rectangle'
		? cutoutPoints(pocket)
		: openingCutPoints(
				{ left: pocket.x, right: pocket.x + pocket.w, bottom: pocket.y, top: pocket.y + pocket.h },
				{ ...pocket, sides: { top: false, right: false, bottom: false, left: false } }
			);
}
