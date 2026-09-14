import type { Assembly } from '$lib/core/assembly/model.js';
import type { GcodeOptions } from '$lib/core/cam/gcode.js';
import type { WorkspaceReader } from '$lib/core/design/normalize.js';
import { validateMachineSettings } from '$lib/core/design/validation.js';
import type {
	DesignState,
	FabricationMode,
	Geometry,
	MachineSettings,
	Sheet
} from '$lib/core/design/types.js';
import type { Selection, WorkspaceDataMap, WorkspaceId } from '$lib/core/design/workspace.js';
import type { SvgLabel } from '$lib/core/export/svg.js';
import type { IconName } from '$lib/components/icons/paths.js';
import { PACKAGING_WORKSPACE } from './packaging/workspace.js';
import { FLAT_PARTS_WORKSPACE } from './flat-parts/workspace.js';

/**
 * The workspace registry: every workspace this build knows, and everything the
 * editor, toolbar, and export need from one. They look up the active sheet's
 * workspace here rather than importing a feature.
 *
 * There is deliberately no generic entity CRUD. A workspace keeps its own
 * verbs (`addPocket`, …) in its own actions module, built on the editor's one
 * document-update primitive.
 */

/** One entry of a drawing tool's menu. */
export type ToolPreset = {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly icon: IconName;
};

/** A toolbar drawing tool: a menu of presets, drawn as a rectangle on the sheet. */
export type WorkspaceTool = {
	readonly id: string;
	readonly label: string;
	readonly title: string;
	readonly icon: IconName;
	readonly presets: readonly ToolPreset[];
	/** Why the tool cannot be used on this machine, or `null` when it can. */
	unavailable(machine: MachineSettings): string | null;
};

/** A kind of file a workspace can bring onto one of its sheets, offered in a drawing tool's menu. */
export type WorkspaceImport = {
	readonly id: string;
	/** The drawing tool whose menu offers it, after that tool's presets. */
	readonly toolId: string;
	readonly label: string;
	readonly description: string;
	readonly icon: IconName;
	/** File types offered by the file picker, as an `accept` attribute lists them. */
	readonly accept: string;
	/**
	 * The document with the file's contents added to a sheet, what to select,
	 * and a sentence saying what came in. Throws with a message for the
	 * operator when the file holds nothing the workspace can use.
	 */
	read(
		design: DesignState,
		sheetId: string,
		text: string,
		fileName: string
	): { design: DesignState; selection: Selection | null; notice: string };
};

/** Behaviour a workspace has or lacks outright; absent features are hidden, not disabled. */
export type WorkspaceCapabilities = {
	/** Board is creased and folded, so there is a crease program and fold UI. */
	readonly folding: boolean;
	/** There is an assembled 3D preview. */
	readonly assembly: boolean;
};

export type Workspace<Id extends WorkspaceId = WorkspaceId> = WorkspaceReader & {
	readonly id: Id;
	readonly label: string;
	/** Shown beside the label in the workspace switcher. */
	readonly icon: IconName;
	/**
	 * Whether the workspace's data spans every sheet tagged with it, or each
	 * sheet is independent. Packaging is document-scoped: a tray's deck opening
	 * and its net are cut from different sheets but are one part.
	 */
	readonly dataScope: 'document' | 'sheet';
	readonly capabilities: WorkspaceCapabilities;
	/** The kind of machine a new project in this workspace starts on. */
	readonly fabricationMode: FabricationMode;
	readonly tools: readonly WorkspaceTool[];
	readonly imports: readonly WorkspaceImport[];
	/** The name a sheet added in this workspace gets. */
	newSheetName(design: DesignState): string;
	/** The data a document gains when it first uses this workspace, on the sheet `sheetId`. */
	defaults(sheetId: string): WorkspaceDataMap[Id];
	/**
	 * Re-derives stored values that depend on others, such as a spanning
	 * support's height. Run on every document change, for every workspace the
	 * document uses, and on import.
	 */
	reconcile(design: DesignState): DesignState;
	/** Flat geometry of one sheet; defaults to the active sheet. */
	geometry(design: DesignState, sheetId?: string): Geometry;
	/** Manufacturability messages for this workspace's part of the document. */
	validate(design: DesignState): string[];
	/** The assembled 3D description, for a workspace with the `assembly` capability. */
	assembly?(design: DesignState, selection: Selection | null): Assembly;
	/** Options for the programs exported from one of this workspace's sheets. */
	gcodeOptions(design: DesignState, sheetId: string): GcodeOptions;
	/** Entity names printed into a sheet's design SVG. */
	labels(design: DesignState, sheetId: string): SvgLabel[];
	/** Whether a selection still names something in the document. */
	selectionExists(design: DesignState, selection: Selection): boolean;
	/** Bounds to frame a selection on a sheet, or `null` when it is not drawn there. */
	selectionBounds(
		design: DesignState,
		selection: Selection,
		sheetId: string
	): { left: number; right: number; bottom: number; top: number } | null;
	/** Whether the selection can be rotated: an imported outline or group, not a drawn shape. */
	canRotate(design: DesignState, selection: Selection): boolean;
	/** The document with the selection turned `degrees` counter-clockwise about the centre of its box. */
	rotateSelection(design: DesignState, selection: Selection, degrees: number): DesignState;
	/** Whether a sheet is one the workspace cannot do without, so it may not be renamed or removed. */
	protectsSheet(design: DesignState, sheetId: string): boolean;
	/** The document with this workspace's parts cut from a sheet removed, ahead of removing the sheet. */
	releaseSheet(design: DesignState, sheetId: string): DesignState;
};

