import {
	createDefaultStock,
	createStockMachineProfile,
	DEFAULT_MACHINE_PROFILE_ID
} from '$lib/core/design/defaults.js';
import { normalizeDocument } from '$lib/core/design/normalize.js';
import type { DesignState, Sheet } from '$lib/core/design/types.js';
import type { WorkspaceId } from '$lib/core/design/workspace.js';
import { unwrapDesignFile } from '$lib/core/export/design-file.js';
import { DEFAULT_DECK_SHEET_ID } from './packaging/defaults.js';
import { DEFAULT_WORKSPACE, PACKAGING_WORKSPACE, WORKSPACES, workspaceById } from './workspaces.js';

/**
 * The whole document, assembled from core and every registered workspace.
 *
 * `core` reads what every document has; it cannot know which workspaces exist.
 * This is the one place that knows both, so creating, normalizing, and parsing a
 * complete design happen here.
 */

function deckSheet(machineProfileId: string): Sheet {
	return {
		id: DEFAULT_DECK_SHEET_ID,
		name: 'Deck',
		workspace: PACKAGING_WORKSPACE.id,
		machineProfileId
	};
}

/**
 * A new design: one empty sheet drawn in `workspaceId`, on a stock profile for
 * the kind of machine that workspace starts on, carrying only its data. Packaging's first sheet is its
 * deck, which keeps the `deck` id every packaging default refers to.
 */
export function createDefaultDesign(workspaceId: WorkspaceId = DEFAULT_WORKSPACE): DesignState {
	const workspace = workspaceById(workspaceId);
	const blank: DesignState = {
		stock: createDefaultStock(),
		toolpathOrder: 'optimized',
		machineProfiles: [createStockMachineProfile(workspace.fabricationMode)],
		sheets: [],
		activeSheetId: '',
		workspaces: {}
	};
	const sheet: Sheet =
		workspaceId === PACKAGING_WORKSPACE.id
			? deckSheet(DEFAULT_MACHINE_PROFILE_ID)
			: {
					id: `${workspaceId}-1`,
					name: workspace.newSheetName(blank),
					workspace: workspaceId,
					machineProfileId: DEFAULT_MACHINE_PROFILE_ID
				};
	return {
		...blank,
		sheets: [sheet],
		activeSheetId: sheet.id,
		workspaces: { [workspaceId]: workspace.defaults(sheet.id) }
	};
}

/**
 * Narrows an untrusted saved document into a `DesignState`. Throws rather than
 * silently repairing a file that is not a design at all.
 */
export function normalizeState(raw: unknown): DesignState {
	return normalizeDocument(raw, {
		workspaces: WORKSPACES,
		defaultWorkspace: DEFAULT_WORKSPACE,
		defaultSheet: deckSheet
	});
}

/** Reads a saved design file of the current version. */
export function parseDesign(text: string): DesignState {
	return normalizeState(unwrapDesignFile(text));
}
