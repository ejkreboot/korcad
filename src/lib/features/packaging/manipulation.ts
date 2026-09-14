import { SHEET } from '$lib/core/constants.js';
import { round, snap, snapWithin } from '$lib/core/units.js';
import type { PackagingData, Pocket, Support } from './types.js';
import type { PackagingView } from './view.js';
import { perimeterExtents } from './perimeter.js';
import { riserFlatBounds } from './supports.js';
import { supportAssemblyOrigin, supportParent, supportPlacementLimits } from './mounting.js';
import type { Point } from '$lib/core/geometry/primitives.js';

/**
 * What a drag reads: packaging's view of the sheet being edited, plus the
 * editor's snap toggle. Snap is a drawing aid rather than part of the design,
 * so it is handed in beside the view instead of living in the document.
 */
export type DragView = PackagingView & { readonly snapEnabled: boolean };

/** Smallest deck a drag may produce, in millimeters. */
export const MIN_DECK = 25;
/** Smallest opening or support a drag may produce, in millimeters. */
export const MIN_COMPONENT = 5;

export type Corner = 'nw' | 'ne' | 'sw' | 'se';

export type DeckAction =
	| 'move'
	| 'left'
	| 'right'
	| 'bottom'
	| 'top'
	| 'wall-left'
	| 'wall-right'
	| 'wall-bottom'
	| 'wall-top';

export type DeckOriginal = {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	readonly wall: number;
	/** Pocket positions at drag start, so a deck move carries them along. */
	readonly pockets: readonly { readonly id: string; readonly x: number; readonly y: number }[];
};

/**
 * Applies a deck drag. Moving the deck carries its openings with it; dragging
 * an edge resizes it; dragging a wall grip changes the perimeter wall height,
 * limited so the unfolded blank still fits the stock on every enabled side.
 */
export function applyDeckDrag(
	design: DragView,
	action: DeckAction,
	original: DeckOriginal,
	start: Point,
	current: Point
): Partial<PackagingData> {
	const extents = perimeterExtents(design);
	const snapping = design.snapEnabled;
	const dx = current.x - start.x;
	const dy = current.y - start.y;

	if (action.startsWith('wall-')) {
		const side = action.slice(5);
		const delta =
			side === 'left'
				? start.x - current.x
				: side === 'right'
					? dx
					: side === 'bottom'
						? start.y - current.y
						: dy;
		const limits: number[] = [];
		if (design.perimeterSides.left) limits.push(design.deckX - design.perimeterFlange);
		if (design.perimeterSides.right) {
			limits.push(SHEET - (design.deckX + design.deckW) - design.perimeterFlange);
		}
		if (design.perimeterSides.bottom) limits.push(design.deckY - design.perimeterFlange);
		if (design.perimeterSides.top) {
			limits.push(SHEET - (design.deckY + design.deckH) - design.perimeterFlange);
		}
		return {
			perimeterWall: round(
				snapWithin(original.wall + delta, 1, Math.max(1, Math.min(...limits)), snapping)
			)
		};
	}

	if (action === 'move') {
		const x = snapWithin(
			original.x + dx,
			extents.left,
			SHEET - extents.right - original.w,
			snapping
		);
		const y = snapWithin(
			original.y + dy,
			extents.bottom,
			SHEET - extents.top - original.h,
			snapping
		);
		const shiftX = x - original.x;
		const shiftY = y - original.y;
		const moved = new Map(original.pockets.map((p) => [p.id, p]));
		return {
			deckX: round(x),
			deckY: round(y),
			pockets: design.pockets.map((pocket) => {
				const position = moved.get(pocket.id);
				if (!position || pocket.host.kind !== 'deck') return pocket;
				return { ...pocket, x: round(position.x + shiftX), y: round(position.y + shiftY) };
			})
		};
	}

	if (action === 'left') {
		const right = original.x + original.w;
		const deckX = round(snapWithin(original.x + dx, extents.left, right - MIN_DECK, snapping));
		return { deckX, deckW: round(Math.max(MIN_DECK, snap(right - deckX, snapping))) };
	}
	if (action === 'right') {
		return {
			deckW: round(
				snapWithin(original.w + dx, MIN_DECK, SHEET - extents.right - original.x, snapping)
			)
		};
	}
	if (action === 'bottom') {
		const top = original.y + original.h;
		const deckY = round(snapWithin(original.y + dy, extents.bottom, top - MIN_DECK, snapping));
		return { deckY, deckH: round(Math.max(MIN_DECK, snap(top - deckY, snapping))) };
	}
	return {
		deckH: round(snapWithin(original.h + dy, MIN_DECK, SHEET - extents.top - original.y, snapping))
	};
}

export type RectOriginal = {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
};

export type Area = {
	readonly left: number;
	readonly right: number;
	readonly bottom: number;
	readonly top: number;
};

/**
 * Applies an opening drag. Openings stay inside the area of board they are cut
 * into — the finished top deck unless another is given — because a cutout
 * crossing the edge of its board is not manufacturable.
 */
