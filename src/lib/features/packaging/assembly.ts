import { point, type Point } from '$lib/core/geometry/primitives.js';
import {
	hingedFlangeVertices,
	type Assembly,
	type AssemblyGroup,
	type AssemblyMaterial,
	type AssemblyPart,
	type PartShape,
	sheetShape,
	type WallNotch
} from '$lib/core/assembly/model.js';
import { clipToConvex, pointInConvex } from '$lib/core/geometry/contour.js';
import type { DesignState, Side } from '$lib/core/design/types.js';
import type { Pocket, RegionRef, Support } from './types.js';
import type { PackagingView } from './view.js';
import { assemblyFoldDirection, assemblyFoldSign } from './folds.js';
import {
	deckSurfaceZ,
	raisedDeckHeight,
	resolveSupportHeights,
	supportMountPlane
} from './levels.js';
import { openingOutline } from './geometry.js';
import { joistSides } from './perimeter.js';
import { supportAssemblyOrigin } from './mounting.js';
import { packagingView } from './view.js';
import { trayHasPull, trayPullWidthAtMouth } from './supports.js';
import { trayOpeningPath } from './model.js';
import {
	DECK_REGION,
	outlineOnFace,
	pocketSheetId,
	regionOf,
	regionPockets,
	trayAssemblyProfile,
	type RegionFace,
	type StockRegion
} from './regions.js';

/**
 * Everything the assembled model depends on. Assembly reads nominal
 * dimensions, not flat ones: a folded wall stands at its design height even
 * though its blank was cut short by the bend deduction.
 */
export type AssemblySettings = PackagingView;

/** Minimum board thickness used for parts that would otherwise be invisible. */
const MIN_BOARD = 1.2;
/** Pocket walls are thinner than structural board so that they read as folded flaps. */
const POCKET_WALL_FACTOR = 0.7;

const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

export { trayAssemblyProfile, type TrayAssemblyProfile } from './regions.js';

/**
 * Whether a flap hinged on a riser wall folds in the same sense as the walls
 * fold off the top panel. The flap then keeps curling the net and turns in,
 * under the footprint or inside the corner; folded the other way it turns out.
 */
function foldsWithWalls(owner: string, role: string, settings: AssemblySettings): boolean {
	return (
		assemblyFoldDirection(owner, role, settings) ===
		assemblyFoldDirection(owner, 'riser-top-fold', settings)
	);
}

export type FlangeDescriptor = {
	readonly side: Side;
	readonly a: Point;
	readonly b: Point;
	readonly extension: Point;
};

/**
 * Hinges and fold directions of the four glue flanges around a support's
 * bottom edge, in support-local coordinates. A platform always folds its
 * flanges inward so that it can be glued down without widening its footprint.
 */
export function supportFlangeDescriptors(
	support: Support,
	settings: AssemblySettings
): FlangeDescriptor[] {
	const f = Math.max(0, support.flange || 0);
	const owner = `riser:${support.id}`;
	const outward =
		support.kind !== 'platform' && !foldsWithWalls(owner, 'riser-bottom-flange-fold', settings);
	return [
		{
			side: 'bottom',
			a: point(0, 0),
			b: point(support.w, 0),
			extension: point(0, outward ? -f : f)
		},
		{
			side: 'top',
			a: point(0, support.d),
			b: point(support.w, support.d),
			extension: point(0, outward ? f : -f)
		},
		{ side: 'left', a: point(0, 0), b: point(0, support.d), extension: point(outward ? -f : f, 0) },
		{
			side: 'right',
			a: point(support.w, 0),
			b: point(support.w, support.d),
			extension: point(outward ? f : -f, 0)
		}
	];
}

export type JoistPart = {
	readonly side: Side;
	readonly kind: 'outer-wall' | 'bottom' | 'inner-wall' | 'closing-panel' | 'locking-return';
	readonly x: number;
	readonly y: number;
	readonly z: number;
	readonly w: number;
	readonly d: number;
	readonly h: number;
};

