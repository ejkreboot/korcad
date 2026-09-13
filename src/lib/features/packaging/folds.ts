import { pathGroup } from './paths.js';
import type { DesignPath, FoldDirection } from '$lib/core/design/types.js';
import type { Support } from './types.js';
import type { PackagingView } from './view.js';

/** Stable identity for a fold group, used to persist per-fold direction overrides. */
export function foldKeyForPath(path: DesignPath, activeSheetId: string): string | null {
	if (path.type !== 'score') return null;
	return `${pathGroup(path.owner, activeSheetId)}:${path.role || 'fold'}`;
}

const FOLD_ROLE_LABELS: Readonly<Record<string, string>> = {
	'top-fold': 'Pocket wall fold',
	'flange-fold': 'Pocket flange fold',
	'perimeter-deck-fold': 'Deck perimeter fold',
	'perimeter-flange-fold': 'Deck flange fold',
	'riser-top-fold': 'Riser top fold',
	'riser-bottom-flange-fold': 'Riser bottom flange fold',
	'riser-corner-tab-fold': 'Riser corner-tab fold',
	'riser-lock-tab-fold': 'Riser locking-tab fold',
	'tray-wall-fold': 'Tray wall fold',
	'tray-flange-fold': 'Tray glue-flange fold',
	'joist-fold-1': 'Joist deck fold',
	'joist-fold-2': 'Joist bottom fold',
	'joist-fold-3': 'Joist inner-wall fold',
	'joist-fold-4': 'Joist closing-panel fold',
	'joist-fold-5': 'Joist locking-tab fold'
};

export function foldRoleLabel(role: string | undefined): string {
	return (role && FOLD_ROLE_LABELS[role]) || 'Fold line';
}

/**
 * Some folds are dictated by the construction and may not be flipped: a
 * platform's bottom flange folds under the panel, and every joist fold is
 * part of a single rolled edge.
 */
export function isFixedFoldPath(
	path: DesignPath | null | undefined,
	supports: readonly Support[]
): boolean {
	const owner = path?.owner;
	const support = owner?.kind === 'support' ? supports.find((item) => item.id === owner.id) : null;
	return Boolean(
		(support?.kind === 'platform' && path?.role === 'riser-bottom-flange-fold') ||
		path?.role?.startsWith('joist-fold-')
	);
}

export function defaultFoldDirection(role: string | undefined): FoldDirection {
	// A tray's wall rises out of the sheet; everything else folds away from the viewer.
	return role === 'tray-wall-fold' ? 'up' : 'down';
}

export type FoldAnnotationSettings = Pick<
	PackagingView,
	'activeSheetId' | 'foldDirections' | 'supports'
>;

/** Attaches fold identity, direction, and label to every score path. */
export function annotateFoldPaths(
	paths: readonly DesignPath[],
	settings: FoldAnnotationSettings
): readonly DesignPath[] {
	return paths.map((path) => {
		const foldKey = foldKeyForPath(path, settings.activeSheetId);
		if (!foldKey) return path;
		return {
			...path,
			foldKey,
			foldDirection: isFixedFoldPath(path, settings.supports)
				? 'down'
				: (settings.foldDirections[foldKey] ?? defaultFoldDirection(path.role)),
			foldLabel: foldRoleLabel(path.role)
		};
	});
}

/** Fold direction for an assembly owner/role pair, honoring saved overrides. */
export function assemblyFoldDirection(
	owner: string,
	role: string,
	settings: FoldAnnotationSettings
): FoldDirection {
	const supportId = owner.startsWith('riser:') ? owner.slice('riser:'.length) : null;
	const support = supportId ? settings.supports.find((item) => item.id === supportId) : null;
	if (support?.kind === 'platform' && role === 'riser-bottom-flange-fold') return 'down';
	return settings.foldDirections[`${owner}:${role}`] ?? defaultFoldDirection(role);
}

export function assemblyFoldSign(
	owner: string,
	role: string,
	settings: FoldAnnotationSettings
): 1 | -1 {
	return assemblyFoldDirection(owner, role, settings) === 'up' ? 1 : -1;
}
