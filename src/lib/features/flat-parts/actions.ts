import type { DesignState } from '$lib/core/design/types.js';
import type { Selection } from '$lib/core/design/workspace.js';
import type { DocumentHost } from '../workspaces.js';
import type { FlatPartsEntity, FlatPartsKind } from './types.js';
import {
	flatPartsData,
	flatPartsSheetView,
	withFlatPartsSheet,
	type FlatPartsView
} from './view.js';

/**
 * The Flat Parts workspace's verbs: pure changes to the document, and `flatPartsActions` binding them
 * to the editor so each is one undo step. An entity lives on exactly one sheet,
 * so an id is enough to find it.
 */

/** The sheet an entity is on, or `null`. */
export function entitySheetId(design: DesignState, id: string): string | null {
	for (const [sheetId, sheet] of Object.entries(flatPartsData(design).sheets)) {
		if (sheet.entities.some((entity) => entity.id === id)) return sheetId;
	}
	return null;
}

export function findEntity(design: DesignState, id: string): FlatPartsEntity | null {
	const sheetId = entitySheetId(design, id);
	if (!sheetId) return null;
	return flatPartsData(design).sheets[sheetId]!.entities.find((entity) => entity.id === id) ?? null;
}

export function addEntity(
	design: DesignState,
	sheetId: string,
	entity: FlatPartsEntity
): DesignState {
	return withFlatPartsSheet(design, sheetId, (sheet) => ({
		entities: [...sheet.entities, entity]
	}));
}

/** Applies several entity changes at once, such as a part and the holes it carries. */
export function updateEntities(
	design: DesignState,
	changes: readonly { readonly id: string; readonly values: Partial<FlatPartsEntity> }[]
): DesignState {
	return changes.reduce((next, { id, values }) => {
		const sheetId = entitySheetId(next, id);
		if (!sheetId) return next;
		return withFlatPartsSheet(next, sheetId, (sheet) => ({
			entities: sheet.entities.map((entity) =>
				entity.id === id ? { ...entity, ...values, id, kind: entity.kind } : entity
			)
		}));
	}, design);
}

export function updateEntity(
	design: DesignState,
	id: string,
	values: Partial<FlatPartsEntity>
): DesignState {
	return updateEntities(design, [{ id, values }]);
}

export function removeEntity(design: DesignState, id: string): DesignState {
	const sheetId = entitySheetId(design, id);
	if (!sheetId) return design;
	return withFlatPartsSheet(design, sheetId, (sheet) => ({
		entities: sheet.entities.filter((entity) => entity.id !== id)
	}));
}

/** A removed sheet's parts go with it. */
export function releaseFlatPartsSheet(design: DesignState, sheetId: string): DesignState {
	const data = design.workspaces.flatParts;
	if (!data || !(sheetId in data.sheets)) return design;
	const sheets = Object.fromEntries(Object.entries(data.sheets).filter(([id]) => id !== sheetId));
	return { ...design, workspaces: { ...design.workspaces, flatParts: { sheets } } };
}

/** The Flat Parts workspace's verbs bound to an editor, for components. They act on the active sheet. */
export function flatPartsActions(host: DocumentHost) {
	const selected = (): Selection | null =>
		host.selection?.kind === 'profile' || host.selection?.kind === 'hole' ? host.selection : null;
	return {
		get view(): FlatPartsView {
			return flatPartsSheetView(host.design);
		},
		get selectedEntity(): FlatPartsEntity | null {
			const selection = selected();
			return selection ? findEntity(host.design, selection.id) : null;
		},
		select(entity: Pick<FlatPartsEntity, 'id' | 'kind'> | null) {
			host.select(entity ? { kind: entity.kind satisfies FlatPartsKind, id: entity.id } : null);
		},
		/** Adds an entity to the active sheet and selects it. */
		addEntity(entity: FlatPartsEntity) {
			host.update((design) => addEntity(design, design.activeSheetId, entity));
			host.select({ kind: entity.kind, id: entity.id });
		},
		updateEntity(id: string, values: Partial<FlatPartsEntity>) {
			host.update((design) => updateEntity(design, id, values));
		},
		removeEntity(id: string) {
			host.update((design) => removeEntity(design, id));
		},
		previewEntities(changes: readonly { id: string; values: Partial<FlatPartsEntity> }[]) {
			host.preview((design) => updateEntities(design, changes));
		}
	};
}

export type FlatPartsActions = ReturnType<typeof flatPartsActions>;
