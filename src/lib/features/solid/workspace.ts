import type { DesignState } from '$lib/core/design/types.js';
import type { Workspace } from '../workspaces.js';
import { findEntity, entitySheetId, releaseSolidSheet } from './actions.js';
import { createDefaultSolid } from './defaults.js';
import { solidGeometry } from './geometry.js';
import { normalizeSolid } from './normalize.js';
import { HOLE_PRESETS, PROFILE_PRESETS } from './presets.js';
import { validateSolid } from './validation.js';
import { solidSheetView } from './view.js';

/** Parts are labelled at their top-left corner; holes are too small to carry a name. */
function labels(design: DesignState, sheetId: string) {
	return solidSheetView(design, sheetId)
		.entities.filter((entity) => entity.kind === 'profile')
		.map((entity) => ({ name: entity.name, x: entity.x + 5, y: entity.y + entity.h - 9 }));
}

export const SOLID_WORKSPACE: Workspace<'solid'> = {
	id: 'solid',
	label: 'Solid',
	icon: 'category',
	newSheetName: (design) =>
		`Plate ${design.sheets.filter((sheet) => sheet.workspace === 'solid').length + 1}`,
	dataScope: 'sheet',
	capabilities: { folding: false, assembly: false },
	tools: [
		{
			id: 'profile',
			label: 'Part',
			title: 'Draw a part outline',
			icon: 'category',
			presets: PROFILE_PRESETS,
			unavailable: () => null
		},
		{
			id: 'hole',
			label: 'Hole',
			title: 'Draw a hole or slot',
			icon: 'radio_button_unchecked',
			presets: HOLE_PRESETS,
			unavailable: () => null
		}
	],
	normalize: normalizeSolid,
	defaults: createDefaultSolid,
	reconcile: (design) => design,
	geometry: solidGeometry,
	validate: validateSolid,
	gcodeOptions: () => ({}),
	labels,
	selectionExists: (design, selection) => findEntity(design, selection.id)?.kind === selection.kind,
	selectionBounds: (design, selection, sheetId) => {
		const entity = findEntity(design, selection.id);
		if (!entity || entitySheetId(design, entity.id) !== sheetId) return null;
		return {
			left: entity.x,
			right: entity.x + entity.w,
			bottom: entity.y,
			top: entity.y + entity.h
		};
	},
	protectsSheet: () => false,
	releaseSheet: releaseSolidSheet
};
