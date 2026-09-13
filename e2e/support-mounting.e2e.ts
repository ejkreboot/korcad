import { expect, test, type Page } from '@playwright/test';
import { gotoEditor, readPackagingDraft } from './helpers.js';

/** The fields of a saved support these tests read. */
type Support = { h: number; heightMode: string; mount: { anchor: string } };

/**
 * Vertical placement, end to end: the anchor a support is built from, and the
 * height that follows from it. The arithmetic is unit-tested; what needs a
 * browser is that the controls are wired to it and that the 3D view agrees.
 */

const heightField = (page: Page) => page.getByLabel(/^Height \(/);
const wallField = (page: Page) => page.getByLabel(/^Wall \(/);
const mountSelect = (page: Page) => page.getByLabel('Assembly mount');
const heightModeSelect = (page: Page) => page.getByLabel('Height from');
const readout = (page: Page) => page.locator('.viewer-readout');

/**
 * Drags on the canvas in coordinates relative to the SVG box, matching the
 * editor's own tests. The sheet is drawn centred in a wider box, so only the
 * middle of the pane lands on the deck.
 */
async function dragOnCanvas(
	page: Page,
	from: { x: number; y: number },
	to: { x: number; y: number }
): Promise<void> {
	const box = (await page.locator('svg.drawing').boundingBox())!;
	await page.mouse.move(box.x + from.x, box.y + from.y);
	await page.mouse.down();
	await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 12 });
	await page.mouse.up();
}

/**
 * Clears the selection by clicking bare sheet, so the stock panel is reachable.
 * The square sheet is centred in a wider box, and its corner sits outside the
 * deck, so this is computed from the box rather than guessed in pixels — the
 * toolbar rewraps as buttons are added and shifts everything below it.
 */
async function deselect(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Select', exact: true }).click();
	const box = (await page.locator('svg.drawing').boundingBox())!;
	const sheetLeft = Math.max(0, (box.width - box.height) / 2);
	await page.mouse.click(box.x + sheetLeft + 12, box.y + 12);
}

/** Draws a riser box, which is the preset that spans to the deck. */
async function addRiser(page: Page, at: { x: number; y: number }): Promise<void> {
	await page.getByRole('button', { name: /^Support/ }).click();
	await page.getByRole('menuitem', { name: /Glued riser box/ }).click();
	await dragOnCanvas(page, at, { x: at.x + 90, y: at.y + 70 });
}

test('a new riser box spans to the deck instead of taking a loose height', async ({ page }) => {
	await gotoEditor(page);
	await addRiser(page, { x: 320, y: 150 });

	await expect(mountSelect(page)).toHaveValue('box-floor');
	await expect(heightModeSelect(page)).toHaveValue('span');
	// The default wall is 1.5in, and the riser fills exactly that cavity.
	await expect(heightField(page)).toHaveValue('1.5');
	// A derived height is not the operator's to type.
	await expect(heightField(page)).toHaveAttribute('readonly', '');
});

test('a spanning height follows the wall it has to meet', async ({ page }) => {
	await gotoEditor(page);
	await addRiser(page, { x: 320, y: 150 });
	await expect(heightField(page)).toHaveValue('1.5');

	// Clear the selection so the stock panel is reachable, then raise the wall.
	await deselect(page);
	await expect(wallField(page)).toBeVisible();
	await wallField(page).fill('2.25');

	// Read the stored document: the height is resolved on the way in, so the
	// riser now fills the taller cavity exactly. 2.25in is 57.15mm.
	await expect
		.poll(async () => {
			const packaging = await readPackagingDraft(page);
			const riser = (packaging?.supports as Support[] | undefined)?.[0];
			return riser ? { h: riser.h, mode: riser.heightMode, wall: packaging?.perimeterWall } : null;
		})
		.toEqual({ h: 57.15, mode: 'span', wall: 57.15 });
});

test('taking manual control of the height keeps the height it was showing', async ({ page }) => {
	await gotoEditor(page);
	await addRiser(page, { x: 320, y: 150 });

	await heightModeSelect(page).selectOption('fixed');
	// No jump: the fixed height starts from the span it replaced.
	await expect(heightField(page)).toHaveValue('1.5');
	await expect(heightField(page)).not.toHaveAttribute('readonly', '');

	await heightField(page).fill('0.75');
	await expect(heightField(page)).toHaveValue('0.75');
});

