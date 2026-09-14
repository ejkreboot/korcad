import { boxAround, rotatePoints, scaleBox, type ShapeBox } from '$lib/core/geometry/outline.js';
import { point, type Point } from '$lib/core/geometry/primitives.js';
import { boxedOutline } from '$lib/core/import/outlines.js';
import { round } from '$lib/core/units.js';
import type { DesignState, EntityGroup } from '$lib/core/design/types.js';
import type { DocumentHost } from '../workspaces.js';

export type { DocumentHost };
import { constrainSupportFlat, placeSupport } from './placement.js';
import type { PackagingData, Pocket, Support } from './types.js';
import { cutoutPoints } from './geometry.js';
import { packagingSheetView, withPackaging, type PackagingView } from './view.js';

/**
 * Packaging's verbs. Each is a pure change to the document; `packagingActions`
 * binds them to the editor's one update primitive so a component can call
 * `actions.addPocket(pocket)` and get one undo step.
 */

/** The selection kinds packaging gives its entities. */
export type PackagingSelectionKind = 'pocket' | 'pocket-group' | 'support';

// Group membership is fixed when an opening is made.
const mapPockets = (design: DesignState, id: string, values: Partial<Pocket>) =>
	withPackaging(design, (data) => ({
		...data,
		pockets: data.pockets.map((pocket) =>
			pocket.id === id ? { ...pocket, ...values, groupId: pocket.groupId } : pocket
		)
	}));

/** Packaging data without the groups that no longer have a member. */
const pruneGroups = (data: PackagingData): PackagingData => {
	const used = new Set(data.pockets.map((pocket) => pocket.groupId));
	return { ...data, pocketGroups: data.pocketGroups.filter((group) => used.has(group.id)) };
};

const mapSupports = (design: DesignState, update: (support: Support) => Support) =>
	withPackaging(design, (data) => ({ ...data, supports: data.supports.map(update) }));

export function setPackagingValues(
	design: DesignState,
	values: Partial<PackagingData>
): DesignState {
	return withPackaging(design, (data) => ({ ...data, ...values }));
}

export function addPocket(design: DesignState, pocket: Pocket): DesignState {
	return withPackaging(design, (data) => ({ ...data, pockets: [...data.pockets, pocket] }));
}

export function updatePocket(
	design: DesignState,
	id: string,
	values: Partial<Pocket>
): DesignState {
	return mapPockets(design, id, values);
}

export function removePocket(design: DesignState, id: string): DesignState {
	return withPackaging(design, (data) =>
		pruneGroups({ ...data, pockets: data.pockets.filter((pocket) => pocket.id !== id) })
	);
}

// ---- imported groups ------------------------------------------------------

export type PocketChange = { readonly id: string; readonly values: Partial<Pocket> };

export function updatePockets(design: DesignState, changes: readonly PocketChange[]): DesignState {
	return changes.reduce((next, { id, values }) => mapPockets(next, id, values), design);
}

export function findPocketGroup(design: DesignState, id: string): EntityGroup | null {
	return design.workspaces.packaging?.pocketGroups.find((group) => group.id === id) ?? null;
}

/** The openings imported as a group. */
export function pocketGroupMembers(design: DesignState, id: string): Pocket[] {
	return (design.workspaces.packaging?.pockets ?? []).filter((pocket) => pocket.groupId === id);
}

/** The box around a group's openings, or `null` when it has none. */
export function pocketGroupBox(design: DesignState, id: string): ShapeBox | null {
	return boxAround(pocketGroupMembers(design, id));
}

/**
 * Where each opening goes when its group is scaled by `factor` about `anchor`
 * and then moved by `offset`, from the openings as they were when a gesture
 * began, so a drag never compounds.
 */
export function pocketGroupChanges(
	members: readonly Pocket[],
	anchor: Point,
	factor: number,
	offset: Point = { x: 0, y: 0 }
): PocketChange[] {
	return members.map((pocket) => {
		const box = scaleBox(pocket, anchor, factor);
		return {
			id: pocket.id,
			values: {
				x: round(box.x + offset.x),
				y: round(box.y + offset.y),
				w: box.w,
				h: box.h,
				cornerRadius: round(pocket.cornerRadius * factor)
			}
		};
	});
}

/** Scales a group of openings by `factor` about its lower-left corner. */
export function scalePocketGroup(design: DesignState, id: string, factor: number): DesignState {
	const box = pocketGroupBox(design, id);
	if (!box || !Number.isFinite(factor) || factor <= 0) return design;
	return updatePockets(design, pocketGroupChanges(pocketGroupMembers(design, id), box, factor));
}

