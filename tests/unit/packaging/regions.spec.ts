import { describe, expect, it } from 'vitest';
import { clipToConvex, pointInConvex } from '$lib/core/geometry/contour.js';
import { point } from '$lib/core/geometry/primitives.js';
import {
	releaseSheet,
	removeSupport,
	resizeSupport,
	updatePocket,
	updateSupport
} from '$lib/features/packaging/actions.js';
import { importSvgOpenings } from '$lib/features/packaging/import.js';
import { buildAssembly } from '$lib/features/packaging/assembly.js';
import { createPocket } from '$lib/features/packaging/defaults.js';
import { INTERIOR_HOLE } from '$lib/features/packaging/paths.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { normalizePackaging } from '$lib/features/packaging/normalize.js';
import {
	hostFor,
	onRegion,
	placeOnFace,
	regionAt,
	regionOf,
	stockRegions
} from '$lib/features/packaging/regions.js';
import { validate } from '$lib/features/packaging/validation.js';
import { packagingData } from '$lib/features/packaging/view.js';
import { createDefaultDesign } from '$lib/features/document.js';
import { partOpeningsDesign, patchDesign, supportDesign, view } from '../../support/designs.js';

/** Openings cut into any stock region: the deck blank or a support's net. */

const riserRef = { kind: 'support', supportId: 'riser-1' } as const;
const trayRef = { kind: 'support', supportId: 'tray-1' } as const;

describe('convex outlines', () => {
	const square = [point(0, 0), point(10, 0), point(10, 10), point(0, 10)];

	it('contains its boundary in either winding', () => {
		expect(pointInConvex(point(10, 5), square)).toBe(true);
		expect(pointInConvex(point(5, 5), [...square].reverse())).toBe(true);
		expect(pointInConvex(point(11, 5), square)).toBe(false);
	});

	it('clips an outline to the part inside', () => {
		const clipped = clipToConvex([point(5, 5), point(15, 5), point(15, 8), point(5, 8)], square);
		expect(Math.max(...clipped.map((p) => p.x))).toBe(10);
		expect(clipToConvex([point(20, 20), point(30, 20), point(30, 30)], square)).toEqual([]);
	});
});

describe('stock regions', () => {
	it('lists the deck and every support, each on its own sheet', () => {
		const regions = stockRegions(view(supportDesign()));
		expect(regions.map((region) => [region.name, region.sheetId])).toEqual([
			['Top deck', 'deck'],
			['Tablet tray', 'parts'],
			['Riser 1', 'parts']
		]);
	});

	it('describes a riser net face by face, so its empty corners are off the net', () => {
		const riser = regionOf(view(supportDesign()), riserRef)!;
		expect(riser.faces.map((face) => face.id)).toEqual(
			expect.arrayContaining(['panel', 'wall-bottom', 'wall-top', 'wall-left', 'wall-right'])
		);
		// The riser panel starts at 300, 60; a wall hangs below it, a corner does not.
		expect(onRegion(riser, [point(310, 50), point(320, 50), point(320, 55)])).toBe(true);
		expect(onRegion(riser, [point(280, 45), point(290, 45), point(290, 50)])).toBe(false);
	});

	it('finds the part under a point, and nothing over bare stock', () => {
		const design = view(supportDesign());
		expect(regionAt(design, 'parts', point(340, 90))?.name).toBe('Riser 1');
		expect(regionAt(design, 'parts', point(100, 90))?.name).toBe('Tablet tray');
		expect(regionAt(design, 'parts', point(560, 560))).toBeNull();
		expect(regionAt(design, 'deck', point(300, 300))?.name).toBe('Top deck');
	});

	it('folds a wall face into place in the riser frame', () => {
		const riser = regionOf(view(supportDesign()), riserRef)!;
		const wall = riser.faces.find((face) => face.id === 'wall-bottom')!;
		const hinge = placeOnFace(point(300, 60), wall);
		const far = placeOnFace(point(300, 30), wall);
		expect([hinge.x, hinge.y]).toEqual([0, 0]);
		expect(Math.abs(hinge.z - far.z)).toBeCloseTo(30, 5);
	});
});