/**
 * Blocks of a rolled joist edge, in the order the blank folds: outer wall up,
 * floor across, inner wall back up, closing panel over, and an optional
 * locking return tucked against the outer wall.
 */
export function joistAssemblyParts(
	settings: AssemblySettings,
	thickness = Math.max(MIN_BOARD, settings.material)
): JoistPart[] {
	if (settings.fabricationMode !== 'knife' || settings.perimeterType !== 'joist') return [];
	const parts: JoistPart[] = [];
	const { joistHeight: height, joistDepth: depth, joistFolds: folds, deckW, deckH } = settings;
	const sides = joistSides(settings);
	const lockWidth = Math.min(
		settings.joistLockWidth,
		settings.joistAxis === 'horizontal' ? deckW * 0.8 : deckH * 0.8
	);
	const add = (
		side: Side,
		kind: JoistPart['kind'],
		x: number,
		y: number,
		z: number,
		w: number,
		d: number,
		h: number
	) => parts.push({ side, kind, x, y, z, w, d, h });

	const vertical = (side: 'left' | 'right') => {
		const left = side === 'left';
		const outerX = left ? -thickness / 2 : deckW - thickness / 2;
		const innerX = left ? depth - thickness / 2 : deckW - depth - thickness / 2;
		const panelX = left ? 0 : deckW - depth;
		add(side, 'outer-wall', outerX, 0, 0, thickness, deckH, height);
		if (folds >= 2) add(side, 'bottom', panelX, 0, 0, depth, deckH, thickness);
		if (folds >= 3) add(side, 'inner-wall', innerX, 0, 0, thickness, deckH, height);
		if (folds >= 4)
			add(side, 'closing-panel', panelX, 0, height - thickness, depth, deckH, thickness);
		if (folds === 5)
			add(
				side,
				'locking-return',
				left ? 0 : deckW - thickness,
				(deckH - lockWidth) / 2,
				0,
				thickness,
				lockWidth,
				height
			);
	};
	const horizontal = (side: 'bottom' | 'top') => {
		const bottom = side === 'bottom';
		const outerY = bottom ? -thickness / 2 : deckH - thickness / 2;
		const innerY = bottom ? depth - thickness / 2 : deckH - depth - thickness / 2;
		const panelY = bottom ? 0 : deckH - depth;
		add(side, 'outer-wall', 0, outerY, 0, deckW, thickness, height);
		if (folds >= 2) add(side, 'bottom', 0, panelY, 0, deckW, depth, thickness);
		if (folds >= 3) add(side, 'inner-wall', 0, innerY, 0, deckW, thickness, height);
		if (folds >= 4)
			add(side, 'closing-panel', 0, panelY, height - thickness, deckW, depth, thickness);
		if (folds === 5)
			add(
				side,
				'locking-return',
				(deckW - lockWidth) / 2,
				bottom ? 0 : deckH - thickness,
				0,
				lockWidth,
				thickness,
				height
			);
	};

	if (sides.left) vertical('left');
	if (sides.right) vertical('right');
	if (sides.bottom) horizontal('bottom');
	if (sides.top) horizontal('top');
	return parts;
}

/** Part constructors. Each returns a fresh object; nothing here mutates input. */
const shaped = (shape: PartShape, material: AssemblyMaterial, fades: boolean): AssemblyPart => ({
	...shape,
	material,
	fades
});

/** Every opening cut on a sheet, whatever it belongs to. */
function sheetCuts(design: AssemblySettings, sheetId: string): Pocket[] {
	return design.pockets.filter((pocket) => pocketSheetId(design, pocket) === sheetId);
}

/** Whether an opening is centred on a face, which is the face its walls fold from. */
function centredOnFace(pocket: Pocket, face: RegionFace): boolean {
	return pointInConvex(point(pocket.x + pocket.w / 2, pocket.y + pocket.h / 2), face.flat);
}

/**
 * A face of a region drawn as a board with the openings that reach it punched
 * through, or `null` when none does, so a face without openings keeps the part
 * it has always been drawn as.
 */
