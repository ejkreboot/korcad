import type { Page } from '@playwright/test';

/** Matches `STORAGE_KEY` in `src/lib/core/constants.ts`. */
export const DRAFT_KEY = 'korcad-draft';

/**
 * Opens the editor and waits until it is interactive.
 *
 * The page is server-rendered, so every button is painted, enabled, and
 * clickable before hydration wires up its handler. A click that lands in that
 * window passes all of Playwright's actionability checks and is then silently
 * swallowed, which shows up later as a missing dialog or a menu that never
 * opened. The editor autosaves its draft from an effect, so the key appearing
 * in `localStorage` is proof the client has mounted.
 */
export async function gotoEditor(page: Page): Promise<void> {
	await page.goto('/');
	await page.waitForFunction((key) => localStorage.getItem(key) !== null, DRAFT_KEY, {
		timeout: 15_000
	});
}

/**
 * Reads the autosaved design document out of the browser.
 *
 * A draft is saved as a complete design file, envelope and version included, so
 * this unwraps it and returns the document inside.
 */
export async function readDraft(page: Page): Promise<Record<string, unknown> | null> {
	return page.evaluate((key) => {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		const file = JSON.parse(raw) as { design?: Record<string, unknown> };
		return file.design ?? null;
	}, DRAFT_KEY);
}

/** The packaging workspace of the autosaved draft. */
export async function readPackagingDraft(page: Page): Promise<Record<string, unknown> | null> {
	const design = await readDraft(page);
	const workspaces = design?.workspaces as Record<string, Record<string, unknown>> | undefined;
	return workspaces?.packaging ?? null;
}
