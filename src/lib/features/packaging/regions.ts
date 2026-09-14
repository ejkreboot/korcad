import { SHEET } from '$lib/core/constants.js';
import { point, type Point } from '$lib/core/geometry/primitives.js';
import { point3, type Point3 } from '$lib/core/assembly/model.js';
import { clipToConvex, outlineBounds, pointInConvex } from '$lib/core/geometry/contour.js';
import { flatPanel } from './fold.js';
import { assemblyFoldSign } from './folds.js';
import { raisedDeckHeight, supportBuildDirection, supportMountPlane } from './levels.js';
import { perimeterBounds } from './perimeter.js';
import { flatSupport, trayMetrics } from './supports.js';
import type { Pocket, RegionRef, Support } from './types.js';
import type { PackagingView } from './view.js';

/**
 * Stock regions: the pieces of board a packaging design is cut into.
 *
 * The deck blank and every support net are, to the knife, the same thing — a
 * flat region cut free from a sheet, creased into faces. Each kind describes
 * its faces here, once; openings, containment, hit-testing, and the holes the
 * 3D model punches are then written against a region rather than against the
 * deck or a particular kind of support.
 *
 * Face outlines are convex and in sheet coordinates. Where a face is modelled
 * in 3D, `placed` lists the same vertices in the assembly frame of its region:
 * deck-local for the deck, support-local for a support. The first, second, and
 * last vertices fix the flat-to-folded mapping.
 */

export type { RegionRef };

export const DECK_REGION: RegionRef = { kind: 'deck' };

export type RegionFace = {
	/** Stable within its region: `panel`, `bottom`, `wall-left`, `flange-top`, `tab-3`. */
	readonly id: string;
	readonly flat: readonly Point[];
	/** The face folded into place, vertex for vertex; `null` where 3D does not model it. */
	readonly placed: readonly Point3[] | null;
};

export type StockRegion = {
	readonly ref: RegionRef;
	readonly name: string;
	readonly sheetId: string;
	/** The face an opening's folded walls hang from, when it is drawn on it. */
	readonly mainFaceId: string;
	readonly faces: readonly RegionFace[];
};

export type RegionSettings = PackagingView;

export const sameRegion = (a: RegionRef, b: RegionRef): boolean =>
	a.kind === 'deck'
		? b.kind === 'deck'
		: a.kind === 'support'
			? b.kind === 'support' && a.supportId === b.supportId
			: b.kind === 'stock' && a.sheetId === b.sheetId;

const rect = (left: number, bottom: number, right: number, top: number): Point[] => [
	point(left, bottom),
	point(right, bottom),
	point(right, top),
	point(left, top)
];

// ---- the deck --------------------------------------------------------------

