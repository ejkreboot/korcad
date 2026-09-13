import type { Component } from 'svelte';
import type { Point } from '$lib/core/geometry/primitives.js';
import type { WorkspaceId } from '$lib/core/design/workspace.js';
import type { EditorState } from '$lib/editor/state.svelte.js';
import type { ToolState } from '$lib/editor/tools.svelte.js';
import { PACKAGING_UI } from './packaging/index.js';
import { SOLID_UI } from './solid/index.js';

/**
 * The UI half of the workspace registry: which panels, canvas layer, and 3D
 * viewer a workspace brings. The editor shell, inspector, and canvas look the
 * active sheet's workspace up here, so a workspace's components are only ever
 * mounted for one of its own sheets.
 */

export type EditorProps = { editor: EditorState };
export type ViewportProps = { editor: EditorState; tools: ToolState };

/**
 * Where a canvas layer is drawn. `under` sits beneath the toolpaths, `over`
 * above them (hit targets and handles), both in CAM coordinates; `labels` is
 * outside the y-flip so text is not mirrored, and must flip its own y.
 */
export type CanvasPlane = 'under' | 'over' | 'labels';

export type CanvasLayerProps = ViewportProps & {
	readonly plane: CanvasPlane;
	/** True while a drawing tool is armed; hit targets stand aside. */
	readonly drawing: boolean;
	/** One screen pixel in sheet millimeters, for handles that keep their size. */
	readonly screenUnit: number;
};

/** A pointer gesture in progress. The canvas commits it as one undo step on release. */
export type CanvasGesture = {
	/** `stock` is the pointer on the sheet, already clamped and snapped. */
	move(stock: Point): void;
};

/** How a workspace answers the pointer on the generic canvas. */
export type CanvasController = {
	/**
	 * A press in select mode. Returns the gesture it starts, or `null` when the
	 * press hit nothing of this workspace's, which clears the selection.
	 */
	press(target: Element, stock: Point): CanvasGesture | null;
	/** Constrains a draft-rectangle corner for the armed tool. */
	draftPoint(stock: Point): Point;
	/** Turns a finished draft rectangle into an entity of the armed tool. */
	finishDraft(rect: { x: number; y: number; w: number; h: number }): void;
};

/** A group being dragged across the assembly's drag plane. */
export type AssemblyDrag = {
	/**
	 * Previews the group with its origin at `global`, and returns where the
	 * workspace actually put it, which the viewer moves the group to.
	 */
	move(global: Point): Point | null;
	/** Settles the drop. The viewer then commits one undo step and rebuilds. */
	drop(global: Point): void;
};

/** How a workspace answers the pointer in the 3D viewer. */
export type AssemblyController = {
	/** What the viewer's readout says: the selection, and mid-drag where a drop would land. */
	readonly readout: string;
	/** Starts dragging the group with this `draggableId`; `null` when it cannot move. */
	grab(id: string): { readonly origin: Point; readonly drag: AssemblyDrag } | null;
};

export type AssemblyUi = {
	/** Accessible name of the 3D canvas. */
	readonly canvasLabel: string;
	/** Label of the control that fades the enclosing piece. */
	readonly fadeLabel: string;
	controller(editor: EditorState, tools: ToolState): AssemblyController;
};

export type WorkspaceUi = {
	/** The selection panels, below the Material and Machine panels. */
	readonly Inspector: Component<EditorProps>;
	/** Extra fields inside the Material panel. */
	readonly MaterialFields?: Component<EditorProps>;
	/** A sentence appended to the Material panel's help. */
	readonly materialHelp?: string;
	readonly CanvasLayer: Component<CanvasLayerProps>;
	canvasController(editor: EditorState, tools: ToolState): CanvasController;
	/** Present exactly when the workspace has the `assembly` capability. */
	readonly assembly?: AssemblyUi;
};

export const WORKSPACE_UI: { readonly [K in WorkspaceId]: WorkspaceUi } = {
	packaging: PACKAGING_UI,
	solid: SOLID_UI
};

export function workspaceUi(id: WorkspaceId): WorkspaceUi {
	return WORKSPACE_UI[id];
}
