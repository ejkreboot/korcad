import { describe, expect, it } from 'vitest';
import { generateGcode } from '$lib/core/cam/gcode.js';
import { simulationMoves } from '$lib/core/cam/simulation.js';
import {
	applySurfaceMap,
	createSurfaceMap,
	DEFAULT_SURFACE_INSET,
	MAX_SURFACE_SPREAD,
	parseSurfaceMap,
	resizeSurfaceMap,
	serializeSurfaceMap,
	SURFACE_STEP,
	surfaceGridPoint,
	surfaceHeight,
	surfaceMapErrors,
	type SurfaceMap
} from '$lib/core/cam/surface.js';
import { SHEET } from '$lib/core/constants.js';
import { sheetView } from '$lib/core/design/machine.js';
import { workspaceById } from '$lib/features/workspaces.js';
import { flatPartsDesign, withMachine } from '../../support/designs.js';

/**
 * A map on `columns` x `rows` points read from `table`, a height in mm at each
 * point. The grid spans the whole sheet unless `inset` pulls it in.
 */
function mapOf(
	table: (x: number, y: number) => number,
	columns = 3,
	rows = 3,
	inset = 0
): SurfaceMap {
	const heights: number[] = [];
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const { x, y } = surfaceGridPoint({ columns, rows, inset }, column, row);
			heights.push(table(x, y));
		}
	}
	return { enabled: true, columns, rows, inset, heights };
}

/** A table 1 mm higher at the back right than at the front left, read from a datum of 5 mm. */
const tilted = (x: number, y: number) => 5 + (0.6 * x) / SHEET + (0.4 * y) / SHEET;

describe('surface height', () => {
	it('is zero at X0 Y0, whatever datum the readings were taken from', () => {
		expect(surfaceHeight(mapOf(tilted), 0, 0)).toBe(0);
		expect(surfaceHeight(mapOf(tilted), SHEET, SHEET)).toBeCloseTo(1, 12);
	});

	it('interpolates a plane exactly anywhere on the sheet', () => {
		const map = mapOf(tilted, 4, 3);
		for (const [x, y] of [
			[10, 20],
			[300, 150],
			[555.5, 601]
		] as const) {
			expect(surfaceHeight(map, x, y)).toBeCloseTo(tilted(x, y) - tilted(0, 0), 12);
		}
	});

	it('is bilinear between the four readings around a point', () => {
		const map: SurfaceMap = { enabled: true, columns: 2, rows: 2, inset: 0, heights: [0, 0, 0, 1] };
		expect(surfaceHeight(map, SHEET / 2, SHEET / 2)).toBeCloseTo(0.25, 12);
		expect(surfaceHeight(map, SHEET, SHEET / 2)).toBeCloseTo(0.5, 12);
	});

	it('takes the nearest edge for a point just off the sheet', () => {
		const map = mapOf(tilted);
		expect(surfaceHeight(map, -3, -3)).toBe(0);
		expect(surfaceHeight(map, SHEET + 3, 0)).toBeCloseTo(0.6, 12);
	});

	it('stands the grid half an inch in from the edges unless told otherwise', () => {
		const map = createSurfaceMap(4, 4);
		expect(map.inset).toBe(DEFAULT_SURFACE_INSET);
		expect(surfaceGridPoint(map, 0, 0)).toEqual({ x: 12.7, y: 12.7 });
		expect(surfaceGridPoint(map, 3, 3)).toEqual({ x: 596.9, y: 596.9 });
		expect(surfaceGridPoint(map, 1, 2).x).toBeCloseTo(12.7 + (SHEET - 25.4) / 3, 12);
	});

	it('holds the height at the grid edge across the inset strip, and is zero at X0 Y0', () => {
		const map = mapOf(tilted, 3, 3, 12.7);
		const front = tilted(12.7, 12.7);
		expect(surfaceHeight(map, 0, 0)).toBe(0);
		expect(surfaceHeight(map, 6, 12.7)).toBe(0);
		// Inside the grid a plane is still exact, measured from the first point.
		expect(surfaceHeight(map, 300, 150)).toBeCloseTo(tilted(300, 150) - front, 12);
		// The back right corner reads the grid's back right point.
		expect(surfaceHeight(map, SHEET, SHEET)).toBeCloseTo(
			tilted(SHEET - 12.7, SHEET - 12.7) - front,
			12
		);
	});

	it('keeps what was measured when the inset changes', () => {
		const moved = resizeSurfaceMap(mapOf(tilted), 3, 3, 25.4);
		expect(moved.inset).toBe(25.4);
		moved.heights.forEach((height, index) =>
			expect(height).toBeCloseTo(mapOf(tilted, 3, 3, 25.4).heights[index]!, 4)
		);
	});

	it('keeps what was measured when the grid is resized', () => {
		const resized = resizeSurfaceMap(mapOf(tilted, 2, 2), 5, 4);
		expect(resized.heights).toHaveLength(20);
		expect(resized).toEqual({ ...mapOf(tilted, 5, 4), heights: expect.any(Array) });
		resized.heights.forEach((height, index) =>
			expect(height).toBeCloseTo(mapOf(tilted, 5, 4).heights[index]!, 4)
		);
	});
});

