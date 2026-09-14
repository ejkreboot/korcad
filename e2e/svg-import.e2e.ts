import { expect, test } from '@playwright/test';
import { gotoEditor, readPackagingDraft } from './helpers.js';

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
