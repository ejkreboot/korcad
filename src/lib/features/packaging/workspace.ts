import type { DesignState } from '$lib/core/design/types.js';
import type { Selection } from '$lib/core/design/workspace.js';
import type { SvgLabel } from '$lib/core/export/svg.js';
import type { Workspace } from '../workspaces.js';
import { pocketGroupBox, releaseSheet, rotatePocket, rotatePocketGroup } from './actions.js';
import { buildAssembly } from './assembly.js';
import { createDefaultPackaging } from './defaults.js';
import { packagingHeaderNotes } from './gcode.js';
import { resolveSupportHeights } from './levels.js';
import { allGeometry } from './model.js';
import { importSvgOpenings } from './import.js';
import { normalizePackaging } from './normalize.js';
import { CUTOUT_PRESETS, SUPPORT_PRESETS } from './presets.js';
import { riserFlatBounds } from './supports.js';
import { validate } from './validation.js';
import { packagingSheetView, packagingView } from './view.js';

/**
 * Openings are labelled at their top-left corner. An imported group is labelled
 * once, as a whole, rather than letter by letter.
 */
export function pocketLabels(design: DesignState): (SvgLabel & { key: string })[] {
	const view = packagingView(design);
	const single = view.pockets
		.filter((pocket) => !pocket.groupId)
		.map((pocket) => ({
			key: `pocket-${pocket.id}`,
			name: pocket.name,
			x: pocket.x + 5 + (pocket.labelOffset?.x ?? 0),
			y: pocket.y + pocket.h - 9 - (pocket.labelOffset?.y ?? 0)
		}));
	const groups = view.pocketGroups.flatMap((group) => {
		const box = pocketGroupBox(design, group.id);
		return box
			? [{ key: `group-${group.id}`, name: group.name, x: box.x + 5, y: box.y + box.h - 9 }]
			: [];
	});
	return [...single, ...groups];
}

function labels(design: DesignState, sheetId: string): SvgLabel[] {
	const view = packagingSheetView(design, sheetId);
	return [
		...(sheetId === view.deckSheetId
			? pocketLabels(design).map(({ name, x, y }) => ({ name, x, y }))
			: []),
		...view.supports
			.filter((support) => support.sheetId === sheetId)
			.map((support) => {
				const bounds = riserFlatBounds(support, view);
				return {
					name: support.name,
					x: bounds.left + 5 + (support.labelOffset?.x ?? 0),
					y: bounds.top - 9 - (support.labelOffset?.y ?? 0)
				};
			})
	];
}

function selectionExists(design: DesignState, selection: Selection): boolean {
	const data = design.workspaces.packaging;
	if (!data) return false;
	if (selection.kind === 'pocket') return data.pockets.some((pocket) => pocket.id === selection.id);
	if (selection.kind === 'pocket-group') return pocketGroupBox(design, selection.id) !== null;
	if (selection.kind === 'support') {
		return data.supports.some((support) => support.id === selection.id);
	}
	return false;
}

/** Only an imported opening, or a group of them, turns; a drawn opening keeps its shape. */
function canRotate(design: DesignState, selection: Selection): boolean {
	if (selection.kind === 'pocket-group') return pocketGroupBox(design, selection.id) !== null;
	if (selection.kind !== 'pocket') return false;
	const pocket = design.workspaces.packaging?.pockets.find((item) => item.id === selection.id);
	return pocket?.shape === 'profile';
}

function rotateSelection(design: DesignState, selection: Selection, degrees: number): DesignState {
	if (selection.kind === 'pocket-group') return rotatePocketGroup(design, selection.id, degrees);
	if (selection.kind === 'pocket') return rotatePocket(design, selection.id, degrees);
	return design;
}

/**
 * An opening is framed where it is drawn on the deck; a support only on the
 * sheet its net is cut from.
 */
function selectionBounds(design: DesignState, selection: Selection, sheetId: string) {
	const view = packagingSheetView(design, sheetId);
	if (selection.kind === 'pocket-group') {
		const box = sheetId === view.deckSheetId ? pocketGroupBox(design, selection.id) : null;
		return box ? { left: box.x, right: box.x + box.w, bottom: box.y, top: box.y + box.h } : null;
	}
	if (selection.kind === 'pocket') {
		const pocket = view.pockets.find((candidate) => candidate.id === selection.id);
		return pocket
			? { left: pocket.x, right: pocket.x + pocket.w, bottom: pocket.y, top: pocket.y + pocket.h }
			: null;
	}
	const support = view.supports.find((candidate) => candidate.id === selection.id);
	return support && support.sheetId === sheetId ? riserFlatBounds(support, view) : null;
}

export const PACKAGING_WORKSPACE: Workspace<'packaging'> = {
	id: 'packaging',
	label: 'Folded Packaging',
	icon: 'inventory_2',
	// The first packaging sheet is the deck, so the next is `Parts 1`.
	newSheetName: (design) => {
		const count = design.sheets.filter((sheet) => sheet.workspace === 'packaging').length;
		return count ? `Parts ${count}` : 'Deck';
	},
	dataScope: 'document',
	capabilities: { folding: true, assembly: true },
	// Board is creased and cut with a drag knife; supports cannot be routed.
	fabricationMode: 'knife',
	imports: [
		{
			id: 'svg',
			toolId: 'cutout',
			label: 'Import SVG',
			description: 'Opening shaped like a drawn outline',
			icon: 'upload_file',
			accept: '.svg,image/svg+xml',
			read: importSvgOpenings
		}
	],
	tools: [
		{
			id: 'cutout',
			label: 'Cutout',
			title: 'Draw a cutout',
			icon: 'activity_zone',
			presets: CUTOUT_PRESETS,
			unavailable: () => null
		},
		{
			id: 'support',
			label: 'Support',
			title: 'Draw a support',
			icon: 'brick',
			presets: SUPPORT_PRESETS,
			unavailable: (machine) =>
				machine.fabricationMode === 'router'
					? 'Supports are folded parts; switch to drag knife to add them'
					: null
		}
	],
	normalize: normalizePackaging,
	// A document's first packaging sheet is its deck.
	defaults: (sheetId) => createDefaultPackaging(sheetId),
	reconcile: resolveSupportHeights,
	geometry: allGeometry,
	validate,
	assembly: (design, selection) =>
		buildAssembly(design, selection?.kind === 'support' ? selection.id : null),
	gcodeOptions: (design, sheetId) => ({
		headerNotes: packagingHeaderNotes(packagingSheetView(design, sheetId))
	}),
	labels,
	selectionExists,
	canRotate,
	rotateSelection,
	selectionBounds,
	protectsSheet: (design, sheetId) => design.workspaces.packaging?.deckSheetId === sheetId,
	releaseSheet
};
