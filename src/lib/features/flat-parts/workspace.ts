import type { DesignState } from '$lib/core/design/types.js';
import type { Workspace } from '../workspaces.js';
import {
	entitySheetId,
	findEntity,
	findGroup,
	groupBox,
	releaseFlatPartsSheet,
	removeEntity,
	removeGroup,
	rotateEntity,
	rotateGroup
} from './actions.js';
import { createDefaultFlatParts } from './defaults.js';
import { flatPartsGeometry } from './geometry.js';
import { importSvg } from './import.js';
import { normalizeFlatParts } from './normalize.js';
import { HOLE_PRESETS, PROFILE_PRESETS } from './presets.js';
import { validateFlatParts } from './validation.js';
import { flatPartsSheetView } from './view.js';

/**
 * Parts are labelled at their top-left corner; holes are too small to carry a
 * name. An imported group is labelled once, as a whole, rather than letter by letter.
 */
export function flatPartsLabels(design: DesignState, sheetId: string) {
	const view = flatPartsSheetView(design, sheetId);
	const parts = view.entities
		.filter((entity) => entity.kind === 'profile' && !entity.groupId)
		.map((entity) => ({ name: entity.name, x: entity.x + 5, y: entity.y + entity.h - 9 }));
	const groups = view.groups.flatMap((group) => {
		const box = groupBox(design, group.id);
		return box ? [{ name: group.name, x: box.x + 5, y: box.y + box.h - 9 }] : [];
	});
	return [...parts, ...groups];
}

/**
 * A routed part without holding tabs is freed by its last cut and can be
 * caught by the bit, so the program says which parts must be held some other
 * way. A knife leaves nothing spinning to catch them.
 */
function untabbedPartNotes(design: DesignState, sheetId: string) {
	const view = flatPartsSheetView(design, sheetId);
	if (view.fabricationMode !== 'router') return {};
	const untabbed = view.entities.filter(
		(entity) => entity.kind === 'profile' && entity.tabCount === 0
	);
	if (!untabbed.length) return {};
	const names = untabbed.map((entity) => entity.name).join(', ');
	return {
		headerNotes: [`; No holding tabs on: ${names}; secure these parts before the release cut`]
	};
}

export const FLAT_PARTS_WORKSPACE: Workspace<'flatParts'> = {
	id: 'flatParts',
	label: 'Flat Parts',
	icon: 'category',
	newSheetName: (design) =>
		`Sheet ${design.sheets.filter((sheet) => sheet.workspace === 'flatParts').length + 1}`,
	dataScope: 'sheet',
	capabilities: { folding: false, assembly: false },
	// Flat parts start on a router; a knife is still available from the Tool panel.
	fabricationMode: 'router',
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
	imports: [
		{
			id: 'svg',
			toolId: 'profile',
			label: 'Import SVG',
			description: 'Outlines become parts and holes',
			icon: 'upload_file',
			accept: '.svg,image/svg+xml',
			read: importSvg
		}
	],
	normalize: normalizeFlatParts,
	defaults: createDefaultFlatParts,
	reconcile: (design) => design,
	geometry: flatPartsGeometry,
	validate: validateFlatParts,
	gcodeOptions: untabbedPartNotes,
	labels: flatPartsLabels,
	selectionExists: (design, selection) =>
		selection.kind === 'group'
			? groupBox(design, selection.id) !== null
			: findEntity(design, selection.id)?.kind === selection.kind,
	canRotate: (design, selection) =>
		selection.kind === 'group'
			? groupBox(design, selection.id) !== null
			: findEntity(design, selection.id)?.shape === 'path',
	rotateSelection: (design, selection, degrees) =>
		selection.kind === 'group'
			? rotateGroup(design, selection.id, degrees)
			: rotateEntity(design, selection.id, degrees),
	removeSelection: (design, selection) =>
		selection.kind === 'group'
			? removeGroup(design, selection.id)
			: removeEntity(design, selection.id),
	selectionBounds: (design, selection, sheetId) => {
		if (selection.kind === 'group') {
			const box =
				findGroup(design, selection.id)?.sheetId === sheetId && groupBox(design, selection.id);
			return box ? { left: box.x, right: box.x + box.w, bottom: box.y, top: box.y + box.h } : null;
		}
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
	releaseSheet: releaseFlatPartsSheet
};
