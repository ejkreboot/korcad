import { round } from '$lib/core/units.js';
import type { DesignPath, SheetView } from '$lib/core/design/types.js';
import { normalizeAngle, point, type Point } from '$lib/core/geometry/primitives.js';
import { swingPoints, trailingOffset, type Operation } from './compensation.js';
import { plannedToolpaths, type RoutingSettings } from './routing.js';
import { bridgeTabbedContour, type ToolpathPoint } from './tabs.js';

export type GcodeSettings = RoutingSettings &
	Pick<
		SheetView,
		| 'grainDirection'
		| 'sheets'
		| 'material'
		| 'fabricationMode'
		| 'spindleSpeed'
		| 'scoreFeed'
		| 'cutFeed'
		| 'tabWidth'
		| 'tabHeight'
		| 'passDepth'
		| 'knifePasses'
		| 'swivelDepth'
	>;

export type GcodeOptions = {
	readonly title?: string;
	readonly sheetLabel?: string;
	/**
	 * Workspace-specific header comments, each a complete `; ...` line, emitted
	 * after the stock description, such as packaging's fold allowance.
	 */
	readonly headerNotes?: readonly string[];
};

/** Up-folds are creased from the back; everything else runs in the cut program. */
export function pathOperation(path: Pick<DesignPath, 'type' | 'foldDirection'>): 'crease' | 'cut' {
	return path.type === 'score' && path.foldDirection === 'up' ? 'crease' : 'cut';
}

/**
 * The programs one sheet exports, in running order. A crease program exists
 * only when something on the sheet is creased from the back; otherwise it
 * would be an empty file the operator is told to run first.
 */
export function programOperations(paths: readonly DesignPath[]): readonly ('crease' | 'cut')[] {
	return paths.some((path) => pathOperation(path) === 'crease') ? ['crease', 'cut'] : ['cut'];
}

/**
 * The depths of successive passes down to `depth`, both positive. The cut is
 * split into the fewest equal passes none deeper than `passDepth`, so there is
 * never a sliver of a last pass. Throws on a pass depth that could not finish.
 */
export function passDepths(depth: number, passDepth: number): number[] {
	if (!(Number.isFinite(passDepth) && passDepth > 0)) {
		throw new Error('Depth per pass must be positive');
	}
	// The tolerance keeps a depth that is an exact multiple from gaining a pass to rounding.
	const count = Math.max(1, Math.ceil(depth / passDepth - 1e-9));
	return Array.from({ length: count }, (_, index) => (depth * (index + 1)) / count);
}

/**
 * The depths of a knife's passes down to `depth`: `count` equal passes, each
 * retracing the kerf of the last. Throws on a count that is not a whole number
 * of at least one.
 */
export function knifePassDepths(depth: number, count: number): number[] {
	if (!(Number.isInteger(count) && count >= 1)) {
		throw new Error('Knife passes must be a whole number, 1 or more');
	}
	return Array.from({ length: count }, (_, index) => (depth * (index + 1)) / count);
}

export function pathsForOperation(
	paths: readonly DesignPath[],
	operation: Operation
): readonly DesignPath[] {
	return operation === 'all' ? paths : paths.filter((path) => pathOperation(path) === operation);
}

/**
 * Emits a G-code program for one operation.
 *
 * Postprocessor assumptions, also stated in the emitted header:
 * - 24 x 24 inch sheet, origin at the lower left, Z zero at the material
 *   surface, so all cutting depths are negative.
 * - Millimeters, absolute positioning, XY plane.
 * - The spindle stays off for knife and creasing work and is only started for
 *   router operations, which are the only ones that need it.
 * - Every path plunges from safe Z and retracts to safe Z before travelling.
 * - A router cuts in equal passes no deeper than `passDepth`. A closed contour
 *   plunges to its next pass where the last one ended, which is where it
 *   started; an open path retracts and returns to its start first. A knife and
 *   a crease cut in one pass.
 * - A knife cuts in `knifePasses` equal passes and scores in one. Each pass
 *   plunges at the start of the path; it retraces a closed contour from where
 *   it ended only if the blade already faces the way the contour leaves.
 * - Before a knife plunges, its blade is lowered to `swivelDepth` and the axis
 *   swung about the start of the cut until the blade faces along it, so the
 *   blade turns gripping only the surface instead of tearing round at depth.
 *   The blade is assumed to keep its heading while it is lifted, so it turns
 *   from the heading the last cut left it on; at the start of a program that
 *   heading is unknown, so the first swivel is a full turn, which draws the
 *   tip in to the start point whichever way it faced.
 * - A routed outline with holding tabs is cut at depth except over each tab,
 *   where the bit rises vertically to leave a bridge `tabHeight` above the
 *   underside of the board, then drops back vertically at plunge feed. A pass
 *   that stops above the bridge runs straight over it.
 * - The program ends with the spindle off, a return to X0 Y0 at safe Z, and M2.
 */
