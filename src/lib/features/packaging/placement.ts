import { SHEET } from '$lib/core/constants.js';
import { DEFAULT_MACHINE_PROFILE_ID } from '$lib/core/design/defaults.js';
import { round } from '$lib/core/units.js';
import type { Sheet, Support, SheetView } from '$lib/core/design/types.js';
import { perimeterBounds, type PerimeterSettings } from './perimeter.js';
import { DECK_SHEET_ID } from './view.js';
import { riserFlatBounds, type SupportSettings } from './supports.js';

/** Clear border kept around a sheet when auto-placing a net. */
const MARGIN = 6.35;
/** Search resolution when looking for free space. */
const STEP = 12.7;

export type PlacementSettings = SupportSettings &
	PerimeterSettings &
	Pick<SheetView, 'sheets' | 'activeSheetId' | 'risers'>;

export type Placement = {
	readonly sheetId: string;
	readonly flatX: number;
	readonly flatY: number;
	/** Set when no existing sheet had room and a new one must be added. */
	readonly newSheet?: Sheet;
};

/**
 * Finds free space for a support's unfolded net, preferring the active sheet.
 * Nets may not overlap each other or the deck blank, because they are cut from
 * the same stock. If nothing fits, a new parts sheet is proposed.
 */
export function placeSupport(
	support: Support,
	design: PlacementSettings,
	makeSheetId: () => string
): Placement {
	const local = { ...support, flatX: 0, flatY: 0 };
	const localBounds = riserFlatBounds(local, design);
	const width = localBounds.right - localBounds.left;
	const height = localBounds.top - localBounds.bottom;

	const sheets = [
		...design.sheets.filter((sheet) => sheet.id === design.activeSheetId),
		...design.sheets.filter((sheet) => sheet.id !== design.activeSheetId)
	];

	const fitsAt = (sheet: Sheet, left: number, bottom: number): boolean => {
		const candidate = { left, right: left + width, bottom, top: bottom + height };
		if (candidate.right > SHEET - MARGIN || candidate.top > SHEET - MARGIN) return false;
		const obstacles = design.risers
			.filter((other) => other.sheetId === sheet.id && other.id !== support.id)
			.map((other) => riserFlatBounds(other, design));
		if (sheet.id === DECK_SHEET_ID) obstacles.push(perimeterBounds(design));
		return obstacles.every(
			(obstacle) =>
				candidate.right <= obstacle.left ||
				candidate.left >= obstacle.right ||
				candidate.top <= obstacle.bottom ||
				candidate.bottom >= obstacle.top
		);
	};

	for (const sheet of sheets) {
		for (let bottom = MARGIN; bottom + height <= SHEET; bottom += STEP) {
			for (let left = MARGIN; left + width <= SHEET; left += STEP) {
				if (fitsAt(sheet, left, bottom)) {
					return {
						sheetId: sheet.id,
						flatX: round(left - localBounds.left),
						flatY: round(bottom - localBounds.bottom)
					};
				}
			}
		}
	}

	// A net that will not fit gets a new sheet cut on the same machine as the
	// one it was drawn from; nothing about the part has changed.
	const newSheet: Sheet = {
		id: makeSheetId(),
		name: `Parts ${design.sheets.length}`,
		machineProfileId:
			design.sheets.find((sheet) => sheet.id === design.activeSheetId)?.machineProfileId ??
			design.sheets[0]?.machineProfileId ??
			DEFAULT_MACHINE_PROFILE_ID
	};
	return {
		sheetId: newSheet.id,
		flatX: round(MARGIN - localBounds.left),
		flatY: round(MARGIN - localBounds.bottom),
		newSheet
	};
}

/** Nudges a support's net back onto the sheet if a resize pushed it off. */
export function constrainSupportFlat(
	support: Support,
	design: SupportSettings
): Pick<Support, 'flatX' | 'flatY'> {
	let flatX = support.flatX;
	let flatY = support.flatY;
	let bounds = riserFlatBounds({ ...support, flatX, flatY }, design);
	if (bounds.left < 0) flatX -= bounds.left;
	if (bounds.right > SHEET) flatX -= bounds.right - SHEET;
	bounds = riserFlatBounds({ ...support, flatX, flatY }, design);
	if (bounds.bottom < 0) flatY -= bounds.bottom;
	if (bounds.top > SHEET) flatY -= bounds.top - SHEET;
	return { flatX: round(flatX), flatY: round(flatY) };
}
