import { round } from '$lib/core/units.js';
import { foldAllowanceLabel, type FoldSettings } from '$lib/core/design/fold.js';
import type { DesignPath, DesignState, MachineSettings } from '$lib/core/design/types.js';
import type { Operation } from './compensation.js';
import { plannedToolpaths, type RoutingSettings } from './routing.js';

export type GcodeSettings = RoutingSettings &
	FoldSettings &
	Pick<DesignState, 'grainDirection' | 'sheets'> &
	Pick<MachineSettings, 'spindleSpeed' | 'scoreFeed' | 'cutFeed'>;

export type GcodeOptions = {
	readonly title?: string;
	readonly sheetLabel?: string;
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
		`; Fold allowance: ${foldAllowanceLabel(settings)}`,
		router && !creasing
			? `; ROUTER operation; ${round(settings.bitWidth)} mm bit with radius compensation`
			: '; SPINDLE MUST REMAIN OFF',
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
		lines.push(`G0 X${round(pts[0]!.x)} Y${round(pts[0]!.y)}`);
		lines.push(`G1 Z-${round(depth)} F${round(settings.plungeFeed)}`);
		for (const p of pts.slice(1)) {
			lines.push(`G1 X${round(p.x)} Y${round(p.y)} F${round(feed)}`);
		}
		lines.push(`G0 Z${round(settings.safeZ)}`);
	});

	lines.push('', 'M5', 'G0 X0 Y0', `G0 Z${round(settings.safeZ)}`, 'M2', '');
	return lines.join('\n');
}
