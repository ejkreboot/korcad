import type { DesignState, MachineSettings, Sheet, StockSettings } from '$lib/core/design/types.js';
import { machineProfileFor, sheetView } from '$lib/core/design/machine.js';
import { createDefaultDesign } from '$lib/features/document.js';
import type { PackagingData, Pocket, Support } from '$lib/features/packaging/types.js';
import { packagingSheetView, withPackaging } from '$lib/features/packaging/view.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { validate } from '$lib/features/packaging/validation.js';
import { constrainSupportFlat, placeSupport } from '$lib/features/packaging/placement.js';
import { resolveSupportHeights } from '$lib/features/packaging/levels.js';
import { createHistory } from './history.js';

const newId = () => crypto.randomUUID();

const clone = (design: DesignState): DesignState =>
	JSON.parse(JSON.stringify(design)) as DesignState;

/** What is selected on the canvas. One slot, so two things can never both be. */
export type Selection = { readonly kind: 'pocket' | 'support'; readonly id: string };

/**
 * The single owner of the design document. Components read derived values and
 * call actions; nothing else mutates the document.
 *
 * Every mutation funnels through `apply` or `preview`, which is where spanning
 * support heights are re-resolved. That keeps a stored `h` in step with the
 * deck it meets, whichever setting moved — so no consumer has to re-derive it.
 *
 * Selection is held here but outside the document: it is editor state, so it
 * is never saved and never makes an undo step.
 */