describe('surface map validation', () => {
	const tools = [{ name: 'Drag knife', safeZ: 3 }];

	it('checks nothing while the map is off', () => {
		const typo = { ...mapOf(tilted), heights: [0, 0, 0, 0, 40, 0, 0, 0, 0] };
		expect(surfaceMapErrors({ ...typo, enabled: false }, tools)).toEqual([]);
		expect(surfaceMapErrors(mapOf(tilted), tools)).toEqual([]);
	});

	it(`refuses a table more than ${MAX_SURFACE_SPREAD} mm out, which is likelier a typo`, () => {
		// 0.04 typed in millimetres where inches were meant reads as 1 in.
		const typo = { ...mapOf(tilted), heights: [0, 0, 0, 0, -25.4, 0, 0, 0, 0] };
		expect(surfaceMapErrors(typo, tools)).toEqual([
			'Surface map: heights span 25.4 mm, more than 3 mm; check for a typo, or flatten the table'
		]);
	});

	it('refuses a table that rises into safe Z, since travel does not follow it', () => {
		const high = mapOf((x) => (2.5 * x) / SHEET);
		expect(surfaceMapErrors(high, [{ name: 'Router', safeZ: 2.5 }])).toEqual([
			"Surface map: the table rises 2.5 mm above X0 Y0, which Router's safe Z does not clear"
		]);
		expect(surfaceMapErrors(high, [{ name: 'Router', safeZ: 3 }])).toEqual([]);
	});

	it('refuses a grid or reading this build would not write', () => {
		expect(surfaceMapErrors({ ...mapOf(tilted), columns: 8 }, tools)).toEqual([
			'Surface map: the grid must be 2 to 7 points each way'
		]);
		expect(surfaceMapErrors({ ...mapOf(tilted), inset: 60 }, tools)).toEqual([
			'Surface map: the inset must be 0 to 50.8 mm'
		]);
		expect(surfaceMapErrors({ ...mapOf(tilted), inset: -1 }, tools)).toEqual([
			'Surface map: the inset must be 0 to 50.8 mm'
		]);
		expect(surfaceMapErrors({ ...mapOf(tilted), heights: [Number.NaN] }, tools)).toEqual([
			'Surface map: every point needs a height'
		]);
	});
});

