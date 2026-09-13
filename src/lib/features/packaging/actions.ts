import type { DesignState } from '$lib/core/design/types.js';
import type { Selection } from '$lib/core/design/workspace.js';
import { constrainSupportFlat, placeSupport } from './placement.js';
import type { PackagingData, Pocket, Support } from './types.js';
import { packagingSheetView, withPackaging, type PackagingView } from './view.js';

/**
 * Packaging's verbs. Each is a pure change to the document; `packagingActions`
 * binds them to the editor's one update primitive so a component can call
 * `actions.addPocket(pocket)` and get one undo step.
 */

/** The selection kinds packaging gives its entities. */
export type PackagingSelectionKind = 'pocket' | 'support';

const mapPockets = (design: DesignState, id: string, values: Partial<Pocket>) =>
	withPackaging(design, (data) => ({
		...data,
		pockets: data.pockets.map((pocket) => (pocket.id === id ? { ...pocket, ...values } : pocket))
	}));

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
	return withPackaging(design, (data) => ({
		...data,
		pockets: data.pockets.filter((pocket) => pocket.id !== id)
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

/** What packaging's actions need from the editor. `EditorState` satisfies it. */
export type DocumentHost = {
	readonly design: DesignState;
	readonly selection: Selection | null;
	/** Applies a change as one undo step. */
	update(change: (design: DesignState) => DesignState): void;
	/** Applies a change mid-gesture, without history. */
	preview(change: (design: DesignState) => DesignState): void;
	select(selection: Selection | null): void;
};

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

		setPackaging<K extends keyof PackagingData>(key: K, value: PackagingData[K]) {
			host.update((design) => setPackagingValues(design, { [key]: value }));
		},
		selectPocket(id: string | null) {
			host.select(id === null ? null : { kind: 'pocket', id });
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