export function generateGcode(
	paths: readonly DesignPath[],
	settings: GcodeSettings,
	operation: Operation = 'all',
	options: GcodeOptions = {}
): string {
	const sourcePaths = pathsForOperation(paths, operation);
	const geometry = plannedToolpaths(sourcePaths, settings, operation).paths;
	const router = settings.fabricationMode === 'router';
	const creasing = operation === 'crease';
	const routing = router && !creasing;
	const toolDescription = router
		? `${round(settings.bitWidth)} mm router bit`
		: creasing && settings.scoreTool === 'crease'
			? 'creasing wheel'
			: 'drag knife';

	const bridged = routing && geometry.some(({ path }) => bridgeTabs(path));
	const knifePasses = !router && settings.knifePasses > 1 && geometry.some(isCut);
	const swivelled =
		!router &&
		settings.swivelDepth > 0 &&
		geometry.some(({ path }) => trailingOffset(path, settings, operation) > 0);

	const sheetName =
		options.sheetLabel ??
		settings.sheets.find((sheet) => sheet.id === settings.activeSheetId)?.name ??
		'Unknown';

	const lines: string[] = [
		options.title ?? '; KorCad v1.0',
		`; Sheet: ${sheetName}`,
		`; Operation: ${operation}; tool: ${toolDescription}`,
		'; 24 x 24 inch sheet; origin at lower left; Z zero at material surface',
		`; Grain direction: ${settings.grainDirection}; material thickness: ${round(settings.material)} mm`,
		...(options.headerNotes ?? []),
		...(routing
			? [
					`; ROUTER operation; ${round(settings.bitWidth)} mm bit with radius compensation`,
					`; Cut in equal passes of at most ${round(settings.passDepth)} mm`
				]
			: ['; SPINDLE MUST REMAIN OFF']),
		...(knifePasses ? [`; Knife cuts in ${settings.knifePasses} equal passes`] : []),
		...(swivelled
			? [
					`; Blade swivels at Z-${round(settings.swivelDepth)} to face each cut before plunging; the first turns a full circle`
				]
			: []),
		...(bridged
			? [
					`; Holding tabs: ${round(settings.tabWidth)} mm wide bridges, ${round(settings.tabHeight)} mm thick; break parts free by hand`
				]
			: []),
		'G21 ; millimeters',
		'G90 ; absolute positioning',
		'G17 ; XY plane',
		`G0 Z${round(settings.safeZ)}`,
		routing ? `M3 S${Math.round(settings.spindleSpeed)} ; spindle clockwise` : 'M5 ; spindle off',
		...(routing ? ['G4 P2 ; allow spindle to reach speed'] : [])
	];

	// The heading the blade was left on, in radians; unknown until a knife cuts.
	let heading: number | null = null;
	geometry.forEach(({ path, pts }, index) => {
		if (pts.length < 2) return;
		const depth = path.depth ?? (path.type === 'score' ? settings.scoreDepth : settings.cutDepth);
		const feed = path.feed ?? (path.type === 'score' ? settings.scoreFeed : settings.cutFeed);
		const owner = path.owner ? ` (${path.owner.name})` : '';
		lines.push(
			'',
			`; ${index + 1}: ${path.type}${path.foldDirection ? ` [${path.foldDirection}]` : ''}${path.note ? ` ${path.note}` : ''} ${path.role || ''}${owner}`
		);
		const tabs = routing ? bridgeTabs(path) : undefined;
		const contour: readonly ToolpathPoint[] = tabs
			? bridgeTabbedContour(pts, {
					centres: tabs,
					tabWidth: settings.tabWidth,
					tabHeight: settings.tabHeight,
					material: settings.material,
					bitWidth: settings.bitWidth,
					cutDepth: depth
				})
			: pts.map((p) => ({ x: p.x, y: p.y, z: -depth }));
		if (router) {
			const passes = routing ? passDepths(depth, settings.passDepth) : [depth];
			lines.push(...passMoves(contour, passes, feed, settings));
		} else {
			const passes = path.type === 'cut' ? knifePassDepths(depth, settings.knifePasses) : [depth];
			const trail = trailingOffset(path, settings, operation);
			const knife = knifeMoves(pts, passes, feed, trail, heading, settings);
			lines.push(...knife.lines);
			heading = knife.heading;
		}
		lines.push(`G0 Z${round(settings.safeZ)}`);
	});

	lines.push('', 'M5', 'G0 X0 Y0', `G0 Z${round(settings.safeZ)}`, 'M2', '');
	return lines.join('\n');
}

function isCut({ path }: { readonly path: DesignPath }): boolean {
	return path.type === 'cut';
}

function bridgeTabs(path: DesignPath): readonly Point[] | undefined {
	return path.closed && path.holdingTabs?.length ? path.holdingTabs : undefined;
}

/**
 * The moves of one path cut in passes. `contour` is the path at full depth,
 * with any vertical rises over holding tabs; each pass cuts it no deeper than
 * that pass's depth, so a tab below the pass floor is not there yet and its
 * rise and drop are left out.
 */
