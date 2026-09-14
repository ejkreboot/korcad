import type { CamIntent, DesignPath, HoldingTab, PathType } from '$lib/core/design/types.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import type { Pocket, Support } from './types.js';

/**
 * Packaging's path constructors and the manufacturing intent they state.
 *
 * Every packaging path says where it is constructed which side of the line the
 * tool runs, which stage it machines in, and which chain it joins — the same
 * contract Flat Parts follows. Core CAM reads only that `CamIntent`; the role string
 * is for display, fold labels, and G-code comments.
 *
 * The rules, as they were when intent was derived from role strings (the
 * emitted programs are golden, so they must not move):
 *
 * - Folds are scored on the line before anything is cut, chained per owner and
 *   role so each wall's folds crease as one pass.
 * - Pocket features and lock slots are interior holes, cut while the blank is
 *   still held by the sheet. A riser's lock slot is interior even though the
 *   riser owns it, so it is cut before the riser is freed around it.
 * - Everything that frees a support's net — including the deck opening a tray
 *   drops through — is `part-release`, chained per support.
 * - The outline that frees the blank is `sheet-release`, last of all, and all of
 *   it: a folded perimeter's notched corners too, which are stretches of that
 *   outline, so the tool goes round it once. Only the routed deck perimeter is a
 *   part outline cut outside the line.
 */

export type PathOwner = NonNullable<DesignPath['owner']>;

/** Everything about a path except its shape. */
export type PathMeta = Omit<DesignPath, 'points' | 'type' | 'closed'>;

export type PackagingGeometry = {
	readonly paths: readonly DesignPath[];
	readonly tabs: readonly HoldingTab[];
};

export const line = (a: Point, b: Point, type: PathType, meta: PathMeta): DesignPath => ({
	points: [a, b],
	type,
	closed: false,
	...meta
});

export const closedPath = (
	points: readonly Point[],
	type: PathType,
	meta: PathMeta
): DesignPath => ({ points, type, closed: true, ...meta });

export const pocketOwner = (pocket: Pocket): PathOwner => ({
	kind: 'pocket',
	id: pocket.id,
	name: pocket.name
});

export const supportOwner = (support: Support): PathOwner => ({
	kind: 'support',
	id: support.id,
	name: support.name
});

/**
 * The group a path belongs to within one sheet: its pocket, its support, or the
 * sheet itself. It prefixes both chain keys and persisted fold keys, so the
 * `riser:` spelling for a support is part of the saved document format.
 */
export function pathGroup(owner: PathOwner | undefined, sheetId: string): string {
	return owner ? ownerGroup(owner) : `sheet:${sheetId}`;
}

/** The group of a path drawn by a pocket or a support; see `pathGroup`. */
export function ownerGroup(owner: PathOwner): string {
	return owner.kind === 'pocket' ? `pocket:${owner.id}` : `riser:${owner.id}`;
}

/** A fold, scored on the line and creased with the other folds of its role and group. */
export const foldIntent = (group: string, role: string): CamIntent => ({
	offsetSide: 'on',
	stage: 'score',
	chainKey: `${group}:score:${role}`
});

/** A closed hole cut before any release cut. */
export const INTERIOR_HOLE: CamIntent = { offsetSide: 'inside', stage: 'interior', chainKey: null };

/** A cut that frees a support's net; open runs chain around that support. */
export const partReleaseIntent = (support: Support, closed: boolean): CamIntent => ({
	offsetSide: 'inside',
	stage: 'part-release',
	chainKey: closed ? null : `${ownerGroup(supportOwner(support))}:release`
});

/** The open runs of the blank outline, chained across the sheet and cut last. */
export const sheetReleaseIntent = (sheetId: string): CamIntent => ({
	offsetSide: 'inside',
	stage: 'sheet-release',
	chainKey: `${pathGroup(undefined, sheetId)}:exterior`
});

/** The routed deck: the one packaging part outline, cut outside the line. */
export const DECK_OUTLINE: CamIntent = {
	offsetSide: 'outside',
	stage: 'sheet-release',
	chainKey: null
};
