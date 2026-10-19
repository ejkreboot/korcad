import type { IconName } from '$lib/components/icons/paths.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import { boxedOutline, signedArea } from '$lib/core/import/outlines.js';
import { round } from '$lib/core/units.js';
import { createFlatPartsEntity } from './defaults.js';
import { MIN_FLAT_PARTS_DRAG } from './manipulation.js';
import type { FlatPartsEntity, FlatPartsKind, FlatPartsShape } from './types.js';

export type FlatPartsPresetInfo = {
	readonly id: FlatPartsShape;
	readonly label: string;
	readonly description: string;
	readonly icon: IconName;
	/** Set on the one preset clicked out vertex by vertex rather than dragged as a box. */
	readonly gesture?: 'outline';
};

/** An outline of any shape, clicked out a corner at a time; it becomes a `path`. */
const OUTLINE_PRESET = {
	id: 'path',
	label: 'Freeform outline',
	description: 'Click each corner, then the first',
	icon: 'polyline',
	gesture: 'outline'
} as const satisfies FlatPartsPresetInfo;

export const PROFILE_PRESETS: readonly FlatPartsPresetInfo[] = [
	{ id: 'rectangle', label: 'Rectangle', description: 'Square-cornered part', icon: 'rectangle' },
	{
		id: 'rounded',
		label: 'Rounded rectangle',
		description: 'Part with rounded corners',
		icon: 'rounded_corner'
	},
	{
		id: 'ellipse',
		label: 'Circle or ellipse',
		description: 'Draw its enclosing bounds',
		icon: 'circle'
	},
	{
		id: 'polygon',
		label: 'Polygon',
		description: 'Regular polygon in its bounds',
		icon: 'pentagon'
	},
	OUTLINE_PRESET
];

export const HOLE_PRESETS: readonly FlatPartsPresetInfo[] = [
	{
		id: 'ellipse',
		label: 'Hole',
		description: 'Round hole, cut inside the line',
		icon: 'radio_button_unchecked'
	},
	{
		id: 'slot',
		label: 'Slot',
		description: 'Rounded ends, cut inside the line',
		icon: 'horizontal_rule'
	},
	OUTLINE_PRESET
];

/** Which kind of entity each drawing tool makes. */
export const TOOL_KINDS: { readonly [tool: string]: FlatPartsKind } = {
	profile: 'profile',
	hole: 'hole'
};

const presetsFor = (kind: FlatPartsKind) => (kind === 'profile' ? PROFILE_PRESETS : HOLE_PRESETS);

export function flatPartsPreset(kind: FlatPartsKind, id: string): FlatPartsPresetInfo | null {
	return presetsFor(kind).find((preset) => preset.id === id) ?? null;
}

/** Builds an entity from a rectangle drawn with a preset. */
export function createEntityFromPreset(
	kind: FlatPartsKind,
	shape: FlatPartsShape,
	rect: { x: number; y: number; w: number; h: number },
	id: string,
	index: number
): FlatPartsEntity {
	const noun = kind === 'profile' ? 'Part' : shape === 'slot' ? 'Slot' : 'Hole';
	return createFlatPartsEntity({
		id,
		name: `${noun} ${index}`,
		kind,
		shape,
		x: round(rect.x),
		y: round(rect.y),
		w: round(rect.w),
		h: round(rect.h)
	});
}

/**
 * Builds a `path` entity from a closed outline clicked out on the sheet, wound
 * counter-clockwise as an imported one is. `null` when it is too small to have
 * been meant, by the same measure as a drawn box, or encloses nothing.
 */
export function createEntityFromOutline(
	kind: FlatPartsKind,
	points: readonly Point[],
	id: string,
	index: number
): FlatPartsEntity | null {
	const area = signedArea(points);
	if (points.length < 3 || Math.abs(area) < 1e-6) return null;
	const { fractions, ...box } = boxedOutline(area < 0 ? [...points].reverse() : points);
	if (box.w < MIN_FLAT_PARTS_DRAG || box.h < MIN_FLAT_PARTS_DRAG) return null;
	return createFlatPartsEntity({
		id,
		name: `${kind === 'profile' ? 'Part' : 'Hole'} ${index}`,
		kind,
		shape: 'path',
		...box,
		outline: fractions
	});
}
