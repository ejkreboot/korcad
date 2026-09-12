import { expect, test, type Page } from '@playwright/test';
import { gotoEditor, readDraft } from './helpers.js';

/**
 * Machine profiles in the editor.
 *
 * The thirteen machine settings used to live on the document, so changing the
 * cut depth changed it for the whole job. They now belong to a named profile
 * that each sheet references, which is what lets one job hold a creased deck
 * and a routed plate. What needs a browser is that the panel edits the profile
 * rather than the document, and that a saved draft carries the new shape.
 */

type Draft = {
	machineProfiles?: { id: string; name: string; cutDepth: number }[];
	sheets?: { id: string; name: string; machineProfileId: string }[];
} & Record<string, unknown>;

const draft = async (page: Page) => (await readDraft(page)) as Draft;

async function openMachinePanel(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Machine' }).click();
	await expect(page.getByLabel('Profile name')).toBeVisible();
}

test('names the profile the active sheet is cut on', async ({ page }) => {
	await gotoEditor(page);
	await openMachinePanel(page);

	await expect(page.getByLabel('Profile name')).toHaveValue('Drag knife');
	// The panel says whose settings these are, so a shared edit is not a surprise.
	await expect(page.locator('.panel', { hasText: 'Profile name' })).toContainText('Drag knife');
	await expect(page.locator('.panel', { hasText: 'Profile name' })).toContainText('Deck');

	const saved = await draft(page);
	expect(saved.machineProfiles).toHaveLength(1);
	expect(saved.sheets?.[0]?.machineProfileId).toBe(saved.machineProfiles?.[0]?.id);
	// The settings left the document when they moved into the profile.
	for (const key of ['cutDepth', 'fabricationMode', 'bladeOffset', 'spindleSpeed']) {
		expect(saved, key).not.toHaveProperty(key);
	}
});

test('writes a machine setting to the profile, not the document', async ({ page }) => {
	await gotoEditor(page);
	await openMachinePanel(page);

	await page.getByLabel(/^Cut depth/).fill('0.2');
	await expect
		.poll(async () => (await draft(page)).machineProfiles?.[0]?.cutDepth)
		.toBeCloseTo(5.08, 2);
	expect(await draft(page)).not.toHaveProperty('cutDepth');
});

test('renames a profile without disturbing the sheets that use it', async ({ page }) => {
	await gotoEditor(page);
	await openMachinePanel(page);

	await page.getByLabel('Profile name').fill('Shop knife');
	await expect.poll(async () => (await draft(page)).machineProfiles?.[0]?.name).toBe('Shop knife');
	const saved = await draft(page);
	// The id is the reference, so a rename cannot orphan a sheet.
	expect(saved.sheets?.[0]?.machineProfileId).toBe(saved.machineProfiles?.[0]?.id);
	await expect(page.locator('.panel', { hasText: 'Profile name' })).toContainText('Shop knife');
});

test('cuts a new sheet on the machine already in use', async ({ page }) => {
	await gotoEditor(page);
	await page.getByRole('tab', { name: 'Deck' }).waitFor();
	await page.getByRole('button', { name: 'Add a parts sheet' }).click();

	await expect.poll(async () => (await draft(page)).sheets?.length).toBe(2);
	const saved = await draft(page);
	const profileId = saved.machineProfiles?.[0]?.id;
	expect(saved.sheets?.every((sheet) => sheet.machineProfileId === profileId)).toBe(true);
});

test('switching fabrication mode still gates the support tools', async ({ page }) => {
	await gotoEditor(page);
	await openMachinePanel(page);

	// Supports are folded parts, so a router profile disables drawing them.
	await page.getByLabel('Fabrication').selectOption('router');
	await expect(page.getByRole('button', { name: 'Support', exact: true })).toBeDisabled();
	await expect(page.getByLabel(/Bit diameter/)).toBeVisible();

	await page.getByLabel('Fabrication').selectOption('knife');
	await expect(page.getByRole('button', { name: 'Support', exact: true })).toBeEnabled();
	await expect(page.getByLabel(/Bit diameter/)).toHaveCount(0);
});
