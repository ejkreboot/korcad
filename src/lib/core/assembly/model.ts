import type { Point } from '$lib/core/geometry/primitives.js';

/**
 * Plain-data description of an assembled design, ready to be turned into
 * meshes by a renderer. Nothing here knows about Three.js, the DOM, or Svelte:
 * the viewer walks these parts and builds geometry from them.
 *
 * Coordinate convention matches the 2D editor and the machine: X right,
 * Y away from the operator, Z up out of the sheet. The origin is the
 * lower-left corner of the deck, so a part's Z is its height above the
 * surface the box sits on.
 */
export type Point3 = { readonly x: number; readonly y: number; readonly z: number };

export const point3 = (x: number, y: number, z: number): Point3 => ({ x, y, z });

/**
 * Which surface a part represents. The viewer maps these to materials, and the
 * deck opacity control keys off `deck`, `wall`, and `pocket`, which together
 * make up the piece the supports sit inside.
 */
export type AssemblyMaterial = 'deck' | 'wall' | 'pocket' | 'support';

/** A rectangular block: a wall segment, a joist panel, or a riser side. */
export type BoxPart = {
	readonly form: 'box';
	readonly x: number;
	readonly y: number;
	readonly z: number;
	readonly w: number;
	readonly d: number;
	readonly h: number;
};

/**
 * A flat polygon given its thickness. Vertices are coplanar and ordered; the
 * renderer thickens them along the face normal, so a flange can lie at any
 * angle without the caller building both faces.
 */
export type PanelPart = {
	readonly form: 'panel';
	readonly vertices: readonly Point3[];
	readonly thickness: number;
};

/** A circular finger pull cut into the top edge of a wall. */
export type WallNotch = { readonly diameter: number; readonly depth: number };

/**
 * A wall that spans between a top edge and a bottom edge, which may differ in
 * length: that is how a tapered tray wall and a pocket wall with relief cuts
 * are described. `inward` is the unit direction the wall's thickness grows.
 */
export type WallPart = {
	readonly form: 'wall';
	readonly topA: Point;
	readonly topB: Point;
	readonly bottomA: Point;
	readonly bottomB: Point;
	readonly inward: Point;
	readonly thickness: number;
	readonly topZ: number;
	readonly bottomZ: number;
	readonly notch: WallNotch | null;
};

/**
 * The deck panel: an outline extruded to the material thickness with the
 * openings punched out of it. Holes are in deck-local coordinates.
 */
export type DeckPart = {
	readonly form: 'deck';
	readonly outline: readonly Point[];
	readonly holes: readonly (readonly Point[])[];
	readonly z: number;
	readonly thickness: number;
};

/**
 * The translucent placement pad drawn under a support. It is an interaction
 * affordance rather than board, so it carries no thickness and casts no shadow.
 */
export type FootprintPart = {
	readonly form: 'footprint';
	readonly x: number;
	readonly y: number;
	readonly z: number;
	readonly w: number;
	readonly d: number;
};

export type PartShape = BoxPart | PanelPart | WallPart | DeckPart | FootprintPart;

export type AssemblyPart = PartShape & {
	readonly material: AssemblyMaterial;
	/**
	 * Whether this part belongs to the deck piece itself. The viewer fades
	 * exactly these when the deck is made translucent, so the supports inside
	 * stay visible.
	 */
	readonly deckPart: boolean;
};

/**
 * Parts that move together. A support's parts are modelled around its own
 * origin and positioned by `origin`, so dragging it in the viewer is a group
 * translation rather than a rebuild.
 */
export type AssemblyGroup = {
	readonly id: string;
	/** Set when the group is a draggable support, else null for fixed geometry. */
	readonly supportId: string | null;
	readonly origin: Point;
	readonly selected: boolean;
	readonly parts: readonly AssemblyPart[];
};

export type Assembly = {
	readonly groups: readonly AssemblyGroup[];
	/** Z of the deck's underside. */
	readonly deckZ: number;
	/** Z of the deck's top face, which is what supports mount to. */
	readonly deckSurfaceZ: number;
	readonly deckW: number;
	readonly deckH: number;
	/** Board colour hint so the viewer does not need to read design settings. */
	readonly finish: 'kraft' | 'white' | 'printed';
};

/**
 * Vertices of a flange folded along the hinge from `hingeA` to `hingeB` and
 * extended by `extension`. The free edge is inset by `chamfer` at both ends so
 * that neighbouring flanges clear each other at the corners, which is how the
 * flat net is cut.
 */
export function hingedFlangeVertices(
	hingeA: Point,
	hingeB: Point,
	extension: Point,
	chamfer: number,
	z: number
): Point3[] {
	const dx = hingeB.x - hingeA.x;
	const dy = hingeB.y - hingeA.y;
	const length = Math.hypot(dx, dy) || 1;
	const tangent = { x: dx / length, y: dy / length };
	const inset = Math.min(Math.max(0, chamfer), length / 2);
	return [
		point3(hingeA.x, hingeA.y, z),
		point3(hingeB.x, hingeB.y, z),
		point3(
			hingeB.x + extension.x - tangent.x * inset,
			hingeB.y + extension.y - tangent.y * inset,
			z
		),
		point3(
			hingeA.x + extension.x + tangent.x * inset,
			hingeA.y + extension.y + tangent.y * inset,
			z
		)
	];
}
