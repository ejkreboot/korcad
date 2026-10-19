import { describe, expect, it } from 'vitest';
import { generateGcode } from '$lib/core/cam/gcode.js';
import { needsZero } from '$lib/core/grbl/job.js';
import { createEditorState } from '$lib/editor/state.svelte.js';
import { sheetPrograms } from '$lib/editor/programs.js';
import { foldedDesign, partOpeningsDesign, withMachine } from '../../support/designs.js';

/** The parts sheet of a design with a support, whose fold up is creased from the back. */
const creasedDesign = () => ({ ...partOpeningsDesign(), activeSheetId: 'parts' });

describe("a sheet's programs", () => {
	it('are what export writes, crease then cut, naming the tool each runs', () => {
		expect(sheetPrograms(createEditorState(foldedDesign())).map((p) => p.operation)).toEqual([
			'cut'
		]);
		const editor = createEditorState(creasedDesign());
		const programs = sheetPrograms(editor);
		expect(programs.map(({ operation, tool, spindle }) => ({ operation, tool, spindle }))).toEqual([
			{ operation: 'crease', tool: 'drag knife', spindle: false },
			{ operation: 'cut', tool: 'drag knife', spindle: false }
		]);
		const options = editor.workspace.gcodeOptions(editor.design, editor.design.activeSheetId);
		expect(programs[1]?.text).toBe(
			generateGcode(editor.geometry.paths, editor.view, 'cut', options)
		);
		// One tool for both, so Z0 is set once.
		expect(needsZero(programs, 1)).toBe(false);
	});

	it('change tools between a creasing wheel and the knife', () => {
		const editor = createEditorState(withMachine(creasedDesign(), { scoreTool: 'crease' }));
		const programs = sheetPrograms(editor);
		expect(programs.map((program) => program.tool)).toEqual(['creasing wheel', 'drag knife']);
		expect(needsZero(programs, 1)).toBe(true);
	});
});
