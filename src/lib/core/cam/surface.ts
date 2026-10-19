import { SHEET } from '$lib/core/constants.js';
import { clamp, round } from '$lib/core/units.js';

/**
 * The height of the table's top, measured by the operator at the points of a
 * regular grid spread over the sheet, so that programs can follow a table
 * that is not flat. The grid stands `inset` in from every edge, since a
 * sheet's far corners can lie at the very end of a machine's travel. It belongs to the CNC, not to a design: it is kept
 * in this browser, apart from every design file, so a design shared with
 * someone else never carries this table's shape onto theirs.
 *
 * Heights may be read from any datum, such as the Z display after jogging the
 * tool down to each point; only differences matter. Programs are cut relative
 * to the height at X0 Y0, which is where the operator sets Z zero.
 */
export type SurfaceMap = {
	readonly enabled: boolean;
	readonly columns: number;
	readonly rows: number;
	/** In mm, how far in from each edge of the sheet the outermost grid points stand. */
	readonly inset: number;
	/** In mm, row by row from the front (Y = inset), each row left to right. */
	readonly heights: readonly number[];
};

export const SURFACE_MAP_FORMAT = 'korcad-surface-map';
export const SURFACE_MAP_VERSION = 2;

/** Grid sizes the operator may choose, along each axis. */
export const SURFACE_GRID_MIN = 2;
export const SURFACE_GRID_MAX = 7;

/** Half an inch keeps the grid's corners off the limit switches of a machine that travels just the sheet. */
export const DEFAULT_SURFACE_INSET = 12.7;

/**
 * The widest inset. Beyond the grid the map holds the height at its edge, which
 * is close for a strip this narrow and more of a guess the wider it grows.
 */
export const MAX_SURFACE_INSET = 50.8;

/**
 * The most the table may vary under the sheet. A table further out than this
 * wants flattening rather than following, and a map that says so more likely
 * holds a typo, such as a reading in the wrong units, that would drive the
 * tool into the table.
 */
export const MAX_SURFACE_SPREAD = 3;

/**
 * The longest move cut at one height. The map is bilinear, so the height
 * along a move bends where it crosses into the next grid cell, and within a
 * cell along a diagonal; a 5 mm chord follows a table 1 mm out over 250 mm to
 * within a few hundredths of a millimetre.
 */
export const SURFACE_STEP = 5;

export function createSurfaceMap(columns = 3, rows = 3, inset = DEFAULT_SURFACE_INSET): SurfaceMap {
	return { enabled: false, columns, rows, inset, heights: Array<number>(columns * rows).fill(0) };
}

/** Where the grid point in `column` and `row` lies on the sheet. */
export function surfaceGridPoint(
	map: Pick<SurfaceMap, 'columns' | 'rows' | 'inset'>,
	column: number,
	row: number
): { readonly x: number; readonly y: number } {
	const span = SHEET - 2 * map.inset;
	return {
		x: map.inset + (span * column) / (map.columns - 1),
		y: map.inset + (span * row) / (map.rows - 1)
	};
}

/**
 * The measured height at a point, interpolated bilinearly between the four
 * grid points around it. A point off the grid, in the inset strip or beyond
 * the sheet like a knife's axis a blade offset past a part at its edge, takes
 * the height at the grid's nearest edge rather than extrapolating a slope,
 * which over so short a reach would add more noise than it removes.
 */
function measuredHeight(map: SurfaceMap, x: number, y: number): number {
	const span = SHEET - 2 * map.inset;
	const u = clamp((x - map.inset) / span, 0, 1) * (map.columns - 1);
	const v = clamp((y - map.inset) / span, 0, 1) * (map.rows - 1);
	const column = Math.min(Math.floor(u), map.columns - 2);
	const row = Math.min(Math.floor(v), map.rows - 2);
	const s = u - column;
	const t = v - row;
	const at = (c: number, r: number) => map.heights[r * map.columns + c] ?? 0;
	const front = at(column, row) * (1 - s) + at(column + 1, row) * s;
	const back = at(column, row + 1) * (1 - s) + at(column + 1, row + 1) * s;
	return front * (1 - t) + back * t;
}

/**
 * How far the table at a point stands above its height at X0 Y0, where Z zero
 * is set. X0 Y0 is in the inset strip, so it reads the grid's first point.
 */
