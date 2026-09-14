import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHEET } from '$lib/core/constants.js';
import { round } from '$lib/core/units.js';
import { toolpathPoints } from '$lib/core/cam/compensation.js';
import { generateGcode } from '$lib/core/cam/gcode.js';
import { simulationMoves } from '$lib/core/cam/simulation.js';
import { sheetView } from '$lib/core/design/machine.js';
import type { DesignState } from '$lib/core/design/types.js';
import { outlineBounds } from '$lib/core/geometry/contour.js';
import { designSvg } from '$lib/core/export/svg.js';
import { serializeDesign } from '$lib/core/export/design-file.js';
import { parseDesign } from '$lib/features/document.js';
import { placeSupport } from '$lib/features/packaging/placement.js';
import { packagingData, packagingSheetView } from '$lib/features/packaging/view.js';
import {
	addEntity,
	releaseFlatPartsSheet,
	removeEntity,
	flatPartsActions,
	updateEntities
} from '$lib/features/flat-parts/actions.js';
import { createFlatPartsEntity } from '$lib/features/flat-parts/defaults.js';
import { entityOutline, flatPartsGeometry } from '$lib/features/flat-parts/geometry.js';
import {
	moveEntityBox,
	MIN_FLAT_PARTS_DRAG,
	resizeEntityBox
} from '$lib/features/flat-parts/manipulation.js';
import { createEntityFromPreset } from '$lib/features/flat-parts/presets.js';
import type { FlatPartsEntity } from '$lib/features/flat-parts/types.js';
import { validateFlatParts } from '$lib/features/flat-parts/validation.js';
import { flatPartsSheetView } from '$lib/features/flat-parts/view.js';
import { FLAT_PARTS_WORKSPACE, validateDocument } from '$lib/features/workspaces.js';
import { flatPartsDesign, supportDesign, withMachine } from '../../support/designs.js';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

/** Same contract as `golden.spec.ts`: regenerate only with UPDATE_GOLDEN=1, after review. */
function golden(name: string, actual: string): void {
	const path = fixture(name);
	if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, actual);
	}
	expect(actual).toBe(readFileSync(path, 'utf8'));
}

const entity = (design: DesignState, id: string) =>
	flatPartsSheetView(design).entities.find((candidate) => candidate.id === id)!;

/** The design with one entity changed, for validation cases. */
const withEntity = (design: DesignState, id: string, values: Partial<FlatPartsEntity>) =>
	updateEntities(design, [{ id, values }]);

