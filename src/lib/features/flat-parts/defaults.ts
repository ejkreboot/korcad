import type { FlatPartsData, FlatPartsEntity, FlatPartsKind, FlatPartsShape } from './types.js';

/** Flat Parts data for a document whose first Flat Parts sheet is `sheetId`: one empty sheet. */
export function createDefaultFlatParts(sheetId: string): FlatPartsData {
	return { sheets: { [sheetId]: { entities: [], groups: [] } } };
}

/** Field defaults for a newly drawn entity, and for fields a saved file lacks. */
export function createFlatPartsEntity(
	values: Partial<FlatPartsEntity> &
		Pick<FlatPartsEntity, 'id' | 'name' | 'kind' | 'shape' | 'x' | 'y' | 'w' | 'h'>
): FlatPartsEntity {
	return {
		cornerRadius: 6.35,
		sides: 6,
		outline: [],
		groupId: null,
		tabCount: values.kind === 'profile' ? 4 : 0,
		...values
	};
}

export const FLAT_PARTS_SHAPES: readonly FlatPartsShape[] = [
	'rectangle',
	'rounded',
	'ellipse',
	'polygon',
	'slot',
	'path'
];

export const FLAT_PARTS_KINDS: readonly FlatPartsKind[] = ['profile', 'hole'];