test('re-anchoring to the top of the deck drops the spanning height', async ({ page }) => {
	await gotoEditor(page);
	await addRiser(page, { x: 320, y: 150 });

	await mountSelect(page).selectOption('deck-top');
	await expect(mountSelect(page)).toHaveValue('deck-top');
	// Nothing above a step on the deck to span to, so it becomes a fixed height.
	await expect(heightModeSelect(page)).toHaveValue('fixed');
	await expect(page.locator('option[value="span"]')).toHaveAttribute('disabled', '');
});

test('offers the top of another support as an anchor, and says so in 3D', async ({ page }) => {
	await gotoEditor(page);
	await addRiser(page, { x: 320, y: 150 });
	await addRiser(page, { x: 560, y: 300 });

	// The second riser can stand on the first.
	await mountSelect(page).selectOption({ label: 'Top of Riser 1' });
	await expect(mountSelect(page)).toHaveValue(/^support:/);

	await page.getByRole('button', { name: '3D', exact: true }).click();
	await expect(page.locator('.viewer-loading')).toHaveCount(0);
	await expect(readout(page)).toContainText('Riser 2');
	// The viewer names the surface, not a Z height.
	await expect(readout(page)).toContainText('on Riser 1');
});

test('never offers a support itself as its own anchor', async ({ page }) => {
	await gotoEditor(page);
	await addRiser(page, { x: 320, y: 150 });
	await addRiser(page, { x: 560, y: 300 });

	// Riser 2 is selected: it may stand on Riser 1, but never on itself.
	const options = await mountSelect(page).locator('option').allTextContents();
	expect(options).toContain('Box floor');
	expect(options).toContain('Top of Riser 1');
	expect(options).not.toContain('Top of Riser 2');
});

test('a tray is locked under the deck', async ({ page }) => {
	await gotoEditor(page);
	await page.getByRole('button', { name: /^Support/ }).click();
	await page.getByRole('menuitem', { name: /Recessed tray/ }).click();
	await dragOnCanvas(page, { x: 320, y: 320 }, { x: 440, y: 400 });

	await expect(mountSelect(page)).toHaveValue('deck-underside');
	await expect(mountSelect(page)).toBeDisabled();
	// A tray's depth is its own, never derived from the deck.
	await expect(heightModeSelect(page)).toHaveCount(0);
});

test('blocks export when a fixed height cannot fit under the deck', async ({ page }) => {
	await gotoEditor(page);
	await addRiser(page, { x: 320, y: 150 });
	await heightModeSelect(page).selectOption('fixed');
	await heightField(page).fill('4');

	await expect(page.locator('.status.error')).toContainText(
		'stands taller than the space under the top deck'
	);
	await expect(page.getByRole('button', { name: 'G-code' })).toBeDisabled();
});

test('dragging a support in 3D re-anchors it instead of setting a bare height', async ({
	page
}) => {
	await gotoEditor(page);
	// A wide, low riser to land on, and a small one to drop onto it.
	await addRiser(page, { x: 300, y: 140 });
	await heightModeSelect(page).selectOption('fixed');
	await heightField(page).fill('0.5');
	await addRiser(page, { x: 560, y: 320 });
	await heightModeSelect(page).selectOption('fixed');
	await heightField(page).fill('0.5');

	await page.getByRole('button', { name: '3D', exact: true }).click();
	await expect(page.locator('.viewer-loading')).toHaveCount(0);
	// Both new supports start at the deck origin, so the second already sits over
	// the first: releasing it there is what commits the relationship.
	await expect(readout(page)).toContainText('Riser 2');

	const canvas = (await page.locator('.assembly-viewer canvas').boundingBox())!;
	const cx = canvas.x + canvas.width / 2;
	const cy = canvas.y + canvas.height / 2;
	// Grab whatever is under the near-bottom of the view, where the deck origin
	// projects, and nudge it.
	await page.mouse.move(cx, cy + canvas.height * 0.16);
	await page.mouse.down();
	await page.mouse.move(cx + 12, cy + canvas.height * 0.16 - 8, { steps: 8 });
	await page.mouse.up();

	// However the drag landed, the document only ever holds a named anchor.
	const packaging = await readPackagingDraft(page);
	const mounts = ((packaging?.supports as Support[] | undefined) ?? []).map(
		(support) => support.mount.anchor
	);
	expect(mounts.length).toBe(2);
	for (const anchor of mounts) {
		expect(['box-floor', 'deck-top', 'deck-underside', 'support-top']).toContain(anchor);
	}
	// Nothing anywhere records a loose Z height.
	const hasAssemblyZ = await page.evaluate(() => {
		const raw = localStorage.getItem('voisee-insert-generator-v02');
		return raw ? raw.includes('assemblyZ') : true;
	});
	expect(hasAssemblyZ).toBe(false);
});