describe('flat parts geometry', () => {
	it('cuts holes inside their line first, and parts outside theirs after', () => {
		const { paths } = flatPartsGeometry(flatPartsDesign('router'));
		const holes = paths.filter((path) => path.owner?.kind === 'hole');
		const parts = paths.filter((path) => path.owner?.kind === 'profile');
		expect(holes).toHaveLength(2);
		expect(
			holes.every((path) => path.cam.offsetSide === 'inside' && path.cam.stage === 'interior')
		).toBe(true);
		expect(
			parts.every((path) => path.cam.offsetSide === 'outside' && path.cam.stage === 'part-release')
		).toBe(true);
	});

	it('keeps a routed part and hole at their drawn size by compensating away from the material', () => {
		const design = flatPartsDesign('router');
		const view = sheetView(design);
		const { paths } = flatPartsGeometry(design);
		const bore = paths.find((path) => path.owner?.id === 'bore')!;
		const bracket = paths.find((path) => path.owner?.id === 'bracket')!;
		const radius = view.bitWidth / 2;
		const boreCut = outlineBounds(toolpathPoints(bore, view));
		const bracketCut = outlineBounds(toolpathPoints(bracket, view));
		expect(boreCut.right - boreCut.left).toBeCloseTo(40 - 2 * radius, 1);
		expect(bracketCut.left).toBeCloseTo(50 - radius, 2);
		expect(bracketCut.right).toBeCloseTo(250 + radius, 2);
	});

	it('releases a routed part in one closed cut that carries its bridge tabs', () => {
		const { paths, tabs } = flatPartsGeometry(flatPartsDesign('router'));
		const bracket = paths.filter((path) => path.owner?.id === 'bracket');
		expect(bracket).toHaveLength(1);
		expect(paths.every((path) => path.closed)).toBe(true);
		expect(bracket[0]!.holdingTabs).toHaveLength(4);
		// The canvas draws the same tabs a knife would leave as gaps.
		expect(tabs).toEqual(flatPartsGeometry(flatPartsDesign('knife')).tabs);
		const none = withEntity(flatPartsDesign('router'), 'bracket', { tabCount: 0 });
		const untabbed = flatPartsGeometry(none).paths.find((path) => path.owner?.id === 'bracket')!;
		expect(untabbed.holdingTabs).toBeUndefined();
		expect(paths.filter((path) => path.owner?.kind === 'hole').every((p) => !p.holdingTabs)).toBe(
			true
		);
	});

	it('leaves holding tabs in a knife-cut part, chained around it', () => {
		const { paths, tabs } = flatPartsGeometry(flatPartsDesign('knife'));
		const runs = paths.filter((path) => path.owner?.id === 'bracket');
		expect(runs).toHaveLength(4);
		expect(tabs).toHaveLength(4 + 3);
		expect(
			runs.every((path) => !path.closed && path.cam.chainKey === 'flat-parts-profile:bracket')
		).toBe(true);
		const none = withEntity(flatPartsDesign('knife'), 'bracket', { tabCount: 0 });
		expect(
			flatPartsGeometry(none).paths.filter((path) => path.owner?.id === 'bracket')
		).toHaveLength(1);
	});

	it('draws a slot with fully rounded ends', () => {
		const slot = entityOutline(entity(flatPartsDesign(), 'adjust'));
		const bounds = outlineBounds(slot);
		expect(bounds).toEqual({ left: 150, right: 220, bottom: 100, top: 120 });
		// The end caps are half-circles of half the slot's height.
		expect(slot.some((p) => Math.abs(p.x - 150) < 1e-9 && Math.abs(p.y - 110) < 1e-9)).toBe(true);
	});

	it('is only drawn on its own sheet', () => {
		expect(flatPartsGeometry(flatPartsDesign(), 'deck').paths).toEqual([]);
	});
});

describe('flat parts golden output', () => {
	for (const mode of ['router', 'knife'] as const) {
		it(`emits a stable ${mode} program and SVG`, () => {
			const design = flatPartsDesign(mode);
			expect(validateDocument(design)).toEqual([]);
			const geometry = FLAT_PARTS_WORKSPACE.geometry(design);
			golden(
				`expected-gcode/flat-parts-${mode}.nc`,
				generateGcode(
					geometry.paths,
					sheetView(design),
					'cut',
					FLAT_PARTS_WORKSPACE.gcodeOptions(design, 'sheet')
				)
			);
			golden(
				`designs/flat-parts-${mode}.svg`,
				designSvg(geometry, FLAT_PARTS_WORKSPACE.labels(design, 'sheet'))
			);
		});
	}

	it('rises over each routed bridge tab while still cutting, and never below the cut', () => {
		const design = flatPartsDesign('router');
		const view = sheetView(design);
		const program = (d: DesignState) =>
			generateGcode(FLAT_PARTS_WORKSPACE.geometry(d).paths, sheetView(d), 'cut');
		const moves = simulationMoves(program(design), view);
		// Bracket 4 + nut plate 3. A tab on a hexagon corner turns it in two moves.
		const rises = moves.filter((move) => move.a.z === -view.cutDepth && move.b.z === -2);
		expect(rises).toHaveLength(7);
		const bridges = moves.filter((move) => move.b.z === -2 && move.a.z === -2);
		expect(bridges.every((move) => move.type === 'cut')).toBe(true);
		const raised = bridges.reduce(
			(sum, move) => sum + Math.hypot(move.b.x - move.a.x, move.b.y - move.a.y),
			0
		);
		// Each bridge spans the tab width plus the bit width along the bit centre.
		expect(raised).toBeCloseTo(7 * (5 + 6.35), 1);
		expect(Math.min(...moves.map((move) => move.b.z))).toBe(-view.cutDepth);
		expect(moves.every((move) => move.a.z === move.b.z || move.a.x === move.b.x)).toBe(true);

		const knife = program(flatPartsDesign('knife'));
		expect(knife).not.toContain('Holding tabs:');
		expect(knife).not.toContain('holding tab');
	});

	it('warns in the program about a routed part left without tabs', () => {
		const untabbed = withEntity(flatPartsDesign('router'), 'nut', { tabCount: 0 });
		expect(FLAT_PARTS_WORKSPACE.gcodeOptions(untabbed, 'sheet').headerNotes).toEqual([
			'; No holding tabs on: Nut plate; secure these parts before the release cut'
		]);
		expect(
			FLAT_PARTS_WORKSPACE.gcodeOptions(flatPartsDesign('router'), 'sheet').headerNotes ?? []
		).toEqual([]);
		const knife = withEntity(flatPartsDesign('knife'), 'nut', { tabCount: 0 });
		expect(FLAT_PARTS_WORKSPACE.gcodeOptions(knife, 'sheet').headerNotes ?? []).toEqual([]);
	});

	it('machines every hole before the part around it', () => {
		const design = flatPartsDesign('router');
		const program = generateGcode(
			FLAT_PARTS_WORKSPACE.geometry(design).paths,
			sheetView(design),
			'cut'
		);
		const lastHole = Math.max(program.indexOf('(Bore)'), program.indexOf('(Adjust slot)'));
		expect(lastHole).toBeGreaterThan(0);
		expect(program.indexOf('(Bracket)')).toBeGreaterThan(lastHole);
	});
});

