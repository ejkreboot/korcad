import { sheetView } from '$lib/core/design/machine.js';
import type { DesignState, SheetView } from '$lib/core/design/types.js';
import type { SolidData, SolidSheet } from './types.js';

/** One Solid sheet as its geometry and validation read it: the sheet view and its entities. */
export type SolidView = SheetView & SolidSheet;

const EMPTY: SolidSheet = { entities: [] };

/** The Solid data of a document; empty when it has none. */
export function solidData(design: DesignState): SolidData {
	return design.workspaces.solid ?? { sheets: {} };
}

/** A Solid sheet's view; defaults to the active sheet. */
export function solidSheetView(
	design: DesignState,
	sheetId: string = design.activeSheetId
): SolidView {
	return { ...sheetView(design, sheetId), ...(solidData(design).sheets[sheetId] ?? EMPTY) };
}

/** The document with one Solid sheet's data replaced. */
export function withSolidSheet(
	design: DesignState,
	sheetId: string,
	update: (sheet: SolidSheet) => SolidSheet
): DesignState {
	const data = solidData(design);
	return {
		...design,
		workspaces: {
			...design.workspaces,
			solid: { sheets: { ...data.sheets, [sheetId]: update(data.sheets[sheetId] ?? EMPTY) } }
		}
	};
}