function faceWithOpenings(
	region: StockRegion,
	faceId: string,
	pockets: readonly Pocket[],
	thickness: number,
	material: AssemblyMaterial,
	fades: boolean
): AssemblyPart | null {
	const face = region.faces.find((candidate) => candidate.id === faceId);
	if (!face?.placed) return null;
	const holes = pockets
		.map((pocket) => outlineOnFace(openingOutline(pocket), face))
		.filter((hole) => hole.length >= 3);
	if (!holes.length) return null;
	const shape = sheetShape(face.placed, holes, thickness);
	return shape ? shaped(shape, material, fades) : null;
}

type WallEdges = Pick<
	Extract<PartShape, { form: 'wall' }>,
	'topA' | 'topB' | 'bottomA' | 'bottomB' | 'inward'
>;

/** Where the board an opening is cut into lies in its assembly group. */
type OpeningSurface = {
	/** Subtracted from sheet coordinates to reach the group's local frame. */
	readonly offset: Point;
	/** Z of the board's face the walls fold from. */
	readonly z: number;
	/** How far a wall folded down may reach before it meets what is below. */
	readonly maxDepth: number;
	readonly material: AssemblyMaterial;
	readonly fades: boolean;
};

/**
 * The flaps folded out of one opening in a horizontal board: its walls, their
 * finger pulls, and their glue flanges, in the frame of the group the board
 * belongs to. The deck, a riser's top panel, and a tray's floor all fold them
 * the same way.
 */
function pocketWallParts(
	pocket: Pocket,
	design: AssemblySettings,
	surface: OpeningSurface
): AssemblyPart[] {
	if (design.fabricationMode === 'router') return [];
	if (!SIDES.some((side) => pocket.sides[side])) return [];
	const parts: AssemblyPart[] = [];
	const x = pocket.x - surface.offset.x;
	const y = pocket.y - surface.offset.y;
	const wall = (
		edges: WallEdges,
		thickness: number,
		topZ: number,
		bottomZ: number,
		notch: WallNotch | null
	) =>
		shaped(
			{ form: 'wall', ...edges, thickness, topZ, bottomZ, notch },
			surface.material,
			surface.fades
		);
	const flange = (
		a: Point,
		b: Point,
		extension: Point,
		chamfer: number,
		z: number,
		thickness: number
	) =>
		shaped(
			{ form: 'panel', vertices: hingedFlangeVertices(a, b, extension, chamfer, z), thickness },
			surface.material,
			surface.fades
		);
	const owner = `pocket:${pocket.id}`;
	const wallSign = assemblyFoldSign(owner, 'top-fold', design);
	// A wall folded down cannot reach past the surface below the board it is cut from.
	const depth = wallSign < 0 ? Math.min(pocket.wallDepth, surface.maxDepth) : pocket.wallDepth;
	const t = Math.max(0.7, design.material * POCKET_WALL_FACTOR);
	const farZ = surface.z + wallSign * depth;
	const relief = Math.max(pocket.relief * 0.8, 0.5);
	const inset: Record<Side, number> = {
		left: pocket.sides.left ? pocket.wallDepth : 0,
		right: pocket.sides.right ? pocket.wallDepth : 0,
		bottom: pocket.sides.bottom ? pocket.wallDepth : 0,
		top: pocket.sides.top ? pocket.wallDepth : 0
	};
	const flangeInward = assemblyFoldDirection(owner, 'flange-fold', design) === 'down';
	const f = pocket.flange * (flangeInward ? 1 : -1);
	const flangeZ = farZ + wallSign * t * 0.18;
	const flangeChamfer = Math.min(pocket.flange, pocket.wallDepth) * 0.45;
	const notch = (side: Side): WallNotch | null =>
		pocket.pulls[side] ? { diameter: pocket.pullDiameter, depth: pocket.pullDepth } : null;

	// Each wall spans the full opening edge at the deck and is cut back by
	// the neighbouring walls' depth where it meets the floor.
	const walls: Record<Side, { edges: WallEdges; hinge: [Point, Point, Point] }> = {
		left: {
			edges: {
				topA: point(x, y + relief),
				topB: point(x, y + pocket.h - relief),
				bottomA: point(x, y + inset.bottom + relief),
				bottomB: point(x, y + pocket.h - inset.top - relief),
				inward: point(1, 0)
			},
			hinge: [
				point(x, y + inset.bottom + relief),
				point(x, y + pocket.h - inset.top - relief),
				point(f, 0)
			]
		},
		right: {
			edges: {
				topA: point(x + pocket.w, y + relief),
				topB: point(x + pocket.w, y + pocket.h - relief),
				bottomA: point(x + pocket.w, y + inset.bottom + relief),
				bottomB: point(x + pocket.w, y + pocket.h - inset.top - relief),
				inward: point(-1, 0)
			},
			hinge: [
				point(x + pocket.w, y + inset.bottom + relief),
				point(x + pocket.w, y + pocket.h - inset.top - relief),
				point(-f, 0)
			]
		},
		bottom: {
			edges: {
				topA: point(x + relief, y),
				topB: point(x + pocket.w - relief, y),
				bottomA: point(x + inset.left + relief, y),
				bottomB: point(x + pocket.w - inset.right - relief, y),
				inward: point(0, 1)
			},
			hinge: [
				point(x + inset.left + relief, y),
				point(x + pocket.w - inset.right - relief, y),
				point(0, f)
			]
		},
		top: {
			edges: {
				topA: point(x + relief, y + pocket.h),
				topB: point(x + pocket.w - relief, y + pocket.h),
				bottomA: point(x + inset.left + relief, y + pocket.h),
				bottomB: point(x + pocket.w - inset.right - relief, y + pocket.h),
				inward: point(0, -1)
			},
			hinge: [
				point(x + inset.left + relief, y + pocket.h),
				point(x + pocket.w - inset.right - relief, y + pocket.h),
				point(0, -f)
			]
		}
	};
	for (const side of SIDES) {
		if (!pocket.sides[side]) continue;
		const spec = walls[side];
		parts.push(wall(spec.edges, t, surface.z, farZ, notch(side)));
		if (pocket.flangeEnabled && pocket.flange > 0) {
			const [a, b, extension] = spec.hinge;
			parts.push(flange(a, b, extension, flangeChamfer, flangeZ, t));
		}
	}
	return parts;
}

