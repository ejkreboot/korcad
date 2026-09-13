import { round } from '$lib/core/units.js';
import type { DesignPath, SheetView } from '$lib/core/design/types.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import type { Operation } from './compensation.js';
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
	>;

export type GcodeOptions = {
	readonly title?: string;
	readonly sheetLabel?: string;
	/**
	 * Workspace-specific header comments, each a complete `; ...` line, emitted
	 * after the stock description. Packaging records its fold allowance here.
	 */
	readonly headerNotes?: readonly string[];
};

/** Up-folds are creased from the back; everything else runs in the cut program. */
export function pathOperation(path: Pick<DesignPath, 'type' | 'foldDirection'>): 'crease' | 'cut' {
	return path.type === 'score' && path.foldDirection === 'up' ? 'crease' : 'cut';
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
 * - A routed outline with holding tabs is cut at depth except over each tab,
 *   where the bit rises vertically to leave a bridge `tabHeight` above the
 *   underside of the board, then drops back vertically at plunge feed.
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
	const toolDescription = router
		? `${round(settings.bitWidth)} mm router bit`
		: creasing && settings.scoreTool === 'crease'
			? 'creasing wheel'
			: 'drag knife';

	const bridged = router && !creasing && geometry.some(({ path }) => bridgeTabs(path));

	const sheetName =
		options.sheetLabel ??
		settings.sheets.find((sheet) => sheet.id === settings.activeSheetId)?.name ??
		'Unknown';

	const lines: string[] = [
		options.title ?? '; Voisee insert generator v0.1',
		`; Sheet: ${sheetName}`,
		`; Operation: ${operation}; tool: ${toolDescription}`,
		'; 24 x 24 inch sheet; origin at lower left; Z zero at material surface',
		`; Grain / flute direction: ${settings.grainDirection}; board thickness: ${round(settings.material)} mm`,
		...(options.headerNotes ?? []),
		router && !creasing
			? `; ROUTER operation; ${round(settings.bitWidth)} mm bit with radius compensation`
			: '; SPINDLE MUST REMAIN OFF',
		...(bridged
			? [
					`; Holding tabs: ${round(settings.tabWidth)} mm wide bridges, ${round(settings.tabHeight)} mm thick; break parts free by hand`
				]
			: []),
		'G21 ; millimeters',
		'G90 ; absolute positioning',
		'G17 ; XY plane',
		`G0 Z${round(settings.safeZ)}`,
		router && !creasing
			? `M3 S${Math.round(settings.spindleSpeed)} ; spindle clockwise`
			: 'M5 ; spindle off',
		...(router && !creasing ? ['G4 P2 ; allow spindle to reach speed'] : [])
	];

	geometry.forEach(({ path, pts }, index) => {
		if (pts.length < 2) return;
		const depth = path.depth ?? (path.type === 'score' ? settings.scoreDepth : settings.cutDepth);
		const feed = path.feed ?? (path.type === 'score' ? settings.scoreFeed : settings.cutFeed);
		const owner = path.owner ? ` (${path.owner.name})` : '';
		lines.push(
			'',
			`; ${index + 1}: ${path.type}${path.foldDirection ? ` [${path.foldDirection}]` : ''}${path.note ? ` ${path.note}` : ''} ${path.role || ''}${owner}`
		);
		const tabs = router && !creasing ? bridgeTabs(path) : undefined;
		if (tabs) {
			lines.push(...bridgedMoves(pts, tabs, depth, feed, settings));
		} else {
			lines.push(`G0 X${round(pts[0]!.x)} Y${round(pts[0]!.y)}`);
			lines.push(`G1 Z-${round(depth)} F${round(settings.plungeFeed)}`);
			for (const p of pts.slice(1)) {
				lines.push(`G1 X${round(p.x)} Y${round(p.y)} F${round(feed)}`);
			}
		}
		lines.push(`G0 Z${round(settings.safeZ)}`);
	});

	lines.push('', 'M5', 'G0 X0 Y0', `G0 Z${round(settings.safeZ)}`, 'M2', '');
	return lines.join('\n');
}

function bridgeTabs(path: DesignPath): readonly Point[] | undefined {
	return path.closed && path.holdingTabs?.length ? path.holdingTabs : undefined;
}

/** The moves of one routed contour that rises over its holding tabs. */
function bridgedMoves(
	pts: readonly Point[],
	centres: readonly Point[],
	depth: number,
	feed: number,
	settings: GcodeSettings
): string[] {
	const moves: readonly ToolpathPoint[] = bridgeTabbedContour(pts, {
		centres,
		tabWidth: settings.tabWidth,
		tabHeight: settings.tabHeight,
		material: settings.material,
		bitWidth: settings.bitWidth,
		cutDepth: depth
	});
	const lines = [
		`G0 X${round(moves[0]!.x)} Y${round(moves[0]!.y)}`,
		`G1 Z-${round(depth)} F${round(settings.plungeFeed)}`
	];
	moves.slice(1).forEach((move, index) => {
		const previous = moves[index]!;
		if (move.z !== previous.z) {
			const rising = move.z > previous.z;
			lines.push(
				`G1 Z${round(move.z)} F${round(settings.plungeFeed)} ; ${rising ? 'holding tab' : 'end of tab'}`
			);
		} else {
			lines.push(`G1 X${round(move.x)} Y${round(move.y)} F${round(feed)}`);
		}
	});
	return lines;
}
