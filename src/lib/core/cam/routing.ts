import { point, type Point } from '$lib/core/geometry/primitives.js';
import { round } from '$lib/core/units.js';
import type { DesignPath, DesignState, MachineSettings } from '$lib/core/design/types.js';
import { toolpathPoints, type CompensationSettings, type Operation } from './compensation.js';
import { STAGE_COUNT, stageIndex } from './stages.js';

export type RoutingSettings = CompensationSettings &
	Pick<DesignState, 'activeSheetId' | 'toolpathOrder'> &
	Pick<MachineSettings, 'safeZ' | 'scoreDepth' | 'cutDepth' | 'plungeFeed'>;

/** Rapid travel rate assumed when costing a route, in mm/min. */
const RAPID_FEED = 3000;

/**
 * A path under consideration for routing. Points and role are mutable here
 * because merging builds a new compound contour in place; the original design
 * paths it came from are never touched and are kept in `sourcePaths`.
 */
type RoutePath = Omit<DesignPath, 'points' | 'role'> & {
	points: Point[];
	role?: string;
	sourcePaths: DesignPath[];
};

export type RouteEntry = {
	/** The routed path, possibly reversed, rotated, or merged from several. */
	readonly path: DesignPath;
	/** The original design paths this entry machines, never mutated. */
	readonly sourcePaths: readonly DesignPath[];
	/** Programmed axis points, rounded to output precision. */
	readonly pts: readonly Point[];
};

type RouteVariant = {
	readonly entries: readonly RouteEntry[];
	readonly start: Point;
	readonly end: Point;
	readonly internalTravel: number;
};

type RouteUnit = { readonly variants: readonly RouteVariant[]; readonly stage: number };

export type PlannedToolpaths = {
	readonly paths: readonly RouteEntry[];
	readonly baselineTravel: number;
	readonly greedyTravel: number;
	readonly travel: number;
	readonly baselineLifts: number;
	readonly lifts: number;
	readonly baselineMotionTime: number;
	readonly motionTime: number;
	readonly strategy: 'design' | 'topology-aware';
};

/**
 * Machining dependency stage. Interior features are cut before the release
 * cuts that free the part from the sheet, so a part never moves under the
 * tool while it still has work left on it.
 */
export function machiningStage(path: DesignPath): number {
	return stageIndex(path.cam.stage);
}

function rapidTravel(entries: readonly RouteEntry[]): number {
	let position = point(0, 0);
	let distance = 0;
	for (const entry of entries) {
		distance += Math.hypot(entry.pts[0]!.x - position.x, entry.pts[0]!.y - position.y);
		position = entry.pts.at(-1)!;
	}
	return distance + Math.hypot(position.x, position.y);
}

function sameRoutePoint(a: Point, b: Point, tolerance = 0.001): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
}

/**
 * Only paths whose direction does not change the manufactured result may be
 * reversed. A drag-knife cut of three or more points is direction-sensitive
 * because of blade-offset lead-in.
 */
function canReverseRoutePath(path: DesignPath, settings: RoutingSettings): boolean {
	return (
		!path.closed &&
		(path.points.length === 2 || path.type === 'score' || settings.fabricationMode === 'router')
	);
}

function asRoutePath(path: DesignPath): RoutePath {
	return {
		...path,
		points: path.points.map((p) => point(p.x, p.y)),
		sourcePaths: (path as RoutePath).sourcePaths ?? [path]
	};
}

function reversedRoutePath(path: DesignPath): RoutePath {
	return {
		...path,
		points: [...path.points].reverse().map((p) => point(p.x, p.y)),
		sourcePaths: (path as RoutePath).sourcePaths ?? [path]
	};
}

function rotatedClosedRoutePath(path: DesignPath, startIndex: number): RoutePath {
	const points = path.points.map((p) => point(p.x, p.y));
	if (points.length > 2 && sameRoutePoint(points[0]!, points.at(-1)!)) points.pop();
	return {
		...path,
		points: [...points.slice(startIndex), ...points.slice(0, startIndex)],
		sourcePaths: (path as RoutePath).sourcePaths ?? [path]
	};
}

/**
 * Groups paths that should be machined as one continuous chain, so that for
 * example all four perimeter folds are creased in one pass instead of being
 * scattered by travel optimization.
 *
 * The grouping is stated by whoever drew the path. A path with no chain stands
 * alone under a key unique to its position, and because this runs inside the
 * same insertion loop as before, group order — and so the route — is unchanged.
 * No stated key can collide with the positional ones, which all start `single:`.
 */
function routeChainKey(path: DesignPath, index: number): string {
	return path.cam.chainKey ?? `single:${index}`;
}