export function createEditorState(initial: DesignState = createDefaultDesign()) {
	let design = $state<DesignState>(clone(initial));
	let selection = $state<Selection | null>(null);
	const history = createHistory(initial);
	// History lives outside the reactive graph, so its availability is mirrored
	// here whenever a command runs.
	let canUndo = $state(false);
	let canRedo = $state(false);

	const geometry = $derived(allGeometry(design));
	const diagnostics = $derived(validate(design));
	/**
	 * The active sheet's document view: stock plus the machine settings of the
	 * profile that sheet is cut on. CAM and export are answered per sheet, so
	 * this is what they are handed.
	 */
	const view = $derived(sheetView(design));
	/** The same sheet as packaging sees it, with the deck, pockets, and supports. */
	const packaging = $derived(packagingSheetView(design));
	const machine = $derived(machineProfileFor(design, design.activeSheetId));
	/**
	 * A selection is only reported while the thing it names exists, so an undo
	 * that removes a freshly added pocket cannot leave the inspector pointing at
	 * nothing.
	 */
	const selectedPocketId = $derived(
		selection?.kind === 'pocket' && packaging.pockets.some((pocket) => pocket.id === selection?.id)
			? selection.id
			: null
	);
	const selectedSupportId = $derived(
		selection?.kind === 'support' &&
			packaging.supports.some((support) => support.id === selection?.id)
			? selection.id
			: null
	);

	/** Applies a design change and records one undo step. */
	function apply(next: DesignState): void {
		design = resolveSupportHeights(next);
		history.commit(design);
		syncHistory();
	}

	function syncHistory(): void {
		canUndo = history.canUndo;
		canRedo = history.canRedo;
	}

	/**
	 * Applies a change without recording history. A drag calls this on every
	 * pointer move and `commit()` once at the end, so one gesture is one undo
	 * step rather than hundreds.
	 */
	function preview(next: DesignState): void {
		design = resolveSupportHeights(next);
	}

	const updatePackaging = (update: (data: PackagingData) => PackagingData) =>
		withPackaging(design, update);

	const mapPockets = (id: string, values: Partial<Pocket>) =>
		updatePackaging((data) => ({
			...data,
			pockets: data.pockets.map((pocket) => (pocket.id === id ? { ...pocket, ...values } : pocket))
		}));

	const mapSupports = (update: (support: Support) => Support) =>
		updatePackaging((data) => ({ ...data, supports: data.supports.map(update) }));

	return {
		get design() {
			return design;
		},
		get view() {
			return view;
		},
		get packaging() {
			return packaging;
		},
		/** The machine profile the active sheet is cut on. */
		get machine() {
			return machine;
		},
		get geometry() {
			return geometry;
		},
		get diagnostics() {
			return diagnostics;
		},
		get canUndo() {
			return canUndo;
		},
		get canRedo() {
			return canRedo;
		},
		get selectedPocketId() {
			return selectedPocketId;
		},
		get selectedSupportId() {
			return selectedSupportId;
		},

		setDesign(next: DesignState) {
			selection = null;
			apply(clone(next));
		},
		setStock<K extends keyof StockSettings>(key: K, value: StockSettings[K]) {
			apply({ ...design, stock: { ...design.stock, [key]: value } });
		},
		setPackaging<K extends keyof PackagingData>(key: K, value: PackagingData[K]) {
			apply(updatePackaging((data) => ({ ...data, [key]: value })));
		},
		/**
		 * Edits the profile the active sheet is cut on. Every sheet sharing that
		 * profile changes with it, which is the point of naming machines.
		 */
		renameMachineProfile(name: string) {
			apply({
				...design,
				machineProfiles: design.machineProfiles.map((profile) =>
					profile.id === machine.id ? { ...profile, name } : profile
				)
			});
		},
		setMachineSetting<K extends keyof MachineSettings>(key: K, value: MachineSettings[K]) {
			apply({
				...design,
				machineProfiles: design.machineProfiles.map((profile) =>
					profile.id === machine.id ? { ...profile, [key]: value } : profile
				)
			});
		},
		/** Changing sheet is a view change, so it skips history. */
		setActiveSheet(sheetId: string) {
			design = { ...design, activeSheetId: sheetId };
		},
		selectPocket(id: string | null) {
			selection = id === null ? null : { kind: 'pocket', id };
		},
		selectSupport(id: string | null) {
			selection = id === null ? null : { kind: 'support', id };
		},

		addPocket(pocket: Pocket) {
			apply(updatePackaging((data) => ({ ...data, pockets: [...data.pockets, pocket] })));
			selection = { kind: 'pocket', id: pocket.id };
		},
		updatePocket(id: string, values: Partial<Pocket>) {
			apply(mapPockets(id, values));
		},
		removePocket(id: string) {
			apply(
				updatePackaging((data) => ({
					...data,
					pockets: data.pockets.filter((pocket) => pocket.id !== id)
				}))
			);
		},

		/**
		 * Adds a support, finding room for its net. A tray is drawn on the deck
		 * but cut from a parts sheet, so placement may add a sheet.
		 */
		addSupport(support: Support) {
			const placement = support.kind === 'tray' ? placeSupport(support, packaging, newId) : null;
			const placed = placement
				? { ...support, sheetId: placement.sheetId, flatX: placement.flatX, flatY: placement.flatY }
				: support;
			const next = updatePackaging((data) => ({ ...data, supports: [...data.supports, placed] }));
			apply(placement?.newSheet ? { ...next, sheets: [...next.sheets, placement.newSheet] } : next);
			selection = { kind: 'support', id: placed.id };
		},
		updateSupport(id: string, values: Partial<Support>) {
			apply(mapSupports((support) => (support.id === id ? { ...support, ...values } : support)));
		},
		/** Like `updateSupport`, but keeps the resulting net on its sheet. */
		resizeSupport(id: string, values: Partial<Support>) {
			apply(
				mapSupports((support) => {
					if (support.id !== id) return support;
					const next = { ...support, ...values };
					return { ...next, ...constrainSupportFlat(next, packaging) };
				})
			);
		},
		removeSupport(id: string) {
			apply(
				updatePackaging((data) => ({
					...data,
					supports: data.supports.filter((support) => support.id !== id)
				}))
			);
		},

		addSheet(name?: string) {
			// A new sheet is cut on the machine the operator is already working on,
			// and drawn in the same workspace.
			const active = design.sheets.find((sheet) => sheet.id === design.activeSheetId);
			const sheet: Sheet = {
				id: newId(),
				name: name ?? `Parts ${design.sheets.length}`,
				workspace: active?.workspace ?? 'packaging',
				machineProfileId: machine.id
			};
			apply({ ...design, sheets: [...design.sheets, sheet], activeSheetId: sheet.id });
		},
		renameSheet(id: string, name: string) {
			apply({
				...design,
				sheets: design.sheets.map((sheet) => (sheet.id === id ? { ...sheet, name } : sheet))
			});
		},
		/**
		 * Removes a sheet and the supports cut from it. The deck sheet is the
		 * design itself and cannot be removed.
		 */
		removeSheet(id: string) {
			const deckSheetId = packaging.deckSheetId;
			if (id === deckSheetId || design.sheets.length < 2) return;
			const next = updatePackaging((data) => ({
				...data,
				supports: data.supports.filter((support) => support.sheetId !== id)
			}));
			apply({
				...next,
				sheets: next.sheets.filter((sheet) => sheet.id !== id),
				activeSheetId: next.activeSheetId === id ? deckSheetId : next.activeSheetId
			});
		},

		previewPackaging(values: Partial<PackagingData>) {
			preview(updatePackaging((data) => ({ ...data, ...values })));
		},
		previewPocket(id: string, values: Partial<Pocket>) {
			preview(mapPockets(id, values));
		},
		previewSupport(id: string, values: Partial<Support>) {
			preview(mapSupports((support) => (support.id === id ? { ...support, ...values } : support)));
		},
		/** Ends a gesture, recording everything since the last commit as one step. */
		commit() {
			history.commit(design);
			syncHistory();
		},

		undo() {
			const previous = history.undo(design);
			if (previous) {
				design = previous;
				syncHistory();
			}
		},
		redo() {
			const next = history.redo(design);
			if (next) {
				design = next;
				syncHistory();
			}
		}
	};
}

export type EditorState = ReturnType<typeof createEditorState>;
