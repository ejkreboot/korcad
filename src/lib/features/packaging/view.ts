import { sheetView } from '$lib/core/design/machine.js';
import type { DesignState, SheetView } from '$lib/core/design/types.js';
import type { PackagingData } from './types.js';

/**
 * The document as packaging sees it from one sheet: the generic sheet view —
 * stock, that sheet's machine, the sheet list — plus the packaging data.
 *
 * Packaging keeps its data namespaced in the document but reads it flat, so
 * its geometry, level, and validation functions can each name exactly the
 * fields they depend on.
 */
export type PackagingView = SheetView & PackagingData;

/**
 * The packaging data of a document.
 *
 * Throws when there is none. Every packaging entry point is only reached for a
 * document with a packaging sheet, and normalization gives such a document its
 * data, so a missing namespace here is a programming error rather than a state
 * to render around.
 */
export function packagingData(design: DesignState): PackagingData {
	const data = design.workspaces.packaging;
	if (!data) throw new Error('This design has no packaging workspace');
	return data;
}

/** Packaging's view of one sheet; defaults to the active sheet. */
export function packagingSheetView(
	design: DesignState,
	sheetId: string = design.activeSheetId
): PackagingView {
	return { ...sheetView(design, sheetId), ...packagingData(design) };
}

/**
 * The document as packaging sees it when a question spans the whole assembly
 * rather than one sheet: how high the deck stands, whether supports fit under
 * it, whether the design is manufacturable.
 *
 * Those answers depend on the machine — a routed deck does not fold, so its
 * walls do not hold it up — and packaging answers them on the deck sheet's
 * machine. Validation rejects a document whose packaging sheets disagree on
 * fabrication mode, so for any document that can be exported the choice of
 * sheet does not change the answer.
 */
export function packagingView(design: DesignState): PackagingView {
	return packagingSheetView(design, packagingData(design).deckSheetId);
}

/** The document with its packaging data replaced. */
export function withPackaging(
	design: DesignState,
	update: (data: PackagingData) => PackagingData
): DesignState {
	return {
		...design,
		workspaces: { ...design.workspaces, packaging: update(packagingData(design)) }
	};
}
