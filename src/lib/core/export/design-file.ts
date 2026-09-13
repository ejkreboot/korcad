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

/**
 * Opens a saved design's envelope and returns the document inside, still
 * untrusted. A file of any other version is rejected rather than partially
 * understood, because a silently dropped or misread field changes what gets
 * cut; KorCad has no older formats to upgrade.
 *
 * Reading the document itself needs every registered workspace, so it is
 * `parseDesign` in `features/document.ts` that callers want.
 */
export function unwrapDesignFile(text: string): unknown {
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Design file must contain an object.');
	}
	const record = parsed as Record<string, unknown>;
	if (record.format !== DESIGN_FORMAT) {
		throw new Error('This is not a KorCad design file.');
	}
	if (record.version !== DESIGN_VERSION) {
		throw new Error(
			`This design file is version ${String(record.version)}; this build reads version ${DESIGN_VERSION}.`
		);
	}
	return record.design;
}
