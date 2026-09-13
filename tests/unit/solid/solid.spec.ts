import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SHEET } from '$lib/core/constants.js';
import { round } from '$lib/core/units.js';
import { toolpathPoints } from '$lib/core/cam/compensation.js';
import { generateGcode } from '$lib/core/cam/gcode.js';
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
	releaseSolidSheet,
	removeEntity,
	solidActions,
	updateEntities
} from '$lib/features/solid/actions.js';
import { createSolidEntity } from '$lib/features/solid/defaults.js';
import { entityOutline, solidGeometry } from '$lib/features/solid/geometry.js';
import {
	moveEntityBox,
	MIN_SOLID_DRAG,
	resizeEntityBox
} from '$lib/features/solid/manipulation.js';
import { createEntityFromPreset } from '$lib/features/solid/presets.js';
import type { SolidEntity } from '$lib/features/solid/types.js';
import { validateSolid } from '$lib/features/solid/validation.js';
import { solidSheetView } from '$lib/features/solid/view.js';
import { SOLID_WORKSPACE, validateDocument } from '$lib/features/workspaces.js';
import { solidDesign, supportDesign, withMachine } from '../../support/designs.js';

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
	solidSheetView(design).entities.find((candidate) => candidate.id === id)!;

/** The design with one entity changed, for validation cases. */
const withEntity = (design: DesignState, id: string, values: Partial<SolidEntity>) =>
	updateEntities(design, [{ id, values }]);

describe('solid geometry', () => {
	it('cuts holes inside their line first, and parts outside theirs after', () => {
		const { paths } = solidGeometry(solidDesign('router'));
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
		const design = solidDesign('router');
		const view = sheetView(design);
		const { paths } = solidGeometry(design);
		const bore = paths.find((path) => path.owner?.id === 'bore')!;
		const bracket = paths.find((path) => path.owner?.id === 'bracket')!;
		const radius = view.bitWidth / 2;
		const boreCut = outlineBounds(toolpathPoints(bore, view));
		const bracketCut = outlineBounds(toolpathPoints(bracket, view));
		expect(boreCut.right - boreCut.left).toBeCloseTo(40 - 2 * radius, 1);
		expect(bracketCut.left).toBeCloseTo(50 - radius, 2);
		expect(bracketCut.right).toBeCloseTo(250 + radius, 2);
	});

	it('releases a routed part in one closed cut, with no tabs', () => {
		const { paths, tabs } = solidGeometry(solidDesign('router'));
		expect(tabs).toEqual([]);
		expect(paths.filter((path) => path.owner?.id === 'bracket')).toHaveLength(1);
		expect(paths.every((path) => path.closed)).toBe(true);
	});

	it('leaves holding tabs in a knife-cut part, chained around it', () => {
		const { paths, tabs } = solidGeometry(solidDesign('knife'));
		const runs = paths.filter((path) => path.owner?.id === 'bracket');
		expect(runs).toHaveLength(4);
		expect(tabs).toHaveLength(4 + 3);
		expect(
			runs.every((path) => !path.closed && path.cam.chainKey === 'solid-profile:bracket')
		).toBe(true);
		const none = withEntity(solidDesign('knife'), 'bracket', { tabCount: 0 });
		expect(solidGeometry(none).paths.filter((path) => path.owner?.id === 'bracket')).toHaveLength(
			1
		);
	});

	it('draws a slot with fully rounded ends', () => {
		const slot = entityOutline(entity(solidDesign(), 'adjust'));
		const bounds = outlineBounds(slot);
		expect(bounds).toEqual({ left: 150, right: 220, bottom: 100, top: 120 });
		// The end caps are half-circles of half the slot's height.
		expect(slot.some((p) => Math.abs(p.x - 150) < 1e-9 && Math.abs(p.y - 110) < 1e-9)).toBe(true);
	});

	it('is only drawn on its own sheet', () => {
		expect(solidGeometry(solidDesign(), 'deck').paths).toEqual([]);
	});
});

describe('solid golden output', () => {
	for (const mode of ['router', 'knife'] as const) {
		it(`emits a stable ${mode} program and SVG`, () => {
			const design = solidDesign(mode);
			expect(validateDocument(design)).toEqual([]);
			const geometry = SOLID_WORKSPACE.geometry(design);
			golden(
				`expected-gcode/solid-plate-${mode}.nc`,
				generateGcode(
					geometry.paths,
					sheetView(design),
					'cut',
					SOLID_WORKSPACE.gcodeOptions(design, 'plate')
				)
			);
			golden(
				`designs/solid-plate-${mode}.svg`,
				designSvg(geometry, SOLID_WORKSPACE.labels(design, 'plate'))
			);
		});
	}

	it('machines every hole before the part around it', () => {
		const design = solidDesign('router');
		const program = generateGcode(SOLID_WORKSPACE.geometry(design).paths, sheetView(design), 'cut');
		const lastHole = Math.max(program.indexOf('(Bore)'), program.indexOf('(Adjust slot)'));
		expect(lastHole).toBeGreaterThan(0);
		expect(program.indexOf('(Bracket)')).toBeGreaterThan(lastHole);
	});
});