describe('flat parts validation', () => {
	it('accepts the fixture on both machines', () => {
		expect(validateFlatParts(flatPartsDesign('router'))).toEqual([]);
		expect(validateFlatParts(flatPartsDesign('knife'))).toEqual([]);
	});

	it('rejects a part off the sheet, counting a router bit outside the line', () => {
		expect(validateFlatParts(withEntity(flatPartsDesign(), 'nut', { x: SHEET - 90 }))).toContain(
			'Nut plate: does not fit the sheet'
		);
		const flush = withEntity(flatPartsDesign('router'), 'nut', { x: SHEET - 100 });
		expect(validateFlatParts(flush)).toContain('Nut plate: does not fit the sheet');
		expect(
			validateFlatParts(withEntity(flatPartsDesign('knife'), 'nut', { x: SHEET - 100 }))
		).toEqual([]);
	});

	it('rejects a hole outside any part, or too close to its edge', () => {
		expect(validateFlatParts(withEntity(flatPartsDesign(), 'bore', { x: 500, y: 500 }))).toContain(
			'Bore: is not inside a part'
		);
		const thin = withEntity(flatPartsDesign(), 'bore', { x: 53, y: 90 });
		expect(validateFlatParts(thin)).toContain(
			'Bore: leaves less than the minimum web to the edge of Bracket'
		);
	});

	it('rejects holes that crowd or overlap each other', () => {
		const touching = withEntity(flatPartsDesign(), 'adjust', { x: 118, y: 100 });
		expect(validateFlatParts(touching)).toContain(
			'Bore and Adjust slot: leave less than the minimum web between them'
		);
	});

	it('rejects parts closer than the web, which a router bit also eats into', () => {
		const design = flatPartsDesign('router');
		const gap = design.stock.minimumWeb + 1;
		const near = withEntity(design, 'nut', { x: 250 + gap });
		expect(validateFlatParts(withMachine(near, { fabricationMode: 'knife' }))).toEqual([]);
		expect(validateFlatParts(near)).toContain(
			`Bracket and Nut plate: leave less than the ${design.stock.minimumWeb} mm minimum web between them`
		);
	});

	it('rejects router bridge tabs that cannot be cut', () => {
		const design = flatPartsDesign('router');
		const stock = (values: Partial<typeof design.stock>) => ({
			...design,
			stock: { ...design.stock, ...values }
		});
		expect(validateFlatParts(stock({ tabHeight: design.stock.material }))).toContain(
			'Bracket: holding tabs must be thinner than the board'
		);
		expect(validateFlatParts(stock({ tabHeight: 0 }))).toContain(
			'Bracket: holding tabs must be thinner than the board'
		);
		expect(validateFlatParts(withMachine(stock({ tabHeight: 1 }), { cutDepth: 1.5 }))).toContain(
			'Bracket: the cut depth stops above the holding tabs'
		);
		expect(validateFlatParts(stock({ tabWidth: 0 }))).toContain(
			'Bracket: holding tabs need a tab width'
		);
		// 80 tabs of 5 mm fit around the bracket's ~623 mm outline on a knife, but not
		// once each bridge also spans a 6.35 mm bit.
		const crowded = withEntity(design, 'bracket', { tabCount: 80 });
		expect(validateFlatParts(withMachine(crowded, { fabricationMode: 'knife' }))).toEqual([]);
		expect(validateFlatParts(crowded)).toContain(
			'Bracket: holding tabs leave no room to cut between them'
		);
	});

	it('rejects an entity too small to cut', () => {
		expect(validateFlatParts(withEntity(flatPartsDesign(), 'bore', { w: 0.5 }))).toContain(
			'Bore: is too small to cut'
		);
	});

	it('is part of the document check that gates export', () => {
		const broken = withEntity(flatPartsDesign(), 'bore', { x: 500, y: 500 });
		expect(validateDocument(broken)).toContain('Bore: is not inside a part');
	});
});

