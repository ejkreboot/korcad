import { finite, isRecord } from '$lib/core/design/normalize.js';
import type { DesignState } from '$lib/core/design/types.js';
import { createSolidEntity, SOLID_KINDS, SOLID_SHAPES } from './defaults.js';
import type { SolidEntity, SolidKind, SolidShape, SolidSheet } from './types.js';

function normalizeEntity(value: unknown, index: number): SolidEntity | null {
	if (!isRecord(value)) return null;
	const kind = SOLID_KINDS.includes(value.kind as SolidKind) ? (value.kind as SolidKind) : null;
	if (!kind) return null;
	const number = (key: string, fallback: number) => {
		const entry = value[key];
		return finite(entry) ? entry : fallback;
	};
	const base = createSolidEntity({
		id: typeof value.id === 'string' && value.id ? value.id : `${kind}-${index + 1}`,
		name: typeof value.name === 'string' ? value.name : `${kind} ${index + 1}`,
		kind,
		shape: SOLID_SHAPES.includes(value.shape as SolidShape)
			? (value.shape as SolidShape)
			: 'rectangle',
		x: number('x', 0),
		y: number('y', 0),
		w: number('w', 0),
		h: number('h', 0)
	});
	return {
		...base,
		cornerRadius: number('cornerRadius', base.cornerRadius),
		sides: Math.max(3, Math.round(number('sides', base.sides))),
		tabCount: Math.max(0, Math.round(number('tabCount', base.tabCount)))
	};
}

/**
 * Reads the Solid workspace. Every sheet tagged `solid` gets an entry, and
 * data for a sheet the document no longer has, or that is drawn in another
 * workspace, is dropped rather than left to be cut from the wrong plate.
 * Entity ids are unique within the whole workspace, so a selection is never
 * ambiguous.
 */
export function normalizeSolid(raw: unknown, document: DesignState): DesignState {
	const savedSheets = isRecord(raw) && isRecord(raw.sheets) ? raw.sheets : {};
	const seen = new Set<string>();
	const sheets: Record<string, SolidSheet> = {};
	for (const sheet of document.sheets) {
		if (sheet.workspace !== 'solid') continue;
		const saved = savedSheets[sheet.id];
		const entries = isRecord(saved) && Array.isArray(saved.entities) ? saved.entities : [];
		sheets[sheet.id] = {
			entities: entries.flatMap((entry, index) => {
				const entity = normalizeEntity(entry, index);
				if (!entity || seen.has(entity.id)) return [];
				seen.add(entity.id);
				return [entity];
			})
		};
	}
	return { ...document, workspaces: { ...document.workspaces, solid: { sheets } } };
}
