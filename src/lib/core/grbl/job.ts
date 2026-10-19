import { surfaceHeight, type SurfaceMap } from '$lib/core/cam/surface.js';
import { streamLines } from './protocol.js';

/**
 * Running a sheet's programs from KorCad: the crease program, if there is one,
 * then the cut program, each streamed to the controller with a stop between
 * them for the operator to change the tool and set Z0 again.
 */

/** One program as the operator is shown it and the controller is sent it. */
export type JobProgram = {
	readonly operation: 'crease' | 'cut';
	/** What it cuts with, in words; programs naming different tools need a tool change. */
	readonly tool: string;
	/** Whether it starts the spindle. */
	readonly spindle: boolean;
	readonly lines: readonly string[];
};

/** The programs of a sheet, as `streamLines` sends them; throws on any GRBL could not take. */
export function jobPrograms(
	programs: readonly {
		readonly operation: 'crease' | 'cut';
		readonly tool: string;
		readonly spindle: boolean;
		readonly text: string;
	}[]
): JobProgram[] {
	return programs.map(({ operation, tool, spindle, text }) => ({
		operation,
		tool,
		spindle,
		lines: streamLines(text)
	}));
}

/**
 * Whether Z0 must be set before program `index` runs: before the first,
 * since nothing says the tool in the spindle is the one the job starts with,
 * and after any change of tool, since a new tool's tip stands at a new height.
 */
export function needsZero(programs: readonly Pick<JobProgram, 'tool'>[], index: number): boolean {
	if (index === 0) return true;
	return programs[index]?.tool !== programs[index - 1]?.tool;
}

/**
 * The work Z of the work's top at `at`, given that Z0 is its top at X0 Y0.
 * With the surface map on, the work there stands as far above X0 Y0 as the
 * table does, so Z0 can be set wherever the tool is and still agree with the
 * map that programs follow.
 */
export function workTopAt(map: SurfaceMap, at: { readonly x: number; readonly y: number }): number {
	return map.enabled ? surfaceHeight(map, at.x, at.y) : 0;
}
