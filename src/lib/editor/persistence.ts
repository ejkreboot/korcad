import { STORAGE_KEY } from '$lib/core/constants.js';
import { serializeDesign } from '$lib/core/export/design-file.js';
import { parseDesign } from '$lib/features/document.js';
import type { DesignState } from '$lib/core/design/types.js';
import { reconcileDocument } from '$lib/features/workspaces.js';

/**
 * Local drafts only. Durable sharing is an explicit file export, so a lost or
 * cleared browser profile never loses a design the user meant to keep.
 *
 * A draft is written exactly like a design file, envelope and version
 * included, so the two can never drift apart. A draft this build cannot read
 * is ignored and the editor starts fresh.
 */
export function loadDraft(): DesignState | null {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return null;
		return readDesignFile(stored);
	} catch {
		return null;
	}
}

export function saveDraft(design: DesignState): void {
	try {
		localStorage.setItem(STORAGE_KEY, serializeDesign(design));
	} catch {
		// A full or blocked storage quota must not interrupt editing.
	}
}

/**
 * Derived values, such as a spanning support height, are recomputed on the way
 * in rather than trusted: the file may have been hand-edited. `core` stays
 * feature-free, so every workspace's reconciliation is applied here.
 */
export function readDesignFile(text: string): DesignState {
	return reconcileDocument(parseDesign(text));
}

export function designFileText(design: DesignState): string {
	return serializeDesign(design);
}

export function slugify(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '') || 'design'
	);
}

/** Browser-only: hands the user a file. Never called from core. */
export function download(name: string, contents: string, type: string): void {
	const url = URL.createObjectURL(new Blob([contents], { type }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = name;
	anchor.click();
	URL.revokeObjectURL(url);
}