/**
 * Assembled description of a whole design: the deck with its openings, the
 * perimeter that holds it up, the walls folded out of each pocket, and one
 * group per support placed at its assembly position.
 *
 * Pure and framework-free. The viewer turns these parts into meshes; nothing
 * in here knows how they will be drawn.
 */
export function buildAssembly(
	source: DesignState,
	selectedSupportId: string | null = null
): Assembly {
	// Spanning heights are resolved up front so that every part below reads a
	// concrete `h`, whoever handed us the design.
	const design = packagingView(resolveSupportHeights(source));
	const deckZ = raisedDeckHeight(design);
	const surface = deckSurfaceZ(design);
	const groups: AssemblyGroup[] = [];

	const deckParts: AssemblyPart[] = [];
	const box = (
		material: AssemblyMaterial,
		fades: boolean,
		x: number,
		y: number,
		z: number,
		w: number,
		d: number,
		h: number
	) => shaped({ form: 'box', x, y, z, w, d, h }, material, fades);
	const flange = (
		material: AssemblyMaterial,
		fades: boolean,
		a: Point,
		b: Point,
		extension: Point,
		chamfer: number,
		z: number,
		thickness: number
	) =>
		shaped(
			{ form: 'panel', vertices: hingedFlangeVertices(a, b, extension, chamfer, z), thickness },
			material,
			fades
		);
	// --- Deck panel, with every opening punched through it -------------------
	// The scene is deck-local: the deck spans 0..deckW by 0..deckH, so design
	// coordinates are shifted by the deck's position on the sheet.
	const local = (p: Point): Point => point(p.x - design.deckX, p.y - design.deckY);
	const deckRegion = regionOf(design, DECK_REGION)!;
	const deckPockets = regionPockets(design, DECK_REGION);
	// Every cut on the deck sheet goes through whatever board it crosses, stock cuts included.
	const deckSheetCuts = sheetCuts(design, design.deckSheetId);
	const holes: Point[][] = [];
	const panelFace = deckRegion.faces.find((face) => face.id === 'panel');
	for (const pocket of deckSheetCuts) {
		// An opening that runs off the panel onto a wall is punched where it overlaps.
		const outline = openingOutline(pocket);
		const opening =
			!panelFace || outline.every((p) => pointInConvex(p, panelFace.flat))
				? outline
				: clipToConvex(outline, panelFace.flat);
		if (opening.length >= 3) holes.push([...opening].reverse().map(local));
	}
	for (const tray of design.supports.filter((support) => support.kind === 'tray')) {
		holes.push(trayOpeningPath(tray, design).points.map(local));
	}
	deckParts.push(
		shaped(
			{
				form: 'plate',
				outline: [
					point(0, 0),
					point(design.deckW, 0),
					point(design.deckW, design.deckH),
					point(0, design.deckH)
				],
				holes,
				z: deckZ,
				thickness: Math.max(0.5, design.material)
			},
			'plate',
			true
		)
	);

	// --- Folded perimeter: a wall per enabled side, each with a glue flange ---
	const knife = design.fabricationMode === 'knife';
	if (knife && design.perimeterType === 'folded') {
		const t = Math.max(MIN_BOARD, design.material);
		const wallSign = assemblyFoldSign('sheet:deck', 'perimeter-deck-fold', design);
		const flangeInward =
			assemblyFoldDirection('sheet:deck', 'perimeter-flange-fold', design) === 'down';
		const farZ = deckZ + wallSign * design.perimeterWall;
		const wallBaseZ = Math.min(deckZ, farZ);
		const wallHeight = Math.abs(farZ - deckZ);
		// Adjacent walls are cut apart by the relief gap so they can fold independently.
		const gap = design.perimeterRelief / 2;
		const f = design.perimeterFlange;
		const horizontalChamfer = Math.min(f, Math.max(0, (design.deckW - gap * 2) / 3));
		const verticalChamfer = Math.min(f, Math.max(0, (design.deckH - gap * 2) / 3));
		const flangeZ = farZ + wallSign * t * 0.2;
		const push = (
			blockX: number,
			blockY: number,
			blockW: number,
			blockD: number,
			hingeA: Point,
			hingeB: Point,
			extension: Point,
			chamfer: number,
			side: Side
		) => {
			deckParts.push(
				faceWithOpenings(deckRegion, `wall-${side}`, deckSheetCuts, t, 'wall', true) ??
					box('wall', true, blockX, blockY, wallBaseZ, blockW, blockD, wallHeight),
				flange('wall', true, hingeA, hingeB, extension, chamfer, flangeZ, t)
			);
		};
		if (design.perimeterSides.bottom) {
			push(
				gap,
				-t / 2,
				design.deckW - gap * 2,
				t,
				point(gap, 0),
				point(design.deckW - gap, 0),
				point(0, flangeInward ? f : -f),
				horizontalChamfer,
				'bottom'
			);
		}
		if (design.perimeterSides.top) {
			push(
				gap,
				design.deckH - t / 2,
				design.deckW - gap * 2,
				t,
				point(gap, design.deckH),
				point(design.deckW - gap, design.deckH),
				point(0, flangeInward ? -f : f),
				horizontalChamfer,
				'top'
			);
		}
		if (design.perimeterSides.left) {
			push(
				-t / 2,
				gap,
				t,
				design.deckH - gap * 2,
				point(0, gap),
				point(0, design.deckH - gap),
				point(flangeInward ? f : -f, 0),
				verticalChamfer,
				'left'
			);
		}
		if (design.perimeterSides.right) {
			push(
				design.deckW - t / 2,
				gap,
				t,
				design.deckH - gap * 2,
				point(design.deckW, gap),
				point(design.deckW, design.deckH - gap),
				point(flangeInward ? -f : f, 0),
				verticalChamfer,
				'right'
			);
		}
	}

	// --- Joist perimeter: rolled blocks rather than a single wall ------------
	for (const part of joistAssemblyParts(design)) {
		deckParts.push(box('wall', true, part.x, part.y, part.z, part.w, part.d, part.h));
	}

	// --- Pocket walls: the flaps folded out of each opening in the deck panel -
	const deckPanel = deckRegion.faces.find((face) => face.id === 'panel');
	for (const pocket of deckPockets) {
		if (deckPanel && !centredOnFace(pocket, deckPanel)) continue;
		deckParts.push(
			...pocketWallParts(pocket, design, {
				offset: point(design.deckX, design.deckY),
				z: deckZ,
				maxDepth: deckZ,
				material: 'recess',
				fades: true
			})
		);
	}

	groups.push({
		id: 'deck',
		draggableId: null,
		origin: point(0, 0),
		selected: false,
		parts: deckParts
	});

	// --- One group per support, placed at its assembly origin ---------------
	for (const support of design.supports) {
		groups.push(buildSupportGroup(support, design, surface, support.id === selectedSupportId));
	}

	return {
		groups,
		extent: { w: design.deckW, d: design.deckH, h: surface },
		// Supports are dragged across the deck's top face.
		dragPlaneZ: surface,
		finish: design.boardFinish
	};
}

