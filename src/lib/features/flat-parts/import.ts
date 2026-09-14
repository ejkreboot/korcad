import { SNAP } from '$lib/core/constants.js';
import { outlineBounds } from '$lib/core/geometry/contour.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import type { DesignState } from '$lib/core/design/types.js';
import type { Selection } from '$lib/core/design/workspace.js';
import {
	boxedOutline,
	drawingName,
	drawingSize,
	importSvgOutlines,
	perimeter,
	plural
} from '$lib/core/import/outlines.js';
import { addEntity, addGroup } from './actions.js';
import { createFlatPartsEntity } from './defaults.js';
import type { FlatPartsEntity } from './types.js';
import { MIN_FLAT_PARTS_ENTITY } from './validation.js';
import { flatPartsSheetView, type FlatPartsView } from './view.js';

/**
 * Brings the closed outlines of an SVG drawing onto a Flat Parts sheet.
 *
 * An outline at an even nesting depth frees kept material, so it is a part:
 * cut outside its line and held by tabs. One at an odd depth frees the slug
 * of a hole in the part around it: cut inside its line and let fall. This is
 * the even-odd fill rule, read as a cutting plan rather than a picture. A part
 * nested in another part's hole imports, and validation rejects it, since the
 * stage order cannot yet cut it.
 *
 * A drawing of two or more parts, such as a logo, arrives as one group that
 * moves and scales as a unit; its members are named after the file, so a
 * validation message or program comment still says where to look. A single
 * part with its holes stays an ordinary part, whose holes already follow it.
 */

/** Where the drawing's lower-left corner lands on the sheet, clear of the edge for a router bit. */
const PLACEMENT_INSET = SNAP * 2;

/** Holding tabs an imported part gets at most; fewer when its perimeter cannot fit them. */
const IMPORTED_TABS = 4;

export type FlatPartsImport = {
	readonly design: DesignState;
	readonly selection: Selection | null;
	readonly notice: string;
};

/**
 * As many evenly spaced tabs, up to `IMPORTED_TABS`, as leave at least as much
 * cut as tab around the outline. A router's bridge is a bit width longer than
 * the tab it leaves.
 */
function importedTabCount(points: readonly Point[], view: FlatPartsView): number {
	const span = view.tabWidth + (view.fabricationMode === 'router' ? view.bitWidth : 0);
	if (!(span > 0)) return 0;
	return Math.max(0, Math.min(IMPORTED_TABS, Math.floor(perimeter(points) / (2 * span))));
}

/**
 * The sheet with an SVG drawing's closed outlines added as parts and holes,
 * its lower-left corner inset from the sheet's, and the first new part
 * selected. Throws with a message for the operator when the file is not an
 * SVG or holds nothing that can be cut.
 */
export function importSvg(
	design: DesignState,
	sheetId: string,
	text: string,
	fileName = 'the drawing'
): FlatPartsImport {
	const { outlines, skipped } = importSvgOutlines(
		text,
		fileName,
		MIN_FLAT_PARTS_ENTITY,
		'parts and holes'
	);
	const extent = outlineBounds(outlines.flatMap((outline) => outline.points));
	const dx = PLACEMENT_INSET - extent.left;
	const dy = PLACEMENT_INSET - extent.bottom;
	const view = flatPartsSheetView(design, sheetId);
	const counts = {
		profile: view.entities.filter((entity) => entity.kind === 'profile').length,
		hole: view.entities.filter((entity) => entity.kind === 'hole').length
	};

	const grouped = outlines.filter((outline) => outline.depth % 2 === 0).length > 1;
	const name = drawingName(fileName, 'Imported drawing');
	const noun = (kind: 'profile' | 'hole') =>
		grouped
			? `${name} ${kind === 'profile' ? 'part' : 'hole'}`
			: kind === 'profile'
				? 'Part'
				: 'Hole';
	if (grouped) {
		counts.profile = 0;
		counts.hole = 0;
	}

	const entities = outlines.map(({ points, depth }): FlatPartsEntity => {
		const kind = depth % 2 === 0 ? 'profile' : 'hole';
		const placed = points.map((vertex) => ({ x: vertex.x + dx, y: vertex.y + dy }));
		const { fractions, ...box } = boxedOutline(placed);
		counts[kind]++;
		return createFlatPartsEntity({
			id: crypto.randomUUID(),
			name: `${noun(kind)} ${counts[kind]}`,
			kind,
			shape: 'path',
			...box,
			outline: fractions,
			tabCount: kind === 'profile' ? importedTabCount(placed, view) : 0
		});
	});

	const parts = entities.filter((entity) => entity.kind === 'profile');
	const holes = entities.length - parts.length;
	const skippedNote = skipped.length ? ` Skipped ${skipped.join(', ')}.` : '';
	const summary = `${plural(parts.length, 'part')} and ${plural(holes, 'hole')} from ${fileName} (${drawingSize(outlines)})`;
	if (grouped) {
		const group = { id: crypto.randomUUID(), name };
		return {
			design: addGroup(design, sheetId, group, entities),
			selection: { kind: 'group', id: group.id },
			notice: `Imported ${summary} as the group ${name}.${skippedNote}`
		};
	}
	const next = entities.reduce((sheet, entity) => addEntity(sheet, sheetId, entity), design);
	const first = parts[0] ?? entities[0]!;
	return {
		design: next,
		selection: { kind: first.kind, id: first.id },
		notice: `Imported ${summary}.${skippedNote}`
	};
}
