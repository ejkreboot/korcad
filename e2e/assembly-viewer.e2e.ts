import { expect, test, type Page } from '@playwright/test';
import { gotoEditor } from './helpers.js';

/**
 * The 3D viewer can only be checked in a real browser: it needs WebGL, a
 * measured canvas, and pointer gestures. These tests assert what the core
 * unit tests cannot — that it actually paints, that its controls work, and
 * that it fits both a desktop pane and a phone.
 */

const viewer = (page: Page) => page.locator('.assembly-viewer canvas');
const readout = (page: Page) => page.locator('.viewer-readout');

async function openViewer(page: Page): Promise<void> {
	await page.getByRole('button', { name: '3D', exact: true }).click();
	await expect(viewer(page)).toBeVisible();
	// The renderer is loaded on demand, so wait for the loading notice to clear.
	await expect(page.locator('.viewer-loading')).toHaveCount(0);
}

/**
 * A shaded render compresses to far more bytes than a flat fill, so PNG size
 * distinguishes a painted scene from a blank canvas without reading back the
 * WebGL drawing buffer (which the renderer does not preserve).
 */
async function renderBytes(page: Page): Promise<number> {
	return (await viewer(page).screenshot()).byteLength;
}

/**
 * Draws a recessed tray centred on the deck, which is also the centre of the
 * sheet. A tray takes its assembly position from where it is drawn — a riser
 * box is instead mounted to the box floor at the deck origin — so this is the
 * support whose position in the 3D view is known from the gesture that made it.
 */
async function addCentredTray(page: Page): Promise<void> {
	await page.getByRole('button', { name: /^Support/ }).click();
	await page.getByRole('menuitem', { name: /Recessed tray/ }).click();
	const box = (await page.locator('svg.drawing').boundingBox())!;
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	await page.mouse.move(cx - 45, cy - 45);
	await page.mouse.down();
	await page.mouse.move(cx + 45, cy + 45, { steps: 10 });
	await page.mouse.up();
}

test('renders a non-blank assembly and reports no page errors', async ({ page }) => {
	const failures: string[] = [];
	page.on('pageerror', (error) => failures.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') failures.push(message.text());
	});

	await gotoEditor(page);
	await openViewer(page);

	const box = (await viewer(page).boundingBox())!;
	expect(box.width).toBeGreaterThan(300);
	expect(box.height).toBeGreaterThan(200);
	// A blank fill would compress to a few kilobytes at this size.
	expect(await renderBytes(page)).toBeGreaterThan(15_000);
	await expect(readout(page)).toBeVisible();
	expect(failures).toEqual([]);
});

test('fades the deck without hiding the supports inside it', async ({ page }) => {
	await gotoEditor(page);
	await addCentredTray(page);
	await openViewer(page);

	const solid = await renderBytes(page);
	await page.locator('.viewer-controls select').selectOption('0.22');
	const ghosted = await renderBytes(page);
	expect(ghosted).not.toBe(solid);

	// With the deck hidden the support must still be drawn.
	await page.locator('.viewer-controls select').selectOption('0');
	expect(await renderBytes(page)).toBeGreaterThan(15_000);
});

test('pressing a tray orbits the camera instead of moving the tray', async ({ page }) => {
	await gotoEditor(page);
	await addCentredTray(page);
	await openViewer(page);

	// The camera is fitted on the deck centre, so the tray drawn there sits at
	// the centre of the canvas.
	const box = (await viewer(page).boundingBox())!;
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	await expect(readout(page)).toContainText('Recessed tray 1');
	const before = (await readout(page).textContent())!;
	const rendered = await renderBytes(page);

	await page.mouse.move(cx, cy);
	await page.mouse.down();
	await page.mouse.move(cx + 90, cy - 40, { steps: 12 });
	await page.mouse.up();

	// The camera moved, and the tray did not.
	expect(await readout(page).textContent()).toBe(before);
	expect(await renderBytes(page)).not.toBe(rendered);
});

test('orbits without moving the support', async ({ page }) => {
	await gotoEditor(page);
	await addCentredTray(page);
	await openViewer(page);

	const box = (await viewer(page).boundingBox())!;
	const before = (await readout(page).textContent())!;
	// Empty space near a corner of the pane belongs to the camera, not a part.
	await page.mouse.move(box.x + 24, box.y + box.height - 24);
	await page.mouse.down();
	await page.mouse.move(box.x + 160, box.y + box.height - 80, { steps: 12 });
	await page.mouse.up();

	expect(await readout(page).textContent()).toBe(before);
});

test('keeps the design when switching between the flat sheet and the assembly', async ({
	page
}) => {
	await gotoEditor(page);
	await addCentredTray(page);
	await openViewer(page);
	await expect(page.locator('svg.drawing')).toHaveCount(0);

	await page.getByRole('button', { name: '2D', exact: true }).click();
	await expect(page.locator('svg.drawing')).toBeVisible();
	await expect(viewer(page)).toHaveCount(0);

	await openViewer(page);
	await expect(readout(page)).toContainText('Recessed tray 1');
	expect(await renderBytes(page)).toBeGreaterThan(15_000);
});

test('fits a phone viewport without overlapping its own controls', async ({ page }) => {
	await page.setViewportSize({ width: 420, height: 820 });
	await gotoEditor(page);
	await openViewer(page);

	const canvas = (await viewer(page).boundingBox())!;
	// The canvas must not force the page to scroll sideways.
	expect(canvas.width).toBeLessThanOrEqual(420);
	expect(canvas.height).toBeGreaterThan(150);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
		true
	);

	const controls = (await page.locator('.viewer-controls').boundingBox())!;
	const text = (await readout(page).boundingBox())!;
	// Controls sit top-right and the readout bottom-left, so neither can cover
	// the other however narrow the pane is.
	const overlaps =
		controls.x < text.x + text.width &&
		text.x < controls.x + controls.width &&
		controls.y < text.y + text.height &&
		text.y < controls.y + controls.height;
	expect(overlaps).toBe(false);

	// Both stay inside the canvas rather than spilling over the editor chrome.
	// A 2px slack absorbs sub-pixel layout rounding of the canvas box itself.
	const slack = 2;
	for (const item of [controls, text]) {
		expect(item.x).toBeGreaterThanOrEqual(canvas.x - slack);
		expect(item.x + item.width).toBeLessThanOrEqual(canvas.x + canvas.width + slack);
		expect(item.y).toBeGreaterThanOrEqual(canvas.y - slack);
		expect(item.y + item.height).toBeLessThanOrEqual(canvas.y + canvas.height + slack);
	}

	expect(await renderBytes(page)).toBeGreaterThan(10_000);
});