/** Nearest-neighbour chaining within one group, choosing endpoint directions. */
function orderedRouteChain(paths: readonly DesignPath[], settings: RoutingSettings): RoutePath[] {
	const remaining = paths.map((path, index) => ({ path, index }));
	const endpoints = remaining.flatMap(({ path, index }) => [
		{ index, endpoint: 0, point: path.points[0]! },
		...(canReverseRoutePath(path, settings)
			? [{ index, endpoint: 1, point: path.points.at(-1)! }]
			: [])
	]);
	endpoints.sort((a, b) => a.point.x - b.point.x || a.point.y - b.point.y || a.index - b.index);
	const firstEndpoint = endpoints[0]!;
	const firstPosition = remaining.findIndex((entry) => entry.index === firstEndpoint.index);
	const [first] = remaining.splice(firstPosition, 1);
	const ordered: RoutePath[] = [
		firstEndpoint.endpoint ? reversedRoutePath(first!.path) : asRoutePath(first!.path)
	];

	while (remaining.length) {
		const cursor = ordered.at(-1)!.points.at(-1)!;
		let best = 0;
		let reverse = false;
		let distance = Infinity;
		remaining.forEach(({ path }, index) => {
			const forward = Math.hypot(path.points[0]!.x - cursor.x, path.points[0]!.y - cursor.y);
			if (forward < distance) {
				best = index;
				reverse = false;
				distance = forward;
			}
			if (canReverseRoutePath(path, settings)) {
				const backward = Math.hypot(
					path.points.at(-1)!.x - cursor.x,
					path.points.at(-1)!.y - cursor.y
				);
				if (backward < distance) {
					best = index;
					reverse = true;
					distance = backward;
				}
			}
		});
		const [next] = remaining.splice(best, 1);
		ordered.push(reverse ? reversedRoutePath(next!.path) : asRoutePath(next!.path));
	}
	return ordered;
}

/** Joins chained paths that meet end-to-start into single lift-free moves. */
function mergeConnectedRoutePaths(paths: readonly DesignPath[]): RoutePath[] {
	const merged: RoutePath[] = [];
	for (const path of paths) {
		const previous = merged.at(-1);
		const compatible =
			previous &&
			!previous.closed &&
			!path.closed &&
			previous.type === path.type &&
			previous.foldDirection === path.foldDirection &&
			sameRoutePoint(previous.points.at(-1)!, path.points[0]!);
		if (!compatible) {
			merged.push(asRoutePath(path));
			continue;
		}
		previous.points.push(...path.points.slice(1).map((p) => point(p.x, p.y)));
		previous.sourcePaths.push(...((path as RoutePath).sourcePaths ?? [path]));
		// The merged contour keeps its head's intent. Merging happens only within
		// one chain group of one stage, so every fragment shares that intent; the
		// role is display-only and is renamed so the comment does not mislead.
		if (previous.role !== path.role) previous.role = 'compound-contour'; // cam-boundary: display only
	}
	return merged;
}

function preparedRouteEntry(
	path: DesignPath,
	settings: RoutingSettings,
	operation: Operation
): RouteEntry {
	return {
		path,
		sourcePaths: (path as RoutePath).sourcePaths ?? [path],
		pts: toolpathPoints(path, settings, operation).map((p) => point(round(p.x), round(p.y)))
	};
}

function routeVariant(
	paths: readonly DesignPath[],
	settings: RoutingSettings,
	operation: Operation
): RouteVariant {
	const entries = paths
		.map((path) => preparedRouteEntry(path, settings, operation))
		.filter((entry) => entry.pts.length >= 2);
	return {
		entries,
		start: entries[0]?.pts[0] ?? point(0, 0),
		end: entries.at(-1)?.pts.at(-1) ?? point(0, 0),
		internalTravel: entries.slice(1).reduce((distance, entry, index) => {
			const previous = entries[index]!;
			return (
				distance +
				Math.hypot(
					entry.pts[0]!.x - previous.pts.at(-1)!.x,
					entry.pts[0]!.y - previous.pts.at(-1)!.y
				)
			);
		}, 0)
	};
}

/**
 * Builds the routable units for a set of paths. Each unit carries every legal
 * variant of itself (direction, or closed-contour start point) so the route
 * solver can pick the cheapest one without changing what gets cut.
 */
