import { sheetView } from '$lib/core/design/machine.js';
import type { DesignState, SheetView } from '$lib/core/design/types.js';
import type { FlatPartsData, FlatPartsSheet } from './types.js';

/** One Flat Parts sheet as its geometry and validation read it: the sheet view and its entities. */
export type FlatPartsView = SheetView & FlatPartsSheet;

const EMPTY: FlatPartsSheet = { entities: [] };

/** The Flat Parts data of a document; empty when it has none. */
export function flatPartsData(design: DesignState): FlatPartsData {
	return design.workspaces.flatParts ?? { sheets: {} };
}

/** A Flat Parts sheet's view; defaults to the active sheet. */
export function flatPartsSheetView(
	design: DesignState,
	sheetId: string = design.activeSheetId
): FlatPartsView {
	return { ...sheetView(design, sheetId), ...(flatPartsData(design).sheets[sheetId] ?? EMPTY) };
}

/** The document with one Flat Parts sheet's data replaced. */
export function withFlatPartsSheet(
	design: DesignState,
	sheetId: string,
	update: (sheet: FlatPartsSheet) => FlatPartsSheet
): DesignState {
	const data = flatPartsData(design);
	return {
		...design,
		workspaces: {
			...design.workspaces,
			flatParts: { sheets: { ...data.sheets, [sheetId]: update(data.sheets[sheetId] ?? EMPTY) } }
		}
	};
}
