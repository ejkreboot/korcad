import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { gotoEditor } from './helpers.js';

/**
 * The table surface map. It is entered by hand, kept in the browser apart from
 * the design, and bends exported programs to follow the table. What needs a
 * browser is that the grid edits the stored map, that a map that is on gates
 * export like any other problem, and that the exported program follows it.
 */

const storedMap = (page: Page) =>
	page.evaluate(() => {
		const stored = localStorage.getItem('korcad-surface-map');
		return stored ? (JSON.parse(stored) as Record<string, unknown>) : null;
	});

async function openSurfacePanel(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Table surface', exact: true }).click();
	await expect(page.getByLabel('Cut following this map')).toBeVisible();
}

test('follows a table entered by hand, and blocks export on a reading that cannot be right', async ({
	page
}) => {
	await gotoEditor(page);
	await openSurfacePanel(page);

	await page.getByLabel('Columns').selectOption('2');
	await page.getByLabel('Rows').selectOption('2');
	await expect(page.getByRole('group', { name: 'Table heights' }).locator('input')).toHaveCount(4);
	// The document opens in inches, and the grid stands half an inch in from the edges:
	// the back right point is 40 thou high.
	await page.getByLabel('Z at X23.5 Y23.5').fill('0.04');
	await page.getByLabel('Cut following this map').check();
	await expect
		.poll(async () => (await storedMap(page))?.heights)
		.toEqual([0, 0, 0, expect.closeTo(1.016, 6)]);
	await expect.poll(async () => (await storedMap(page))?.enabled).toBe(true);
	// The map belongs to the table, so it never enters the design.
	expect(await page.evaluate(() => localStorage.getItem('korcad-draft'))).not.toContain('heights');

	// A reading a whole inch out is far likelier a typo than a table.
	await page.getByLabel('Z at X23.5 Y23.5').fill('1');
	await expect(page.locator('.status.error')).toContainText('Surface map: heights span 25.4 mm');
	await expect(page.getByRole('button', { name: 'G-code' })).toBeDisabled();

	await page.getByLabel('Z at X23.5 Y23.5').fill('0.04');
	await expect(page.getByRole('button', { name: 'G-code' })).toBeEnabled();
	await page.getByRole('button', { name: 'Table surface', exact: true }).click();
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'G-code' }).click();
	const program = await readFile((await (await download).path())!, 'utf8');
	expect(program).toContain(
		'; Surface map: 2 x 2 points, 12.7 mm in from the edges; table 0 to 1.016 mm from X0 Y0; set Z zero at X0 Y0'
	);
	expect(program).toMatch(/^G1 X[\d.]+ Y[\d.]+ Z-?[\d.]+ F\d+$/m);
});

test('keeps the map across a reload, and leaves programs alone while it is off', async ({
	page
}) => {
	await gotoEditor(page);
	await openSurfacePanel(page);
	// The edges of the grid say where its columns (X) and rows (Y) stand, and follow the inset.
	const grid = page.getByRole('group', { name: 'Table heights' });
	await expect(grid.locator('.surface-axis.column')).toHaveText(['0.5', '12', '23.5']);
	await page.getByLabel('Inset from edges (in)').fill('1');
	await page.getByLabel('Inset from edges (in)').press('Enter');
	await expect(grid.locator('.surface-axis.row')).toHaveText(['23', '12', '1']);
	await expect.poll(async () => (await storedMap(page))?.inset).toBeCloseTo(25.4, 6);
	await expect(page.getByLabel('Z at X1 Y1', { exact: true })).toBeVisible();

	await page.getByLabel('Z at X12 Y12').fill('0.01');
	await expect
		.poll(async () => (await storedMap(page))?.heights)
		.toContainEqual(expect.closeTo(0.254, 6));

	// Dropping the draft makes the reloaded editor write it again, which is how gotoEditor knows it has hydrated.
	await page.evaluate(() => localStorage.removeItem('korcad-draft'));
	await gotoEditor(page);
	await openSurfacePanel(page);
	await expect(page.getByLabel('Z at X12 Y12')).toHaveValue('0.01');
	await expect(page.getByLabel('Cut following this map')).not.toBeChecked();

	await page.getByRole('button', { name: 'Table surface', exact: true }).click();
	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'G-code' }).click();
	const program = await readFile((await (await download).path())!, 'utf8');
	expect(program).not.toContain('Surface map');
});
