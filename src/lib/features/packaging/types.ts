import type { Point } from '$lib/core/geometry/primitives.js';
import type { FoldDirection, Side, SideFlags } from '$lib/core/design/types.js';

/**
 * The packaging workspace's vocabulary: a folded deck with a perimeter, the
 * openings cut into it, and the supports folded up underneath it.
 *
 * None of this is known to `core`. The document reaches it through
 * `WorkspaceDataMap`, which this module augments at the bottom.
 */

export type PerimeterType = 'plain' | 'folded' | 'joist';
export type FoldCompensation = 'none' | 'computed' | 'manual';
export type JoistAxis = 'vertical' | 'horizontal';

export type PocketShape = 'rectangle' | 'rounded' | 'ellipse' | 'profile';
/**
 * What an opening is for. Presets that carry no distinct intent collapse to
 * `product`; the rest keep the preset identity so later passes (and the
 * operator) can tell a locating hole from a cable pass-through.
 */
export type PocketPurpose =
	'product' | 'rounded' | 'ellipse' | 'slot' | 'cable' | 'registration' | 'imported';

export type Pocket = {
	readonly id: string;
	readonly name: string;
	readonly purpose: PocketPurpose;
	readonly shape: PocketShape;
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
	readonly wallDepth: number;
	readonly flange: number;
	readonly flangeEnabled: boolean;
	readonly relief: number;
	readonly pullDiameter: number;
	readonly pullDepth: number;
	readonly pulls: SideFlags;
	readonly sides: SideFlags;
	readonly cornerRadius: number;
	/** Normalized 0..1 outline used when `shape` is `profile`. */
	readonly profile: readonly Point[] | null;
	/** Offset of the drawn name label from its default corner. */
	readonly labelOffset?: Point;
};

export type SupportKind = 'riser' | 'tray' | 'platform';
export type CornerClosure = 'glue' | 'lock';

/**
 * The surface a support is built from. Every anchor names a real surface in the
 * assembly rather than a bare Z height, so raising the perimeter wall moves
 * everything anchored to the deck with it.
 */
export type SupportAnchor = 'box-floor' | 'deck-top' | 'deck-underside' | 'support-top';

/**
 * Where a support sits vertically.
 *
 * `offset` always measures away from the anchoring surface along the
 * support's own build direction, so it is positive downward for
 * `deck-underside` and positive upward everywhere else.
 *
 * Discriminated so that illegal combinations cannot be written down: only
 * `support-top` carries a `supportId`, and there is no way to express a face
 * for the box floor.
 */
export type SupportMount =
	| { readonly anchor: 'box-floor'; readonly offset: number }
	| { readonly anchor: 'deck-top'; readonly offset: number }
	| { readonly anchor: 'deck-underside'; readonly offset: number }
	| { readonly anchor: 'support-top'; readonly supportId: string; readonly offset: number };

/**
 * How a support's height is decided.
 *
 * `fixed` takes the stored `h`. `span` derives it from the gap between the
 * support's anchor and the underside of the deck, which is the manufacturing
 * intent for a riser whose job is to hold the deck up: change the wall height
 * and the riser — and its flat net — follow.
 */
export type SupportHeightMode = 'fixed' | 'span';

/** A riser or tray: a separate folded part mounted to the deck or box floor. */
export type Support = {
	readonly kind: SupportKind;
	readonly id: string;
	readonly name: string;
	readonly sheetId: string;
	readonly w: number;
	readonly d: number;
	/**
	 * Nominal height. Authoritative when `heightMode` is `fixed`; when `span`,
	 * it is kept resolved from the anchor gap so that every geometry consumer
	 * can read it without knowing how it was decided.
	 */
	readonly h: number;
	readonly heightMode: SupportHeightMode;
	readonly flange: number;
	readonly seam: number;
	readonly overlap: number;
	readonly taper: number;
	readonly openSide: Side | 'none';
	readonly bottomFlange: boolean;
	readonly cornerClosure: CornerClosure;
	readonly top: 'panel';
	readonly pullDiameter: number;
	readonly pullDepth: number;
	readonly pulls: SideFlags;
	readonly flatX: number;
	readonly flatY: number;
	readonly assemblyX: number;
	readonly assemblyY: number;
	readonly mount: SupportMount;
	readonly netVersion: number;
	/** Offset of the drawn name label from its default corner. */
	readonly labelOffset?: Point;
};

/**
 * Everything the packaging workspace keeps in a document.
 *
 * Document-scoped rather than per sheet: the deck sheet carries the pockets,
 * the perimeter, and each tray's opening, while the supports are cut from
 * whichever sheet `Support.sheetId` names. Splitting that by sheet would
 * separate a tray's deck opening from its own net.
 */
export type PackagingData = {
	/** The sheet the deck blank is cut from. */
	readonly deckSheetId: string;
	readonly deckX: number;
	readonly deckY: number;
	readonly deckW: number;
	readonly deckH: number;
	readonly perimeterType: PerimeterType;
	readonly perimeterWall: number;
	readonly perimeterFlange: number;
	readonly perimeterRelief: number;
	readonly perimeterSides: SideFlags;
	readonly joistAxis: JoistAxis;
	readonly joistFolds: number;
	readonly joistHeight: number;
	readonly joistDepth: number;
	readonly joistLockWidth: number;
	readonly joistSlotClearance: number;
	readonly foldCompensation: FoldCompensation;
	readonly foldRadiusFactor: number;
	readonly foldKFactor: number;
	readonly foldDeduction: number;
	readonly foldDirections: Readonly<Record<string, FoldDirection>>;
	readonly pockets: readonly Pocket[];
	/** Risers, platforms, and trays. Saved as `risers` before version 8. */
	readonly supports: readonly Support[];
};

declare module '$lib/core/design/workspace.js' {
	interface WorkspaceDataMap {
		packaging: PackagingData;
	}
}
