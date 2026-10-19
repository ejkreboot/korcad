import type { BoardFinish, GrainDirection, StockSettings } from './types.js';

/**
 * A material preset: the settings of the Material panel, kept in a file of
 * their own so that one board's thickness, grain, tabs, and fold allowance can
 * be brought into any design. Lengths are in millimetres, like the document.
 */

export const MATERIAL_FORMAT = 'korcad-material';
export const MATERIAL_VERSION = 1;

/**
 * The stock settings a preset carries. The display units are the operator's
 * preference rather than a property of the board, and the stock-wide tab
 * count is edited on no panel, so neither travels with a preset.
 */
export type MaterialSettings = Pick<
	StockSettings,
	'material' | 'boardFinish' | 'grainDirection' | 'minimumWeb' | 'tabWidth' | 'tabHeight'
>;

/** One workspace's part of a preset, such as packaging's fold allowance. */
export type MaterialValues = Readonly<Record<string, string | number>>;

export type MaterialPreset = {
	readonly stock: MaterialSettings;
	/** Keyed by workspace id; a workspace with no material settings of its own has no entry. */
	readonly workspaces: Readonly<Record<string, MaterialValues>>;
};

const GRAIN_DIRECTIONS: readonly GrainDirection[] = ['x', 'y', 'unknown'];
const BOARD_FINISHES: readonly BoardFinish[] = ['kraft', 'white', 'printed'];

export function materialSettings(stock: StockSettings): MaterialSettings {
	return {
		material: stock.material,
		boardFinish: stock.boardFinish,
		grainDirection: stock.grainDirection,
		minimumWeb: stock.minimumWeb,
		tabWidth: stock.tabWidth,
		tabHeight: stock.tabHeight
	};
}

function record(value: unknown, what: string): Readonly<Record<string, unknown>> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`Material preset: ${what} must be an object.`);
	}
	return { ...value };
}

/**
 * A number read from a preset. Values are not held to a range here: the
 * editor accepts any number typed into the panel and validation judges it, so
 * a preset is held to the same rules as the panel and no stricter.
 */
export function presetNumber(values: Readonly<Record<string, unknown>>, key: string): number {
	const value = values[key];
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`Material preset: ${key} must be a number.`);
	}
	return value;
}

export function presetChoice<T extends string>(
	values: Readonly<Record<string, unknown>>,
	key: string,
	choices: readonly T[]
): T {
	const value = values[key];
	const choice = choices.find((candidate) => candidate === value);
	if (choice === undefined) {
		throw new Error(`Material preset: ${key} must be one of ${choices.join(', ')}.`);
	}
	return choice;
}

/** Narrows a preset's stock settings, refusing rather than repairing anything malformed. */
export function parseMaterialSettings(value: unknown): MaterialSettings {
	const stock = record(value, 'stock');
	return {
		material: presetNumber(stock, 'material'),
		boardFinish: presetChoice(stock, 'boardFinish', BOARD_FINISHES),
		grainDirection: presetChoice(stock, 'grainDirection', GRAIN_DIRECTIONS),
		minimumWeb: presetNumber(stock, 'minimumWeb'),
		tabWidth: presetNumber(stock, 'tabWidth'),
		tabHeight: presetNumber(stock, 'tabHeight')
	};
}

export function serializeMaterialPreset(
	preset: MaterialPreset,
	savedAt = new Date().toISOString()
): string {
	return JSON.stringify(
		{ format: MATERIAL_FORMAT, version: MATERIAL_VERSION, savedAt, ...preset },
		null,
		2
	);
}

/**
 * Opens a preset file: its stock settings narrowed, and each workspace's
 * section still untrusted, since only that workspace can read it. A file of
 * any other format or version is refused, as a design file is.
 */
export function unwrapMaterialFile(text: string): {
	readonly stock: MaterialSettings;
	readonly workspaces: Readonly<Record<string, unknown>>;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('This is not a KorCad material preset.');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('This is not a KorCad material preset.');
	}
	const file: Readonly<Record<string, unknown>> = { ...parsed };
	if (file.format !== MATERIAL_FORMAT) throw new Error('This is not a KorCad material preset.');
	if (file.version !== MATERIAL_VERSION) {
		throw new Error(
			`This material preset is version ${String(file.version)}; this build reads version ${MATERIAL_VERSION}.`
		);
	}
	return {
		stock: parseMaterialSettings(file.stock),
		workspaces: file.workspaces === undefined ? {} : record(file.workspaces, 'workspaces')
	};
}

/** The stock with a preset's settings in place; the units and tab count stay the design's. */
export function withMaterialSettings(
	stock: StockSettings,
	settings: MaterialSettings
): StockSettings {
	return { ...stock, ...settings };
}

/** JSON with every object's keys sorted, so equal presets compare equal however they were built. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (typeof value === 'object' && value !== null) {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

export function sameMaterialPreset(a: MaterialPreset, b: MaterialPreset): boolean {
	return canonical(a) === canonical(b);
}
