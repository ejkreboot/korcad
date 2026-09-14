import { expect, test, type Page } from '@playwright/test';
import { gotoEditor, readDraft, readPackagingDraft } from './helpers.js';

/**
 * SVG import from a drawing tool's menu. On the packaging deck a drawn product
 * outline becomes an opening of its own shape; the Flat Parts case lives with
 * the rest of that workspace's tests.
 */

const PRODUCT = `<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="80mm" viewBox="0 0 120 80">
	<path d="M0 20 A20 20 0 0 1 20 0 H100 L120 30 V80 H0 Z"/>
	<circle cx="60" cy="40" r="6"/>
</svg>`;

test('the Cutout menu imports an SVG outline as a deck opening', async ({ page }) => {
	await gotoEditor(page);
	await expect(page.getByRole('button', { name: 'Import SVG' })).toHaveCount(0);

	await page.getByRole('button', { name: 'Cutout' }).click();
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('menuitem', { name: /Import SVG/ }).click();
	await (
		await chooser
	).setFiles({ name: 'voisee-hub.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(PRODUCT) });

	await expect(page.getByRole('heading', { name: 'voisee-hub' })).toBeVisible();
	await expect(page.locator('.badge')).toContainText('Imported profile');
	await expect(page.locator('.status.ok')).toContainText(
		'Imported 1 opening from voisee-hub.svg (120 × 80 mm), centred on the deck.'
	);

	const data = (await readPackagingDraft(page))!;
	const pockets = data.pockets as { name: string; shape: string; w: number; h: number }[];
	expect(pockets).toHaveLength(1);
	expect(pockets[0]).toMatchObject({ name: 'voisee-hub', shape: 'profile', w: 120, h: 80 });
});

/** Three letters, spaced for a router's web and bit: a logo, in effect. */
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="130mm" height="50mm" viewBox="0 0 130 50">
	<rect x="0" y="0" width="30" height="50"/>
	<rect x="50" y="0" width="30" height="50"/>
	<rect x="100" y="0" width="30" height="50"/>
</svg>`;

async function importLogo(page: Page, tool: string): Promise<void> {
	await page.getByRole('button', { name: tool, exact: true }).click();
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('menuitem', { name: /Import SVG/ }).click();
	await (
		await chooser
	).setFiles({ name: 'acme.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(LOGO) });
}

/** Presses a hit target near its lower-left corner, clear of any handle drawn over its centre. */
async function pressTarget(page: Page, selector: string): Promise<void> {
	const box = (await page.locator(selector).first().boundingBox())!;
	await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.7);
}

test('a logo imported to the deck scales and rotates as one group', async ({ page }) => {
	await gotoEditor(page);
	// With nothing imported selected there is nothing to rotate.
	await expect(page.getByRole('button', { name: 'Rotate left' })).toBeDisabled();
	await importLogo(page, 'Cutout');
	await expect(page.getByRole('heading', { name: 'acme' })).toBeVisible();
	await expect(page.locator('.badge')).toContainText('Imported group · 3 openings');

	// Clicking one letter selects the whole drawing.
	await page.getByRole('button', { name: 'Select', exact: true }).click();
	await pressTarget(page, '[data-pocket]');
	await expect(page.getByRole('heading', { name: 'acme' })).toBeVisible();

	const width = page.getByLabel(/^Width/);
	const before = Number(await width.inputValue());
	await width.fill(String(before / 2));
	await width.press('Enter');
	await expect(page.getByLabel(/^Height/)).toHaveValue(String(Number((50 / 2 / 25.4).toFixed(3))));

	const data = (await readPackagingDraft(page))!;
	const pockets = data.pockets as { w: number; h: number }[];
	// The field shows inches to three places, so sizes land within a hundredth of a millimetre.
	const tenth = (value: number) => Math.round(value * 10) / 10;
	expect(pockets.map((pocket) => [tenth(pocket.w), tenth(pocket.h)])).toEqual([
		[15, 25],
		[15, 25],
		[15, 25]
	]);

	// Six 15° steps stand the halved logo on end, and six back return it.
	const left = page.getByRole('button', { name: 'Rotate left' });
	const right = page.getByRole('button', { name: 'Rotate right' });
	const size = String(Number((65 / 25.4).toFixed(3)));
	for (let step = 0; step < 6; step++) await left.click();
	await expect(page.getByLabel(/^Height/)).toHaveValue(size);
	for (let step = 0; step < 6; step++) await right.click();
	await expect(page.getByLabel(/^Width/)).toHaveValue(size);
});

test('a logo imported to Flat Parts moves and scales as one group', async ({ page }) => {
	await gotoEditor(page);
	await page.getByRole('button', { name: 'Add a sheet' }).click();
	await page.getByRole('menuitem', { name: /Flat Parts sheet/ }).click();
	await importLogo(page, 'Part');
	await expect(page.getByRole('heading', { name: 'acme' })).toBeVisible();
	await expect(page.locator('.badge')).toContainText('Imported group · 3 parts, 0 holes');

	await page.getByRole('button', { name: 'Select', exact: true }).click();
	await pressTarget(page, '[data-flat-parts-entity]');
	await expect(page.getByRole('heading', { name: 'acme' })).toBeVisible();
	await page.getByLabel('Holding tabs').fill('2');
	await page.getByLabel('Holding tabs').press('Enter');
	const width = page.getByLabel(/^Width/);
	await width.fill(String(Number(await width.inputValue()) * 2));
	await width.press('Enter');

	await expect
		.poll(async () => {
			const design = (await readDraft(page))!;
			const flatParts = (
				design.workspaces as {
					flatParts: {
						sheets: Record<string, { entities: { w: number; h: number; tabCount: number }[] }>;
					};
				}
			).flatParts;
			// Inch fields round to three places, so compare to a tenth of a millimetre.
			const tenth = (value: number) => Math.round(value * 10) / 10;
			return Object.values(flatParts.sheets)[0]!.entities.map((entity) => [
				tenth(entity.w),
				tenth(entity.h),
				entity.tabCount
			]);
		})
		.toEqual([
			[60, 100, 2],
			[60, 100, 2],
			[60, 100, 2]
		]);
});
