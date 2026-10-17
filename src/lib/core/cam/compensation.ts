import { normalizeAngle, point, unit, type Point } from '$lib/core/geometry/primitives.js';
import type { DesignPath, MachineSettings } from '$lib/core/design/types.js';

/** The machine settings compensation depends on. */
export type CompensationSettings = Pick<
	MachineSettings,
	| 'fabricationMode'
	| 'bitWidth'
	| 'bladeOffset'
	| 'overcut'
	| 'cornerStep'
	| 'scoreTool'
	| 'swivelDepth'
	| 'liftAngle'
	| 'liftRadius'
>;

/**
 * Offsets a closed polygon by `distance`, positive being outward relative to
 * the polygon's own winding. Miters are used where the adjacent edges
 * intersect close enough to the vertex; otherwise the angle bisector is used
 * so that a sharp corner cannot throw the offset point far off the part.
 */
export function offsetClosedPath(points: readonly Point[], distance: number): Point[] {
	const source = points
		.map((p) => point(p.x, p.y))
		.filter(
			(p, index, list) =>
				index === 0 || Math.hypot(p.x - list[index - 1]!.x, p.y - list[index - 1]!.y) > 0.0001
		);
	if (
		source.length > 2 &&
		Math.hypot(
			source[0]!.x - source[source.length - 1]!.x,
			source[0]!.y - source[source.length - 1]!.y
		) < 0.0001
	) {
		source.pop();
	}
	if (source.length < 3 || distance === 0) return source;

	const area = source.reduce((sum, vertex, index) => {
		const next = source[(index + 1) % source.length]!;
		return sum + vertex.x * next.y - next.x * vertex.y;
	}, 0);
	const winding = area >= 0 ? 1 : -1;
	const edge = (a: Point, b: Point) => {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const length = Math.hypot(dx, dy) || 1;
		return {
			x: dx / length,
			y: dy / length,
			nx: (winding * dy) / length,
			ny: (-winding * dx) / length
		};
	};

	return source.map((vertex, index) => {
		const previous = source[(index - 1 + source.length) % source.length]!;
		const next = source[(index + 1) % source.length]!;
		const before = edge(previous, vertex);
		const after = edge(vertex, next);
		const a = point(vertex.x + before.nx * distance, vertex.y + before.ny * distance);
		const b = point(vertex.x + after.nx * distance, vertex.y + after.ny * distance);
		const denominator = before.x * after.y - before.y * after.x;
		if (Math.abs(denominator) > 0.000001) {
			const t = ((b.x - a.x) * after.y - (b.y - a.y) * after.x) / denominator;
			const intersection = point(a.x + before.x * t, a.y + before.y * t);
			if (
				Math.hypot(intersection.x - vertex.x, intersection.y - vertex.y) <=
				Math.abs(distance) * 8
			) {
				return intersection;
			}
		}
		const nx = before.nx + after.nx;
		const ny = before.ny + after.ny;
		const length = Math.hypot(nx, ny) || 1;
		return point(vertex.x + (nx / length) * distance, vertex.y + (ny / length) * distance);
	});
}

/**
 * Router compensation: the bit centre runs half a bit width off the drawn line,
 * on whichever side the path states. A part outline is cut outside so the part
 * keeps its size; a hole is cut inside so the hole does. A path cut on the line
 * itself — an engraving — is left where it was drawn.
 */
export function routerCompensatedPoints(path: DesignPath, settings: CompensationSettings): Point[] {
	if (path.cam.offsetSide === 'on') {
		const nominal = path.points.map((p) => point(p.x, p.y));
		return path.closed && nominal.length
			? [...nominal, point(nominal[0]!.x, nominal[0]!.y)]
			: nominal;
	}
	const radius = settings.bitWidth / 2;
	const distance = path.cam.offsetSide === 'outside' ? radius : -radius;
	const points = offsetClosedPath(path.points, distance);
	return points.length ? [...points, point(points[0]!.x, points[0]!.y)] : [];
}

/**
 * Drag-knife compensation. The blade tip trails the spindle axis by
 * `bladeOffset`, so the programmed axis path leads the desired cut by that
 * distance and every direction change is swung around the vertex in
 * `cornerStep` degree increments. Closed contours get an `overcut` past the
 * start point so the final corner releases cleanly.
 */
export function compensatedPoints(path: DesignPath, settings: CompensationSettings): Point[] {
	return compensatedToolpath(path, settings).points;
}

/**
 * A swing about a corner that the blade makes lifted to swivel depth: it
 * reaches `points[from]` at depth, rises, swings through to `points[to]`, and
 * plunges back.
 */
export type LiftedTurn = { readonly from: number; readonly to: number };

/** A knife's programmed axis path, and the turns on it made lifted. */
export type KnifeToolpath = {
	readonly points: Point[];
	readonly lifts: readonly LiftedTurn[];
};

/**
 * `compensatedPoints`, marking the swings to make lifted. Lifting never moves
 * the axis in XY, so the points are the same whatever the lift settings.
 *
 * The blade may turn at most `liftAngle` at depth within a window of cut,
 * `liftWindow`. A curve of radius r turns the blade `window / r` over that
 * window, which passes `liftAngle` exactly when r is under `window /
 * liftAngle`; a single corner passes it when it is sharper than `liftAngle`.
 * Turns made lifted do not count against the blade afterwards.
 */