function routeUnits(
	paths: readonly DesignPath[],
	settings: RoutingSettings,
	operation: Operation
): RouteUnit[] {
	const groups = new Map<string, DesignPath[]>();
	paths.forEach((path, index) => {
		const key = routeChainKey(path, index);
		const group = groups.get(key);
		if (group) group.push(path);
		else groups.set(key, [path]);
	});

	return [...groups.values()].map((group) => {
		let variants: RouteVariant[];
		if (group.length > 1) {
			const forward = mergeConnectedRoutePaths(orderedRouteChain(group, settings));
			const backward = mergeConnectedRoutePaths(
				[...forward].reverse().map((path) => reversedRoutePath(path))
			);
			variants = [
				routeVariant(forward, settings, operation),
				routeVariant(backward, settings, operation)
			];
		} else if (group[0]!.closed) {
			const path = group[0]!;
			const count = sameRoutePoint(path.points[0]!, path.points.at(-1)!)
				? path.points.length - 1
				: path.points.length;
			const variantCount = Math.min(count, 24);
			const indices = [
				...new Set(
					Array.from({ length: variantCount }, (_, index) =>
						Math.floor((index * count) / variantCount)
					)
				)
			];
			variants = indices.map((index) =>
				routeVariant([rotatedClosedRoutePath(path, index)], settings, operation)
			);
		} else {
			const path = group[0]!;
			variants = [routeVariant([path], settings, operation)];
			if (canReverseRoutePath(path, settings)) {
				variants.push(routeVariant([reversedRoutePath(path)], settings, operation));
			}
		}
		return {
			variants: variants.filter((variant) => variant.entries.length),
			stage: machiningStage(group[0]!)
		};
	});
}

/**
 * Picks one variant per unit by shortest total travel, using a forward
 * Viterbi pass over the unit sequence and then walking the choices back.
 */
function materializeRoute(units: readonly RouteUnit[]): RouteEntry[] {
	if (!units.length) return [];
	const layers: { cost: number; previous: number }[][] = [];
	units.forEach((unit, unitIndex) => {
		const previous = layers[unitIndex - 1];
		layers.push(
			unit.variants.map((variant) => {
				if (!previous) {
					return {
						cost: Math.hypot(variant.start.x, variant.start.y) + variant.internalTravel,
						previous: -1
					};
				}
				return previous.reduce(
					(best, layerState, previousIndex) => {
						const previousVariant = units[unitIndex - 1]!.variants[previousIndex]!;
						const cost =
							layerState.cost +
							Math.hypot(
								variant.start.x - previousVariant.end.x,
								variant.start.y - previousVariant.end.y
							) +
							variant.internalTravel;
						return cost < best.cost ? { cost, previous: previousIndex } : best;
					},
					{ cost: Infinity, previous: -1 }
				);
			})
		);
	});

	let variantIndex = layers.at(-1)!.reduce(
		(best, layerState, index) => {
			const end = units.at(-1)!.variants[index]!.end;
			const cost = layerState.cost + Math.hypot(end.x, end.y);
			return cost < best.cost ? { cost, index } : best;
		},
		{ cost: Infinity, index: 0 }
	).index;

	const selected: RouteVariant[] = Array(units.length);
	for (let index = units.length - 1; index >= 0; index--) {
		selected[index] = units[index]!.variants[variantIndex]!;
		variantIndex = layers[index]![variantIndex]!.previous;
	}
	return selected.flatMap((variant) => [...variant.entries]);
}

function isUnitRoute(route: readonly (RouteUnit | RouteEntry)[]): route is readonly RouteUnit[] {
	return Boolean((route[0] as RouteUnit | undefined)?.variants);
}

function routeEntries(route: readonly (RouteUnit | RouteEntry)[]): readonly RouteEntry[] {
	return isUnitRoute(route) ? materializeRoute(route) : (route as readonly RouteEntry[]);
}

function routeTravel(route: readonly (RouteUnit | RouteEntry)[]): number {
	return rapidTravel(routeEntries(route));
}

/** Seconds spent plunging and retracting, which a shorter route cannot avoid. */
function routeLiftTime(
	route: readonly (RouteUnit | RouteEntry)[],
	settings: RoutingSettings
): number {
	return routeEntries(route).reduce((seconds, entry) => {
		const depth = entry.path.type === 'score' ? settings.scoreDepth : settings.cutDepth;
		return (
			seconds +
			((settings.safeZ + depth) / settings.plungeFeed) * 60 +
			((settings.safeZ + depth) / RAPID_FEED) * 60
		);
	}, 0);
}

function routeMotionCost(
	route: readonly (RouteUnit | RouteEntry)[],
	settings: RoutingSettings
): number {
	return (routeTravel(route) / RAPID_FEED) * 60 + routeLiftTime(route, settings);
}