describe('the flat parts document', () => {
	it('round-trips through a design file', () => {
		const design = flatPartsDesign();
		expect(parseDesign(serializeDesign(design))).toEqual(design);
	});

	it('gives every Flat Parts sheet an entry and drops data for any other sheet', () => {
		const design = flatPartsDesign();
		const raw = JSON.parse(serializeDesign(design));
		raw.design.workspaces.flatParts.sheets.deck = { entities: [] };
		raw.design.workspaces.flatParts.sheets.gone = { entities: [] };
		raw.design.sheets.push({
			id: 'blank',
			name: 'Blank',
			workspace: 'flatParts',
			machineProfileId: 'default'
		});
		const read = parseDesign(JSON.stringify(raw));
		expect(Object.keys(read.workspaces.flatParts!.sheets).sort()).toEqual(['blank', 'sheet']);
	});

	it('drops an entity it cannot read, or one reusing an id', () => {
		const raw = JSON.parse(serializeDesign(flatPartsDesign()));
		const entities = raw.design.workspaces.flatParts.sheets.sheet.entities;
		entities.push({ id: 'x', kind: 'engraving' }, { ...entities[0], name: 'Copy' }, null);
		const read = parseDesign(JSON.stringify(raw));
		expect(flatPartsSheetView(read).entities.map((item) => item.id)).toEqual([
			'bracket',
			'bore',
			'adjust',
			'nut'
		]);
	});

	it('keeps a tray net off a Flat Parts sheet', () => {
		const base = supportDesign();
		const design = {
			...base,
			sheets: [...flatPartsDesign().sheets.filter((s) => s.id === 'sheet'), ...base.sheets],
			activeSheetId: 'sheet'
		};
		const tray = packagingData(design).supports[0]!;
		const placement = placeSupport(
			{ ...tray, id: 'tray-2' },
			packagingSheetView(design),
			() => 'new'
		);
		expect(placement.sheetId).not.toBe('sheet');
	});
});

