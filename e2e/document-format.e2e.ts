import { expect, test, type Page } from '@playwright/test';
import { DRAFT_KEY, gotoEditor, readDraft, readPackagingDraft } from './helpers.js';

/**
 * The saved document: generic settings at the top, each workspace's
 * data under `workspaces`, and editor state — selection, snap — not saved at
 * all. The shape is unit-tested; what needs a browser is that the editor writes
 * it, and recovers from a draft it cannot read.
 */

async function drawOpening(page: Page): Promise<void> {
	await page.getByRole('button', { name: /^Cutout/ }).click();
	await page.getByRole('menuitem', { name: /Product opening/ }).click();
	const box = (await page.locator('svg.drawing').boundingBox())!;
	await page.mouse.move(box.x + 300, box.y + 300);
	await page.mouse.down();
	await page.mouse.move(box.x + 420, box.y + 380, { steps: 12 });
	await page.mouse.up();
}

test('saves packaging data under its workspace and no editor state', async ({ page }) => {
	await gotoEditor(page);
	await drawOpening(page);
	await expect(page.getByRole('heading', { name: /^Pocket 1$/ })).toBeVisible();
	await page.getByRole('button', { name: 'Snap' }).click();

	await expect
		.poll(async () => ((await readPackagingDraft(page))?.pockets as unknown[] | undefined)?.length)
		.toBe(1);
	const design = (await readDraft(page))!;
	expect((design.sheets as { workspace: string }[])[0]?.workspace).toBe('packaging');
	for (const key of ['pockets', 'selectedId', 'selectedRiserId', 'snapEnabled', 'deckW']) {
		expect(design, key).not.toHaveProperty(key);
	}
	expect(design.stock).toMatchObject({ units: 'in' });
});

test('undoing the opening it just drew clears the selection with it', async ({ page }) => {
	await gotoEditor(page);
	await drawOpening(page);
	await expect(page.getByRole('heading', { name: /^Pocket 1$/ })).toBeVisible();

	await page.getByRole('button', { name: 'Undo' }).click();
	// The inspector falls back to the deck rather than pointing at nothing.
	await expect(page.getByRole('heading', { name: /^Pocket 1$/ })).toHaveCount(0);
	await expect(page.getByLabel(/Deck width/)).toBeVisible();
});

test('starts fresh over a draft this build cannot read, and replaces it', async ({ page }) => {
	// A bare document with no envelope, as no current build writes.
	const unreadable = {
		units: 'mm',
		deckW: 300,
		sheets: [{ id: 'deck', name: 'Deck' }],
		pockets: []
	};
	await page.addInitScript(
		([key, value]) => {
			// Only seed the first load, so the editor's own save is what we read.
			if (!sessionStorage.getItem('seeded')) {
				localStorage.setItem(key, value);
				sessionStorage.setItem('seeded', '1');
			}
		},
		[DRAFT_KEY, JSON.stringify(unreadable)] as const
	);
	await gotoEditor(page);

	await expect
		.poll(async () =>
			(await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY))?.includes('"format"')
		)
		.toBe(true);
	const design = (await readDraft(page))!;
	expect(design.workspaces).toHaveProperty('packaging');
	await expect(page.getByLabel(/Deck width/)).not.toHaveValue('300');
});