/** Nearest-neighbour seed order, restarting within each machining stage. */
function greedyStageOrder(stages: readonly (readonly RouteUnit[])[]): RouteUnit[] {
	const ordered: RouteUnit[] = [];
	let position = point(0, 0);
	for (const stage of stages) {
		const remaining = [...stage];
		while (remaining.length) {
			let best = 0;
			let bestDistance = Infinity;
			remaining.forEach((entry, index) => {
				const starts = entry.variants.map((variant) => variant.start);
				const distance = Math.min(
					...starts.map((start) => Math.hypot(start.x - position.x, start.y - position.y))
				);
				if (distance < bestDistance) {
					best = index;
					bestDistance = distance;
				}
			});
			const [next] = remaining.splice(best, 1);
			ordered.push(next!);
			const variant = next!.variants.reduce((nearest, candidate) =>
				Math.hypot(candidate.start.x - position.x, candidate.start.y - position.y) <
				Math.hypot(nearest.start.x - position.x, nearest.start.y - position.y)
					? candidate
					: nearest
			);
			position = variant.end;
		}
	}
	return ordered;
}

/**
 * Improves unit order by relocating single units, never across a machining
 * stage boundary. Pass and candidate caps keep large sheets interactive.
 */
function improveConstrainedRoute(
	seed: readonly RouteUnit[],
	stageSizes: readonly number[]
): RouteUnit[] {
	let best = [...seed];
	let bestTravel = routeTravel(best);
	const ranges: { start: number; end: number }[] = [];
	let cursor = 0;
	stageSizes.forEach((size) => {
		ranges.push({ start: cursor, end: cursor + size });
		cursor += size;
	});
	// `plannedToolpaths` only ever seeds this with variant-carrying units, so
	// the original's variant-aware caps are the ones that apply.
	const maxPasses = 3;
	const maxCandidates = 400;

	for (let pass = 0; pass < maxPasses; pass++) {
		let improved: RouteUnit[] | null = null;
		let improvedTravel = bestTravel;
		let candidates = 0;
		for (const { start, end } of ranges) {
			if (end - start < 2) continue;
			for (let from = start; from < end; from++) {
				for (let to = start; to < end; to++) {
					if (from === to) continue;
					const candidate = [...best];
					const [entry] = candidate.splice(from, 1);
					candidate.splice(to, 0, entry!);
					const travel = routeTravel(candidate);
					candidates++;
					if (travel < improvedTravel - 0.000001) {
						improved = candidate;
						improvedTravel = travel;
					}
					if (candidates >= maxCandidates) break;
				}
				if (candidates >= maxCandidates) break;
			}
			if (candidates >= maxCandidates) break;
		}
		if (!improved) break;
		best = improved;
		bestTravel = improvedTravel;
	}
	return best;
}

/**
 * Plans the machining order for a set of design paths. The authored order is
 * always kept as a baseline and an optimized route is only accepted when it
 * is cheaper by both motion time and rapid travel.
 */
export function plannedToolpaths(
	paths: readonly DesignPath[],
	settings: RoutingSettings,
	operation: Operation = 'all'
): PlannedToolpaths {
	const prepared = paths
		.map((path) => preparedRouteEntry(path, settings, operation))
		.filter((entry) => entry.pts.length >= 2);
	const baselineStages = Array.from({ length: STAGE_COUNT }, (_, stage) =>
		prepared.filter((entry) => machiningStage(entry.path) === stage)
	);
	const pathStages = Array.from({ length: STAGE_COUNT }, (_, stage) =>
		paths.filter((path) => machiningStage(path) === stage)
	);
	const unitStages = pathStages.map((stage) =>
		routeUnits(stage, settings, operation).filter((unit) => unit.variants.length)
	);
	const baseline = baselineStages.flat();
	const designUnits = unitStages.flat();
	const stageSizes = unitStages.map((stage) => stage.length);
	const greedyUnits = greedyStageOrder(unitStages);
	const baselineTravel = rapidTravel(baseline);
	const greedyTravel = routeTravel(greedyUnits);

	const topologyCandidates = [
		designUnits,
		improveConstrainedRoute(designUnits, stageSizes),
		greedyUnits,
		improveConstrainedRoute(greedyUnits, stageSizes)
	];
	const bestUnits = topologyCandidates.reduce((best, candidate) =>
		routeMotionCost(candidate, settings) < routeMotionCost(best, settings) ? candidate : best
	);
	const topologyOptimized = materializeRoute(bestUnits);
	const optimized =
		routeMotionCost(topologyOptimized, settings) <= routeMotionCost(baseline, settings) &&
		rapidTravel(topologyOptimized) <= baselineTravel
			? topologyOptimized
			: baseline;
	const ordered = settings.toolpathOrder !== 'design' ? optimized : baseline;

	return {
		paths: ordered,
		baselineTravel,
		greedyTravel,
		travel: rapidTravel(ordered),
		baselineLifts: baseline.length,
		lifts: ordered.length,
		baselineMotionTime: routeMotionCost(baseline, settings),
		motionTime: routeMotionCost(ordered, settings),
		strategy: settings.toolpathOrder === 'design' ? 'design' : 'topology-aware'
	};
}
