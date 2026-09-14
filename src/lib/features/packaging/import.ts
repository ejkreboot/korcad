import { outlineBounds } from '$lib/core/geometry/contour.js';
import type { DesignState } from '$lib/core/design/types.js';
import type { Selection } from '$lib/core/design/workspace.js';
import {
	boxedOutline,
	drawingName,
	drawingSize,
	importSvgOutlines,
	plural
} from '$lib/core/import/outlines.js';
import { addPocket, addPocketGroup } from './actions.js';
import { createPocket } from './defaults.js';
import type { Pocket } from './types.js';
import { SHEET } from '$lib/core/constants.js';
import { openingOutline } from './geometry.js';
import { hostFor } from './regions.js';
import { packagingData, packagingView } from './view.js';

/**
 * Brings the outline of a product drawing onto a sheet as openings, so an
 * irregular part gets a cutout of its own shape.
 *
 * Only the outermost outlines become openings. Everything inside an opening
 * falls out of the deck with its slug, so a hole in the product, or the inner
 * edge of an outline drawn as a thick stroke, has nothing left to be cut
 * from. Those are skipped and named in the notice rather than cut as loose
 * scraps.
 *
 * A drawing of several openings, such as a logo, arrives as one group that
 * moves and scales as a unit.
 *
 * An opening is cut inside its line, so it keeps the drawn size. A product
 * that needs clearance should be drawn, or scaled, with it.
 */

/** Smallest opening, in mm, taken from a drawing; anything smaller is a speck. */
const MIN_IMPORTED_OPENING = 1;

/**
 * The document with a drawing's outermost outlines added to a sheet as imported
 * openings, and the first selected. They arrive centred on the deck on its own
 * sheet and centred on any other sheet, and are cut wherever they land: into
 * the part they lie wholly on, or straight out of the stock. Throws with a
 * message for the operator when the file holds no closed outline or the sheet
 * is not a packaging sheet.
 */
export function importSvgOpenings(
	design: DesignState,
	sheetId: string,
	text: string,
	fileName = 'the drawing'
): { design: DesignState; selection: Selection | null; notice: string } {
	const data = packagingData(design);
	const view = packagingView(design);
	const sheet = design.sheets.find((candidate) => candidate.id === sheetId);
	if (sheet?.workspace !== 'packaging') {
		throw new Error('Openings are cut from a packaging sheet; switch to one to import them.');
	}
	const onDeck = sheetId === data.deckSheetId;
	const { outlines, skipped } = importSvgOutlines(text, fileName, MIN_IMPORTED_OPENING, 'openings');
	const outer = outlines.filter((outline) => outline.depth === 0);
	if (!outer.length) {
		throw new Error(`The outlines in ${fileName} cross each other, so none is clearly outermost.`);
	}
	const inner = outlines.length - outer.length;
	const notes = inner
		? [`${plural(inner, 'inner outline')} (they fall out with the opening)`, ...skipped]
		: skipped;

	const extent = outlineBounds(outer.flatMap((outline) => outline.points));
	const centre = onDeck
		? { x: view.deckX + view.deckW / 2, y: view.deckY + view.deckH / 2 }
		: { x: SHEET / 2, y: SHEET / 2 };
	const dx = centre.x - (extent.left + extent.right) / 2;
	const dy = centre.y - (extent.bottom + extent.top) / 2;
	const name = drawingName(fileName, 'Imported opening');

	const placed = outer.map(({ points }, index): Pocket => {
		const { fractions, ...box } = boxedOutline(
			points.map((vertex) => ({ x: vertex.x + dx, y: vertex.y + dy }))
		);
		return createPocket({
			id: crypto.randomUUID(),
			name: outer.length === 1 ? name : `${name} ${index + 1}`,
			purpose: 'imported',
			shape: 'profile',
			...box,
			profile: fractions
		});
	});

	// One drawing goes to one owner: the part it lies wholly on, or the stock.
	const host = hostFor(view, sheetId, placed.map(openingOutline));
	const pockets = placed.map((pocket) => ({ ...pocket, host }));
	const placeName = onDeck ? 'the deck' : `the ${sheet.name} sheet`;
	const skippedNote = notes.length ? ` Skipped ${notes.join(', ')}.` : '';
	const summary = `${plural(pockets.length, 'opening')} from ${fileName} (${drawingSize(outer)})`;
	if (pockets.length > 1) {
		const group = { id: crypto.randomUUID(), name };
		return {
			design: addPocketGroup(design, group, pockets),
			selection: { kind: 'pocket-group', id: group.id },
			notice: `Imported ${summary} as the group ${name}, centred on ${placeName}.${skippedNote}`
		};
	}
	return {
		design: addPocket(design, pockets[0]!),
		selection: { kind: 'pocket', id: pockets[0]!.id },
		notice: `Imported ${summary}, centred on ${placeName}.${skippedNote}`
	};
}
