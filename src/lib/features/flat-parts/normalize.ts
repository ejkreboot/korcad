import { finite, groupIdOf, isRecord, normalizeGroups } from '$lib/core/design/normalize.js';
import type { DesignState } from '$lib/core/design/types.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import { createFlatPartsEntity, FLAT_PARTS_KINDS, FLAT_PARTS_SHAPES } from './defaults.js';
import type { FlatPartsEntity, FlatPartsKind, FlatPartsShape, FlatPartsSheet } from './types.js';

function normalizeOutline(values: readonly unknown[]): Point[] {
	return values.flatMap((vertex) =>
		isRecord(vertex) && finite(vertex.x) && finite(vertex.y) ? [{ x: vertex.x, y: vertex.y }] : []
	);
}

function normalizeEntity(value: unknown, index: number): FlatPartsEntity | null {
	if (!isRecord(value)) return null;
	const kind = FLAT_PARTS_KINDS.includes(value.kind as FlatPartsKind)
		? (value.kind as FlatPartsKind)
		: null;
	if (!kind) return null;
	const number = (key: string, fallback: number) => {
		const entry = value[key];
		return finite(entry) ? entry : fallback;
	};
	const base = createFlatPartsEntity({
		id: typeof value.id === 'string' && value.id ? value.id : `${kind}-${index + 1}`,
		name: typeof value.name === 'string' ? value.name : `${kind} ${index + 1}`,
		kind,
		shape: FLAT_PARTS_SHAPES.includes(value.shape as FlatPartsShape)
			? (value.shape as FlatPartsShape)
			: 'rectangle',
		x: number('x', 0),
		y: number('y', 0),
		w: number('w', 0),
		h: number('h', 0)
	});
	// A path is nothing without its outline, and the outline means nothing to any other shape.
	const outline =
		base.shape === 'path' && Array.isArray(value.outline) ? normalizeOutline(value.outline) : [];
	if (base.shape === 'path' && outline.length < 3) return null;
	return {
		...base,
		outline,
		groupId: groupIdOf(value.groupId),
		cornerRadius: number('cornerRadius', base.cornerRadius),
		sides: Math.max(3, Math.round(number('sides', base.sides))),
		tabCount: Math.max(0, Math.round(number('tabCount', base.tabCount)))
	};
}

/**
 * Reads the Flat Parts workspace. Every sheet tagged `flatParts` gets an entry, and
 * data for a sheet the document no longer has, or that is drawn in another
 * workspace, is dropped rather than left to be cut from the wrong sheet.
 * Entity ids are unique within the whole workspace, so a selection is never
 * ambiguous.
 */
export function normalizeFlatParts(raw: unknown, document: DesignState): DesignState {
	const savedSheets = isRecord(raw) && isRecord(raw.sheets) ? raw.sheets : {};
	const seen = new Set<string>();
	const seenGroups = new Set<string>();
	const sheets: Record<string, FlatPartsSheet> = {};
	for (const sheet of document.sheets) {
		if (sheet.workspace !== 'flatParts') continue;
		const saved = savedSheets[sheet.id];
		const entries = isRecord(saved) && Array.isArray(saved.entities) ? saved.entities : [];
		const entities = entries.flatMap((entry, index) => {
			const entity = normalizeEntity(entry, index);
			if (!entity || seen.has(entity.id)) return [];
			seen.add(entity.id);
			return [entity];
		});
		// A group with no member is dropped, and a member of a group that is not
		// on its sheet stands alone.
		const memberOf = new Set(entities.flatMap((entity) => entity.groupId ?? []));
		const groups = normalizeGroups(isRecord(saved) ? saved.groups : [], memberOf, seenGroups);
		const kept = new Set(groups.map((group) => group.id));
		sheets[sheet.id] = {
			entities: entities.map((entity) =>
				entity.groupId && !kept.has(entity.groupId) ? { ...entity, groupId: null } : entity
			),
			groups
		};
	}
	return { ...document, workspaces: { ...document.workspaces, flatParts: { sheets } } };
}
