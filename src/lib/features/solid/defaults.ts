import type { SolidData, SolidEntity, SolidKind, SolidShape } from './types.js';

export function createDefaultSolid(): SolidData {
	return { sheets: {} };
}

/** Field defaults for a newly drawn entity, and for fields a saved file lacks. */
export function createSolidEntity(
	values: Partial<SolidEntity> &
		Pick<SolidEntity, 'id' | 'name' | 'kind' | 'shape' | 'x' | 'y' | 'w' | 'h'>
): SolidEntity {
	return {
		cornerRadius: 6.35,
		sides: 6,
		tabCount: values.kind === 'profile' ? 4 : 0,
		...values
	};
}

export const SOLID_SHAPES: readonly SolidShape[] = [
	'rectangle',
	'rounded',
	'ellipse',
	'polygon',
	'slot'
];

export const SOLID_KINDS: readonly SolidKind[] = ['profile', 'hole'];