function deckRegion(view: RegionSettings): StockRegion {
	const { deckX: x, deckY: y, deckW: w, deckH: h } = view;
	const deckZ = raisedDeckHeight(view);
	const faces: RegionFace[] = [
		{
			id: 'panel',
			flat: rect(x, y, x + w, y + h),
			placed: [point3(0, 0, deckZ), point3(w, 0, deckZ), point3(w, h, deckZ), point3(0, h, deckZ)]
		}
	];
	const knife = view.fabricationMode === 'knife';

	if (knife && view.perimeterType === 'folded') {
		// Mirrors `buildFoldedPerimeter`: each wall hinges on the deck edge, gapped
		// by half the relief at both ends, with its chamfered flange beyond.
		const wall = flatPanel(view.perimeterWall, view);
		const flange = flatPanel(view.perimeterFlange, view);
		const gap = view.perimeterRelief / 2;
		const farZ =
			deckZ + assemblyFoldSign('sheet:deck', 'perimeter-deck-fold', view) * view.perimeterWall;
		const sides = [
			{ side: 'bottom', a: point(x + gap, y), b: point(x + w - gap, y), out: point(0, -1) },
			{ side: 'right', a: point(x + w, y + gap), b: point(x + w, y + h - gap), out: point(1, 0) },
			{ side: 'top', a: point(x + gap, y + h), b: point(x + w - gap, y + h), out: point(0, 1) },
			{ side: 'left', a: point(x, y + gap), b: point(x, y + h - gap), out: point(-1, 0) }
		] as const;
		for (const { side, a, b, out } of sides) {
			if (!view.perimeterSides[side]) continue;
			const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
			const along = point((b.x - a.x) / length, (b.y - a.y) / length);
			const chamfer = Math.min(flange, Math.max(0, length / 3));
			const wa = point(a.x + out.x * wall, a.y + out.y * wall);
			const wb = point(b.x + out.x * wall, b.y + out.y * wall);
			const local = (p: Point) => point(p.x - x, p.y - y);
			const [la, lb] = [local(a), local(b)];
			faces.push(
				{
					id: `wall-${side}`,
					flat: [a, b, wb, wa],
					placed: [
						point3(la.x, la.y, deckZ),
						point3(lb.x, lb.y, deckZ),
						point3(lb.x, lb.y, farZ),
						point3(la.x, la.y, farZ)
					]
				},
				{
					id: `flange-${side}`,
					flat: [
						wa,
						wb,
						point(
							wb.x + out.x * flange - along.x * chamfer,
							wb.y + out.y * flange - along.y * chamfer
						),
						point(
							wa.x + out.x * flange + along.x * chamfer,
							wa.y + out.y * flange + along.y * chamfer
						)
					],
					placed: null
				}
			);
		}
	} else if (knife && view.perimeterType === 'joist') {
		// The rolled strips are one face each for containment; 3D models them as blocks.
		const outer = perimeterBounds(view);
		if (outer.left < x)
			faces.push({ id: 'joist-left', flat: rect(outer.left, y, x, y + h), placed: null });
		if (outer.right > x + w) {
			faces.push({ id: 'joist-right', flat: rect(x + w, y, outer.right, y + h), placed: null });
		}
		if (outer.bottom < y) {
			faces.push({ id: 'joist-bottom', flat: rect(x, outer.bottom, x + w, y), placed: null });
		}
		if (outer.top > y + h) {
			faces.push({ id: 'joist-top', flat: rect(x, y + h, x + w, outer.top), placed: null });
		}
	}

	return {
		ref: DECK_REGION,
		name: 'Top deck',
		sheetId: view.deckSheetId,
		mainFaceId: 'panel',
		faces
	};
}

// ---- supports --------------------------------------------------------------

export type TrayAssemblyProfile = {
	readonly mouth: { left: number; right: number; bottom: number; top: number };
	readonly bottom: { left: number; right: number; bottom: number; top: number };
	readonly topZ: number;
	readonly bottomZ: number;
};

/**
 * The assembled shape of a tray, in tray-local coordinates. The mouth is wider
 * than the nominal opening by the flange overlap, and the floor is drawn in by
 * the wall taper.
 */
export function trayAssemblyProfile(tray: Support, settings: RegionSettings): TrayAssemblyProfile {
	const metrics = trayMetrics(tray);
	const mouth = {
		left: -metrics.overlap,
		right: tray.w + metrics.overlap,
		bottom: -metrics.overlap,
		top: tray.d + metrics.overlap
	};
	const topZ = supportMountPlane(tray, settings);
	return {
		mouth,
		bottom: {
			left: mouth.left + metrics.taper,
			right: mouth.right - metrics.taper,
			bottom: mouth.bottom + metrics.taper,
			top: mouth.top - metrics.taper
		},
		topZ,
		bottomZ:
			topZ +
			supportBuildDirection(tray) *
				assemblyFoldSign(`riser:${tray.id}`, 'tray-wall-fold', settings) *
				tray.h
	};
}

/** Z of a riser or platform's top panel and of its walls' far edge. */
export function riserLevels(
	support: Support,
	settings: RegionSettings
): { panelZ: number; farZ: number } {
	const wallSign = assemblyFoldSign(`riser:${support.id}`, 'riser-top-fold', settings);
	const baseZ = supportMountPlane(support, settings);
	// Folding down puts the panel at the top of the walls rather than the bottom.
	const panelZ = baseZ + (wallSign < 0 ? support.h : 0);
	return { panelZ, farZ: panelZ + wallSign * support.h };
}

/** A chamfered flap hinged on `a`–`b`, reaching `depth` along `out`. */
function flap(a: Point, b: Point, out: Point, depth: number, chamfer: number): Point[] {
	const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
	const along = point((b.x - a.x) / length, (b.y - a.y) / length);
	const cut = Math.min(chamfer, length / 3);
	return [
		a,
		b,
		point(b.x + out.x * depth - along.x * cut, b.y + out.y * depth - along.y * cut),
		point(a.x + out.x * depth + along.x * cut, a.y + out.y * depth + along.y * cut)
	];
}

