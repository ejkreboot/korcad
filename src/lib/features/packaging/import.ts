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
import { packagingData, packagingView } from './view.js';

/**
 * Brings the outline of a product drawing into the deck as openings, so an
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
 * The deck with a drawing's outermost outlines added as imported openings,
 * centred on the finished deck as a group, and the first selected. Throws
 * with a message for the operator when the file holds no closed outline or
 * the active sheet is not the one the deck is cut from.
 */
export function importSvgOpenings(
	design: DesignState,
	sheetId: string,
	text: string,
	fileName = 'the drawing'
): { design: DesignState; selection: Selection | null; notice: string } {
	const data = packagingData(design);
	if (sheetId !== data.deckSheetId) {
		const deck = design.sheets.find((sheet) => sheet.id === data.deckSheetId)?.name ?? 'deck';
		throw new Error(`Openings are cut from the deck; switch to the ${deck} sheet to import them.`);
	}
	const { outlines, skipped } = importSvgOutlines(text, fileName, MIN_IMPORTED_OPENING, 'openings');
	const outer = outlines.filter((outline) => outline.depth === 0);
	if (!outer.length) {
		throw new Error(`The outlines in ${fileName} cross each other, so none is clearly outermost.`);
	}
	const inner = outlines.length - outer.length;
	const notes = inner
		? [`${plural(inner, 'inner outline')} (they fall out with the opening)`, ...skipped]
		: skipped;

	const view = packagingView(design);
	const extent = outlineBounds(outer.flatMap((outline) => outline.points));
	const dx = view.deckX + view.deckW / 2 - (extent.left + extent.right) / 2;
	const dy = view.deckY + view.deckH / 2 - (extent.bottom + extent.top) / 2;
	const name = drawingName(fileName, 'Imported opening');

	const pockets = outer.map(({ points }, index): Pocket => {
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

	const skippedNote = notes.length ? ` Skipped ${notes.join(', ')}.` : '';
	const summary = `${plural(pockets.length, 'opening')} from ${fileName} (${drawingSize(outer)})`;
	if (pockets.length > 1) {
		const group = { id: crypto.randomUUID(), name };
		return {
			design: addPocketGroup(design, group, pockets),
			selection: { kind: 'pocket-group', id: group.id },
			notice: `Imported ${summary} as the group ${name}, centred on the deck.${skippedNote}`
		};
	}
	return {
		design: addPocket(design, pockets[0]!),
		selection: { kind: 'pocket', id: pockets[0]!.id },
		notice: `Imported ${summary}, centred on the deck.${skippedNote}`
	};
}
