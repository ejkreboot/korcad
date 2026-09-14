import type { Point } from '$lib/core/geometry/primitives.js';

/**
 * Plain-data description of an assembled design, ready to be turned into
 * meshes by a renderer. Nothing here knows about Three.js, the DOM, or Svelte:
 * the viewer walks these parts and builds geometry from them.
 *
 * Coordinate convention matches the 2D editor and the machine: X right,
 * Y away from the operator, Z up out of the sheet. The origin is the
 * lower-left corner of the assembled piece, so a part's Z is its height above
 * the surface it stands on.
 *
 * The model names no workspace's parts. A workspace maps its own vocabulary
 * onto these forms and materials: packaging's deck is a `plate`, its supports
 * are draggable groups of `part` material.
 */
export type Point3 = { readonly x: number; readonly y: number; readonly z: number };

export const point3 = (x: number, y: number, z: number): Point3 => ({ x, y, z });

/**
 * Which surface a part represents, for the viewer's choice of board shade: the
 * main `plate`, a standing or folded `wall`, a `recess` let into the plate,
 * and a movable `part`.
 */
export type AssemblyMaterial = 'plate' | 'wall' | 'recess' | 'part';

/** A rectangular block, such as a wall segment or a standing panel. */
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
 * A flat plate: an outline extruded to the material thickness with openings
 * punched out of it. Outline and holes share the assembly's coordinates.
 */
export type PlatePart = {
	readonly form: 'plate';
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

/**
 * A flat piece of board lying in any plane, with openings through it. The
 * outline and holes are 2D in the sheet's own frame: `origin` is its (0, 0),
 * and `u` and `v` are unit axes along its face. The board is centred on that
 * plane, so a wall stands on its fold line the way a `box` wall does.
 */
export type SheetPart = {
	readonly form: 'sheet';
	readonly outline: readonly Point[];
	readonly holes: readonly (readonly Point[])[];
	readonly frame: { readonly origin: Point3; readonly u: Point3; readonly v: Point3 };
	readonly thickness: number;
};

export type PartShape = BoxPart | PanelPart | WallPart | PlatePart | FootprintPart | SheetPart;

export type AssemblyPart = PartShape & {
	readonly material: AssemblyMaterial;
	/**
	 * Whether this part belongs to the enclosing piece. The viewer fades
	 * exactly these when that piece is made translucent, so what sits inside
	 * it stays visible.
	 */
	readonly fades: boolean;
};

/**
 * Parts that move together. A draggable group's parts are modelled around its
 * own origin and positioned by `origin`, so dragging it in the viewer is a
 * group translation rather than a rebuild.
 */
export type AssemblyGroup = {
	readonly id: string;
	/** The id the workspace drags this group by, or null for fixed geometry. */
	readonly draggableId: string | null;
	readonly origin: Point;
	readonly selected: boolean;
	readonly parts: readonly AssemblyPart[];
};

export type Assembly = {
	readonly groups: readonly AssemblyGroup[];
	/**
	 * The fixed piece's footprint from the origin, and its height: what the
	 * camera frames and the ground plane is sized to.
	 */
	readonly extent: { readonly w: number; readonly d: number; readonly h: number };
	/** Z of the plane a dragged group slides across. */
	readonly dragPlaneZ: number;
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

const minus = (a: Point3, b: Point3) => point3(a.x - b.x, a.y - b.y, a.z - b.z);
const dot = (a: Point3, b: Point3) => a.x * b.x + a.y * b.y + a.z * b.z;
const crossed = (a: Point3, b: Point3) =>
	point3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const normalized = (a: Point3): Point3 | null => {
	const length = Math.hypot(a.x, a.y, a.z);
	return length > 1e-9 ? point3(a.x / length, a.y / length, a.z / length) : null;
};

/**
 * A `sheet` shape from a planar outline and holes given in 3D. The frame is
 * fixed by the outline's first, second, and last vertices; `null` when those
 * do not span a plane, which is how a collapsed face is skipped.
 */
export function sheetShape(
	outline: readonly Point3[],
	holes: readonly (readonly Point3[])[],
	thickness: number
): SheetPart | null {
	const origin = outline[0];
	const second = outline[1];
	const last = outline.at(-1);
	if (!origin || !second || !last || outline.length < 3) return null;
	const u = normalized(minus(second, origin));
	const normal = u && normalized(crossed(u, minus(last, origin)));
	if (!u || !normal) return null;
	const v = crossed(normal, u);
	const flatten = (p: Point3): Point => ({
		x: dot(minus(p, origin), u),
		y: dot(minus(p, origin), v)
	});
	return {
		form: 'sheet',
		outline: outline.map(flatten),
		holes: holes.filter((hole) => hole.length >= 3).map((hole) => hole.map(flatten)),
		frame: { origin, u, v },
		thickness
	};
}
