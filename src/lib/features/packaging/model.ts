import { point } from '$lib/core/geometry/primitives.js';
import type { DesignState, Geometry, Support, SheetView } from '$lib/core/design/types.js';
import type { PackagingGeometry, PackagingPath } from './paths.js';
import { sheetView } from '$lib/core/design/machine.js';
import { DECK_SHEET_ID } from './view.js';
import { annotateCamIntent } from './cam-intent.js';
import { annotateFoldPaths } from './folds.js';
import { cutoutPoints, openingCutPoints, pocketPaths } from './geometry.js';
import { exteriorPaths } from './perimeter.js';
import { riserPaths } from './supports.js';

const NO_SIDES = { top: false, right: false, bottom: false, left: false } as const;

/**
 * The deck opening a tray drops through. It is placed by the tray's assembly
 * position, not its position on the cutting sheet.
 */
export function trayOpeningPath(
	tray: Support,
	design: Pick<SheetView, 'deckX' | 'deckY'>,
	role = 'tray-opening'
): PackagingPath {
	const x = design.deckX + tray.assemblyX;
	const y = design.deckY + tray.assemblyY;
	return {
		points: openingCutPoints(
			{ left: x, right: x + tray.w, bottom: y, top: y + tray.d },
			{ ...trayAsPocketProxy(tray), sides: NO_SIDES }
		),
		type: 'cut',
		closed: true,
		riserId: tray.id,
		role
	};
}

/**
 * `openingCutPoints` is shared with pockets, so a tray is presented to it
 * with the few pocket fields it reads.
 */
function trayAsPocketProxy(tray: Support) {
	return {
		pullDiameter: tray.pullDiameter,
		pulls: tray.pulls,
		sides: NO_SIDES
	} as Parameters<typeof openingCutPoints>[1];
}

/**
 * All flat geometry for the active sheet.
 *
 * Score paths are emitted before cut paths so that folds are always creased
 * while the board is still fully supported by the sheet.
 */
export function allGeometry(document: DesignState, sheetId = document.activeSheetId): Geometry {
	// A sheet is cut on its own machine, and a routed sheet does not fold, so
	// the geometry of one sheet is answered against that sheet's profile.
	const design = sheetView(document, sheetId);
	const isDeckSheet = design.activeSheetId === DECK_SHEET_ID;
	const trayOpenings = design.risers
		.filter((support) => support.kind === 'tray')
		.map((tray) => trayOpeningPath(tray, design));

	if (design.fabricationMode === 'router') {
		// A router cuts openings and releases the deck; it never folds.
		if (!isDeckSheet) return { paths: [], tabs: [] };
		const openings = design.pockets.map((pocket) => {
			const points =
				pocket.shape === 'rectangle'
					? openingCutPoints(
							{
								left: pocket.x,
								right: pocket.x + pocket.w,
								bottom: pocket.y,
								top: pocket.y + pocket.h
							},
							{ ...pocket, sides: NO_SIDES }
						)
					: cutoutPoints(pocket);
			return {
				points,
				type: 'cut' as const,
				closed: true,
				pocketId: pocket.id,
				role: 'router-opening'
			};
		});
		const deck: PackagingPath = {
			points: [
				point(design.deckX, design.deckY),
				point(design.deckX + design.deckW, design.deckY),
				point(design.deckX + design.deckW, design.deckY + design.deckH),
				point(design.deckX, design.deckY + design.deckH)
			],
			type: 'cut',
			closed: true,
			role: 'router-deck-perimeter'
		};
		return {
			paths: annotateCamIntent([...openings, ...trayOpenings, deck], design),
			tabs: []
		};
	}

	const interior = isDeckSheet
		? [...design.pockets.flatMap((pocket) => pocketPaths(pocket, design)), ...trayOpenings]
		: [];
	const exterior: PackagingGeometry = isDeckSheet ? exteriorPaths(design) : { paths: [], tabs: [] };
	const supports = design.risers
		.filter((support) => support.sheetId === design.activeSheetId)
		.flatMap((support) => riserPaths(support, design));

	const paths = [...interior, ...supports, ...exterior.paths];
	return {
		paths: annotateCamIntent(
			annotateFoldPaths(
				[
					...paths.filter((path) => path.type === 'score'),
					...paths.filter((path) => path.type === 'cut')
				],
				design
			),
			design
		),
		tabs: exterior.tabs
	};
}