/** What a workspace's bound actions need from the editor. `EditorState` satisfies it. */
export type DocumentHost = {
	readonly design: DesignState;
	readonly selection: Selection | null;
	/** Applies a change as one undo step. */
	update(change: (design: DesignState) => DesignState): void;
	/** Applies a change mid-gesture, without history. */
	preview(change: (design: DesignState) => DesignState): void;
	select(selection: Selection | null): void;
};

export { PACKAGING_WORKSPACE, FLAT_PARTS_WORKSPACE };

export const WORKSPACES: readonly Workspace[] = [PACKAGING_WORKSPACE, FLAT_PARTS_WORKSPACE];

/** The workspace a new design opens in. */
export const DEFAULT_WORKSPACE: WorkspaceId = PACKAGING_WORKSPACE.id;

export function workspaceById(id: WorkspaceId): Workspace {
	const workspace = WORKSPACES.find((candidate) => candidate.id === id);
	if (!workspace) throw new Error(`Unknown workspace: ${id}`);
	return workspace;
}

/** The sheet a document is showing; the first sheet when the active id is stale. */
export function activeSheet(design: DesignState): Sheet {
	const sheet =
		design.sheets.find((candidate) => candidate.id === design.activeSheetId) ?? design.sheets[0];
	if (!sheet) throw new Error('A design always has at least one sheet');
	return sheet;
}

/** The workspace the active sheet is drawn in. */
export function activeWorkspace(design: DesignState): Workspace {
	return workspaceById(activeSheet(design).workspace);
}

/** Every registered workspace the document has data for. */
export function presentWorkspaces(design: DesignState): readonly Workspace[] {
	return WORKSPACES.filter((workspace) => design.workspaces[workspace.id] !== undefined);
}

/** Reconciles every workspace the document uses, not only the active sheet's. */
export function reconcileDocument(design: DesignState): DesignState {
	return presentWorkspaces(design).reduce((next, workspace) => workspace.reconcile(next), design);
}

/**
 * Manufacturability of the whole document. Export of any sheet is gated on it,
 * so every workspace present is asked, not only the active sheet's. The machine
 * settings of every profile in use are checked first and apart from any
 * workspace, so no sheet can export on an unsafe machine because its workspace
 * forgot to ask.
 */
export function validateDocument(design: DesignState): string[] {
	return [
		...validateMachineSettings(design),
		...presentWorkspaces(design).flatMap((workspace) => workspace.validate(design))
	];
}

/**
 * The sheet to show when switching to a workspace: the active sheet if it is
 * already drawn there, else the first sheet that is, else `null` when the
 * document has none and one must be added.
 */
export function sheetForWorkspace(design: DesignState, id: WorkspaceId): string | null {
	if (activeSheet(design).workspace === id) return design.activeSheetId;
	return design.sheets.find((sheet) => sheet.workspace === id)?.id ?? null;
}
