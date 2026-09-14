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
 * rounded fully at both ends; `polygon` is regular, inscribed in the box.
 */
export type FlatPartsShape = 'rectangle' | 'rounded' | 'ellipse' | 'polygon' | 'slot';

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
	 * Holding tabs left in a profile's release cut, spaced evenly around it and
	 * as wide as the stock's tab width. Ignored on a hole, and on a router,
	 * whose compensated contour cannot yet be interrupted.
	 */
	readonly tabCount: number;
};

export type FlatPartsSheet = {
	readonly entities: readonly FlatPartsEntity[];
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
