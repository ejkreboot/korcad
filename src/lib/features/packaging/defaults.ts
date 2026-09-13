import type { SideFlags } from '$lib/core/design/types.js';
import type { PackagingData, Pocket, Support } from './types.js';

const noSides = (): SideFlags => ({ top: false, right: false, bottom: false, left: false });

/** The id the deck sheet of a new design gets. Only a default, never a rule. */
export const DEFAULT_DECK_SHEET_ID = 'deck';

/**
 * Ported verbatim from the monolith's `defaults()`. These values are part of
 * the manufactured result; do not "clean them up" without updated fixtures.
 */
export function createDefaultPackaging(deckSheetId: string = DEFAULT_DECK_SHEET_ID): PackagingData {
	return {
		deckSheetId,
		deckX: 76.2,
		deckY: 76.2,
		deckW: 457.2,
		deckH: 457.2,
		perimeterType: 'folded',
		perimeterWall: 38.1,
		perimeterFlange: 12.7,
		perimeterRelief: 3.5,
		perimeterSides: { top: true, right: true, bottom: true, left: true },
		joistAxis: 'vertical',
		joistFolds: 4,
		joistHeight: 12.7,
		joistDepth: 6.35,
		joistLockWidth: 25.4,
		joistSlotClearance: 0.4,
		foldCompensation: 'none',
		foldRadiusFactor: 1,
		foldKFactor: 0.5,
		foldDeduction: 0,
		foldDirections: {},
		pockets: [],
		supports: []
	};
}

/** Field defaults applied to every pocket read from a saved file. */
export function pocketDefaults(): Pick<
	Pocket,
	'purpose' | 'shape' | 'cornerRadius' | 'profile' | 'pullDiameter' | 'pullDepth' | 'pulls'
> {
	return {
		purpose: 'product',
		shape: 'rectangle',
		cornerRadius: 6.35,
		profile: null,
		pullDiameter: 38.1,
		pullDepth: 19,
		pulls: noSides()
	};
}

/** Field defaults for a newly drawn pocket, matching the cutout presets. */
export function createPocket(values: Partial<Pocket> & Pick<Pocket, 'id' | 'name'>): Pocket {
	return {
		purpose: 'product',
		shape: 'rectangle',
		cornerRadius: 6.35,
		profile: null,
		x: 0,
		y: 0,
		w: 0,
		h: 0,
		wallDepth: 25.4,
		flange: 10,
		relief: 3.5,
		pullDiameter: 38.1,
		pullDepth: 19,
		pulls: noSides(),
		flangeEnabled: false,
		sides: noSides(),
		...values
	};
}

/** Field defaults applied to every support read from a saved file. */
export function supportDefaults(
	sheetId: string = DEFAULT_DECK_SHEET_ID
): Omit<Support, 'id' | 'name' | 'w' | 'd' | 'h' | 'kind' | 'mount' | 'netVersion'> {
	return {
		bottomFlange: true,
		cornerClosure: 'glue',
		flange: 12.7,
		seam: 15,
		overlap: 6.35,
		taper: 6.35,
		openSide: 'none',
		pullDiameter: 38.1,
		pullDepth: 15,
		pulls: noSides(),
		sheetId,
		flatX: 25.4,
		flatY: 25.4,
		assemblyX: 0,
		assemblyY: 0,
		// Saved files predate spanning heights, so a height read from one is
		// taken at face value; only a newly drawn riser box spans by default.
		heightMode: 'fixed',
		top: 'panel'
	};
}
