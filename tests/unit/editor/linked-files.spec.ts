import { describe, expect, it } from 'vitest';
import { createSurfaceMap, surfaceGrid } from '$lib/core/cam/surface.js';
import { createEditorState } from '$lib/editor/state.svelte.js';
import { materialPreset } from '$lib/features/document.js';
import { foldedDesign } from '../../support/designs.js';

const file = (name: string) => ({ name, handle: null });

describe('a linked material preset', () => {
	it('is unsaved once the material differs from it, and saved again when undo puts it back', () => {
		const editor = createEditorState(foldedDesign());
		expect(editor.materialUnsaved).toBe(false);
		editor.setMaterialFile({ ...file('birch.json'), saved: editor.material });
		expect(editor.materialUnsaved).toBe(false);
		editor.setStock('tabWidth', editor.design.stock.tabWidth + 1);
		expect(editor.materialUnsaved).toBe(true);
		editor.undo();
		expect(editor.materialUnsaved).toBe(false);
	});

	it('is applied as one undo step', () => {
		const editor = createEditorState(foldedDesign());
		const before = editor.design;
		const preset = materialPreset(before, null);
		editor.openMaterialPreset(
			{ ...preset, stock: { ...preset.stock, material: 2.5 } },
			file('thin.json')
		);
		expect(editor.design.stock.material).toBe(2.5);
		expect(editor.materialFile?.name).toBe('thin.json');
		expect(editor.materialUnsaved).toBe(false);
		editor.undo();
		expect(editor.design).toEqual(before);
		expect(editor.materialUnsaved).toBe(true);
	});

	it("opens saved even when the file had nothing for one of the design's workspaces", () => {
		const editor = createEditorState(foldedDesign());
		editor.openMaterialPreset({ ...editor.material, workspaces: {} }, file('flat.json'));
		expect(editor.materialUnsaved).toBe(false);
	});
});

describe('a linked surface file', () => {
	it("replaces the map's measurements, leaving whether programs follow it as it was", () => {
		const editor = createEditorState(foldedDesign());
		editor.setSurfaceMap({ ...createSurfaceMap(), enabled: true });
		const grid = { columns: 2, rows: 2, inset: 10, heights: [0, 0.1, -0.2, 0.05] };
		editor.openSurfaceFile(grid, file('table.json'));
		expect(editor.surfaceMap).toEqual({ enabled: true, ...grid });
		expect(editor.surfaceUnsaved).toBe(false);
	});

	it('is unsaved once a height changes, and not when following is switched', () => {
		const editor = createEditorState(foldedDesign());
		editor.setSurfaceFile({ ...file('table.json'), saved: surfaceGrid(editor.surfaceMap) });
		editor.setSurfaceMap({ ...editor.surfaceMap, enabled: true });
		expect(editor.surfaceUnsaved).toBe(false);
		const heights = [...editor.surfaceMap.heights];
		heights[0] = 0.2;
		editor.setSurfaceMap({ ...editor.surfaceMap, heights });
		expect(editor.surfaceUnsaved).toBe(true);
	});
});
