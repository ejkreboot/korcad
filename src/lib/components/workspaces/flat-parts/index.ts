import type { WorkspaceUi } from '../index.js';
import { createFlatPartsCanvas } from './canvas.js';
import FlatPartsCanvasLayer from './FlatPartsCanvasLayer.svelte';
import FlatPartsInspector from './FlatPartsInspector.svelte';

export const FLAT_PARTS_UI: WorkspaceUi = {
	Inspector: FlatPartsInspector,
	CanvasLayer: FlatPartsCanvasLayer,
	canvasController: createFlatPartsCanvas
};
