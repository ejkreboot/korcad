import { MM_PER_IN } from '$lib/core/constants.js';
import { MAX_SURFACE_SPREAD, type SurfaceMap } from '$lib/core/cam/surface.js';
import { round, type Units } from '$lib/core/units.js';

/**
 * How the table is measured with the controller: a touch plate, or a thin
 * conductive sheet laid over the table, wired to the probe input with the tool
 * clipped to the other side. Lengths in millimetres.
 */
export type ProbeSettings = {
	/** What the probe touches stands this far above the table; 0 for foil or a thin sheet. */
	readonly plateThickness: number;
	/** Work Z the tool travels between points at, above Z0, clear of the plate. */
	readonly travelHeight: number;
};

export const DEFAULT_PROBE_SETTINGS: ProbeSettings = { plateThickness: 0, travelHeight: 20 };

export const PROBE_SETTINGS_FORMAT = 'korcad-probe-settings';
export const PROBE_SETTINGS_VERSION = 1;

/*
 * Each point is probed twice, as touch-plate routines usually are: a quick seek
 * down to find the plate, a back-off, and a slow second touch that is the
 * reading. The probe input lags the touch, and the tool coasts past it while
 * decelerating, by distances that grow with feed; the seek only has to be
 * slow enough to stop well within the back-off, the touch slow enough that
 * its lag is a few thousandths of a millimetre.
 */
export const PROBE_SEEK_FEED = 200;
export const PROBE_TOUCH_FEED = 25;

/** How far the tool rises from where the seek stopped before touching again. */
export const PROBE_BACKOFF = 2;

/**
 * The seek and the touch must find the plate within this of each other. Feed
 * lag alone accounts for hundredths at most, so more means a chip, a moving
 * plate, or a noisy probe input, and the reading is not to be trusted.
 */
export const PROBE_AGREEMENT = 0.1;

/**
 * How far below the plate's top, were the table level with Z0, a probe may
 * go looking for it. The map refuses a table further out than this, so a
 * probe that has not touched by then has lost its clip or plate, and GRBL
 * stops it with an alarm before the tool goes further into the table.
 */
export const PROBE_MARGIN = MAX_SURFACE_SPREAD;

/**
 * How far below where it stands a probe for Z0 after a tool change may go.
 * A new tool's length is unknown, so the search starts from the tool, which
 * the operator jogs down to just above the plate; a lost clip then ends in
 * alarm 5 this far down, not deep in the work.
 */
export const PROBE_Z_SEARCH = 10;

/** The tool must stand at least this far above the plate before probing down to it. */
export const PROBE_CLEARANCE = 1;

/** The plate must fit under the tool at travel height with this to spare. */
export const TRAVEL_CLEARANCE = 2;

/** Jog feeds, in mm/min: brisk across the table, gentle up and down. */
export const JOG_FEED_XY = 1500;
export const JOG_FEED_Z = 300;

/**
 * Speeds across the table the operator picks from, in the document's units per
 * minute. GRBL holds every move to its own maximum rates ($110–$112), so the
 * fastest is safe on a slower machine: it only goes no faster. Z keeps
 * `JOG_FEED_Z` whatever is picked, since a fast Z is how a bit meets the table.
 */
export const JOG_SPEEDS: Readonly<Record<Units, readonly number[]>> = {
	mm: [500, 1500, 3000, 6000],
	in: [20, 60, 120, 240]
};
export const DEFAULT_JOG_SPEED = 1;

/** The feed in mm/min for a choice from `JOG_SPEEDS`. */
export function jogFeed(units: Units, speed: number): number {
	const speeds = JOG_SPEEDS[units];
	const value = speeds[speed] ?? speeds[DEFAULT_JOG_SPEED]!;
	return units === 'in' ? value * MM_PER_IN : value;
}

/** The longest single Z jog, in mm: a long jog down is how a bit goes into the table. */
export const MAX_Z_JOG = MM_PER_IN;

/** How close in XY the tool must be to a grid point for a reading to belong to it. */
export const POINT_TOLERANCE = 0.05;

export function probeSettingsErrors(settings: ProbeSettings): string[] {
	const errors: string[] = [];
	if (!(Number.isFinite(settings.plateThickness) && settings.plateThickness >= 0)) {
		errors.push('Plate thickness must be zero or more');
	} else if (!(
		Number.isFinite(settings.travelHeight) &&
		settings.travelHeight >= settings.plateThickness + TRAVEL_CLEARANCE
	)) {
		errors.push(
			`Travel height must clear the plate by at least ${TRAVEL_CLEARANCE} mm (${round(settings.plateThickness + TRAVEL_CLEARANCE)} mm)`
		);
	}
	return errors;
}

/** The work Z a probe may go down to before GRBL gives up on touching. */
export function probeTarget(settings: ProbeSettings): number {
	return settings.plateThickness - PROBE_MARGIN;
}

/** The table's height at a point, from the work Z where the probe touched the plate there. */
export function surfaceReading(touchedAt: number, settings: ProbeSettings): number {
	return round(touchedAt - settings.plateThickness, 4);
}

/**
 * Grid indices in the order a probing run visits them: along the front row,
 * back along the next, and so on, so the tool never crosses the table empty.
 */
export function probeOrder(map: Pick<SurfaceMap, 'columns' | 'rows'>): number[] {
	const order: number[] = [];
	for (let row = 0; row < map.rows; row++) {
		for (let step = 0; step < map.columns; step++) {
			const column = row % 2 === 0 ? step : map.columns - 1 - step;
			order.push(row * map.columns + column);
		}
	}
	return order;
}

/** A grid point to probe: its index in the map, and where it lies in work X and Y. */
export type ProbePoint = { readonly index: number; readonly x: number; readonly y: number };

/**
 * What is left to probe of a run that stopped short, as long as the grid is
 * still the one it was probing: if any point it left has moved or gone, the
 * columns, rows, or inset changed since, and nothing is resumed.
 */
export function pointsToResume(
	left: readonly ProbePoint[],
	grid: readonly ProbePoint[]
): ProbePoint[] {
	const same = left.every((point) => {
		const now = grid.find((candidate) => candidate.index === point.index);
		return (
			now !== undefined &&
			Math.abs(now.x - point.x) <= POINT_TOLERANCE &&
			Math.abs(now.y - point.y) <= POINT_TOLERANCE
		);
	});
	return same ? [...left] : [];
}

export function serializeProbeSettings(settings: ProbeSettings): string {
	return JSON.stringify({
		format: PROBE_SETTINGS_FORMAT,
		version: PROBE_SETTINGS_VERSION,
		...settings
	});
}

/** Stored settings, or `null` when the text is not what this build writes. */
export function parseProbeSettings(text: string): ProbeSettings | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const record: Record<string, unknown> = { ...value };
	const { format, version, plateThickness, travelHeight } = record;
	if (format !== PROBE_SETTINGS_FORMAT || version !== PROBE_SETTINGS_VERSION) return null;
	if (typeof plateThickness !== 'number' || typeof travelHeight !== 'number') return null;
	return { plateThickness, travelHeight };
}