export function surfaceHeight(map: SurfaceMap, x: number, y: number): number {
	return measuredHeight(map, x, y) - measuredHeight(map, 0, 0);
}

/**
 * The map on a different grid, or inset, each new point read from the old
 * map, so that changing the grid keeps what was measured until the new points
 * are.
 */
export function resizeSurfaceMap(
	map: SurfaceMap,
	columns: number,
	rows: number,
	inset = map.inset
): SurfaceMap {
	const size = { columns, rows, inset };
	const heights: number[] = [];
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const { x, y } = surfaceGridPoint(size, column, row);
			heights.push(round(measuredHeight(map, x, y), 4));
		}
	}
	return { ...map, columns, rows, inset, heights };
}

/** The lowest and highest the table stands relative to X0 Y0. */
export function surfaceRange(map: SurfaceMap): { readonly low: number; readonly high: number } {
	const origin = measuredHeight(map, 0, 0);
	return {
		low: Math.min(...map.heights) - origin,
		high: Math.max(...map.heights) - origin
	};
}

const gridSize = (value: number) =>
	Number.isInteger(value) && value >= SURFACE_GRID_MIN && value <= SURFACE_GRID_MAX;

export const surfaceInsetValid = (inset: number) =>
	Number.isFinite(inset) && inset >= 0 && inset <= MAX_SURFACE_INSET;

/**
 * Why a map that is switched on cannot be followed. Each tool's safe Z must
 * clear the highest point of the table, since travel stays at safe Z above
 * X0 Y0 rather than following the map. A map that is off is never checked,
 * because no program reads it.
 */
export function surfaceMapErrors(
	map: SurfaceMap,
	tools: readonly { readonly name: string; readonly safeZ: number }[]
): string[] {
	if (!map.enabled) return [];
	if (!gridSize(map.columns) || !gridSize(map.rows)) {
		return [
			`Surface map: the grid must be ${SURFACE_GRID_MIN} to ${SURFACE_GRID_MAX} points each way`
		];
	}
	if (!surfaceInsetValid(map.inset)) {
		return [`Surface map: the inset must be 0 to ${MAX_SURFACE_INSET} mm`];
	}
	if (
		map.heights.length !== map.columns * map.rows ||
		!map.heights.every((height) => Number.isFinite(height))
	) {
		return ['Surface map: every point needs a height'];
	}
	const errors: string[] = [];
	const { low, high } = surfaceRange(map);
	if (high - low > MAX_SURFACE_SPREAD) {
		errors.push(
			`Surface map: heights span ${round(high - low)} mm, more than ${MAX_SURFACE_SPREAD} mm; check for a typo, or flatten the table`
		);
	}
	for (const tool of tools) {
		if (high >= tool.safeZ) {
			errors.push(
				`Surface map: the table rises ${round(high)} mm above X0 Y0, which ${tool.name}'s safe Z does not clear`
			);
		}
	}
	return errors;
}

/** The words of one emitted motion line, and its comment. */
type Motion = {
	readonly rapid: boolean;
	readonly x?: number;
	readonly y?: number;
	readonly z?: number;
	readonly feed?: number;
	readonly comment: string;
};

function motion(line: string): Motion | null {
	const split = line.indexOf(';');
	const code = (split < 0 ? line : line.slice(0, split)).trim();
	const comment = split < 0 ? '' : ` ${line.slice(split).trim()}`;
	const [command, ...words] = code.split(/\s+/);
	if (command !== 'G0' && command !== 'G1') return null;
	const values: Partial<Record<'X' | 'Y' | 'Z' | 'F', number>> = {};
	for (const word of words) {
		const letter = word[0];
		const value = Number(word.slice(1));
		if (
			(letter !== 'X' && letter !== 'Y' && letter !== 'Z' && letter !== 'F') ||
			!Number.isFinite(value)
		) {
			throw new Error(`The surface map cannot follow "${line}"`);
		}
		values[letter] = value;
	}
	return {
		rapid: command === 'G0',
		...(values.X === undefined ? {} : { x: values.X }),
		...(values.Y === undefined ? {} : { y: values.Y }),
		...(values.Z === undefined ? {} : { z: values.Z }),
		...(values.F === undefined ? {} : { feed: values.F }),
		comment
	};
}

const feedWord = (feed: number | undefined) => (feed === undefined ? '' : ` F${feed}`);