/** Moves a group of openings so its lower-left corner is at `x`, `y`. */
export function movePocketGroup(
	design: DesignState,
	id: string,
	x: number,
	y: number
): DesignState {
	const box = pocketGroupBox(design, id);
	if (!box || !Number.isFinite(x) || !Number.isFinite(y)) return design;
	return updatePockets(
		design,
		pocketGroupChanges(pocketGroupMembers(design, id), box, 1, { x: x - box.x, y: y - box.y })
	);
}

/**
 * Where each opening goes when its group turns `degrees` counter-clockwise
 * about `pivot`: its outline turns vertex by vertex and is boxed again, so the
 * group's box is read afresh from its openings.
 */
export function pocketGroupRotationChanges(
	members: readonly Pocket[],
	pivot: Point,
	degrees: number
): PocketChange[] {
	return members.map((pocket) => {
		const { fractions, ...box } = boxedOutline(rotatePoints(cutoutPoints(pocket), pivot, degrees));
		return { id: pocket.id, values: { ...box, shape: 'profile', profile: fractions } };
	});
}

/** Turns a group of openings `degrees` counter-clockwise about the centre of its box. */
export function rotatePocketGroup(design: DesignState, id: string, degrees: number): DesignState {
	const box = pocketGroupBox(design, id);
	if (!box || !Number.isFinite(degrees) || degrees % 360 === 0) return design;
	const pivot = point(box.x + box.w / 2, box.y + box.h / 2);
	return updatePockets(
		design,
		pocketGroupRotationChanges(pocketGroupMembers(design, id), pivot, degrees)
	);
}

/**
 * Turns an imported opening `degrees` counter-clockwise about the centre of its
 * box. Only an imported outline turns: a drawn opening is kept to its shape.
 */
export function rotatePocket(design: DesignState, id: string, degrees: number): DesignState {
	const pocket = design.workspaces.packaging?.pockets.find((candidate) => candidate.id === id);
	if (pocket?.shape !== 'profile' || !Number.isFinite(degrees) || degrees % 360 === 0) {
		return design;
	}
	const pivot = point(pocket.x + pocket.w / 2, pocket.y + pocket.h / 2);
	return updatePockets(design, pocketGroupRotationChanges([pocket], pivot, degrees));
}

export function renamePocketGroup(design: DesignState, id: string, name: string): DesignState {
	return withPackaging(design, (data) => ({
		...data,
		pocketGroups: data.pocketGroups.map((group) => (group.id === id ? { ...group, name } : group))
	}));
}

/** Deletes a group of openings with its members. */
export function removePocketGroup(design: DesignState, id: string): DesignState {
	return withPackaging(design, (data) =>
		pruneGroups({ ...data, pockets: data.pockets.filter((pocket) => pocket.groupId !== id) })
	);
}

/** Adds an imported group and its openings to the deck. */
export function addPocketGroup(
	design: DesignState,
	group: EntityGroup,
	members: readonly Pocket[]
): DesignState {
	return withPackaging(design, (data) => ({
		...data,
		pockets: [...data.pockets, ...members.map((pocket) => ({ ...pocket, groupId: group.id }))],
		pocketGroups: [...data.pocketGroups, group]
	}));
}

/**
 * Adds a support, finding room for its net. A tray is drawn on the deck but
 * cut from a parts sheet, so placement may add a sheet.
 */
export function addSupport(
	design: DesignState,
	support: Support,
	newId: () => string
): DesignState {
	const placement =
		support.kind === 'tray' ? placeSupport(support, packagingSheetView(design), newId) : null;
	const placed = placement
		? { ...support, sheetId: placement.sheetId, flatX: placement.flatX, flatY: placement.flatY }
		: support;
	const next = withPackaging(design, (data) => ({ ...data, supports: [...data.supports, placed] }));
	return placement?.newSheet ? { ...next, sheets: [...next.sheets, placement.newSheet] } : next;
}

export function updateSupport(
	design: DesignState,
	id: string,
	values: Partial<Support>
): DesignState {
	return mapSupports(design, (support) =>
		support.id === id ? { ...support, ...values } : support
	);
}

/** Like `updateSupport`, but keeps the resulting net on its sheet. */
export function resizeSupport(
	design: DesignState,
	id: string,
	values: Partial<Support>
): DesignState {
	const view = packagingSheetView(design);
	return mapSupports(design, (support) => {
		if (support.id !== id) return support;
		const next = { ...support, ...values };
		return { ...next, ...constrainSupportFlat(next, view) };
	});
}