/** Mirrors `trayPaths`: the floor, four tapered walls, and their glue flanges. */
function trayFaces(nominal: Support, settings: RegionSettings): RegionFace[] {
	const tray = flatSupport(nominal, settings);
	const metrics = trayMetrics(tray);
	if (metrics.bottomW <= 0 || metrics.bottomD <= 0) return [];
	const { mouth, bottom, topZ, bottomZ } = trayAssemblyProfile(nominal, settings);
	const x = tray.flatX;
	const y = tray.flatY;
	const corners = {
		bl: point(x, y),
		br: point(x + metrics.bottomW, y),
		tr: point(x + metrics.bottomW, y + metrics.bottomD),
		tl: point(x, y + metrics.bottomD)
	};
	const faces: RegionFace[] = [
		{
			id: 'bottom',
			flat: [corners.bl, corners.br, corners.tr, corners.tl],
			placed: [
				point3(bottom.left, bottom.bottom, bottomZ),
				point3(bottom.right, bottom.bottom, bottomZ),
				point3(bottom.right, bottom.top, bottomZ),
				point3(bottom.left, bottom.top, bottomZ)
			]
		}
	];
	const walls = [
		{
			side: 'bottom',
			a: corners.bl,
			b: corners.br,
			out: point(0, -1),
			floor: [point(bottom.left, bottom.bottom), point(bottom.right, bottom.bottom)],
			rim: [point(mouth.left, mouth.bottom), point(mouth.right, mouth.bottom)]
		},
		{
			side: 'right',
			a: corners.br,
			b: corners.tr,
			out: point(1, 0),
			floor: [point(bottom.right, bottom.bottom), point(bottom.right, bottom.top)],
			rim: [point(mouth.right, mouth.bottom), point(mouth.right, mouth.top)]
		},
		{
			side: 'top',
			a: corners.tr,
			b: corners.tl,
			out: point(0, 1),
			floor: [point(bottom.right, bottom.top), point(bottom.left, bottom.top)],
			rim: [point(mouth.right, mouth.top), point(mouth.left, mouth.top)]
		},
		{
			side: 'left',
			a: corners.tl,
			b: corners.bl,
			out: point(-1, 0),
			floor: [point(bottom.left, bottom.top), point(bottom.left, bottom.bottom)],
			rim: [point(mouth.left, mouth.top), point(mouth.left, mouth.bottom)]
		}
	] as const;
	for (const { side, a, b, out, floor, rim } of walls) {
		if (tray.openSide === side) continue;
		const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
		const along = point((b.x - a.x) / length, (b.y - a.y) / length);
		const topA = point(
			a.x + out.x * metrics.wallReach - along.x * metrics.taper,
			a.y + out.y * metrics.wallReach - along.y * metrics.taper
		);
		const topB = point(
			b.x + out.x * metrics.wallReach + along.x * metrics.taper,
			b.y + out.y * metrics.wallReach + along.y * metrics.taper
		);
		faces.push({
			id: `wall-${side}`,
			flat: [a, b, topB, topA],
			placed: [
				point3(floor[0].x, floor[0].y, bottomZ),
				point3(floor[1].x, floor[1].y, bottomZ),
				point3(rim[1].x, rim[1].y, topZ),
				point3(rim[0].x, rim[0].y, topZ)
			]
		});
		if (tray.flange > 0) {
			faces.push({
				id: `flange-${side}`,
				flat: flap(topA, topB, out, tray.flange, tray.flange),
				placed: null
			});
		}
	}
	return faces;
}

