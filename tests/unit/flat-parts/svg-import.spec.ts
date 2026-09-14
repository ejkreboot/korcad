import { describe, expect, it } from 'vitest';
import { generateGcode } from '$lib/core/cam/gcode.js';
import { sheetView } from '$lib/core/design/machine.js';
import type { DesignState } from '$lib/core/design/types.js';
import { serializeDesign } from '$lib/core/export/design-file.js';
import { outlineBounds } from '$lib/core/geometry/contour.js';
import { parseDesign } from '$lib/features/document.js';
import {
	addEntity,
	groupBox,
	moveGroup,
	removeGroup,
	rotateGroup,
	scaleEntity,
	scaleGroup,
	setGroupTabs,
	updateEntity
} from '$lib/features/flat-parts/actions.js';
import { createFlatPartsEntity } from '$lib/features/flat-parts/defaults.js';
import { entityOutline, flatPartsGeometry } from '$lib/features/flat-parts/geometry.js';
import { importSvg } from '$lib/features/flat-parts/import.js';
import type { FlatPartsEntity } from '$lib/features/flat-parts/types.js';
import { validateFlatParts } from '$lib/features/flat-parts/validation.js';
import { flatPartsSheetView, withFlatPartsSheet } from '$lib/features/flat-parts/view.js';
import { FLAT_PARTS_WORKSPACE } from '$lib/features/workspaces.js';
import { flatPartsDesign } from '../../support/designs.js';

const empty = (mode: 'router' | 'knife' = 'router'): DesignState =>
	withFlatPartsSheet(flatPartsDesign(mode), 'sheet', () => ({ entities: [], groups: [] }));

