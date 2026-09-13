import { expect, test, type Page } from '@playwright/test';
import { gotoEditor, readDraft } from './helpers.js';

/**
 * The workspace switcher and machine profile management. The switcher shows a
 * sheet of the chosen workspace — adding one if there is none — and brings
 * that workspace's tools; packaging keeps working exactly as before. Profiles
 * can be added, duplicated, assigned, and deleted from the Machine panel.
 */

const switcher = (page: Page) => page.getByRole('button', { name: /^Workspace:/ });

async function switchTo(page: Page, label: RegExp): Promise<void> {
	await switcher(page).click();
	await page.getByRole('menuitemradio', { name: label }).click();
}

type Draft = {
	machineProfiles: { id: string; name: string; cutDepth: number }[];
	sheets: { id: string; name: string; workspace: string; machineProfileId: string }[];
};
const draft = async (page: Page) => (await readDraft(page)) as unknown as Draft;

test('switching workspace changes the tools, and packaging is untouched', async ({ page }) => {
	await gotoEditor(page);
	await expect(switcher(page)).toHaveAccessibleName('Workspace: Folded Packaging');
	await expect(page.getByRole('button', { name: 'Cutout' })).toBeVisible();

	// Arm a packaging tool, then leave: it must not follow onto the Solid sheet.
	await page.getByRole('button', { name: 'Cutout' }).click();
	await page.getByRole('menuitem', { name: /Product opening/ }).click();
	await switchTo(page, /Solid/);

	// No Solid sheet existed, so one is added and shown.
	await expect(page.getByRole('tab', { name: 'Plate 1' })).toHaveAttribute('aria-selected', 'true');
	await expect(switcher(page)).toHaveAccessibleName('Workspace: Solid');
	await expect(page.getByRole('button', { name: 'Part', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Cutout' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);

	await switchTo(page, /Folded Packaging/);
	await expect(page.getByRole('tab', { name: 'Deck' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('button', { name: 'Cutout' })).toBeVisible();
	await expect(page.getByLabel(/Deck width/)).toHaveValue('18');

	// Switching back to Solid reuses the plate rather than adding another.
	await switchTo(page, /Solid/);
	await expect(page.getByRole('tab', { name: /^Plate/ })).toHaveCount(1);
	expect((await draft(page)).sheets.map((sheet) => sheet.workspace)).toEqual([
		'packaging',
		'solid'
	]);
});

test('starts a new project in a chosen workspace, and undo brings the old one back', async ({
	page
}) => {
	await gotoEditor(page);
	await page.getByLabel(/Deck width/).fill('12');
	await page.getByLabel(/Deck width/).blur();

	page.once('dialog', (dialog) => dialog.accept());
	await page.getByRole('button', { name: 'New project' }).click();
	await page.getByRole('menuitem', { name: /Solid/ }).click();

	await expect(switcher(page)).toHaveAccessibleName('Workspace: Solid');
	await expect(page.getByRole('tab')).toHaveCount(1);
	await expect(page.getByRole('tab', { name: 'Plate 1' })).toHaveAttribute('aria-selected', 'true');
	await expect
		.poll(async () => (await draft(page)).sheets.map((sheet) => sheet.workspace))
		.toEqual(['solid']);

	// Packaging added to a Solid project gets a deck of its own.
	await switchTo(page, /Folded Packaging/);
	await expect(page.getByRole('tab', { name: 'Deck' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByLabel(/Deck width/)).toHaveValue('18');

	await page.getByRole('button', { name: 'Undo' }).click();
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByRole('tab')).toHaveCount(1);
	await expect(page.getByLabel(/Deck width/)).toHaveValue('12');
});

test('keeps the design when a new project is declined', async ({ page }) => {
	await gotoEditor(page);
	await switchTo(page, /Solid/);
	page.once('dialog', (dialog) => dialog.dismiss());
	await page.getByRole('button', { name: 'New project' }).click();
	await page.getByRole('menuitem', { name: /Folded Packaging/ }).click();
	await expect(page.getByRole('tab')).toHaveCount(2);
	await expect(switcher(page)).toHaveAccessibleName('Workspace: Solid');
});

async function openMachinePanel(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Machine' }).click();
	await expect(page.getByLabel('Profile name')).toBeVisible();
}

test('adds, duplicates, assigns, and deletes machine profiles', async ({ page }) => {
	await gotoEditor(page);
	await openMachinePanel(page);
	const panel = page.getByRole('group', { name: 'Machine profiles' });
	await expect(panel.getByRole('button', { name: 'Delete' })).toBeDisabled();

	await page.getByLabel(/^Cut depth/).fill('0.1');
	await panel.getByRole('button', { name: 'Duplicate' }).click();
	await expect(page.getByLabel('Profile name')).toHaveValue('Drag knife copy');
	// The copy carries every setting, and the deck is now cut on it.
	await expect(page.getByLabel(/^Cut depth/)).toHaveValue('0.1');
	await expect(page.getByLabel('Cut on')).toHaveValue((await draft(page)).machineProfiles[1]!.id);

	await panel.getByRole('button', { name: 'New' }).click();
	await expect(page.getByLabel('Profile name')).toHaveValue('New profile');
	await expect.poll(async () => (await draft(page)).machineProfiles.length).toBe(3);

	// Back onto the original profile by choosing it.
	await page.getByLabel('Cut on').selectOption({ label: 'Drag knife' });
	await expect(page.getByLabel('Profile name')).toHaveValue('Drag knife');

	// Deleting names the sheets that move, and where they go.
	let message = '';
	page.once('dialog', async (dialog) => {
		message = dialog.message();
		await dialog.accept();
	});
	await panel.getByRole('button', { name: 'Delete' }).click();
	expect(message).toBe(
		'Delete the Drag knife profile? Deck will be cut on Drag knife copy instead.'
	);
	await expect(page.getByLabel('Profile name')).toHaveValue('Drag knife copy');
	const saved = await draft(page);
	expect(saved.machineProfiles.map((profile) => profile.name)).toEqual([
		'Drag knife copy',
		'New profile'
	]);
	expect(saved.sheets[0]!.machineProfileId).toBe(saved.machineProfiles[0]!.id);
});

test('keeps a profile when its deletion is cancelled', async ({ page }) => {
	await gotoEditor(page);
	await openMachinePanel(page);
	await page
		.getByRole('group', { name: 'Machine profiles' })
		.getByRole('button', { name: 'New' })
		.click();
	page.once('dialog', (dialog) => dialog.dismiss());
	await page
		.getByRole('group', { name: 'Machine profiles' })
		.getByRole('button', { name: 'Delete' })
		.click();
	await expect(page.getByLabel('Profile name')).toHaveValue('New profile');
	expect((await draft(page)).machineProfiles).toHaveLength(2);
});