/** Mirrors `riserPaths`: the top panel, four walls, bottom flanges, and corner closures. */
function riserFaces(nominal: Support, settings: RegionSettings): RegionFace[] {
	const r = flatSupport(nominal, settings);
	const ox = r.flatX;
	const oy = r.flatY;
	const { panelZ, farZ } = riserLevels(nominal, settings);
	const w = nominal.w;
	const d = nominal.d;
	const faces: RegionFace[] = [
		{
			id: 'panel',
			flat: rect(ox, oy, ox + r.w, oy + r.d),
			placed: [
				point3(0, 0, panelZ),
				point3(w, 0, panelZ),
				point3(w, d, panelZ),
				point3(0, d, panelZ)
			]
		}
	];
	const walls = [
		{
			side: 'bottom',
			a: point(ox, oy),
			b: point(ox + r.w, oy),
			out: point(0, -1),
			la: point(0, 0),
			lb: point(w, 0)
		},
		{
			side: 'right',
			a: point(ox + r.w, oy),
			b: point(ox + r.w, oy + r.d),
			out: point(1, 0),
			la: point(w, 0),
			lb: point(w, d)
		},
		{
			side: 'top',
			a: point(ox, oy + r.d),
			b: point(ox + r.w, oy + r.d),
			out: point(0, 1),
			la: point(0, d),
			lb: point(w, d)
		},
		{
			side: 'left',
			a: point(ox, oy),
			b: point(ox, oy + r.d),
			out: point(-1, 0),
			la: point(0, 0),
			lb: point(0, d)
		}
	] as const;
	for (const { side, a, b, out, la, lb } of walls) {
		const wa = point(a.x + out.x * r.h, a.y + out.y * r.h);
		const wb = point(b.x + out.x * r.h, b.y + out.y * r.h);
		faces.push({
			id: `wall-${side}`,
			flat: [a, b, wb, wa],
			placed: [
				point3(la.x, la.y, panelZ),
				point3(lb.x, lb.y, panelZ),
				point3(lb.x, lb.y, farZ),
				point3(la.x, la.y, farZ)
			]
		});
		if (r.bottomFlange && r.flange > 0) {
			faces.push({
				id: `flange-${side}`,
				flat: flap(wa, wb, out, r.flange, r.flange),
				placed: null
			});
		}
	}

	// Corner closures hang off the ends of the bottom and top walls.
	const tabs: [Point, Point, number][] = [
		[point(ox, oy - r.h), point(ox, oy), -1],
		[point(ox + r.w, oy - r.h), point(ox + r.w, oy), 1],
		[point(ox, oy + r.d), point(ox, oy + r.d + r.h), -1],
		[point(ox + r.w, oy + r.d), point(ox + r.w, oy + r.d + r.h), 1]
	];
	tabs.forEach(([a, b, direction], index) => {
		let low = Math.min(a.y, b.y);
		let high = Math.max(a.y, b.y);
		let inset = Math.min(r.seam / 2, r.h / 4);
		if (r.cornerClosure === 'lock') {
			const tabWidth = Math.min(r.h * 0.55, 25.4);
			const centre = (low + high) / 2;
			low = centre - tabWidth / 2;
			high = centre + tabWidth / 2;
			inset = Math.min(tabWidth * 0.18, r.seam * 0.35);
		}
		const tipX = a.x + direction * r.seam;
		faces.push({
			id: `tab-${index + 1}`,
			flat: [
				point(a.x, low),
				point(tipX, low + inset),
				point(tipX, high - inset),
				point(a.x, high)
			],
			placed: null
		});
	});
	return faces;
}

function supportRegion(support: Support, view: RegionSettings): StockRegion {
	const tray = support.kind === 'tray';
	return {
		ref: { kind: 'support', supportId: support.id },
		name: support.name,
		sheetId: support.sheetId,
		mainFaceId: tray ? 'bottom' : 'panel',
		faces: tray ? trayFaces(support, view) : riserFaces(support, view)
	};
}

// ---- queries ---------------------------------------------------------------

/** Every region of the design: the deck, then each support that is folded from a net. */
export function stockRegions(view: RegionSettings): StockRegion[] {
	const deck = deckRegion(view);
	// Supports are folded parts; a routed design has none to cut openings into.
	if (view.fabricationMode !== 'knife') return [deck];
	return [deck, ...view.supports.map((support) => supportRegion(support, view))];
}

/** A sheet's bare stock, as a region: one face, the whole sheet, never folded. */
function sheetRegion(view: RegionSettings, sheetId: string): StockRegion | null {
	const sheet = view.sheets.find((candidate) => candidate.id === sheetId);
	if (!sheet) return null;
	return {
		ref: { kind: 'stock', sheetId },
		name: `the ${sheet.name} stock`,
		sheetId,
		mainFaceId: 'sheet',
		faces: [{ id: 'sheet', flat: rect(0, 0, SHEET, SHEET), placed: null }]
	};
}

export function regionOf(view: RegionSettings, ref: RegionRef): StockRegion | null {
	if (ref.kind === 'deck') return deckRegion(view);
	if (ref.kind === 'stock') return sheetRegion(view, ref.sheetId);
	const support = view.supports.find((item) => item.id === ref.supportId);
	return support && view.fabricationMode === 'knife' ? supportRegion(support, view) : null;
}

