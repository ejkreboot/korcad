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
export const DESIGN_FORMAT = 'korcad-design';
/**
 * The document version this build writes, and the only one it reads. There are
 * no legacy designs to upgrade: a shape change bumps this and regenerates the
 * serialization fixture.
 */
export const DESIGN_VERSION = 9;
