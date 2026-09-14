import { SNAP } from '$lib/core/constants.js';
import { outlineBounds, pointInOutline } from '$lib/core/geometry/contour.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import type { DesignState } from '$lib/core/design/types.js';
import type { Selection } from '$lib/core/design/workspace.js';
import { readSvgOutlines } from '$lib/core/import/svg.js';
import { round } from '$lib/core/units.js';
import { addEntity } from './actions.js';
import { createFlatPartsEntity } from './defaults.js';
import type { FlatPartsEntity, FlatPartsKind } from './types.js';
import { MIN_FLAT_PARTS_ENTITY } from './validation.js';
import { flatPartsSheetView, type FlatPartsView } from './view.js';

/**
 * Brings the closed outlines of an SVG drawing onto a Flat Parts sheet.
 *
 * Whether an outline is a part or a hole follows from what cutting it does.
 * A closed cut through the board always frees whatever lies inside it, so
 * each outline's nesting depth, the number of other outlines around it,
 * decides what that freed piece is: at an even depth it is a part, cut
 * outside its line and held by tabs; at an odd depth it is the slug of a hole
 * in the part around it, cut inside its line and let fall. This is the
 * even-odd fill rule, read as a cutting plan rather than a picture.
 *
 * The rule needs outlines that do not cross. Crossing or touching outlines
 * have no single nesting, and are left for validation to name, as are parts
 * nested in another part's hole, which the stage order cannot yet cut.
 */

/** Largest deviation, in mm, of a flattened curve from the drawing: well under a router's accuracy. */
export const SVG_IMPORT_TOLERANCE = 0.05;

/** Where the drawing's lower-left corner lands on the sheet, clear of the edge for a router bit. */
const PLACEMENT_INSET = SNAP * 2;

/** Holding tabs an imported part gets at most; fewer when its perimeter cannot fit them. */
const IMPORTED_TABS = 4;

export type ClassifiedOutline = {
	readonly points: readonly Point[];
	/** How many other outlines enclose this one. */
	readonly depth: number;
	readonly kind: FlatPartsKind;
};

export type FlatPartsImport = {
	readonly design: DesignState;
	readonly selection: Selection | null;
	readonly notice: string;
};

/**
 * Each outline's nesting depth and kind. An outline is inside another when a
 * vertex of it is; for outlines that do not cross, any vertex gives the same
 * answer.
 */
export function classifyOutlines(outlines: readonly (readonly Point[])[]): ClassifiedOutline[] {
	const bounds = outlines.map(outlineBounds);
	return outlines.map((points, index) => {
		const box = bounds[index]!;
		const probe = points[0]!;
		const depth = outlines.filter((other, otherIndex) => {
			if (otherIndex === index) return false;
			const around = bounds[otherIndex]!;
			const encloses =
				box.left >= around.left &&
				box.right <= around.right &&
				box.bottom >= around.bottom &&
				box.top <= around.top;
			return encloses && pointInOutline(probe, other);
		}).length;
		return { points, depth, kind: depth % 2 === 0 ? 'profile' : 'hole' };
	});
}

/** Signed area, positive counter-clockwise. */
function area(points: readonly Point[]): number {
	return (
		points.reduce((sum, vertex, index) => {
			const next = points[(index + 1) % points.length]!;
			return sum + vertex.x * next.y - next.x * vertex.y;
		}, 0) / 2
	);
}

function perimeter(points: readonly Point[]): number {
	return points.reduce((sum, vertex, index) => {
		const next = points[(index + 1) % points.length]!;
		return sum + Math.hypot(next.x - vertex.x, next.y - vertex.y);
	}, 0);
}

/**
 * The same outline drawn twice, as a filled shape and its stroke often are.
 * Cutting both would cut the line twice and leave no single nesting.
 */