/**
 * An emitted program bent to follow the table, as the last step before it is
 * written out. Every height at or below Z zero, where the tool is in the work,
 * is raised by how far the table there stands above X0 Y0, and every cut is
 * broken into moves no longer than `SURFACE_STEP` so that its depth follows
 * the table between grid points. Safe Z and travel above the work are left as
 * they are; validation makes sure safe Z clears the table.
 *
 * The generator moves either in XY or in Z, never both at once, and never
 * rapids below Z zero. Anything else is refused rather than guessed at.
 * A map that is off returns the program unchanged.
 */
export function applySurfaceMap(program: string, map: SurfaceMap): string {
	if (!map.enabled) return program;
	const lines = program.split('\n');
	const header = lines.findIndex((line) => line !== '' && !line.startsWith(';'));
	const { low, high } = surfaceRange(map);
	const note = `; Surface map: ${map.columns} x ${map.rows} points, ${round(map.inset)} mm in from the edges; table ${round(low)} to ${round(high)} mm from X0 Y0; set Z zero at X0 Y0`;
	const height = (x: number, y: number) => surfaceHeight(map, x, y);

	let x = 0;
	let y = 0;
	// Nothing is below the surface until the program first goes there.
	let z = Number.POSITIVE_INFINITY;
	const result: string[] = [];
	lines.forEach((line, index) => {
		if (index === header) result.push(note);
		const move = motion(line);
		if (!move) {
			result.push(line);
			return;
		}
		const nextX = move.x ?? x;
		const nextY = move.y ?? y;
		const nextZ = move.z ?? z;
		const planar = move.x !== undefined || move.y !== undefined;
		if (planar && move.z !== undefined) {
			throw new Error(`The surface map cannot follow a move in XY and Z at once: "${line}"`);
		}
		if (!planar) {
			// A vertical move: into the work it lands on the table's height here.
			if (move.z !== undefined && nextZ <= 0) {
				result.push(
					`${move.rapid ? 'G0' : 'G1'} Z${round(nextZ + height(x, y))}${feedWord(move.feed)}${move.comment}`
				);
			} else {
				result.push(line);
			}
		} else if (z > 0) {
			result.push(line);
		} else {
			if (move.rapid)
				throw new Error(`The surface map cannot follow a rapid in the work: "${line}"`);
			const steps = Math.max(1, Math.ceil(Math.hypot(nextX - x, nextY - y) / SURFACE_STEP));
			for (let step = 1; step <= steps; step++) {
				const last = step === steps;
				const px = last ? nextX : round(x + ((nextX - x) * step) / steps);
				const py = last ? nextY : round(y + ((nextY - y) * step) / steps);
				result.push(
					`G1 X${px} Y${py} Z${round(z + height(px, py))}${feedWord(move.feed)}${last ? move.comment : ''}`
				);
			}
		}
		x = nextX;
		y = nextY;
		z = nextZ;
	});
	return result.join('\n');
}

/** A map as stored in the browser, in an envelope like a design file's. */
export function serializeSurfaceMap(map: SurfaceMap): string {
	return JSON.stringify({ format: SURFACE_MAP_FORMAT, version: SURFACE_MAP_VERSION, ...map });
}

/**
 * A stored map, or `null` when the text is not one this build writes. A map
 * that cannot be read is dropped rather than repaired, so the operator
 * measures again instead of cutting on a guess.
 */
export function parseSurfaceMap(text: string): SurfaceMap | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const record: Record<string, unknown> = { ...value };
	const { format, version, enabled, columns, rows, inset, heights } = record;
	if (format !== SURFACE_MAP_FORMAT || version !== SURFACE_MAP_VERSION) return null;
	if (
		typeof enabled !== 'boolean' ||
		typeof columns !== 'number' ||
		typeof rows !== 'number' ||
		typeof inset !== 'number'
	) {
		return null;
	}
	if (!gridSize(columns) || !gridSize(rows) || !surfaceInsetValid(inset)) return null;
	if (!Array.isArray(heights)) return null;
	const readings: unknown[] = heights;
	const numbers = readings.filter(
		(height): height is number => typeof height === 'number' && Number.isFinite(height)
	);
	if (numbers.length !== columns * rows || numbers.length !== readings.length) return null;
	return { enabled, columns, rows, inset, heights: numbers };
}
