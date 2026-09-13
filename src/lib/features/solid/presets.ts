import type { IconName } from '$lib/components/icons/paths.js';
import { round } from '$lib/core/units.js';
import { createSolidEntity } from './defaults.js';
import type { SolidEntity, SolidKind, SolidShape } from './types.js';

export type SolidPresetInfo = {
	readonly id: SolidShape;
	readonly label: string;
	readonly description: string;
	readonly icon: IconName;
};

export const PROFILE_PRESETS: readonly SolidPresetInfo[] = [
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
	}
];

export const HOLE_PRESETS: readonly SolidPresetInfo[] = [
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
	}
];

/** Which kind of entity each drawing tool makes. */
export const TOOL_KINDS: { readonly [tool: string]: SolidKind } = {
	profile: 'profile',
	hole: 'hole'
};

const presetsFor = (kind: SolidKind) => (kind === 'profile' ? PROFILE_PRESETS : HOLE_PRESETS);

export function solidPreset(kind: SolidKind, id: string): SolidPresetInfo | null {
	return presetsFor(kind).find((preset) => preset.id === id) ?? null;
}

/** Builds an entity from a rectangle drawn with a preset. */
export function createEntityFromPreset(
	kind: SolidKind,
	shape: SolidShape,
	rect: { x: number; y: number; w: number; h: number },
	id: string,
	index: number
): SolidEntity {
	const noun = kind === 'profile' ? 'Part' : shape === 'slot' ? 'Slot' : 'Hole';
	return createSolidEntity({
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
