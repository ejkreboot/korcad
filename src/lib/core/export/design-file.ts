import { DESIGN_FORMAT, DESIGN_VERSION } from '$lib/core/constants.js';
import type { DesignFile, DesignState } from '$lib/core/design/types.js';

export function serializeDesign(design: DesignState, savedAt = new Date().toISOString()): string {
	const file: DesignFile = {
		format: DESIGN_FORMAT,
		version: DESIGN_VERSION,
		savedAt,
		design
	};
	return JSON.stringify(file, null, 2);
}

/** A saved design taken out of its envelope, still untrusted. */
export type UnwrappedDesign = {
	readonly document: unknown;
	/** The version the envelope records; absent for a bare document. */
	readonly version: number | undefined;
};

/**
 * Opens a saved design's envelope. A file from a newer version is rejected
 * rather than partially understood, because a silently dropped field changes
 * what gets cut.
 *
 * A bare document with no envelope is accepted too, which is how the editor's
 * local drafts were written before they gained one. Reading the document
 * itself needs every registered workspace, so it is `parseDesign` in
 * `features/document.ts` that callers want.
 */
export function unwrapDesignFile(text: string): UnwrappedDesign {
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== 'object') throw new Error('Design file must contain an object.');
	const record = parsed as Record<string, unknown>;
	if (record.format !== undefined && record.format !== DESIGN_FORMAT) {
		throw new Error('This is not a Voisee insert design file.');
	}
	if (typeof record.version === 'number' && record.version > DESIGN_VERSION) {
		throw new Error('This design was created by a newer version of the insert generator.');
	}
	return {
		document: record.design ?? record,
		version: typeof record.version === 'number' ? record.version : undefined
	};
}
