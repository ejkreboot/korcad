import type { WorkspaceUi } from '../index.js';
import { createPackagingAssembly } from './assembly.svelte.js';
import { createPackagingCanvas } from './canvas.js';
import PackagingCanvasLayer from './PackagingCanvasLayer.svelte';
import PackagingInspector from './PackagingInspector.svelte';
import PackagingMaterialFields from './PackagingMaterialFields.svelte';

export const PACKAGING_UI: WorkspaceUi = {
	Inspector: PackagingInspector,
	MaterialFields: PackagingMaterialFields,
	materialHelp:
		'Fold allowance shrinks each folded panel so the assembled part lands on its drawn size.',
	CanvasLayer: PackagingCanvasLayer,
	canvasController: createPackagingCanvas,
	assembly: {
		canvasLabel: '3D packaging assembly',
		fadeLabel: 'Deck',
		controller: createPackagingAssembly
	}
};