/**
 * Parts of one support in its own local coordinates, so that dragging it in
 * the viewer only moves the group's origin.
 */
function buildSupportGroup(
	support: Support,
	design: AssemblySettings,
	surface: number,
	selected: boolean
): AssemblyGroup {
	const origin = supportAssemblyOrigin(support, design.supports);
	const parts: AssemblyPart[] = [];
	const t = Math.max(MIN_BOARD, design.material);
	const owner = `riser:${support.id}`;
	const ref: RegionRef = { kind: 'support', supportId: support.id };
	const region = regionOf(design, ref);
	const openings = regionPockets(design, ref);
	const cuts = sheetCuts(design, support.sheetId);
	/** A face of this support's net drawn with its openings, or `null` when it has none. */
	const cutFace = (id: string) =>
		region ? faceWithOpenings(region, id, cuts, t, 'part', false) : null;
	/** The folded walls of each opening cut wholly into the face `id`, hanging from `z`. */
	const openingWalls = (id: string, offset: Point, z: number, maxDepth: number) => {
		const face = region?.faces.find((candidate) => candidate.id === id);
		if (!face) return;
		for (const pocket of openings) {
			if (!centredOnFace(pocket, face)) continue;
			parts.push(
				...pocketWallParts(pocket, design, { offset, z, maxDepth, material: 'part', fades: false })
			);
		}
	};

	const box = (x: number, y: number, z: number, w: number, d: number, h: number): AssemblyPart => ({
		form: 'box',
		x,
		y,
		z,
		w,
		d,
		h,
		material: 'part',
		fades: false
	});
	const flangePanel = (
		a: Point,
		b: Point,
		extension: Point,
		chamfer: number,
		z: number,
		thickness = t
	): AssemblyPart => ({
		form: 'panel',
		vertices: hingedFlangeVertices(a, b, extension, chamfer, z),
		thickness,
		material: 'part',
		fades: false
	});

	if (support.kind === 'tray') {
		const { mouth, bottom, topZ, bottomZ } = trayAssemblyProfile(support, design);
		parts.push(
			cutFace('bottom') ??
				box(
					bottom.left,
					bottom.bottom,
					bottomZ - t / 2,
					bottom.right - bottom.left,
					bottom.top - bottom.bottom,
					t
				)
		);
		// The floor's flat corner is its assembled corner, so that is the offset.
		openingWalls(
			'bottom',
			point(support.flatX - bottom.left, support.flatY - bottom.bottom),
			bottomZ,
			Number.POSITIVE_INFINITY
		);
		// Walls run mouth-to-floor and lean in by the taper. Corners are named
		// clockwise so that each wall's `inward` points into the tray.
		const trayWalls: Record<
			Side,
			Omit<
				Extract<PartShape, { form: 'wall' }>,
				'form' | 'thickness' | 'topZ' | 'bottomZ' | 'notch'
			>
		> = {
			bottom: {
				topA: point(mouth.left, mouth.bottom),
				topB: point(mouth.right, mouth.bottom),
				bottomA: point(bottom.left, bottom.bottom),
				bottomB: point(bottom.right, bottom.bottom),
				inward: point(0, 1)
			},
			right: {
				topA: point(mouth.right, mouth.bottom),
				topB: point(mouth.right, mouth.top),
				bottomA: point(bottom.right, bottom.bottom),
				bottomB: point(bottom.right, bottom.top),
				inward: point(-1, 0)
			},
			top: {
				topA: point(mouth.right, mouth.top),
				topB: point(mouth.left, mouth.top),
				bottomA: point(bottom.right, bottom.top),
				bottomB: point(bottom.left, bottom.top),
				inward: point(0, -1)
			},
			left: {
				topA: point(mouth.left, mouth.top),
				topB: point(mouth.left, mouth.bottom),
				bottomA: point(bottom.left, bottom.top),
				bottomB: point(bottom.left, bottom.bottom),
				inward: point(1, 0)
			}
		};
		for (const side of SIDES) {
			if (support.openSide === side) continue;
			// A wall with an opening is drawn as its flat face; its finger pull is not.
			const cut = cutFace(`wall-${side}`);
			if (cut) {
				parts.push(cut);
				continue;
			}
			parts.push({
				form: 'wall',
				...trayWalls[side],
				thickness: t,
				topZ,
				bottomZ,
				notch: trayHasPull(support, side)
					? { diameter: trayPullWidthAtMouth(support), depth: support.pullDepth }
					: null,
				material: 'part',
				fades: false
			});
		}

		if (support.flange > 0) {
			const f = support.flange;
			const direction =
				assemblyFoldDirection(owner, 'tray-flange-fold', design) === 'down' ? 1 : -1;
			const horizontalChamfer = Math.min(f, support.w / 3);
			const verticalChamfer = Math.min(f, support.d / 3);
			const flanges: Record<Side, { a: Point; b: Point; extension: Point; chamfer: number }> = {
				bottom: {
					a: point(mouth.left, mouth.bottom),
					b: point(mouth.right, mouth.bottom),
					extension: point(0, -f * direction),
					chamfer: horizontalChamfer
				},
				right: {
					a: point(mouth.right, mouth.bottom),
					b: point(mouth.right, mouth.top),
					extension: point(f * direction, 0),
					chamfer: verticalChamfer
				},
				top: {
					a: point(mouth.right, mouth.top),
					b: point(mouth.left, mouth.top),
					extension: point(0, f * direction),
					chamfer: horizontalChamfer
				},
				left: {
					a: point(mouth.left, mouth.top),
					b: point(mouth.left, mouth.bottom),
					extension: point(-f * direction, 0),
					chamfer: verticalChamfer
				}
			};
			for (const side of SIDES) {
				if (support.openSide === side) continue;
				const spec = flanges[side];
				if (!trayHasPull(support, side)) {
					parts.push(flangePanel(spec.a, spec.b, spec.extension, spec.chamfer, topZ));
					continue;
				}
				// A finger pull interrupts the flange, leaving a segment either side.
				const dx = spec.b.x - spec.a.x;
				const dy = spec.b.y - spec.a.y;
				const length = Math.hypot(dx, dy) || 1;
				const tangent = point(dx / length, dy / length);
				const halfGap = Math.min(trayPullWidthAtMouth(support) / 2, length * 0.42);
				const center = point((spec.a.x + spec.b.x) / 2, (spec.a.y + spec.b.y) / 2);
				const gapStart = point(center.x - tangent.x * halfGap, center.y - tangent.y * halfGap);
				const gapEnd = point(center.x + tangent.x * halfGap, center.y + tangent.y * halfGap);
				for (const [a, b] of [
					[spec.a, gapStart],
					[gapEnd, spec.b]
				] as const) {
					const segment = Math.hypot(b.x - a.x, b.y - a.y);
					if (segment <= 0.5) continue;
					parts.push(flangePanel(a, b, spec.extension, Math.min(spec.chamfer, segment / 3), topZ));
				}
			}
		}
		parts.push({
			form: 'footprint',
			x: 0,
			y: 0,
			z: surface + 0.8,
			w: support.w,
			d: support.d,
			material: 'part',
			fades: false
		});
		// A tray hangs from its deck opening, which is placed in 2D; dragging it
		// in 3D only ever moved it by accident.
		return { id: owner, draggableId: null, origin, selected, parts };
	}

	// --- Riser or platform: four walls closed by a top panel ----------------
	const wallSign = assemblyFoldSign(owner, 'riser-top-fold', design);
	const baseZ = supportMountPlane(support, design);
	// Folding down puts the panel at the top of the walls rather than the bottom.
	const panelZ = baseZ + (wallSign < 0 ? support.h : 0);
	const farZ = panelZ + wallSign * support.h;
	const wallBaseZ = Math.min(panelZ, farZ);
	const wallHeight = Math.abs(farZ - panelZ);
	parts.push(
		cutFace('wall-bottom') ?? box(0, -t / 2, wallBaseZ, support.w, t, wallHeight),
		cutFace('wall-top') ?? box(0, support.d - t / 2, wallBaseZ, support.w, t, wallHeight),
		cutFace('wall-left') ?? box(-t / 2, 0, wallBaseZ, t, support.d, wallHeight),
		cutFace('wall-right') ?? box(support.w - t / 2, 0, wallBaseZ, t, support.d, wallHeight),
		cutFace('panel') ?? box(0, 0, panelZ - t / 2, support.w, support.d, t)
	);
	// Walls folded down from the top panel hang inside the riser and stop at its floor.
	openingWalls(
		'panel',
		point(support.flatX, support.flatY),
		panelZ,
		farZ < panelZ ? panelZ - farZ : Number.POSITIVE_INFINITY
	);

	if (support.bottomFlange && support.flange > 0) {
		const chamfer = Math.min(support.flange, support.w / 3, support.d / 3);
		const z = farZ + wallSign * t * 0.18;
		for (const { a, b, extension } of supportFlangeDescriptors(support, design)) {
			parts.push(flangePanel(a, b, extension, chamfer, z));
		}
	}

	// --- Corner closures: glue tabs the full wall height, or shorter locking tabs
	const closureRole =
		support.cornerClosure === 'lock' ? 'riser-lock-tab-fold' : 'riser-corner-tab-fold';
	const tabInward = foldsWithWalls(owner, closureRole, design);
	const lowZ = Math.min(panelZ, farZ);
	const highZ = Math.max(panelZ, farZ);
	const tabHeight = support.cornerClosure === 'lock' ? Math.min(support.h * 0.55, 25.4) : support.h;
	const tabLow = support.cornerClosure === 'lock' ? (lowZ + highZ - tabHeight) / 2 : lowZ;
	const tabHigh = tabLow + tabHeight;
	// The free edge tapers so the tab clears its neighbour as it wraps the corner.
	const taper = Math.min(support.seam / 2, tabHeight / 4);
	const nearY = tabInward ? support.seam : -support.seam;
	const farY = tabInward ? support.d - support.seam : support.d + support.seam;
	for (const { x, edgeY, freeY } of [
		{ x: 0, edgeY: 0, freeY: nearY },
		{ x: support.w, edgeY: 0, freeY: nearY },
		{ x: 0, edgeY: support.d, freeY: farY },
		{ x: support.w, edgeY: support.d, freeY: farY }
	]) {
		parts.push({
			form: 'panel',
			vertices: [
				{ x, y: edgeY, z: tabLow },
				{ x, y: edgeY, z: tabHigh },
				{ x, y: freeY, z: tabHigh - taper },
				{ x, y: freeY, z: tabLow + taper }
			],
			thickness: t * 0.72,
			material: 'part',
			fades: false
		});
	}

	parts.push({
		form: 'footprint',
		x: 0,
		y: 0,
		z: surface + 0.8,
		w: support.w,
		d: support.d,
		material: 'part',
		fades: false
	});
	return { id: owner, draggableId: support.id, origin, selected, parts };
}
