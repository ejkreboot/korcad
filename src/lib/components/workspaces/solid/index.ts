import type { WorkspaceUi } from '../index.js';
import { createSolidCanvas } from './canvas.js';
import SolidCanvasLayer from './SolidCanvasLayer.svelte';
import SolidInspector from './SolidInspector.svelte';

export const SOLID_UI: WorkspaceUi = {
	Inspector: SolidInspector,
	CanvasLayer: SolidCanvasLayer,
	canvasController: createSolidCanvas
};
