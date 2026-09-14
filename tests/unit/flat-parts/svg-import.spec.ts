import { describe, expect, it } from 'vitest';
import { generateGcode } from '$lib/core/cam/gcode.js';
import { sheetView } from '$lib/core/design/machine.js';
import type { DesignState } from '$lib/core/design/types.js';
import { serializeDesign } from '$lib/core/export/design-file.js';
import { outlineBounds } from '$lib/core/geometry/contour.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import { parseDesign } from '$lib/features/document.js';
import { updateEntity } from '$lib/features/flat-parts/actions.js';
import { entityOutline, flatPartsGeometry } from '$lib/features/flat-parts/geometry.js';
import { classifyOutlines, importSvg } from '$lib/features/flat-parts/import.js';
import { validateFlatParts } from '$lib/features/flat-parts/validation.js';
import { flatPartsSheetView, withFlatPartsSheet } from '$lib/features/flat-parts/view.js';
import { FLAT_PARTS_WORKSPACE } from '$lib/features/workspaces.js';
import { flatPartsDesign } from '../../support/designs.js';

const empty = (mode: 'router' | 'knife' = 'router'): DesignState =>
	withFlatPartsSheet(flatPartsDesign(mode), 'sheet', () => ({ entities: [] }));

const svg = (body: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="300mm" viewBox="0 0 300 300">${body}</svg>`;

const square = (x: number, y: number, size: number): Point[] => [
	{ x, y },
	{ x: x + size, y },
	{ x: x + size, y: y + size },
	{ x, y: y + size }
];

/** A 200 x 100 mm plate with a round hole and a square window, drawn clockwise in SVG. */
const PLATE = svg(`
	<path d="M0 0 H200 V100 H0 Z"/>
	<circle cx="50" cy="50" r="20"/>
	<rect x="120" y="30" width="40" height="40"/>
`);

const entities = (design: DesignState) => flatPartsSheetView(design, 'sheet').entities;

describe('classifying imported outlines', () => {
	it('alternates parts and holes by nesting depth', () => {
		const classified = classifyOutlines([
			square(0, 0, 100),
			square(10, 10, 80),
			square(20, 20, 60),
			square(30, 30, 10),
			square(200, 0, 50)
		]);
		expect(classified.map(({ depth, kind }) => [depth, kind])).toEqual([
			[0, 'profile'],
			[1, 'hole'],
			[2, 'profile'],
			[3, 'hole'],
			[0, 'profile']
		]);
	});
});

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
			'No closed outlines to cut in lines.svg: parts and holes need closed shapes. Skipped 1 open path.'
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
			)
		);
		expect(entities(design).map((entity) => entity.kind)).toEqual(['profile', 'hole', 'profile']);
		expect(validateFlatParts(design)).toContain(
			'Part 2: is inside Part 1; a part nested inside another cannot be cut yet'
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