export function removeSupport(design: DesignState, id: string): DesignState {
	return withPackaging(design, (data) => ({
		...data,
		supports: data.supports.filter((support) => support.id !== id)
	}));
}

/** The supports cut from a sheet go with it. */
export function releaseSheet(design: DesignState, sheetId: string): DesignState {
	return withPackaging(design, (data) => ({
		...data,
		supports: data.supports.filter((support) => support.sheetId !== sheetId)
	}));
}

const selectedId = (host: DocumentHost, kind: PackagingSelectionKind): string | null =>
	host.selection?.kind === kind ? host.selection.id : null;

/** Packaging's verbs bound to an editor, for components. */
export function packagingActions(host: DocumentHost) {
	return {
		/** The active sheet as packaging sees it: deck, perimeter, pockets, supports. */
		get view(): PackagingView {
			return packagingSheetView(host.design);
		},
		get selectedPocketId() {
			return selectedId(host, 'pocket');
		},
		get selectedSupportId() {
			return selectedId(host, 'support');
		},
		/** The selected imported group, with its openings and the box around them. */
		get selectedPocketGroup(): { group: EntityGroup; members: Pocket[]; box: ShapeBox } | null {
			const id = selectedId(host, 'pocket-group');
			const group = id ? findPocketGroup(host.design, id) : null;
			const members = id ? pocketGroupMembers(host.design, id) : [];
			const box = boxAround(members);
			return group && box ? { group, members, box } : null;
		},

		setPackaging<K extends keyof PackagingData>(key: K, value: PackagingData[K]) {
			host.update((design) => setPackagingValues(design, { [key]: value }));
		},
		/** Selects an opening, or the group it was imported with. */
		selectPocket(id: string | null) {
			const pocket = host.design.workspaces.packaging?.pockets.find((p) => p.id === id);
			if (pocket?.groupId) host.select({ kind: 'pocket-group', id: pocket.groupId });
			else host.select(id === null ? null : { kind: 'pocket', id });
		},
		selectPocketGroup(id: string) {
			host.select({ kind: 'pocket-group', id });
		},
		rotatePocket(id: string, degrees: number) {
			host.update((design) => rotatePocket(design, id, degrees));
		},
		scalePocketGroup(id: string, factor: number) {
			host.update((design) => scalePocketGroup(design, id, factor));
		},
		movePocketGroup(id: string, x: number, y: number) {
			host.update((design) => movePocketGroup(design, id, x, y));
		},
		rotatePocketGroup(id: string, degrees: number) {
			host.update((design) => rotatePocketGroup(design, id, degrees));
		},
		renamePocketGroup(id: string, name: string) {
			host.update((design) => renamePocketGroup(design, id, name));
		},
		removePocketGroup(id: string) {
			host.update((design) => removePocketGroup(design, id));
		},
		previewPockets(changes: readonly PocketChange[]) {
			host.preview((design) => updatePockets(design, changes));
		},
		selectSupport(id: string | null) {
			host.select(id === null ? null : { kind: 'support', id });
		},

		/** Adds an opening and selects it. */
		addPocket(pocket: Pocket) {
			host.update((design) => addPocket(design, pocket));
			host.select({ kind: 'pocket', id: pocket.id });
		},
		updatePocket(id: string, values: Partial<Pocket>) {
			host.update((design) => updatePocket(design, id, values));
		},
		removePocket(id: string) {
			host.update((design) => removePocket(design, id));
		},

		/** Adds a support, placing its net, and selects it. */
		addSupport(support: Support) {
			host.update((design) => addSupport(design, support, () => crypto.randomUUID()));
			host.select({ kind: 'support', id: support.id });
		},
		updateSupport(id: string, values: Partial<Support>) {
			host.update((design) => updateSupport(design, id, values));
		},
		resizeSupport(id: string, values: Partial<Support>) {
			host.update((design) => resizeSupport(design, id, values));
		},
		removeSupport(id: string) {
			host.update((design) => removeSupport(design, id));
		},

		previewPackaging(values: Partial<PackagingData>) {
			host.preview((design) => setPackagingValues(design, values));
		},
		previewPocket(id: string, values: Partial<Pocket>) {
			host.preview((design) => updatePocket(design, id, values));
		},
		previewSupport(id: string, values: Partial<Support>) {
			host.preview((design) => updateSupport(design, id, values));
		}
	};
}

export type PackagingActions = ReturnType<typeof packagingActions>;
