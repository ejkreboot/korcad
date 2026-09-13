import type { DesignState, MachineSettings, Sheet, StockSettings } from '$lib/core/design/types.js';
import type { Selection, WorkspaceId } from '$lib/core/design/workspace.js';
import { machineProfileFor, sheetView } from '$lib/core/design/machine.js';
import {
	addProfile,
	assignProfile,
	deleteProfile,
	duplicateProfile
} from '$lib/core/design/profiles.js';
import { createDefaultDesign } from '$lib/features/document.js';
import {
	activeSheet,
	activeWorkspace,
	presentWorkspaces,
	reconcileDocument,
	sheetForWorkspace,
	validateDocument,
	workspaceById
} from '$lib/features/workspaces.js';
import { createHistory } from './history.js';

const newId = () => crypto.randomUUID();

const clone = (design: DesignState): DesignState =>
	JSON.parse(JSON.stringify(design)) as DesignState;

export type { Selection };

/**
 * The single owner of the design document. Components read derived values and
 * call actions; nothing else mutates the document.
 *
 * The editor knows no workspace's vocabulary. It looks the active sheet's
 * workspace up in the registry for geometry, tools, and export, and offers one
 * primitive for changing the document — `update` as one undo step, `preview`
 * mid-gesture. Each workspace keeps its own verbs in its own actions module,
 * built on that primitive.
 *
 * Every mutation funnels through `apply` or `preview`, which is where every
 * workspace present reconciles derived values, such as spanning support
 * heights — so no consumer has to re-derive them.
 *
 * Selection is held here but outside the document: it is editor state, so it
 * is never saved and never makes an undo step.
 */
export function createEditorState(initial: DesignState = createDefaultDesign()) {
	let design = $state<DesignState>(clone(initial));
	let selected = $state<Selection | null>(null);
	const history = createHistory(initial);
	// History lives outside the reactive graph, so its availability is mirrored
	// here whenever a command runs.
	let canUndo = $state(false);
	let canRedo = $state(false);

	/** The workspace the active sheet is drawn in. */
	const workspace = $derived(activeWorkspace(design));
	const geometry = $derived(workspace.geometry(design));
	const diagnostics = $derived(validateDocument(design));
	/**
	 * The active sheet's document view: stock plus the machine settings of the
	 * profile that sheet is cut on. CAM and export are answered per sheet, so
	 * this is what they are handed.
	 */
	const view = $derived(sheetView(design));
	const machine = $derived(machineProfileFor(design, design.activeSheetId));
	/**
	 * A selection is only reported while the thing it names exists, so an undo
	 * that removes a freshly added entity cannot leave the inspector pointing at
	 * nothing.
	 */
	const selection = $derived(
		selected && workspace.selectionExists(design, selected) ? selected : null
	);

	/** Applies a design change and records one undo step. */
	function apply(next: DesignState): void {
		design = reconcileDocument(next);
		history.commit(design);
		syncHistory();
	}

	function syncHistory(): void {
		canUndo = history.canUndo;
		canRedo = history.canRedo;
	}

	/** Whether a workspace needs this sheet, so it may not be renamed or removed. */
	const protectsSheet = (id: string) =>
		presentWorkspaces(design).some((candidate) => candidate.protectsSheet(design, id));

	/**
	 * Adds a sheet and shows it. It is cut on the machine the operator is
	 * already working on, and drawn in the given workspace, or the active
	 * sheet's.
	 */
	function addSheet(workspaceId: WorkspaceId = activeSheet(design).workspace, name?: string): void {
		const sheet: Sheet = {
			id: newId(),
			name: name ?? workspaceById(workspaceId).newSheetName(design),
			workspace: workspaceId,
			machineProfileId: machine.id
		};
		const workspaces =
			design.workspaces[workspaceId] === undefined
				? { ...design.workspaces, [workspaceId]: workspaceById(workspaceId).defaults() }
				: design.workspaces;
		apply({
			...design,
			workspaces,
			sheets: [...design.sheets, sheet],
			activeSheetId: sheet.id
		});
	}

	return {
		get design() {
			return design;
		},
		get view() {
			return view;
		},
		get workspace() {
			return workspace;
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
		get selection() {
			return selection;
		},

		/** Changes the document as one undo step. */
		update(change: (design: DesignState) => DesignState) {
			apply(change(design));
		},
		/**
		 * Changes the document without recording history. A drag calls this on
		 * every pointer move and `commit()` once at the end, so one gesture is one
		 * undo step rather than hundreds.
		 */
		preview(change: (design: DesignState) => DesignState) {
			design = reconcileDocument(change(design));
		},
		/** Ends a gesture, recording everything since the last commit as one step. */
		commit() {
			history.commit(design);
			syncHistory();
		},
		select(next: Selection | null) {
			selected = next;
		},

		setDesign(next: DesignState) {
			selected = null;
			apply(clone(next));
		},
		setStock<K extends keyof StockSettings>(key: K, value: StockSettings[K]) {
			apply({ ...design, stock: { ...design.stock, [key]: value } });
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
		/** Cuts the active sheet on another existing profile. */
		assignMachineProfile(profileId: string) {
			apply(assignProfile(design, design.activeSheetId, profileId));
		},
		/** Adds a stock drag-knife profile and cuts the active sheet on it. */
		addMachineProfile() {
			apply(addProfile(design, design.activeSheetId, newId()));
		},
		/** Copies the active sheet's profile and cuts the active sheet on the copy. */
		duplicateMachineProfile() {
			apply(duplicateProfile(design, design.activeSheetId, newId()));
		},
		/** Deletes the active sheet's profile; its sheets move to the first remaining one. */
		deleteMachineProfile() {
			apply(deleteProfile(design, machine.id));
		},
		/**
		 * Shows a sheet drawn in another workspace, adding one when the document
		 * has none. Only adding a sheet makes an undo step.
		 */
		switchWorkspace(id: WorkspaceId) {
			const sheetId = sheetForWorkspace(design, id);
			if (sheetId === null) addSheet(id);
			else design = { ...design, activeSheetId: sheetId };
		},
		/** Changing sheet is a view change, so it skips history. */
		setActiveSheet(sheetId: string) {
			design = { ...design, activeSheetId: sheetId };
		},

		addSheet,
		/** A sheet its workspace cannot do without is locked. */
		canEditSheet(id: string) {
			return !protectsSheet(id);
		},
		renameSheet(id: string, name: string) {
			if (protectsSheet(id)) return;
			apply({
				...design,
				sheets: design.sheets.map((sheet) => (sheet.id === id ? { ...sheet, name } : sheet))
			});
		},
		/**
		 * Removes a sheet and every part cut from it. A sheet a workspace cannot
		 * do without, and the last sheet, stay.
		 */
		removeSheet(id: string) {
			if (protectsSheet(id) || design.sheets.length < 2) return;
			const released = presentWorkspaces(design).reduce(
				(next, candidate) => candidate.releaseSheet(next, id),
				design
			);
			const sheets = released.sheets.filter((sheet) => sheet.id !== id);
			apply({
				...released,
				sheets,
				activeSheetId: released.activeSheetId === id ? sheets[0]!.id : released.activeSheetId
			});
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
