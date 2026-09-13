import type { WorkspaceUi } from '../index.js';
import { createPackagingCanvas } from './canvas.js';
import PackagingAssemblyViewer from './PackagingAssemblyViewer.svelte';
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
	AssemblyViewer: PackagingAssemblyViewer
};