export function applyPocketDrag(
	design: DragView,
	type: 'move' | 'resize',
	handle: Corner | null,
	original: RectOriginal,
	start: Point,
	current: Point,
	area: Area = {
		left: design.deckX,
		right: design.deckX + design.deckW,
		bottom: design.deckY,
		top: design.deckY + design.deckH
	}
): Pick<Pocket, 'x' | 'y' | 'w' | 'h'> {
	const snapping = design.snapEnabled;
	const deckLeft = area.left;
	const deckBottom = area.bottom;
	const deckRight = area.right;
	const deckTop = area.top;

	if (type === 'move') {
		return {
			x: round(
				snapWithin(original.x + current.x - start.x, deckLeft, deckRight - original.w, snapping)
			),
			y: round(
				snapWithin(original.y + current.y - start.y, deckBottom, deckTop - original.h, snapping)
			),
			w: original.w,
			h: original.h
		};
	}

	const left = original.x;
	const right = original.x + original.w;
	const bottom = original.y;
	const top = original.y + original.h;
	let { x, y, w, h } = original;

	if (handle?.includes('w')) {
		w = round(snapWithin(right - current.x, MIN_COMPONENT, right - deckLeft, snapping));
		x = round(right - w);
	}
	if (handle?.includes('e')) {
		x = left;
		w = round(snapWithin(current.x - left, MIN_COMPONENT, deckRight - left, snapping));
	}
	if (handle?.includes('s')) {
		h = round(snapWithin(top - current.y, MIN_COMPONENT, top - deckBottom, snapping));
		y = round(top - h);
	}
	if (handle?.includes('n')) {
		y = bottom;
		h = round(snapWithin(current.y - bottom, MIN_COMPONENT, deckTop - bottom, snapping));
	}
	return { x, y, w, h };
}

export type SupportOriginal = {
	readonly flatX: number;
	readonly flatY: number;
	readonly w: number;
	readonly d: number;
	readonly h: number;
};

/**
 * Applies a support drag on its cutting sheet. Moving is limited so the whole
 * unfolded net stays on the sheet, which depends on the support's own walls
 * and flanges rather than just its footprint.
 */
export function applySupportDrag(
	design: DragView,
	support: Support,
	type: 'move' | 'resize' | 'height',
	handle: Corner | null,
	original: SupportOriginal,
	start: Point,
	current: Point
): Pick<Support, 'flatX' | 'flatY' | 'w' | 'd' | 'h'> {
	const snapping = design.snapEnabled;
	const dx = current.x - start.x;
	const dy = current.y - start.y;
	const result = { ...original };

	if (type === 'move') {
		const bounds = riserFlatBounds({ ...support, ...original }, design);
		return {
			...result,
			flatX: round(
				snapWithin(
					original.flatX + dx,
					original.flatX - bounds.left,
					SHEET - bounds.right + original.flatX,
					snapping
				)
			),
			flatY: round(
				snapWithin(
					original.flatY + dy,
					original.flatY - bounds.bottom,
					SHEET - bounds.top + original.flatY,
					snapping
				)
			)
		};
	}

	if (type === 'height') {
		return { ...result, h: round(Math.max(MIN_COMPONENT, snap(original.h + dy, snapping))) };
	}

	if (handle?.includes('e')) {
		result.w = round(Math.max(MIN_COMPONENT, snap(original.w + dx, snapping)));
	}
	if (handle?.includes('w')) {
		result.w = round(Math.max(MIN_COMPONENT, snap(original.w - dx, snapping)));
		result.flatX = round(original.flatX + original.w - result.w);
	}
	if (handle?.includes('n')) {
		result.d = round(Math.max(MIN_COMPONENT, snap(original.d + dy, snapping)));
	}
	if (handle?.includes('s')) {
		result.d = round(Math.max(MIN_COMPONENT, snap(original.d - dy, snapping)));
		result.flatY = round(original.flatY + original.d - result.d);
	}
	return result;
}

/**
 * Places a support on the deck by its assembly position, clamped to its mount.
 *
 * `originalOrigin` is the support's global origin, while `assemblyX`/`assemblyY`
 * are relative to whatever it is mounted to, so the parent's own origin is
 * subtracted back out before clamping to that parent's surface.
 */
export function applySupportPlacement(
	design: DragView,
	support: Support,
	originalOrigin: Point,
	start: Point,
	current: Point
): Pick<Support, 'assemblyX' | 'assemblyY'> {
	const limits = supportPlacementLimits(support, design.supports, design);
	const parent = supportParent(support, design.supports);
	const base = parent ? supportAssemblyOrigin(parent, design.supports) : { x: 0, y: 0 };
	return {
		assemblyX: round(
			snapWithin(
				originalOrigin.x + current.x - start.x - base.x,
				0,
				limits.maxX,
				design.snapEnabled
			)
		),
		assemblyY: round(
			snapWithin(
				originalOrigin.y + current.y - start.y - base.y,
				0,
				limits.maxY,
				design.snapEnabled
			)
		)
	};
}
