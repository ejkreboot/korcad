import { SHEET } from '$lib/core/constants.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import { round, snapWithin } from '$lib/core/units.js';
import type { FlatPartsEntity } from './types.js';

/** Smallest box a drag may shrink an entity to, in millimeters. */
export const MIN_FLAT_PARTS_DRAG = 5;

export type Corner = 'nw' | 'ne' | 'sw' | 'se';

export type EntityBox = Pick<FlatPartsEntity, 'x' | 'y' | 'w' | 'h'>;

/**
 * Moves a box by the pointer's travel, kept on the sheet. The drawn box is
 * what is kept on the sheet; a router's outside offset is validation's call.
 */
export function moveEntityBox(
	original: EntityBox,
	start: Point,
	current: Point,
	snapping: boolean
): EntityBox {
	return {
		x: round(snapWithin(original.x + current.x - start.x, 0, SHEET - original.w, snapping)),
		y: round(snapWithin(original.y + current.y - start.y, 0, SHEET - original.h, snapping)),
		w: original.w,
		h: original.h
	};
}

/** Resizes a box from one corner, holding the opposite corner still. */
export function resizeEntityBox(
	original: EntityBox,
	handle: Corner,
	current: Point,
	snapping: boolean
): EntityBox {
	const left = original.x;
	const right = original.x + original.w;
	const bottom = original.y;
	const top = original.y + original.h;
	let { x, y } = original;
	let w: number;
	let h: number;
	if (handle.includes('w')) {
		w = round(snapWithin(right - current.x, MIN_FLAT_PARTS_DRAG, right, snapping));
		x = round(right - w);
	} else {
		w = round(snapWithin(current.x - left, MIN_FLAT_PARTS_DRAG, SHEET - left, snapping));
	}
	if (handle.includes('s')) {
		h = round(snapWithin(top - current.y, MIN_FLAT_PARTS_DRAG, top, snapping));
		y = round(top - h);
	} else {
		h = round(snapWithin(current.y - bottom, MIN_FLAT_PARTS_DRAG, SHEET - bottom, snapping));
	}
	return { x, y, w, h };
}
