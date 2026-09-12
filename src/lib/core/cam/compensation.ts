import { normalizeAngle, point, unit, type Point } from '$lib/core/geometry/primitives.js';
import type { DesignPath, MachineSettings } from '$lib/core/design/types.js';

/** The machine settings compensation depends on. */
export type CompensationSettings = Pick<
	MachineSettings,
	'fabricationMode' | 'bitWidth' | 'bladeOffset' | 'overcut' | 'cornerStep' | 'scoreTool'
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
	if (offset <= 0 || desired.length < 2) return desired;

	const result: Point[] = [];
	let direction = unit(desired[0]!, desired[1]!);
	result.push(point(desired[0]!.x + direction.x * offset, desired[0]!.y + direction.y * offset));
	for (let i = 1; i < desired.length; i++) {
		const vertex = desired[i]!;
		result.push(point(vertex.x + direction.x * offset, vertex.y + direction.y * offset));
		if (i < desired.length - 1) {
			const next = unit(vertex, desired[i + 1]!);
			const startAngle = Math.atan2(direction.y, direction.x);
			const delta = normalizeAngle(Math.atan2(next.y, next.x) - startAngle);
			const steps = Math.max(
				1,
				Math.ceil(Math.abs(delta) / ((settings.cornerStep * Math.PI) / 180))
			);
			for (let step = 1; step <= steps; step++) {
				const angle = startAngle + (delta * step) / steps;
				result.push(
					point(vertex.x + Math.cos(angle) * offset, vertex.y + Math.sin(angle) * offset)
				);
			}
			direction = next;
		}
	}
	return result;
}

export type Operation = 'all' | 'cut' | 'crease';

/**
 * The programmed axis path for one design path. A creasing wheel has no
 * trailing offset, so up-folds run on the nominal line when the crease
 * program is being generated.
 */
export function toolpathPoints(
	path: DesignPath,
	settings: CompensationSettings,
	operation: Operation = 'all'
): Point[] {
	if (settings.fabricationMode === 'router') return routerCompensatedPoints(path, settings);
	if (
		path.type === 'score' &&
		path.foldDirection === 'up' &&
		settings.scoreTool === 'crease' &&
		(operation === 'crease' || operation === 'all')
	) {
		return path.points.map((p) => point(p.x, p.y));
	}
	return compensatedPoints(path, settings);
}