describe('following the surface', () => {
	const program = [
		'; KorCad v1.0',
		'; Operation: cut; tool: drag knife',
		'G21 ; millimeters',
		'G0 Z3',
		'',
		'; 1: cut',
		'G0 X0 Y0',
		'G1 Z-3.2 F250',
		'G1 X609.6 Y0 F800',
		'G1 Z-0.3 F250 ; lift',
		'G1 X609.6 Y1 F800',
		'G1 Z-3.2 F250 ; end of lift',
		'G0 Z3',
		'G0 X0 Y0',
		'M2',
		''
	].join('\n');

	it('leaves the program exactly as it was while the map is off', () => {
		expect(applySurfaceMap(program, { ...mapOf(tilted), enabled: false })).toBe(program);
	});

	it('states the map and where to set Z zero ahead of the first command', () => {
		const lines = applySurfaceMap(program, mapOf(tilted)).split('\n');
		expect(lines.slice(0, 3)).toEqual([
			'; KorCad v1.0',
			'; Operation: cut; tool: drag knife',
			'; Surface map: 3 x 3 points, 0 mm in from the edges; table 0 to 1 mm from X0 Y0; set Z zero at X0 Y0'
		]);
		expect(lines[3]).toBe('G21 ; millimeters');
	});

	it('lands each plunge and lift on the table, and leaves safe Z and travel alone', () => {
		const lines = applySurfaceMap(program, mapOf(tilted)).split('\n');
		expect(lines).toContain('G1 Z-3.2 F250');
		expect(lines).toContain('G1 Z0.3 F250 ; lift');
		// 1 mm along the back edge's slope of 0.4 mm over the sheet.
		expect(lines).toContain('G1 Z-2.599 F250 ; end of lift');
		expect(lines.filter((line) => line === 'G0 Z3')).toHaveLength(2);
		expect(lines).toContain('G0 X0 Y0');
	});

	it(`breaks each cut into moves of at most ${SURFACE_STEP} mm that keep their depth below the table`, () => {
		const lines = applySurfaceMap(program, mapOf(tilted)).split('\n');
		const across = lines.filter((line) => /^G1 X[\d.]+ Y0 Z/.test(line));
		expect(across).toHaveLength(Math.ceil(SHEET / SURFACE_STEP));
		expect(across.at(-1)).toBe('G1 X609.6 Y0 Z-2.6 F800');
		for (const line of across) {
			const x = Number(/X([\d.]+)/.exec(line)![1]);
			const z = Number(/Z(-?[\d.]+)/.exec(line)![1]);
			expect(z).toBeCloseTo(-3.2 + surfaceHeight(mapOf(tilted), x, 0), 3);
		}
		// The short move made lifted stays at lift depth above the table, in one piece.
		expect(lines).toContain('G1 X609.6 Y1 Z0.301 F800');
	});

	it('refuses a move it cannot follow rather than guess', () => {
		const map = mapOf(tilted);
		expect(() => applySurfaceMap('G0 Z3\nG1 Z-1 F250\nG1 X5 Y5 Z-2 F800', map)).toThrow(
			/XY and Z at once/
		);
		expect(() => applySurfaceMap('G0 Z3\nG1 Z-1 F250\nG0 X5 Y5', map)).toThrow(/rapid in the work/);
		expect(() => applySurfaceMap('G0 Z3\nG1 Z-1 F250\nG1 X5 A2 F800', map)).toThrow(
			/cannot follow/
		);
	});

	it('cuts a generated program at its own depths below the table, along the same XY path', () => {
		const design = withMachine(flatPartsDesign('knife'), { knifePasses: 2 });
		const view = sheetView(design, 'sheet');
		const paths = workspaceById('flatParts').geometry(design, 'sheet').paths;
		const plain = generateGcode(paths, view, 'cut');
		const map = mapOf((x, y) => 0.5 * Math.sin(x / 200) + 0.3 * Math.cos(y / 150), 5, 4);
		const followed = applySurfaceMap(plain, map);

		const depths = new Set([-view.cutDepth / 2, -view.cutDepth, -view.swivelDepth]);
		const moves = simulationMoves(followed, view);
		for (const move of moves.filter((m) => m.type !== 'travel')) {
			const nominal = move.b.z - surfaceHeight(map, move.b.x, move.b.y);
			expect([...depths].some((depth) => Math.abs(nominal - depth) < 2e-3)).toBe(true);
		}
		const flat = (text: string) =>
			simulationMoves(text, view)
				.filter((m) => m.type !== 'travel')
				.reduce((sum, m) => sum + Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y), 0);
		expect(flat(followed)).toBeCloseTo(flat(plain), 1);
	});
});

describe('storing a surface map', () => {
	it('reads back what it wrote', () => {
		const map = mapOf(tilted, 4, 2, 10);
		expect(parseSurfaceMap(serializeSurfaceMap(map))).toEqual(map);
		expect(parseSurfaceMap(serializeSurfaceMap(createSurfaceMap()))).toEqual(createSurfaceMap());
	});

	it('drops anything else, so a damaged map is measured again rather than cut on', () => {
		const good = JSON.parse(serializeSurfaceMap(mapOf(tilted))) as Record<string, unknown>;
		for (const text of [
			'not json',
			'null',
			JSON.stringify({ ...good, format: 'korcad-design' }),
			JSON.stringify({ ...good, version: 1 }),
			JSON.stringify({ ...good, inset: undefined }),
			JSON.stringify({ ...good, inset: 100 }),
			JSON.stringify({ ...good, columns: 9 }),
			JSON.stringify({ ...good, heights: [1, 2, 3] }),
			JSON.stringify({ ...good, heights: [0, 0, 0, 0, '1', 0, 0, 0, 0] })
		]) {
			expect(parseSurfaceMap(text)).toBeNull();
		}
	});
});
