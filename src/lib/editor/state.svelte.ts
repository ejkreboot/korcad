import { createDefaultDesign } from '$lib/core/design/defaults.js';
import type {
	DesignState,
	MachineSettings,
	Pocket,
	Sheet,
	Support
} from '$lib/core/design/types.js';
import { machineProfileFor, sheetView } from '$lib/core/design/machine.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { validate } from '$lib/features/packaging/validation.js';
import { constrainSupportFlat, placeSupport } from '$lib/features/packaging/placement.js';
import { resolveSupportHeights } from '$lib/features/packaging/levels.js';
import { createHistory } from './history.js';

const newId = () => crypto.randomUUID();

const clone = (design: DesignState): DesignState =>
	JSON.parse(JSON.stringify(design)) as DesignState;

/**
 * The single owner of the design document. Components read derived values and
 * call actions; nothing else mutates the document.
 *
 * Every mutation funnels through `apply` or `preview`, which is where spanning
 * support heights are re-resolved. That keeps a stored `h` in step with the
 * deck it meets, whichever setting moved — so no consumer has to re-derive it.
 */
export function createEditorState(initial: DesignState = createDefaultDesign()) {
	let design = $state<DesignState>(clone(initial));
	const history = createHistory(initial);
	// History lives outside the reactive graph, so its availability is mirrored
	// here whenever a command runs.
	let canUndo = $state(false);
	let canRedo = $state(false);

	const geometry = $derived(allGeometry(design));
	const diagnostics = $derived(validate(design));
	/**
	 * The active sheet's document view: the design plus the machine settings of
	 * the profile that sheet is cut on. Geometry, CAM, and export are all
	 * answered per sheet, so this is what they are handed.
	 */
	const view = $derived(sheetView(design));
	const machine = $derived(machineProfileFor(design, design.activeSheetId));

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

	return {
		get design() {
			return design;
		},
		get view() {
			return view;
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

		setDesign(next: DesignState) {
			apply(clone(next));
		},
		setSetting<K extends keyof DesignState>(key: K, value: DesignState[K]) {
			apply({ ...design, [key]: value });
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
		/** Selection, sheet, and snap changes are editor state, so they skip history. */
		setActiveSheet(sheetId: string) {
			design = { ...design, activeSheetId: sheetId };
		},
		setSnap(enabled: boolean) {
			design = { ...design, snapEnabled: enabled };
		},
		selectPocket(id: string | null) {
			design = { ...design, selectedId: id, selectedRiserId: null };
		},
		selectSupport(id: string | null) {
			design = { ...design, selectedRiserId: id, selectedId: null };
		},

		addPocket(pocket: Pocket) {
			apply({ ...design, pockets: [...design.pockets, pocket], selectedId: pocket.id });
		},
		updatePocket(id: string, values: Partial<Pocket>) {
			apply({
				...design,
				pockets: design.pockets.map((pocket) =>
					pocket.id === id ? { ...pocket, ...values } : pocket
				)
			});
		},
		removePocket(id: string) {
			apply({
				...design,
				pockets: design.pockets.filter((pocket) => pocket.id !== id),
				selectedId: design.selectedId === id ? null : design.selectedId
			});
		},

		/**
		 * Adds a support, finding room for its net. A tray is drawn on the deck
		 * but cut from a parts sheet, so placement may add a sheet.
		 */
		addSupport(support: Support) {
			const placement = support.kind === 'tray' ? placeSupport(support, view, newId) : null;
			const placed = placement
				? { ...support, sheetId: placement.sheetId, flatX: placement.flatX, flatY: placement.flatY }
				: support;
			apply({
				...design,
				sheets: placement?.newSheet ? [...design.sheets, placement.newSheet] : design.sheets,
				risers: [...design.risers, placed],
				selectedRiserId: placed.id,
				selectedId: null
			});
		},
		updateSupport(id: string, values: Partial<Support>) {
			apply({
				...design,
				risers: design.risers.map((support) =>
					support.id === id ? { ...support, ...values } : support
				)
			});
		},
		/** Like `updateSupport`, but keeps the resulting net on its sheet. */
		resizeSupport(id: string, values: Partial<Support>) {
			apply({
				...design,
				risers: design.risers.map((support) => {
					if (support.id !== id) return support;
					const next = { ...support, ...values };
					return { ...next, ...constrainSupportFlat(next, view) };
				})
			});
		},
		removeSupport(id: string) {
			apply({
				...design,
				risers: design.risers.filter((support) => support.id !== id),
				selectedRiserId: design.selectedRiserId === id ? null : design.selectedRiserId
			});
		},

		addSheet(name?: string) {
			// A new sheet is cut on the machine the operator is already working on.
			const sheet: Sheet = {
				id: newId(),
				name: name ?? `Parts ${design.sheets.length}`,
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
			if (id === 'deck' || design.sheets.length < 2) return;
			apply({
				...design,
				sheets: design.sheets.filter((sheet) => sheet.id !== id),
				risers: design.risers.filter((support) => support.sheetId !== id),
				activeSheetId: design.activeSheetId === id ? 'deck' : design.activeSheetId
			});
		},

		previewSettings(values: Partial<DesignState>) {
			preview({ ...design, ...values });
		},
		previewPocket(id: string, values: Partial<Pocket>) {
			preview({
				...design,
				pockets: design.pockets.map((pocket) =>
					pocket.id === id ? { ...pocket, ...values } : pocket
				)
			});
		},
		previewSupport(id: string, values: Partial<Support>) {
			preview({
				...design,
				risers: design.risers.map((support) =>
					support.id === id ? { ...support, ...values } : support
				)
			});
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