function sameOutline(a: readonly Point[], b: readonly Point[]): boolean {
	const first = outlineBounds(a);
	const second = outlineBounds(b);
	const close = (x: number, y: number) => Math.abs(x - y) <= SVG_IMPORT_TOLERANCE;
	return (
		close(first.left, second.left) &&
		close(first.right, second.right) &&
		close(first.bottom, second.bottom) &&
		close(first.top, second.top) &&
		Math.abs(Math.abs(area(a)) - Math.abs(area(b))) <=
			SVG_IMPORT_TOLERANCE * Math.max(perimeter(a), perimeter(b))
	);
}

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

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

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
	const read = readSvgOutlines(text, { tolerance: SVG_IMPORT_TOLERANCE });
	const skipped: string[] = [];
	if (read.openCount) skipped.push(plural(read.openCount, 'open path'));

	const sized = read.closed.filter((points) => {
		const box = outlineBounds(points);
		return (
			box.right - box.left >= MIN_FLAT_PARTS_ENTITY && box.top - box.bottom >= MIN_FLAT_PARTS_ENTITY
		);
	});
	if (sized.length < read.closed.length) {
		skipped.push(
			`${plural(read.closed.length - sized.length, 'outline')} under ${MIN_FLAT_PARTS_ENTITY} mm`
		);
	}
	const distinct = sized.filter(
		(points, index) => !sized.slice(0, index).some((earlier) => sameOutline(points, earlier))
	);
	if (distinct.length < sized.length) {
		skipped.push(plural(sized.length - distinct.length, 'duplicate outline'));
	}
	skipped.push(...read.unsupported.map((name) => `${name} elements`));

	if (!distinct.length) {
		const reason = skipped.length ? ` Skipped ${skipped.join(', ')}.` : '';
		throw new Error(
			`No closed outlines to cut in ${fileName}: parts and holes need closed shapes.${reason}`
		);
	}

	const extent = outlineBounds(distinct.flat());
	const dx = PLACEMENT_INSET - extent.left;
	const dy = PLACEMENT_INSET - extent.bottom;
	const view = flatPartsSheetView(design, sheetId);
	const counts = {
		profile: view.entities.filter((entity) => entity.kind === 'profile').length,
		hole: view.entities.filter((entity) => entity.kind === 'hole').length
	};

	const entities = classifyOutlines(distinct).map(({ points, kind }): FlatPartsEntity => {
		const placed = points.map((vertex) => ({ x: vertex.x + dx, y: vertex.y + dy }));
		// Stored counter-clockwise, like every drawn shape, so tabs and routing
		// start the same way whichever direction the drawing ran.
		const ordered = area(placed) < 0 ? [...placed].reverse() : placed;
		const box = outlineBounds(ordered);
		const x = round(box.left);
		const y = round(box.bottom);
		const w = round(box.right - box.left);
		const h = round(box.top - box.bottom);
		counts[kind]++;
		return createFlatPartsEntity({
			id: crypto.randomUUID(),
			name: `${kind === 'profile' ? 'Part' : 'Hole'} ${counts[kind]}`,
			kind,
			shape: 'path',
			x,
			y,
			w,
			h,
			outline: ordered.map((vertex) => ({ x: (vertex.x - x) / w, y: (vertex.y - y) / h })),
			tabCount: kind === 'profile' ? importedTabCount(ordered, view) : 0
		});
	});

	const next = entities.reduce((sheet, entity) => addEntity(sheet, sheetId, entity), design);
	const parts = entities.filter((entity) => entity.kind === 'profile');
	const holes = entities.length - parts.length;
	const size = `${round(extent.right - extent.left, 1)} × ${round(extent.top - extent.bottom, 1)} mm`;
	const skippedNote = skipped.length ? ` Skipped ${skipped.join(', ')}.` : '';
	const first = parts[0] ?? entities[0]!;
	return {
		design: next,
		selection: { kind: first.kind, id: first.id },
		notice: `Imported ${plural(parts.length, 'part')} and ${plural(holes, 'hole')} from ${fileName} (${size}).${skippedNote}`
	};
}