describe('openings in a part', () => {
	const hosted = (design = partOpeningsDesign()) =>
		packagingData(design).pockets.filter((pocket) => pocket.host.kind === 'support');

	it('is cut on its part’s sheet as an interior hole, and not on the deck sheet', () => {
		const design = partOpeningsDesign();
		const parts = allGeometry(design, 'parts').paths;
		const deck = allGeometry(design, 'deck').paths;
		const owned = (id: string) => (path: { owner?: { id: string } }) => path.owner?.id === id;
		expect(parts.filter(owned('tray-hole')).map((path) => path.cam)).toEqual([INTERIOR_HOLE]);
		expect(parts.some(owned('riser-opening'))).toBe(true);
		expect(deck.some(owned('riser-opening'))).toBe(false);
		expect(deck.some(owned('tray-hole'))).toBe(false);
	});

	it('moves with its part on the sheet', () => {
		const moved = updateSupport(partOpeningsDesign(), 'riser-1', { flatX: 340, flatY: 90 });
		const opening = hosted(moved).find((pocket) => pocket.id === 'riser-opening')!;
		expect([opening.x, opening.y]).toEqual([360, 105]);
		// A change that leaves the net in place leaves the opening alone.
		const renamed = resizeSupport(partOpeningsDesign(), 'riser-1', { name: 'Step' });
		expect(hosted(renamed).find((pocket) => pocket.id === 'riser-opening')?.x).toBe(320);
	});

	it('goes with its part, and with the sheet the part is cut from', () => {
		expect(hosted(removeSupport(partOpeningsDesign(), 'riser-1')).map((p) => p.id)).toEqual([
			'tray-hole'
		]);
		expect(hosted(releaseSheet(partOpeningsDesign(), 'parts'))).toEqual([]);
		expect(packagingData(releaseSheet(partOpeningsDesign(), 'parts')).pockets).toHaveLength(1);
	});

	it('is dropped on load when the part it names is not in the file', () => {
		const design = partOpeningsDesign();
		const raw = { ...packagingData(design), supports: [] };
		const read = packagingData(normalizePackaging(raw, createDefaultDesign()));
		expect(read.pockets.map((pocket) => pocket.host.kind)).toEqual(['deck']);
	});

	it('is reported when it runs off its part', () => {
		const design = patchDesign(partOpeningsDesign(), {
			pockets: [
				createPocket({ id: 'off', name: 'Off', host: riserRef, x: 280, y: 40, w: 15, h: 10 })
			]
		});
		expect(validate(design)).toContain('Off: opening runs off Riser 1');
	});

	it('may not fold walls deeper than the riser it hangs inside', () => {
		const design = patchDesign(partOpeningsDesign(), {
			pockets: [
				createPocket({
					id: 'deep',
					name: 'Deep',
					host: riserRef,
					x: 310,
					y: 70,
					w: 70,
					h: 50,
					wallDepth: 40,
					sides: { top: false, right: true, bottom: false, left: true }
				})
			]
		});
		expect(validate(design)).toContain('Deep: folded walls reach past the floor of Riser 1');
	});

	it('is punched through its face in 3D, with its walls folded inside the part', () => {
		const assembly = buildAssembly(partOpeningsDesign());
		const group = (id: string) => assembly.groups.find((g) => g.id === `riser:${id}`)!;
		const sheets = (id: string) => group(id).parts.filter((part) => part.form === 'sheet');
		expect(sheets('riser-1')).toHaveLength(1);
		expect(sheets('riser-1')[0]?.form === 'sheet' && sheets('riser-1')[0]?.holes).toHaveLength(1);
		expect(sheets('tray-1')).toHaveLength(1);
		expect(group('riser-1').parts.filter((part) => part.form === 'wall')).toHaveLength(4);
		// A support with no openings keeps the solid parts it has always had.
		const plain = buildAssembly(supportDesign());
		expect(plain.groups.flatMap((g) => g.parts).some((part) => part.form === 'sheet')).toBe(false);
	});

	it('reports an opening whose part is gone rather than cutting it into the deck', () => {
		const design = patchDesign(supportDesign(), {
			pockets: [createPocket({ id: 'lost', name: 'Lost', host: trayRef, x: 0, y: 0, w: 1, h: 1 })],
			supports: []
		});
		expect(validate(design)).toContain('Lost: the part it is cut into is missing');
	});
});

