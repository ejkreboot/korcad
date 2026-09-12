import { STORAGE_KEY } from '$lib/core/constants.js';
import { normalizeState } from '$lib/core/design/normalize.js';
import { parseDesign, serializeDesign } from '$lib/core/export/design-file.js';
import type { DesignState } from '$lib/core/design/types.js';
import { resolveSupportHeights } from '$lib/features/packaging/levels.js';

/**
 * Local drafts only. Durable sharing is an explicit file export, so a lost or
 * cleared browser profile never loses a design the user meant to keep.
 */
export function loadDraft(): DesignState | null {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return null;
		return resolveSupportHeights(normalizeState(JSON.parse(stored)));
	} catch {
		return null;
	}
}

export function saveDraft(design: DesignState): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(design));
	} catch {
		// A full or blocked storage quota must not interrupt editing.
	}
}

/**
 * A spanning height is a function of the deck, so it is recomputed on the way
 * in rather than trusted: the file may have been saved before a wall change,
 * or hand-edited. `core` stays framework- and feature-free, so this is where
 * the packaging rule is applied.
 */
export function readDesignFile(text: string): DesignState {
	return resolveSupportHeights(parseDesign(text));
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
			.replace(/(^-|-$)/g, '') || 'insert'
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
