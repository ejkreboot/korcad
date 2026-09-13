import { generateGcode, type GcodeOptions, type GcodeSettings } from '$lib/core/cam/gcode.js';
import type { Operation } from '$lib/core/cam/compensation.js';
import type { DesignPath } from '$lib/core/design/types.js';
import { foldAllowanceLabel, type FoldSettings } from './fold.js';

/** The header lines packaging adds to every program it exports. */
export function packagingHeaderNotes(settings: FoldSettings): readonly string[] {
	return [`; Fold allowance: ${foldAllowanceLabel(settings)}`];
}

/**
 * A G-code program for a packaging sheet: the generic program, with the fold
 * allowance recorded in its header so the operator knows what the flat panels
 * were cut to.
 */
export function packagingGcode(
	paths: readonly DesignPath[],
	settings: GcodeSettings & FoldSettings,
	operation: Operation = 'all',
	options: GcodeOptions = {}
): string {
	return generateGcode(paths, settings, operation, {
		...options,
		headerNotes: [...packagingHeaderNotes(settings), ...(options.headerNotes ?? [])]
	});
}