function compensatedToolpath(path: DesignPath, settings: CompensationSettings): KnifeToolpath {
	const desired: Point[] = path.points.map((p) => point(p.x, p.y));
	if (path.closed) {
		desired.push(point(desired[0]!.x, desired[0]!.y));
		const overcut = path.overcut ?? settings.overcut;
		if (overcut > 0) {
			const direction = unit(desired[0]!, desired[1]!);
			desired.push(
				point(desired[0]!.x + direction.x * overcut, desired[0]!.y + direction.y * overcut)
			);
		}
	}
	const offset = path.bladeOffset ?? settings.bladeOffset;
	if (offset <= 0 || desired.length < 2) return { points: desired, lifts: [] };

	const lifting = settings.swivelDepth > 0;
	const limit = (settings.liftAngle * Math.PI) / 180;
	const window = liftWindow(settings, offset);
	const lifts: LiftedTurn[] = [];
	// Turns made at depth inside the window: where along the cut, and how far.
	let recent: { readonly at: number; readonly angle: number }[] = [];
	let along = 0;
	const result: Point[] = [];
	let direction = unit(desired[0]!, desired[1]!);
	result.push(point(desired[0]!.x + direction.x * offset, desired[0]!.y + direction.y * offset));
	for (let i = 1; i < desired.length; i++) {
		const vertex = desired[i]!;
		along += Math.hypot(vertex.x - desired[i - 1]!.x, vertex.y - desired[i - 1]!.y);
		result.push(point(vertex.x + direction.x * offset, vertex.y + direction.y * offset));
		if (i < desired.length - 1) {
			const next = unit(vertex, desired[i + 1]!);
			const startAngle = Math.atan2(direction.y, direction.x);
			const delta = normalizeAngle(Math.atan2(next.y, next.x) - startAngle);
			const from = result.length - 1;
			result.push(...swingPoints(vertex, startAngle, delta, offset, settings.cornerStep));
			if (lifting) {
				recent = recent.filter((turn) => along - turn.at < window);
				const atDepth = recent.reduce((sum, turn) => sum + turn.angle, Math.abs(delta));
				// The tolerance keeps a corner of exactly the lift angle at depth.
				if (atDepth > limit + 1e-9) {
					lifts.push({ from, to: result.length - 1 });
					recent = [];
				} else {
					recent.push({ at: along, angle: Math.abs(delta) });
				}
			}
			direction = next;
		}
	}
	return { points: result, lifts };
}

/**
 * The length of cut over which a knife's turns at depth add up against
 * `liftAngle`: `liftRadius × liftAngle`, so curves tighter than `liftRadius`
 * are turned lifted, but never less than two blade offsets. The blade swings
 * about a tip that trails the axis by one offset, so two turns closer than
 * twice that leave it no straight cut to settle on between them, and they
 * count as one turn.
 */
export function liftWindow(
	settings: Pick<CompensationSettings, 'liftAngle' | 'liftRadius'>,
	offset: number
): number {
	return Math.max(settings.liftRadius * ((settings.liftAngle * Math.PI) / 180), 2 * offset);
}

/**
 * Axis positions that turn a trailing blade about its tip at `tip`, from
 * heading `startAngle` through `delta` radians, in equal steps no larger than
 * `cornerStep` degrees. The axis stays `offset` from the tip throughout, so the
 * tip pivots in place. The position at `startAngle` itself is not included.
 */
export function swingPoints(
	tip: Point,
	startAngle: number,
	delta: number,
	offset: number,
	cornerStep: number
): Point[] {
	const steps = Math.max(1, Math.ceil(Math.abs(delta) / ((cornerStep * Math.PI) / 180)));
	const result: Point[] = [];
	for (let step = 1; step <= steps; step++) {
		const angle = startAngle + (delta * step) / steps;
		result.push(point(tip.x + Math.cos(angle) * offset, tip.y + Math.sin(angle) * offset));
	}
	return result;
}

export type Operation = 'all' | 'cut' | 'crease';

/** A creasing wheel has no trailing offset, so it runs up-folds on the nominal line. */
function creasedOnLine(
	path: DesignPath,
	settings: CompensationSettings,
	operation: Operation
): boolean {
	return (
		path.type === 'score' &&
		path.foldDirection === 'up' &&
		settings.scoreTool === 'crease' &&
		(operation === 'crease' || operation === 'all')
	);
}

/**
 * How far the tool's cutting point trails the axis on this path: the blade
 * offset of a drag knife, and zero for a router bit or creasing wheel, which
 * cut under the axis and have no heading to swivel.
 */
export function trailingOffset(
	path: DesignPath,
	settings: CompensationSettings,
	operation: Operation = 'all'
): number {
	if (settings.fabricationMode === 'router' || creasedOnLine(path, settings, operation)) return 0;
	return Math.max(0, path.bladeOffset ?? settings.bladeOffset);
}

/**
 * A knife or creasing wheel's programmed axis path, with the turns it makes
 * lifted. A creasing wheel has no trailing offset, so up-folds run on the
 * nominal line, unlifted, when the crease program is being generated.
 */
export function knifeToolpath(
	path: DesignPath,
	settings: CompensationSettings,
	operation: Operation = 'all'
): KnifeToolpath {
	if (creasedOnLine(path, settings, operation)) {
		return { points: path.points.map((p) => point(p.x, p.y)), lifts: [] };
	}
	return compensatedToolpath(path, settings);
}

/** The programmed axis path for one design path. */
export function toolpathPoints(
	path: DesignPath,
	settings: CompensationSettings,
	operation: Operation = 'all'
): Point[] {
	if (settings.fabricationMode === 'router') return routerCompensatedPoints(path, settings);
	return knifeToolpath(path, settings, operation).points;
}