function passMoves(
	contour: readonly ToolpathPoint[],
	passes: readonly number[],
	feed: number,
	settings: GcodeSettings
): string[] {
	const start = contour[0]!;
	const end = contour.at(-1)!;
	const closed = contour.length > 2 && Math.hypot(end.x - start.x, end.y - start.y) <= 1e-6;
	const lines: string[] = [];
	passes.forEach((depth, pass) => {
		if (pass > 0 && !closed) {
			lines.push(`G0 Z${round(settings.safeZ)}`);
		}
		if (pass === 0 || !closed) lines.push(`G0 X${round(start.x)} Y${round(start.y)}`);
		lines.push(`G1 Z-${round(depth)} F${round(settings.plungeFeed)}`);
		const floor = (z: number) => Math.max(z, -depth);
		contour.slice(1).forEach((move, index) => {
			const previous = contour[index]!;
			if (move.z === previous.z) {
				lines.push(`G1 X${round(move.x)} Y${round(move.y)} F${round(feed)}`);
				return;
			}
			if (floor(move.z) === floor(previous.z)) return;
			const rising = move.z > previous.z;
			lines.push(
				`G1 Z${round(floor(move.z))} F${round(settings.plungeFeed)} ; ${rising ? 'holding tab' : 'end of tab'}`
			);
		});
	});
	return lines;
}

/** Below this a change of heading is rounding in the output, not a turn to swivel. */
const SWIVEL_TOLERANCE = Math.PI / 180;

/** The direction of travel, in radians, along the first segment of `pts` with length. */
function leavingHeading(pts: readonly Point[]): number | null {
	for (let index = 1; index < pts.length; index++) {
		const a = pts[index - 1]!;
		const b = pts[index]!;
		if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) return Math.atan2(b.y - a.y, b.x - a.x);
	}
	return null;
}

/** The direction of travel, in radians, along the last segment of `pts` with length. */
function arrivingHeading(pts: readonly Point[]): number | null {
	const back = leavingHeading([...pts].reverse());
	return back === null ? null : normalizeAngle(back + Math.PI);
}

/**
 * The moves of one knife or creasing-wheel path cut in `passes`, and the
 * heading it leaves the blade on.
 *
 * `pts` is the programmed axis path, which leads the blade tip by `trail`
 * along the direction of travel, so the tip at the start of the cut lies
 * `trail` behind the first point. When the blade must turn to face that way,
 * it is lowered `swivelDepth` into the board with the axis where the tip
 * lands on that start point, and swung about it until it faces along the cut.
 * A swivel is never deeper than the pass it leads into.
 */
function knifeMoves(
	pts: readonly Point[],
	passes: readonly number[],
	feed: number,
	trail: number,
	heading: number | null,
	settings: GcodeSettings
): { lines: string[]; heading: number | null } {
	const start = pts[0]!;
	const end = pts.at(-1)!;
	const closed = pts.length > 2 && Math.hypot(end.x - start.x, end.y - start.y) <= 1e-6;
	const leaving = leavingHeading(pts);
	const arriving = arrivingHeading(pts);
	const swivels = settings.swivelDepth > 0 && trail > 0 && leaving !== null;
	const tip =
		leaving === null
			? start
			: point(start.x - Math.cos(leaving) * trail, start.y - Math.sin(leaving) * trail);
	const lines: string[] = [];
	let current = heading;
	passes.forEach((depth, pass) => {
		const turn =
			!swivels || leaving === null
				? 0
				: current === null
					? Math.PI * 2
					: normalizeAngle(leaving - current);
		const swivel = Math.abs(turn) > SWIVEL_TOLERANCE;
		if (pass > 0 && (swivel || !closed)) lines.push(`G0 Z${round(settings.safeZ)}`);
		if (swivel) {
			const from = current ?? leaving!;
			const approach = point(tip.x + Math.cos(from) * trail, tip.y + Math.sin(from) * trail);
			const swivelDepth = Math.min(settings.swivelDepth, depth);
			lines.push(
				`G0 X${round(approach.x)} Y${round(approach.y)}`,
				`G1 Z-${round(swivelDepth)} F${round(settings.plungeFeed)} ; swivel`
			);
			for (const p of swingPoints(tip, from, turn, trail, settings.cornerStep)) {
				lines.push(`G1 X${round(p.x)} Y${round(p.y)} F${round(feed)}`);
			}
			if (swivelDepth < depth) lines.push(`G1 Z-${round(depth)} F${round(settings.plungeFeed)}`);
		} else {
			if (pass === 0 || !closed) lines.push(`G0 X${round(start.x)} Y${round(start.y)}`);
			lines.push(`G1 Z-${round(depth)} F${round(settings.plungeFeed)}`);
		}
		for (const move of pts.slice(1)) {
			lines.push(`G1 X${round(move.x)} Y${round(move.y)} F${round(feed)}`);
		}
		// A creasing wheel has no blade heading to carry into the next cut.
		current = trail > 0 ? (arriving ?? current) : null;
	});
	return { lines, heading: current };
}
