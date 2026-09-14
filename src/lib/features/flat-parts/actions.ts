import { outlineInside } from '$lib/core/geometry/contour.js';
import { boxAround, scaleBox, type ShapeBox } from '$lib/core/geometry/outline.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import { round } from '$lib/core/units.js';
import type { DesignState, EntityGroup } from '$lib/core/design/types.js';
import type { Selection } from '$lib/core/design/workspace.js';
import type { DocumentHost } from '../workspaces.js';
import { entityOutline } from './geometry.js';
import { scaleEntityBox } from './manipulation.js';
import type { FlatPartsEntity, FlatPartsKind, FlatPartsSheet } from './types.js';
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
		...sheet,
		entities: [...sheet.entities, entity]
	}));
}

/** A sheet without the groups that no longer have a member. */
function pruneGroups(sheet: FlatPartsSheet): FlatPartsSheet {
	const used = new Set(sheet.entities.map((entity) => entity.groupId));
	return { ...sheet, groups: sheet.groups.filter((group) => used.has(group.id)) };
}

/** Applies several entity changes at once, such as a part and the holes it carries. */
export function updateEntities(
	design: DesignState,
	changes: readonly { readonly id: string; readonly values: Partial<FlatPartsEntity> }[]
): DesignState {
	return changes.reduce((next, { id, values }) => {
		const sheetId = entitySheetId(next, id);
		if (!sheetId) return next;
		// Kind and group membership are fixed when an entity is made.
		return withFlatPartsSheet(next, sheetId, (sheet) => ({
			...sheet,
			entities: sheet.entities.map((entity) =>
				entity.id === id
					? { ...entity, ...values, id, kind: entity.kind, groupId: entity.groupId }
					: entity
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

/** The holes cut through a part: those on its sheet lying wholly inside its outline. */
export function holesInside(design: DesignState, part: FlatPartsEntity): FlatPartsEntity[] {
	const sheetId = entitySheetId(design, part.id);
	if (!sheetId || part.kind !== 'profile') return [];
	const outline = entityOutline(part);
	return flatPartsSheetView(design, sheetId).entities.filter(
		(other) => other.kind === 'hole' && outlineInside(entityOutline(other), outline)
	);
}

/**
 * Scales an entity by `factor` about the lower-left corner of its box, the
 * point its X and Y fields name. A part carries the holes inside it, scaled
 * about the same corner, so a plate grows as one piece rather than leaving
 * its holes behind. Tab width is a stock setting and does not scale.
 */
export function scaleEntity(design: DesignState, id: string, factor: number): DesignState {
	const entity = findEntity(design, id);
	if (!entity || !Number.isFinite(factor) || factor <= 0) return design;
	const anchor = { x: entity.x, y: entity.y };
	return updateEntities(
		design,
		[entity, ...holesInside(design, entity)].map((item) => ({
			id: item.id,
			values: scaleEntityBox(item, anchor, factor)
		}))
	);
}

export function removeEntity(design: DesignState, id: string): DesignState {
	const sheetId = entitySheetId(design, id);
	if (!sheetId) return design;
	return withFlatPartsSheet(design, sheetId, (sheet) =>
		pruneGroups({ ...sheet, entities: sheet.entities.filter((entity) => entity.id !== id) })
	);
}

// ---- imported groups ------------------------------------------------------

/** A group and the sheet it is on, or `null`. */
export function findGroup(
	design: DesignState,
	id: string
): { readonly sheetId: string; readonly group: EntityGroup } | null {
	for (const [sheetId, sheet] of Object.entries(flatPartsData(design).sheets)) {
		const group = sheet.groups.find((candidate) => candidate.id === id);
		if (group) return { sheetId, group };
	}
	return null;
}

/** The entities imported as a group. */
export function groupMembers(design: DesignState, id: string): FlatPartsEntity[] {
	const found = findGroup(design, id);
	if (!found) return [];
	return flatPartsSheetView(design, found.sheetId).entities.filter(
		(entity) => entity.groupId === id
	);
}

/** The box around a group's members, or `null` when it has none. */
export function groupBox(design: DesignState, id: string): ShapeBox | null {
	return boxAround(groupMembers(design, id));
}

/**
 * What moves and scales with a group: its members, and any hole drawn later
 * through one of its parts, which follows that part as holes always do.
 */
export function groupCarried(design: DesignState, id: string): FlatPartsEntity[] {
	const carried = new Map(groupMembers(design, id).map((entity) => [entity.id, entity]));
	for (const member of [...carried.values()]) {
		for (const hole of holesInside(design, member)) carried.set(hole.id, hole);
	}
	return [...carried.values()];
}

export type EntityChange = { readonly id: string; readonly values: Partial<FlatPartsEntity> };

/**
 * Where each carried entity goes when its group is scaled by `factor` about
 * `anchor` and then moved by `offset`: every box, and every corner radius,
 * scales together, so the drawing keeps its proportions. Computed from the
 * entities as they were when a gesture began, so a drag never compounds.
 */
export function groupChanges(
	carried: readonly FlatPartsEntity[],
	anchor: Point,
	factor: number,
	offset: Point = { x: 0, y: 0 }
): EntityChange[] {
	return carried.map((entity) => {
		const box = scaleBox(entity, anchor, factor);
		return {
			id: entity.id,
			values: {
				x: round(box.x + offset.x),
				y: round(box.y + offset.y),
				w: box.w,
				h: box.h,
				cornerRadius: round(entity.cornerRadius * factor)
			}
		};
	});
}

/** Scales a group by `factor` about its lower-left corner. */
export function scaleGroup(design: DesignState, id: string, factor: number): DesignState {
	const box = groupBox(design, id);
	if (!box || !Number.isFinite(factor) || factor <= 0) return design;
	return updateEntities(design, groupChanges(groupCarried(design, id), box, factor));
}

/** Moves a group so its lower-left corner is at `x`, `y`. */
export function moveGroup(design: DesignState, id: string, x: number, y: number): DesignState {
	const box = groupBox(design, id);
	if (!box || !Number.isFinite(x) || !Number.isFinite(y)) return design;
	return updateEntities(
		design,
		groupChanges(groupCarried(design, id), box, 1, { x: x - box.x, y: y - box.y })
	);
}

/** Gives every part in a group the same number of holding tabs. */
export function setGroupTabs(design: DesignState, id: string, tabCount: number): DesignState {
	return updateEntities(
		design,
		groupMembers(design, id)
			.filter((entity) => entity.kind === 'profile')
			.map((entity) => ({ id: entity.id, values: { tabCount } }))
	);
}

export function renameGroup(design: DesignState, id: string, name: string): DesignState {
	const found = findGroup(design, id);
	if (!found) return design;
	return withFlatPartsSheet(design, found.sheetId, (sheet) => ({
		...sheet,
		groups: sheet.groups.map((group) => (group.id === id ? { ...group, name } : group))
	}));
}

/** Deletes a group with its members; a hole drawn through one of its parts goes too. */
export function removeGroup(design: DesignState, id: string): DesignState {
	const found = findGroup(design, id);
	if (!found) return design;
	const gone = new Set(groupCarried(design, id).map((entity) => entity.id));
	return withFlatPartsSheet(design, found.sheetId, (sheet) =>
		pruneGroups({ ...sheet, entities: sheet.entities.filter((entity) => !gone.has(entity.id)) })
	);
}

/** Adds an imported group and its members to a sheet. */
export function addGroup(
	design: DesignState,
	sheetId: string,
	group: EntityGroup,
	members: readonly FlatPartsEntity[]
): DesignState {
	return withFlatPartsSheet(design, sheetId, (sheet) => ({
		entities: [...sheet.entities, ...members.map((entity) => ({ ...entity, groupId: group.id }))],
		groups: [...sheet.groups, group]
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
	const groupId = () => (host.selection?.kind === 'group' ? host.selection.id : null);
	return {
		get view(): FlatPartsView {
			return flatPartsSheetView(host.design);
		},
		get selectedEntity(): FlatPartsEntity | null {
			const selection = selected();
			return selection ? findEntity(host.design, selection.id) : null;
		},
		/** The selected imported group, with its members and the box around them. */
		get selectedGroup(): {
			group: EntityGroup;
			members: FlatPartsEntity[];
			box: ShapeBox;
		} | null {
			const id = groupId();
			const found = id ? findGroup(host.design, id) : null;
			const members = id ? groupMembers(host.design, id) : [];
			const box = boxAround(members);
			return found && box ? { group: found.group, members, box } : null;
		},
		/** Selects an entity, or the group it was imported with. */
		select(entity: Pick<FlatPartsEntity, 'id' | 'kind' | 'groupId'> | null) {
			if (entity?.groupId) host.select({ kind: 'group', id: entity.groupId });
			else
				host.select(entity ? { kind: entity.kind satisfies FlatPartsKind, id: entity.id } : null);
		},
		scaleGroup(id: string, factor: number) {
			host.update((design) => scaleGroup(design, id, factor));
		},
		moveGroup(id: string, x: number, y: number) {
			host.update((design) => moveGroup(design, id, x, y));
		},
		setGroupTabs(id: string, tabCount: number) {
			host.update((design) => setGroupTabs(design, id, tabCount));
		},
		renameGroup(id: string, name: string) {
			host.update((design) => renameGroup(design, id, name));
		},
		removeGroup(id: string) {
			host.update((design) => removeGroup(design, id));
		},
		groupCarried(id: string): FlatPartsEntity[] {
			return groupCarried(host.design, id);
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
		scaleEntity(id: string, factor: number) {
			host.update((design) => scaleEntity(design, id, factor));
		},
		holesInside(part: FlatPartsEntity): FlatPartsEntity[] {
			return holesInside(host.design, part);
		},
		previewEntities(changes: readonly { id: string; values: Partial<FlatPartsEntity> }[]) {
			host.preview((design) => updateEntities(design, changes));
		}
	};
}

export type FlatPartsActions = ReturnType<typeof flatPartsActions>;
