/**
 * Changing any of these changes manufactured output, so they are kept
 * together and covered by tests rather than inlined at call sites.
 */

export const MM_PER_IN = 25.4;

/** Nominal stock is a 24 in square sheet. Origin is lower-left. */
export const SHEET = 24 * MM_PER_IN;

/** Snap increment: a quarter inch. */
export const SNAP = MM_PER_IN / 4;

export const STORAGE_KEY = 'korcad-draft';
/** The table's surface map, kept apart from the draft because it belongs to the CNC. */
export const SURFACE_MAP_KEY = 'korcad-surface-map';
/** How the table is probed: plate thickness and travel height, which belong to the CNC too. */
export const PROBE_SETTINGS_KEY = 'korcad-probe-settings';
/** The surface file the map was last opened from or saved to, and what it held. */
export const SURFACE_FILE_KEY = 'korcad-surface-file';
/** The material preset file last opened or saved, and what it held. */
export const MATERIAL_FILE_KEY = 'korcad-material-file';
export const DESIGN_FORMAT = 'korcad-design';
/**
 * The document version this build writes, and the only one it reads. There are
 * no legacy designs to upgrade: a shape change bumps this and regenerates the
 * serialization fixture.
 */
export const DESIGN_VERSION = 10;
