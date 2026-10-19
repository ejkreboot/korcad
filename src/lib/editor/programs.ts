import {
	generateGcode,
	programOperations,
	programSpindle,
	programTool
} from '$lib/core/cam/gcode.js';
import { applySurfaceMap } from '$lib/core/cam/surface.js';
import type { EditorState } from './state.svelte.js';

export type SheetProgram = {
	readonly operation: 'crease' | 'cut';
	readonly text: string;
	readonly tool: string;
	readonly spindle: boolean;
};

/**
 * The active sheet's programs in running order, exactly as G-code export
 * writes them and the Run panel sends them: the crease program, when
 * something is creased from the back, then the cut program, each bent to
 * follow the table when the surface map is on.
 */
export function sheetPrograms(
	editor: Pick<EditorState, 'design' | 'view' | 'geometry' | 'workspace' | 'surfaceMap'>
): SheetProgram[] {
	const paths = editor.geometry.paths;
	const options = editor.workspace.gcodeOptions(editor.design, editor.design.activeSheetId);
	return programOperations(paths).map((operation) => ({
		operation,
		text: applySurfaceMap(generateGcode(paths, editor.view, operation, options), editor.surfaceMap),
		tool: programTool(editor.view, operation),
		spindle: programSpindle(editor.view, operation)
	}));
}