describe('solid validation', () => {
	it('accepts the fixture on both machines', () => {
		expect(validateSolid(solidDesign('router'))).toEqual([]);
		expect(validateSolid(solidDesign('knife'))).toEqual([]);
	});

	it('rejects a part off the sheet, counting a router bit outside the line', () => {
		expect(validateSolid(withEntity(solidDesign(), 'nut', { x: SHEET - 90 }))).toContain(
			'Nut plate: does not fit the sheet'
		);
		const flush = withEntity(solidDesign('router'), 'nut', { x: SHEET - 100 });
		expect(validateSolid(flush)).toContain('Nut plate: does not fit the sheet');
		expect(validateSolid(withEntity(solidDesign('knife'), 'nut', { x: SHEET - 100 }))).toEqual([]);
	});

	it('rejects a hole outside any part, or too close to its edge', () => {
		expect(validateSolid(withEntity(solidDesign(), 'bore', { x: 500, y: 500 }))).toContain(
			'Bore: is not inside a part'
		);
		const thin = withEntity(solidDesign(), 'bore', { x: 53, y: 90 });
		expect(validateSolid(thin)).toContain(
			'Bore: leaves less than the minimum web to the edge of Bracket'
		);
	});

	it('rejects holes that crowd or overlap each other', () => {
		const touching = withEntity(solidDesign(), 'adjust', { x: 118, y: 100 });
		expect(validateSolid(touching)).toContain(
			'Bore and Adjust slot: leave less than the minimum web between them'
		);
	});

	it('rejects parts closer than the web, which a router bit also eats into', () => {
		const design = solidDesign('router');
		const gap = design.stock.minimumWeb + 1;
		const near = withEntity(design, 'nut', { x: 250 + gap });
		expect(validateSolid(withMachine(near, { fabricationMode: 'knife' }))).toEqual([]);
		expect(validateSolid(near)).toContain(
			`Bracket and Nut plate: leave less than the ${design.stock.minimumWeb} mm minimum web between them`
		);
	});

	it('rejects an entity too small to cut', () => {
		expect(validateSolid(withEntity(solidDesign(), 'bore', { w: 0.5 }))).toContain(
			'Bore: is too small to cut'
		);
	});

	it('is part of the document check that gates export', () => {
		const broken = withEntity(solidDesign(), 'bore', { x: 500, y: 500 });
		expect(validateDocument(broken)).toContain('Bore: is not inside a part');
	});
});

describe('the solid document', () => {
	it('round-trips through a design file', () => {
		const design = solidDesign();
		expect(parseDesign(serializeDesign(design))).toEqual(design);
	});

	it('gives every Solid sheet an entry and drops data for any other sheet', () => {
		const design = solidDesign();
		const raw = JSON.parse(serializeDesign(design));
		raw.design.workspaces.solid.sheets.deck = { entities: [] };
		raw.design.workspaces.solid.sheets.gone = { entities: [] };
		raw.design.sheets.push({
			id: 'blank',
			name: 'Blank',
			workspace: 'solid',
			machineProfileId: 'default'
		});
		const read = parseDesign(JSON.stringify(raw));
		expect(Object.keys(read.workspaces.solid!.sheets).sort()).toEqual(['blank', 'plate']);
	});

	it('drops an entity it cannot read, or one reusing an id', () => {
		const raw = JSON.parse(serializeDesign(solidDesign()));
		const entities = raw.design.workspaces.solid.sheets.plate.entities;
		entities.push({ id: 'x', kind: 'engraving' }, { ...entities[0], name: 'Copy' }, null);
		const read = parseDesign(JSON.stringify(raw));
		expect(solidSheetView(read).entities.map((item) => item.id)).toEqual([
			'bracket',
			'bore',
			'adjust',
			'nut'
		]);
	});

	it('keeps a tray net off a Solid sheet', () => {
		const base = supportDesign();
		const design = {
			...base,
			sheets: [...solidDesign().sheets.filter((s) => s.id === 'plate'), ...base.sheets],
			activeSheetId: 'plate'
		};
		const tray = packagingData(design).supports[0]!;
		const placement = placeSupport(
			{ ...tray, id: 'tray-2' },
			packagingSheetView(design),
			() => 'new'
		);
		expect(placement.sheetId).not.toBe('plate');
	});
});

describe('solid actions', () => {
	const extra = createSolidEntity({
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
		const added = addEntity(solidDesign(), 'plate', extra);
		expect(entity(added, 'e')).toEqual(extra);
		expect(
			entity(updateEntities(added, [{ id: 'e', values: { w: 12, kind: 'profile' } }]), 'e')
		).toMatchObject({ w: 12, kind: 'hole' });
		expect(entity(removeEntity(added, 'e'), 'e')).toBeUndefined();
	});

	it('remove a sheet’s parts with the sheet', () => {
		expect(releaseSolidSheet(solidDesign(), 'plate').workspaces.solid!.sheets).toEqual({});
	});

	it('select what they add, as one undo step', () => {
		let design = solidDesign();
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
		const actions = solidActions(host);
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

describe('solid manipulation', () => {
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
			w: MIN_SOLID_DRAG,
			h: MIN_SOLID_DRAG
		});
	});
});

describe('the solid registry entry', () => {
	it('protects no sheet, names new plates, and frames an entity only on its sheet', () => {
		const design = solidDesign();
		expect(SOLID_WORKSPACE.protectsSheet(design, 'plate')).toBe(false);
		expect(SOLID_WORKSPACE.newSheetName(design)).toBe('Plate 2');
		expect(SOLID_WORKSPACE.selectionExists(design, { kind: 'hole', id: 'bore' })).toBe(true);
		expect(SOLID_WORKSPACE.selectionExists(design, { kind: 'profile', id: 'bore' })).toBe(false);
		expect(SOLID_WORKSPACE.selectionBounds(design, { kind: 'hole', id: 'bore' }, 'plate')).toEqual({
			left: 80,
			right: 120,
			bottom: 90,
			top: 130
		});
		expect(
			SOLID_WORKSPACE.selectionBounds(design, { kind: 'hole', id: 'bore' }, 'deck')
		).toBeNull();
		expect(SOLID_WORKSPACE.labels(design, 'plate').map((label) => label.name)).toEqual([
			'Bracket',
			'Nut plate'
		]);
	});
});
