/**
 * Values ported verbatim from the original insert-generator monolith.
 * Changing any of these changes manufactured output, so they are kept
 * together and covered by tests rather than inlined at call sites.
 */

export const MM_PER_IN = 25.4;

/** Nominal stock is a 24 in square sheet. Origin is lower-left. */
export const SHEET = 24 * MM_PER_IN;

/** Snap increment: a quarter inch. */
export const SNAP = MM_PER_IN / 4;

export const STORAGE_KEY = 'voisee-insert-generator-v02';
export const DESIGN_FORMAT = 'voisee-insert-design';
/**
 * The document version this build writes. Every bump needs a step in
 * `core/design/migrate.ts`; a test asserts the two agree.
 */
export const DESIGN_VERSION = 8;

/**
 * A folded panel may never be reduced below this flat width by bend
 * deduction; a shorter panel cannot be folded reliably.
 */
export const MIN_FLAT_PANEL = 0.4;
