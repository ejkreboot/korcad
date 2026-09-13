import { expect, test, type Page } from '@playwright/test';
import { DRAFT_KEY, gotoEditor, readDraft, readPackagingDraft } from './helpers.js';

/**
 * The saved document, version 8: generic settings at the top, each workspace's
 * data under `workspaces`, and editor state — selection, snap — not saved at
 * all. The shape is unit-tested; what needs a browser is that the editor writes
 * it, and still opens a draft an earlier build left behind.
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

test('opens a bare draft saved by an earlier build and rewrites it', async ({ page }) => {
	const legacy = {
		units: 'mm',
		fabricationMode: 'knife',
		cutDepth: 2.5,
		deckW: 300,
		snapEnabled: true,
		sheets: [{ id: 'deck', name: 'Deck' }],
		activeSheetId: 'deck',
		selectedId: null,
		pockets: [],
		selectedRiserId: null,
		risers: []
	};
	await page.addInitScript(
		([key, value]) => {
			// Only seed the first load, so the editor's own save is what we read.
			if (!sessionStorage.getItem('seeded')) {
				localStorage.setItem(key, value);
				sessionStorage.setItem('seeded', '1');
			}
		},
		[DRAFT_KEY, JSON.stringify(legacy)] as const
	);
	await gotoEditor(page);

	await expect
		.poll(async () =>
			(await page.evaluate((key) => localStorage.getItem(key), DRAFT_KEY))?.includes('"format"')
		)
		.toBe(true);
	const design = (await readDraft(page))!;
	expect((await readPackagingDraft(page))?.deckW).toBe(300);
	expect(design.stock).toMatchObject({ units: 'mm' });
	expect((design.machineProfiles as { cutDepth: number }[])[0]?.cutDepth).toBe(2.5);
	await expect(page.getByLabel(/Deck width/)).toHaveValue('300');
});
