/**
 * The Solid workspace's vocabulary: flat parts cut from a plate, and the holes
 * and slots cut through them. Nothing folds.
 *
 * Data is sheet-scoped. Each plate is independent, so a Solid sheet's parts
 * live under its own id, and removing the sheet removes exactly them.
 */

/** A cut that frees a part (`profile`, cut outside the line) or goes through one (`hole`, inside). */
export type SolidKind = 'profile' | 'hole';

/**
 * The outline an entity is drawn with, inside its box. `slot` is a rectangle
 * rounded fully at both ends; `polygon` is regular, inscribed in the box.
 */
export type SolidShape = 'rectangle' | 'rounded' | 'ellipse' | 'polygon' | 'slot';

export type SolidEntity = {
	readonly id: string;
	readonly name: string;
	readonly kind: SolidKind;
	readonly shape: SolidShape;
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

export type SolidSheet = {
	readonly entities: readonly SolidEntity[];
};

export type SolidData = {
	/** Keyed by sheet id; every sheet tagged `solid` has an entry. */
	readonly sheets: { readonly [sheetId: string]: SolidSheet };
};

declare module '$lib/core/design/workspace.js' {
	interface WorkspaceDataMap {
		solid: SolidData;
	}
}
