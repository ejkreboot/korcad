import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { gotoEditor } from './helpers.js';

/**
 * Material presets and table surfaces saved to files and opened again. The
 * File System Access pickers are native dialogs Playwright cannot drive, so
 * they are taken away and the download and file input that stand in for them
 * elsewhere are what is exercised.
 */

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'showOpenFilePicker', { value: undefined });
		Object.defineProperty(window, 'showSaveFilePicker', { value: undefined });
	});
});

/** Clicks a button that downloads a file, answering the name prompt if one comes, and reads it. */
async function saveFile(page: Page, button: string, group: string, name?: string) {
	if (name) page.once('dialog', (dialog) => void dialog.accept(name));
	const download = page.waitForEvent('download');
	await page
		.getByRole('group', { name: group })
		.getByRole('button', { name: button, exact: true })
		.click();
	const file = await download;
	return { name: file.suggestedFilename(), text: await readFile((await file.path())!, 'utf8') };
}

async function openFile(page: Page, group: string, name: string, text: string) {
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('group', { name: group }).getByRole('button', { name: 'Open…' }).click();
	await (await chooser).setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
}

test('saves the material to a preset, says when it has changed, and opens it again', async ({
	page
}) => {
	await gotoEditor(page);
	await page.getByRole('button', { name: 'Material', exact: true }).click();
	const group = 'Material preset file';
	await expect(page.getByText('No preset file.')).toBeVisible();

	await page.getByLabel('Thickness (in)', { exact: true }).fill('0.25');
	await page.getByLabel('Grain direction').selectOption('x');
	const saved = await saveFile(page, 'Save', group, 'birch quarter');
	expect(saved.name).toBe('birch quarter.korcad-material.json');
	const preset = JSON.parse(saved.text) as {
		format: string;
		stock: Record<string, unknown>;
		workspaces: Record<string, unknown>;
	};
	expect(preset.format).toBe('korcad-material');
	expect(preset.stock).toMatchObject({ material: 6.35, grainDirection: 'x' });
	expect(preset.stock).not.toHaveProperty('units');
	expect(Object.keys(preset.workspaces)).toEqual(['packaging']);

	const panel = page.locator('.file-link').first();
	await expect(panel).toContainText('birch quarter.korcad-material.json');
	await expect(panel).not.toContainText('Unsaved changes');
	await page.getByLabel('Thickness (in)', { exact: true }).fill('0.125');
	await expect(panel).toContainText('Unsaved changes');

	// The link survives a reload, and still knows what the file held.
	await page.reload();
	await page.getByRole('button', { name: 'Material', exact: true }).click();
	await expect(page.locator('.file-link').first()).toContainText('Unsaved changes');
	// The panel's header says so too, so it is seen while the panel is folded.
	await expect(page.locator('.panel-status').first()).toHaveText('birch quarter');
	await expect(page.locator('.panel-badge').first()).toHaveText('unsaved');

	await openFile(page, group, 'birch quarter.korcad-material.json', saved.text);
	await expect(page.getByLabel('Thickness (in)', { exact: true })).toHaveValue('0.25');
	await expect(page.locator('.file-link').first()).not.toContainText('Unsaved changes');

	// Saving again writes to the linked name without asking.
	await page.getByLabel('Tab width (in)').fill('0.2');
	expect((await saveFile(page, 'Save', group)).name).toBe('birch quarter.korcad-material.json');
	await expect(page.locator('.file-link').first()).not.toContainText('Unsaved changes');

	await openFile(page, group, 'design.json', '{"format":"korcad-design"}');
	await expect(page.getByRole('alert')).toHaveText('This is not a KorCad material preset.');
});

test('saves the table surface to a file and opens it again, leaving following as it was', async ({
	page
}) => {
	await gotoEditor(page);
	await page.getByRole('button', { name: 'Table surface', exact: true }).click();
	const group = 'Table surface file';
	await page.getByLabel('Columns').selectOption('2');
	await page.getByLabel('Rows').selectOption('2');
	await page.getByLabel('Z at X23.5 Y23.5').fill('0.04');

	const saved = await saveFile(page, 'Save', group, 'shop table');
	expect(saved.name).toBe('shop table.korcad-surface.json');
	const file = JSON.parse(saved.text) as Record<string, unknown>;
	expect(file).toMatchObject({ format: 'korcad-table-surface', columns: 2, rows: 2 });
	expect(file).not.toHaveProperty('enabled');

	const link = page.locator('.file-link').first();
	await expect(link).toContainText('shop table.korcad-surface.json');
	await page.getByLabel('Z at X23.5 Y23.5').fill('0.05');
	await expect(link).toContainText('Unsaved changes');

	await page.getByLabel('Cut following this map').check();
	// The heights here are in no file, so opening another asks first.
	page.once('dialog', (dialog) => void dialog.accept());
	await openFile(page, group, 'shop table.korcad-surface.json', saved.text);
	await expect(page.getByLabel('Z at X23.5 Y23.5')).toHaveValue('0.04');
	await expect(link).not.toContainText('Unsaved changes');
	await expect(page.getByLabel('Cut following this map')).toBeChecked();
});
