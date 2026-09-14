import { point } from '$lib/core/geometry/primitives.js';
import type { DesignPath, DesignState, Geometry } from '$lib/core/design/types.js';
import type { Pocket, Support } from './types.js';
import type { PackagingView } from './view.js';
import {
	DECK_OUTLINE,
	INTERIOR_HOLE,
	partReleaseIntent,
	pocketOwner,
	supportOwner,
	type PackagingGeometry
} from './paths.js';
import { packagingSheetView } from './view.js';
import { annotateFoldPaths } from './folds.js';
import { cutoutPoints, openingCutPoints, pocketPaths } from './geometry.js';
import { exteriorPaths } from './perimeter.js';
import { riserPaths } from './supports.js';

const NO_SIDES = { top: false, right: false, bottom: false, left: false } as const;

const onDeck = (pocket: Pocket) => pocket.host.kind === 'deck';

/**
 * The deck opening a tray drops through. It is placed by the tray's assembly
 * position, not its position on the cutting sheet.
 */
export function trayOpeningPath(
	tray: Support,
	design: Pick<PackagingView, 'deckX' | 'deckY'>,
	role = 'tray-opening'
): DesignPath {
	const x = design.deckX + tray.assemblyX;
	const y = design.deckY + tray.assemblyY;
	return {
		points: openingCutPoints(
			{ left: x, right: x + tray.w, bottom: y, top: y + tray.d },
			{ ...trayAsPocketProxy(tray), sides: NO_SIDES }
		),
		type: 'cut',
		closed: true,
		cam: partReleaseIntent(tray, true),
		role,
		owner: supportOwner(tray)
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
	const design = packagingSheetView(document, sheetId);
	const isDeckSheet = design.activeSheetId === design.deckSheetId;
	const onDeckSheet = (pocket: Pocket) =>
		onDeck(pocket) ||
		(pocket.host.kind === 'stock' && pocket.host.sheetId === design.activeSheetId);
	const trayOpenings = design.supports
		.filter((support) => support.kind === 'tray')
		.map((tray) => trayOpeningPath(tray, design));

	if (design.fabricationMode === 'router') {
		// A router cuts openings and releases the deck; it never folds.
		if (!isDeckSheet) return { paths: [], tabs: [] };
		const openings = design.pockets.filter(onDeckSheet).map((pocket) => {
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
			const opening: DesignPath = {
				points,
				type: 'cut',
				closed: true,
				cam: INTERIOR_HOLE,
				role: 'router-opening',
				owner: pocketOwner(pocket)
			};
			return opening;
		});
		const deck: DesignPath = {
			points: [
				point(design.deckX, design.deckY),
				point(design.deckX + design.deckW, design.deckY),
				point(design.deckX + design.deckW, design.deckY + design.deckH),
				point(design.deckX, design.deckY + design.deckH)
			],
			type: 'cut',
			closed: true,
			cam: DECK_OUTLINE,
			role: 'router-deck-perimeter'
		};
		return {
			paths: [...openings, ...trayOpenings, deck],
			tabs: []
		};
	}

	// Every region cut from this sheet takes its openings with it: the deck's
	// when this is the deck sheet, and those of each support whose net is here.
	const sheetSupportIds = new Set(
		design.supports
			.filter((support) => support.sheetId === design.activeSheetId)
			.map((support) => support.id)
	);
	// A cut into bare stock, or across a part's edge, is cut on its sheet all the same.
	const cutOnThisSheet = (pocket: Pocket) =>
		(pocket.host.kind === 'support' && sheetSupportIds.has(pocket.host.supportId)) ||
		(pocket.host.kind === 'stock' && pocket.host.sheetId === design.activeSheetId);
	const interior = [
		...(isDeckSheet
			? [
					...design.pockets.filter(onDeck).flatMap((pocket) => pocketPaths(pocket, design)),
					...trayOpenings
				]
			: []),
		...design.pockets.filter(cutOnThisSheet).flatMap((pocket) => pocketPaths(pocket, design))
	];
	const exterior: PackagingGeometry = isDeckSheet ? exteriorPaths(design) : { paths: [], tabs: [] };
	const supports = design.supports
		.filter((support) => support.sheetId === design.activeSheetId)
		.flatMap((support) => riserPaths(support, design));

	const paths = [...interior, ...supports, ...exterior.paths];
	return {
		paths: annotateFoldPaths(
			[
				...paths.filter((path) => path.type === 'score'),
				...paths.filter((path) => path.type === 'cut')
			],
			design
		),
		tabs: exterior.tabs
	};
}