describe('cuts straight out of the stock', () => {
	const box = (left: number, bottom: number, right: number, top: number) => [
		point(left, bottom),
		point(right, bottom),
		point(right, top),
		point(left, top)
	];
	const opening = (design = partOpeningsDesign(), id = 'riser-opening') =>
		packagingData(design).pockets.find((pocket) => pocket.id === id)!;

	it('belongs to a part only when it lies wholly on it', () => {
		const design = view(supportDesign());
		expect(hostFor(design, 'parts', [box(320, 75, 370, 115)])).toEqual(riserRef);
		// Straddling the riser's edge, or clear of every part, it is the sheet's.
		// The riser's right wall reaches 420 and its flange 432, so this crosses the net's edge.
		expect(hostFor(design, 'parts', [box(410, 75, 450, 115)])).toEqual({
			kind: 'stock',
			sheetId: 'parts'
		});
		expect(hostFor(design, 'parts', [box(500, 500, 540, 540)])).toEqual({
			kind: 'stock',
			sheetId: 'parts'
		});
	});

	it('changes hands as it is moved on and off a part', () => {
		const off = updatePocket(partOpeningsDesign(), 'riser-opening', { x: 500, y: 500 });
		expect(opening(off).host).toEqual({ kind: 'stock', sheetId: 'parts' });
		// A stock cut stays put when the part next to it moves.
		const riserMoved = updateSupport(off, 'riser-1', { flatX: 320 });
		expect(opening(riserMoved).x).toBe(500);
		const back = updatePocket(off, 'riser-opening', { x: 320, y: 75 });
		expect(opening(back).host).toEqual(riserRef);
	});

	it('is cut on its sheet, before the parts are released, and goes with the sheet', () => {
		const design = updatePocket(partOpeningsDesign(), 'tray-hole', { x: 500, y: 500 });
		const cuts = allGeometry(design, 'parts').paths.filter(
			(path) => path.owner?.id === 'tray-hole'
		);
		expect(cuts.map((path) => path.cam)).toEqual([INTERIOR_HOLE]);
		expect(validate(design)).toEqual([]);
		expect(packagingData(releaseSheet(design, 'parts')).pockets.map((p) => p.id)).toEqual([
			'pocket-1'
		]);
	});

	it('punches through the part it crosses in 3D', () => {
		// Across the riser's right wall (to 426) and flange (to 438), out over bare stock.
		const design = updatePocket(partOpeningsDesign(), 'riser-opening', {
			x: 410,
			y: 80,
			w: 40,
			h: 30,
			sides: { top: false, right: false, bottom: false, left: false }
		});
		expect(opening(design).host.kind).toBe('stock');
		const riser = buildAssembly(design).groups.find((group) => group.id === 'riser:riser-1')!;
		const wall = riser.parts.find((part) => part.form === 'sheet');
		expect(wall?.form === 'sheet' && wall.holes).toHaveLength(1);
		expect(wall?.form === 'sheet' && Math.abs(wall.frame.v.z)).toBeCloseTo(1, 5);
		expect(riser.parts.some((part) => part.form === 'wall')).toBe(false);
	});

	it('is imported anywhere on a parts sheet, centred on the sheet', () => {
		const product = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="60mm" viewBox="0 0 100 60"><rect width="100" height="60"/></svg>`;
		const { design, notice } = importSvgOpenings(supportDesign(), 'parts', product, 'p.svg');
		const imported = packagingData(design).pockets.at(-1)!;
		expect(imported.host).toEqual({ kind: 'stock', sheetId: 'parts' });
		expect(imported.x + imported.w / 2).toBeCloseTo(304.8, 3);
		expect(notice).toContain('centred on the Parts 1 sheet');
		expect(allGeometry(design, 'parts').paths.some((p) => p.owner?.id === imported.id)).toBe(true);
	});

	it('keeps its sheet when saved and read back, and is dropped with a missing sheet', () => {
		const design = updatePocket(partOpeningsDesign(), 'tray-hole', { x: 500, y: 500 });
		const read = packagingData(normalizePackaging(packagingData(design), design));
		expect(read.pockets.find((p) => p.id === 'tray-hole')?.host).toEqual({
			kind: 'stock',
			sheetId: 'parts'
		});
		const orphan = packagingData(normalizePackaging(packagingData(design), createDefaultDesign()));
		expect(orphan.pockets.some((p) => p.id === 'tray-hole')).toBe(false);
	});
});
