import type { EntityGroup } from '$lib/core/design/types.js';
import type { Point } from '$lib/core/geometry/primitives.js';

/**
 * The Flat Parts workspace's vocabulary: flat parts cut from a sheet, and the holes
 * and slots cut through them. Nothing folds.
 *
 * Data is sheet-scoped. Each sheet is independent, so a Flat Parts sheet's parts
 * live under its own id, and removing the sheet removes exactly them.
 */

/** A cut that frees a part (`profile`, cut outside the line) or goes through one (`hole`, inside). */
export type FlatPartsKind = 'profile' | 'hole';

/**
 * The outline an entity is drawn with, inside its box. `slot` is a rectangle
 * rounded fully at both ends; `polygon` is regular, inscribed in the box;
 * `path` is an arbitrary outline, usually imported from a drawing.
 */
export type FlatPartsShape = 'rectangle' | 'rounded' | 'ellipse' | 'polygon' | 'slot' | 'path';

export type FlatPartsEntity = {
	readonly id: string;
	readonly name: string;
	readonly kind: FlatPartsKind;
	readonly shape: FlatPartsShape;
	/** Lower-left corner of the box, in sheet millimeters. */
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	/** For `rounded`. */
	readonly cornerRadius: number;
	/** For `polygon`. */
	readonly sides: number;
	/**
	 * For `path`: the outline's vertices as fractions of the box, (0, 0) at its
	 * lower-left corner and (1, 1) at its upper right, so moving or resizing the
	 * box moves or stretches the outline with it. Empty for every other shape.
	 */
	readonly outline: readonly Point[];
	/**
	 * Holding tabs left in a profile's release cut, spaced evenly around it and
	 * as wide as the stock's tab width. Ignored on a hole, and on a router,
	 * whose compensated contour cannot yet be interrupted.
	 */
	readonly tabCount: number;
	/** The imported drawing this entity belongs to, which it moves and scales with; `null` alone. */
	readonly groupId: string | null;
};

export type FlatPartsSheet = {
	readonly entities: readonly FlatPartsEntity[];
	/** Imported drawings on this sheet; every one has at least one member. */
	readonly groups: readonly EntityGroup[];
};

export type FlatPartsData = {
	/** Keyed by sheet id; every sheet tagged `flatParts` has an entry. */
	readonly sheets: { readonly [sheetId: string]: FlatPartsSheet };
};

declare module '$lib/core/design/workspace.js' {
	interface WorkspaceDataMap {
		flatParts: FlatPartsData;
	}
}