/** The region of a sheet whose net covers `p`; supports win over the deck they sit on. */
export function regionAt(view: RegionSettings, sheetId: string, p: Point): StockRegion | null {
	const candidates = stockRegions(view)
		.filter((region) => region.sheetId === sheetId)
		.reverse();
	return (
		candidates.find((region) => region.faces.some((face) => pointInConvex(p, face.flat))) ?? null
	);
}

/**
 * What outlines drawn on a sheet are cut into: the part whose net they all lie
 * on — a support before the deck it may sit over — or else the sheet's stock.
 */
export function hostFor(
	view: RegionSettings,
	sheetId: string,
	outlines: readonly (readonly Point[])[]
): RegionRef {
	const part = stockRegions(view)
		.filter((region) => region.sheetId === sheetId)
		.reverse()
		.find((region) => outlines.every((outline) => onRegion(region, outline)));
	return part?.ref ?? { kind: 'stock', sheetId };
}

/** Axis-aligned bounds of a region's whole net. */
export function regionBounds(region: StockRegion) {
	return outlineBounds(region.faces.flatMap((face) => face.flat));
}

/**
 * Whether an outline lies on a region's net. Every vertex, and points along
 * every edge, must land on some face, so an opening bridging the empty corner
 * between two walls is caught even though its box is inside the net's box.
 */
export function onRegion(region: StockRegion, outline: readonly Point[]): boolean {
	const samples: Point[] = [];
	outline.forEach((a, index) => {
		const b = outline[(index + 1) % outline.length]!;
		const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
		for (let i = 0; i < steps; i++) {
			samples.push(point(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps));
		}
	});
	return (
		samples.length > 0 &&
		samples.every((p) => region.faces.some((face) => pointInConvex(p, face.flat, 1e-3)))
	);
}

/** The sheet an opening is cut from: its region's, or `null` when that region is gone. */
export function pocketSheetId(
	view: Pick<PackagingView, 'deckSheetId' | 'supports'>,
	pocket: Pick<Pocket, 'host'>
): string | null {
	const { host } = pocket;
	if (host.kind === 'deck') return view.deckSheetId;
	if (host.kind === 'stock') return host.sheetId;
	return view.supports.find((support) => support.id === host.supportId)?.sheetId ?? null;
}

/** The pockets cut into a region. */
export function regionPockets(view: Pick<PackagingView, 'pockets'>, ref: RegionRef): Pocket[] {
	return view.pockets.filter((pocket) => sameRegion(pocket.host, ref));
}

/**
 * A flat outline carried onto a face in 3D: clipped to the face, then mapped
 * through the affine that takes the face's first, second, and last flat
 * vertices onto their placed positions. Empty when the outline misses the face.
 */
export function outlineOnFace(outline: readonly Point[], face: RegionFace): Point3[] {
	if (!face.placed) return [];
	const inside = outline.every((p) => pointInConvex(p, face.flat));
	const clipped = inside ? [...outline] : clipToConvex(outline, face.flat);
	return clipped.map((p) => placeOnFace(p, face));
}

export function placeOnFace(p: Point, face: RegionFace): Point3 {
	const placed = face.placed;
	const f0 = face.flat[0];
	const f1 = face.flat[1];
	const fl = face.flat.at(-1);
	const q0 = placed?.[0];
	const q1 = placed?.[1];
	const ql = placed?.at(-1);
	if (!placed || !f0 || !f1 || !fl || !q0 || !q1 || !ql) return point3(p.x, p.y, 0);
	const e1 = point(f1.x - f0.x, f1.y - f0.y);
	const e2 = point(fl.x - f0.x, fl.y - f0.y);
	const determinant = e1.x * e2.y - e1.y * e2.x || 1;
	const dx = p.x - f0.x;
	const dy = p.y - f0.y;
	const s = (dx * e2.y - dy * e2.x) / determinant;
	const t = (e1.x * dy - e1.y * dx) / determinant;
	return point3(
		q0.x + s * (q1.x - q0.x) + t * (ql.x - q0.x),
		q0.y + s * (q1.y - q0.y) + t * (ql.y - q0.y),
		q0.z + s * (q1.z - q0.z) + t * (ql.z - q0.z)
	);
}
