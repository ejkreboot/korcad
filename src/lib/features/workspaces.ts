import type { WorkspaceReader } from '$lib/core/design/normalize.js';
import type { WorkspaceId } from '$lib/core/design/workspace.js';
import { normalizePackaging } from './packaging/normalize.js';
import './packaging/types.js';

/**
 * The workspace registry: every workspace this build knows, and what the
 * document layer needs from each.
 *
 * Deliberately small for now — identity, data scope, and how to read saved
 * data. Tools, geometry, validation, and the inspector join the contract when
 * a second workspace needs them dispatched rather than called directly.
 */
export type Workspace = WorkspaceReader & {
	readonly label: string;
	/**
	 * Whether the workspace's data spans every sheet tagged with it, or each
	 * sheet is independent. Packaging is document-scoped: a tray's deck opening
	 * and its net are cut from different sheets but are one part.
	 */
	readonly dataScope: 'document' | 'sheet';
};

export const PACKAGING_WORKSPACE: Workspace = {
	id: 'packaging',
	label: 'Folded Packaging',
	dataScope: 'document',
	normalize: normalizePackaging
};

export const WORKSPACES: readonly Workspace[] = [PACKAGING_WORKSPACE];

/** The workspace a new design opens in. */
export const DEFAULT_WORKSPACE: WorkspaceId = PACKAGING_WORKSPACE.id;

export function workspaceById(id: WorkspaceId): Workspace {
	const workspace = WORKSPACES.find((candidate) => candidate.id === id);
	if (!workspace) throw new Error(`Unknown workspace: ${id}`);
	return workspace;
}