describe('flat parts actions', () => {
	const extra = createFlatPartsEntity({
		id: 'e',
		name: 'E',
		kind: 'hole',
		shape: 'ellipse',
		x: 60,
		y: 60,
		w: 10,
		h: 10
	});

	it('add, update, and remove an entity on its sheet', () => {
		const added = addEntity(flatPartsDesign(), 'sheet', extra);
		expect(entity(added, 'e')).toEqual(extra);
		expect(
			entity(updateEntities(added, [{ id: 'e', values: { w: 12, kind: 'profile' } }]), 'e')
		).toMatchObject({ w: 12, kind: 'hole' });
		expect(entity(removeEntity(added, 'e'), 'e')).toBeUndefined();
	});

	it('remove a sheet’s parts with the sheet', () => {
		expect(releaseFlatPartsSheet(flatPartsDesign(), 'sheet').workspaces.flatParts!.sheets).toEqual(
			{}
		);
	});

	it('select what they add, as one undo step', () => {
		let design = flatPartsDesign();
		let steps = 0;
		const host = {
			get design() {
				return design;
			},
			selection: null as { kind: string; id: string } | null,
			update(change: (d: DesignState) => DesignState) {
				design = change(design);
				steps += 1;
			},
			preview(change: (d: DesignState) => DesignState) {
				design = change(design);
			},
			select(selection: { kind: string; id: string } | null) {
				host.selection = selection;
			}
		};
		const actions = flatPartsActions(host);
		actions.addEntity(extra);
		expect(steps).toBe(1);
		expect(actions.selectedEntity?.id).toBe('e');
	});

	it('name a drawn entity by what it is', () => {
		const rect = { x: 1, y: 2, w: 30, h: 40 };
		expect(createEntityFromPreset('profile', 'polygon', rect, 'a', 3)).toMatchObject({
			name: 'Part 3',
			tabCount: 4
		});
		expect(createEntityFromPreset('hole', 'slot', rect, 'b', 1)).toMatchObject({
			name: 'Slot 1',
			tabCount: 0
		});
	});
});

describe('flat parts manipulation', () => {
	const box = { x: 100, y: 100, w: 50, h: 40 };

	it('moves a box by the pointer’s travel, kept on the sheet', () => {
		expect(moveEntityBox(box, { x: 0, y: 0 }, { x: 10, y: -5 }, false)).toEqual({
			...box,
			x: 110,
			y: 95
		});
		expect(moveEntityBox(box, { x: 0, y: 0 }, { x: -500, y: 5000 }, false)).toEqual({
			...box,
			x: 0,
			y: round(SHEET - 40)
		});
	});

	it('resizes from a corner, holding the opposite one, never below the minimum', () => {
		expect(resizeEntityBox(box, 'ne', { x: 170, y: 160 }, false)).toEqual({
			x: 100,
			y: 100,
			w: 70,
			h: 60
		});
		expect(resizeEntityBox(box, 'sw', { x: 90, y: 90 }, false)).toEqual({
			x: 90,
			y: 90,
			w: 60,
			h: 50
		});
		expect(resizeEntityBox(box, 'sw', { x: 400, y: 400 }, false)).toMatchObject({
			w: MIN_FLAT_PARTS_DRAG,
			h: MIN_FLAT_PARTS_DRAG
		});
	});
});

describe('the flat parts registry entry', () => {
	it('protects no sheet, names new sheets, and frames an entity only on its sheet', () => {
		const design = flatPartsDesign();
		expect(FLAT_PARTS_WORKSPACE.protectsSheet(design, 'sheet')).toBe(false);
		expect(FLAT_PARTS_WORKSPACE.newSheetName(design)).toBe('Sheet 2');
		expect(FLAT_PARTS_WORKSPACE.selectionExists(design, { kind: 'hole', id: 'bore' })).toBe(true);
		expect(FLAT_PARTS_WORKSPACE.selectionExists(design, { kind: 'profile', id: 'bore' })).toBe(
			false
		);
		expect(
			FLAT_PARTS_WORKSPACE.selectionBounds(design, { kind: 'hole', id: 'bore' }, 'sheet')
		).toEqual({
			left: 80,
			right: 120,
			bottom: 90,
			top: 130
		});
		expect(
			FLAT_PARTS_WORKSPACE.selectionBounds(design, { kind: 'hole', id: 'bore' }, 'deck')
		).toBeNull();
		expect(FLAT_PARTS_WORKSPACE.labels(design, 'sheet').map((label) => label.name)).toEqual([
			'Bracket',
			'Nut plate'
		]);
	});
});