const svg = (body: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="300mm" viewBox="0 0 300 300">${body}</svg>`;

/** A 200 x 100 mm plate with a round hole and a square window, drawn clockwise in SVG. */
const PLATE = svg(`
	<path d="M0 0 H200 V100 H0 Z"/>
	<circle cx="50" cy="50" r="20"/>
	<rect x="120" y="30" width="40" height="40"/>
`);

const entities = (design: DesignState) => flatPartsSheetView(design, 'sheet').entities;

describe('importing an SVG into Flat Parts', () => {
	it('makes a tabbed part with holes that validates and cuts holes first', () => {
		const result = importSvg(empty(), 'sheet', PLATE, 'plate.svg');
		const imported = entities(result.design);
		expect(imported.map((entity) => [entity.name, entity.kind, entity.tabCount])).toEqual([
			['Part 1', 'profile', 4],
			['Hole 1', 'hole', 0],
			['Hole 2', 'hole', 0]
		]);
		expect(imported.every((entity) => entity.shape === 'path')).toBe(true);
		expect(result.selection).toEqual({ kind: 'profile', id: imported[0]!.id });
		expect(result.notice).toBe('Imported 1 part and 2 holes from plate.svg (200 × 100 mm).');
		expect(validateFlatParts(result.design)).toEqual([]);

		const part = imported[0]!;
		expect(part).toMatchObject({ x: 12.7, y: 12.7, w: 200, h: 100 });
		const outline = entityOutline(part);
		const area = outline.reduce((sum, p, index) => {
			const q = outline[(index + 1) % outline.length]!;
			return sum + p.x * q.y - q.x * p.y;
		}, 0);
		expect(area).toBeGreaterThan(0);

		const { paths } = flatPartsGeometry(result.design, 'sheet');
		expect(paths.map((path) => path.cam.stage)).toEqual(['interior', 'interior', 'part-release']);
		expect(paths[2]!.holdingTabs).toHaveLength(4);
		const program = generateGcode(
			paths,
			sheetView(result.design, 'sheet'),
			'cut',
			FLAT_PARTS_WORKSPACE.gcodeOptions(result.design, 'sheet')
		);
		expect(program.indexOf('(Part 1)')).toBeGreaterThan(program.indexOf('(Hole 2)'));
	});

	it('numbers after what the sheet already has', () => {
		const result = importSvg(flatPartsDesign(), 'sheet', svg('<rect width="20" height="20"/>'));
		expect(entities(result.design).at(-1)!.name).toBe('Part 3');
	});

	it('moves and stretches an imported outline with its box', () => {
		const { design } = importSvg(empty(), 'sheet', PLATE);
		const hole = entities(design).find((entity) => entity.name === 'Hole 2')!;
		const before = outlineBounds(entityOutline(hole));
		const moved = updateEntity(design, hole.id, { x: hole.x + 10, w: hole.w * 2 });
		const after = outlineBounds(
			entityOutline(entities(moved).find((entity) => entity.id === hole.id)!)
		);
		expect(after.left).toBeCloseTo(before.left + 10);
		expect(after.right - after.left).toBeCloseTo((before.right - before.left) * 2);
	});

	it('scales an imported plate as one piece', () => {
		const { design } = importSvg(empty(), 'sheet', PLATE);
		const part = entities(design)[0]!;
		const holeSpan = (d: DesignState) =>
			entities(d)
				.filter((entity) => entity.kind === 'hole')
				.map((entity) => outlineBounds(entityOutline(entity)));
		const scaled = scaleEntity(design, part.id, 0.5);
		expect(validateFlatParts(scaled)).toEqual([]);
		const [before, after] = [holeSpan(design), holeSpan(scaled)];
		after.forEach((box, index) => {
			expect(box.left - part.x).toBeCloseTo((before[index]!.left - part.x) * 0.5, 2);
			expect(box.right - box.left).toBeCloseTo(
				(before[index]!.right - before[index]!.left) * 0.5,
				2
			);
		});
	});

	it('says what it skipped, dropping duplicates and specks', () => {
		const result = importSvg(
			empty(),
			'sheet',
			svg(`
				<rect width="50" height="50"/>
				<rect width="50" height="50" fill="none" stroke="red"/>
				<rect x="100" width="0.5" height="0.5"/>
				<line x1="0" y1="0" x2="10" y2="10"/>
				<text>hi</text>
			`),
			'mixed.svg'
		);
		expect(entities(result.design)).toHaveLength(1);
		expect(result.notice).toBe(
			'Imported 1 part and 0 holes from mixed.svg (50 × 50 mm). Skipped 1 open path, 1 outline under 1 mm, 1 duplicate outline, text elements.'
		);
	});

	it('refuses a drawing with nothing closed to cut', () => {
		expect(() =>
			importSvg(empty(), 'sheet', svg('<line x1="0" y1="0" x2="10" y2="10"/>'), 'lines.svg')
		).toThrow(
			'No closed outlines to cut in lines.svg: parts and holes need closed outlines. Skipped 1 open path.'
		);
	});

	it('gives a small part only the tabs its perimeter can hold', () => {
		// Router span is 5 mm tab + 6.35 mm bit; a 20 mm square has 80 mm of perimeter.
		const { design } = importSvg(empty(), 'sheet', svg('<rect width="20" height="20"/>'));
		expect(entities(design)[0]!.tabCount).toBe(3);
		const knife = importSvg(empty('knife'), 'sheet', svg('<rect width="20" height="20"/>'));
		expect(entities(knife.design)[0]!.tabCount).toBe(4);
	});

	it('leaves a part nested in a hole for validation to reject', () => {
		const { design } = importSvg(
			empty(),
			'sheet',
			svg(
				'<rect width="200" height="200"/><rect x="20" y="20" width="160" height="160"/><rect x="60" y="60" width="80" height="80"/>'
			),
			'nest.svg'
		);
		expect(entities(design).map((entity) => entity.kind)).toEqual(['profile', 'hole', 'profile']);
		expect(validateFlatParts(design)).toContain(
			'nest part 2: is inside nest part 1; a part nested inside another cannot be cut yet'
		);
	});

	it('round-trips imported outlines through a design file', () => {
		const { design } = importSvg(empty(), 'sheet', PLATE);
		expect(parseDesign(serializeDesign(design))).toEqual(design);

		const raw = JSON.parse(serializeDesign(design));
		raw.design.workspaces.flatParts.sheets.sheet.entities[0].outline = [{ x: 0, y: 0 }];
		expect(entities(parseDesign(JSON.stringify(raw)))).toHaveLength(2);
	});
});

/** Three letters side by side, the middle one with a counter, spaced for a router: a logo, in effect. */
const LOGO = svg(`
	<rect x="0" y="0" width="30" height="50"/>
	<rect x="50" y="0" width="30" height="50"/>
	<rect x="57" y="10" width="16" height="20"/>
	<rect x="100" y="0" width="30" height="50"/>
`);

describe('importing a drawing of several parts as a group', () => {
	const imported = () => importSvg(empty(), 'sheet', LOGO, 'acme.svg');

	it('keeps the letters together, named after the file', () => {
		const result = imported();
		const view = flatPartsSheetView(result.design, 'sheet');
		expect(view.groups).toEqual([{ id: expect.any(String), name: 'acme' }]);
		const id = view.groups[0]!.id;
		expect(view.entities.map((entity) => [entity.name, entity.groupId])).toEqual([
			['acme part 1', id],
			['acme part 2', id],
			['acme hole 1', id],
			['acme part 3', id]
		]);
		expect(result.selection).toEqual({ kind: 'group', id });
		expect(result.notice).toBe(
			'Imported 3 parts and 1 hole from acme.svg (130 × 50 mm) as the group acme.'
		);
		expect(validateFlatParts(result.design)).toEqual([]);
		expect(FLAT_PARTS_WORKSPACE.labels(result.design, 'sheet').map((label) => label.name)).toEqual([
			'acme'
		]);
		expect(FLAT_PARTS_WORKSPACE.selectionExists(result.design, result.selection!)).toBe(true);
		expect(FLAT_PARTS_WORKSPACE.selectionBounds(result.design, result.selection!, 'sheet')).toEqual(
			{ left: 12.7, right: 142.7, bottom: 12.7, top: 62.7 }
		);
	});

	it('leaves a single part with holes ungrouped', () => {
		const { design } = importSvg(empty(), 'sheet', PLATE, 'plate.svg');
		expect(flatPartsSheetView(design, 'sheet').groups).toEqual([]);
		expect(entities(design).every((entity) => entity.groupId === null)).toBe(true);
	});

	it('moves and scales every member together, and scaling back restores them', () => {
		const { design, selection } = imported();
		const id = selection!.id;
		const before = entities(design);

		const moved = entities(moveGroup(design, id, 50, 60));
		moved.forEach((entity, index) => {
			expect(entity.x).toBeCloseTo(before[index]!.x + 50 - 12.7, 3);
			expect(entity.y).toBeCloseTo(before[index]!.y + 60 - 12.7, 3);
		});

		const doubled = scaleGroup(design, id, 2);
		expect(groupBox(doubled, id)).toEqual({ x: 12.7, y: 12.7, w: 260, h: 100 });
		expect(validateFlatParts(doubled)).toEqual([]);
		expect(entities(scaleGroup(doubled, id, 0.5))).toEqual(before);
		expect(scaleGroup(design, id, 0)).toBe(design);
	});

	it('carries a hole drawn later through one of its parts, and deletes it with the group', () => {
		const { design, selection } = imported();
		const id = selection!.id;
		const drilled = addEntity(
			design,
			'sheet',
			createFlatPartsEntity({
				id: 'drill',
				name: 'Drill',
				kind: 'hole',
				shape: 'ellipse',
				x: 20,
				y: 40,
				w: 10,
				h: 10
			})
		);
		const scaled = scaleGroup(drilled, id, 2);
		expect(entities(scaled).find((entity) => entity.id === 'drill')).toMatchObject({
			x: 27.3,
			y: 67.3,
			w: 20,
			h: 20,
			groupId: null
		});
		const gone = removeGroup(drilled, id);
		expect(entities(gone)).toEqual([]);
		expect(flatPartsSheetView(gone, 'sheet').groups).toEqual([]);
		expect(FLAT_PARTS_WORKSPACE.selectionExists(gone, selection!)).toBe(false);
	});

	it('rotates every member about the centre of the group, and turns back to where it began', () => {
		const { design, selection } = imported();
		const id = selection!.id;
		const before = entities(design);
		const outlines = (d: DesignState) => entities(d).map((entity) => entityOutline(entity));

		const turned = rotateGroup(design, id, 90);
		// 130 x 50 about its centre (77.7, 37.7) becomes 50 x 130.
		expect(groupBox(turned, id)).toEqual({ x: 52.7, y: -27.3, w: 50, h: 130 });
		// The first letter, at the left, is now at the bottom.
		const first = outlineBounds(entityOutline(entities(turned)[0]!));
		[52.7, -27.3, 102.7, 2.7].forEach((edge, index) =>
			expect([first.left, first.bottom, first.right, first.top][index]).toBeCloseTo(edge, 6)
		);
		expect(entities(turned).map((entity) => [entity.kind, entity.groupId, entity.shape])).toEqual(
			before.map((entity) => [entity.kind, id, 'path'])
		);

		const placed = moveGroup(turned, id, 12.7, 12.7);
		expect(validateFlatParts(placed)).toEqual([]);

		const around = [90, 90, 90].reduce((next, degrees) => rotateGroup(next, id, degrees), turned);
		expect(groupBox(around, id)).toEqual(groupBox(design, id));
		outlines(around).forEach((outline, index) =>
			outline.forEach((vertex, at) => {
				expect(vertex.x).toBeCloseTo(outlines(design)[index]![at]!.x, 6);
				expect(vertex.y).toBeCloseTo(outlines(design)[index]![at]!.y, 6);
			})
		);
		expect(rotateGroup(design, id, 360)).toBe(design);
		expect(rotateGroup(design, id, Number.NaN)).toBe(design);
	});

	it('turns by any angle, keeping each outline wound counter-clockwise', () => {
		const { design, selection } = imported();
		const id = selection!.id;
		const turned = rotateGroup(design, id, 30);
		const box = groupBox(design, id)!;
		const after = groupBox(turned, id)!;
		expect(after.x + after.w / 2).toBeCloseTo(box.x + box.w / 2, 2);
		expect(after.y + after.h / 2).toBeCloseTo(box.y + box.h / 2, 2);
		// A 130 x 50 box turned 30 degrees spans 130 cos 30 + 50 sin 30 across.
		expect(after.w).toBeCloseTo(130 * Math.cos(Math.PI / 6) + 50 * 0.5, 2);
		for (const entity of entities(turned)) {
			const outline = entityOutline(entity);
			const area = outline.reduce((sum, p, index) => {
				const q = outline[(index + 1) % outline.length]!;
				return sum + p.x * q.y - q.x * p.y;
			}, 0);
			expect(area).toBeGreaterThan(0);
		}
		const moved = moveGroup(turned, id, 20, 20);
		expect(validateFlatParts(moved)).toEqual([]);
		expect(flatPartsGeometry(moved, 'sheet').paths).toHaveLength(4);
	});

	it('turns a hole drawn through a part, keeping its shape while a box can hold it', () => {
		const { design, selection } = imported();
		const id = selection!.id;
		const hole = (values: Partial<FlatPartsEntity> & Pick<FlatPartsEntity, 'id' | 'shape'>) =>
			createFlatPartsEntity({
				name: values.id,
				kind: 'hole',
				x: 20,
				y: 40,
				w: 10,
				h: 10,
				...values
			});
		const drilled = [
			hole({ id: 'drill', shape: 'ellipse', y: 45 }),
			hole({ id: 'slot', shape: 'slot', x: 23, y: 24, w: 4, h: 12 }),
			hole({ id: 'hex', shape: 'polygon', x: 120, y: 30, sides: 6 })
		].reduce((next, entity) => addEntity(next, 'sheet', entity), design);
		const find = (d: DesignState, key: string) => entities(d).find((entity) => entity.id === key)!;

		const quarter = rotateGroup(drilled, id, 90);
		// The drill's centre (25, 50) turns about (77.7, 37.7) to (65.4, -15).
		expect(find(quarter, 'drill')).toMatchObject({
			shape: 'ellipse',
			x: 60.4,
			y: -20,
			w: 10,
			h: 10
		});
		expect(find(quarter, 'slot')).toMatchObject({ shape: 'slot', w: 12, h: 4 });
		expect(find(quarter, 'hex').shape).toBe('path');

		const slanted = rotateGroup(drilled, id, 30);
		expect(find(slanted, 'drill').shape).toBe('ellipse');
		expect(find(slanted, 'slot').shape).toBe('path');
		expect(validateFlatParts(moveGroup(slanted, id, 20, 20))).toEqual([]);
	});

	it('gives every part the same tabs, and never moves an entity out of its group', () => {
		const { design, selection } = imported();
		const id = selection!.id;
		const tabbed = setGroupTabs(design, id, 2);
		expect(
			entities(tabbed).map((entity) => (entity.kind === 'profile' ? entity.tabCount : null))
		).toEqual([2, 2, null, 2]);
		const member = entities(design)[0]!;
		expect(entities(updateEntity(design, member.id, { groupId: null }))[0]!.groupId).toBe(id);
	});

	it('reads groups back, dropping one with no members and a dangling reference', () => {
		const { design } = imported();
		expect(parseDesign(serializeDesign(design))).toEqual(design);
		const raw = JSON.parse(serializeDesign(design));
		const sheet = raw.design.workspaces.flatParts.sheets.sheet;
		sheet.groups.push({ id: 'empty', name: 'Empty' });
		sheet.entities[0].groupId = 'missing';
		const read = flatPartsSheetView(parseDesign(JSON.stringify(raw)), 'sheet');
		expect(read.groups.map((group) => group.name)).toEqual(['acme']);
		expect(read.entities.map((entity) => entity.groupId === null)).toEqual([
			true,
			false,
			false,
			false
		]);
	});
});
