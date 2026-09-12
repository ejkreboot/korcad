import { expect, test, type Page } from '@playwright/test';
import { gotoEditor } from './helpers.js';

/**
 * The simulator's arithmetic is unit-tested; what needs a real browser is that
 * the clock actually runs, that the tool head and trail follow it, and that the
 * controls do what they say. Playback is driven by animation frames, which only
 * fire in a visible tab — a hidden one is throttled to a standstill.
 */

const dialog = (page: Page) => page.locator('dialog.simulation');
const readout = (page: Page) => page.locator('.sim-readout');
const head = (page: Page) => page.locator('circle.sim-head');
const trail = (page: Page) => page.locator('.sim-trail');
const playButton = (page: Page) => page.getByRole('button', { name: /Play|Pause|Replay/ });

/** Elapsed seconds parsed out of the operator-facing readout. */
async function elapsed(page: Page): Promise<number> {
	const text = (await readout(page).textContent()) ?? '';
	return Number(/([\d.]+)\s*\/\s*[\d.]+\s*s/.exec(text)?.[1] ?? NaN);
}

async function openSimulation(page: Page): Promise<void> {
	await gotoEditor(page);
	await page.getByRole('button', { name: 'Simulate' }).click();
	await expect(dialog(page)).toBeVisible();
}

/**
 * Draws a tray and opens its parts sheet. A tray's walls fold up, so its net
 * is a two-pass job — but the net is cut from a parts sheet, and programs are
 * emitted per sheet, so the simulation of it lives on that sheet.
 */
async function openTrayParts(page: Page): Promise<void> {
	await page.getByRole('button', { name: /^Support/ }).click();
	await page.getByRole('menuitem', { name: /Recessed tray/ }).click();
	const box = (await page.locator('svg.drawing').boundingBox())!;
	await page.mouse.move(box.x + 320, box.y + 320);
	await page.mouse.down();
	await page.mouse.move(box.x + 440, box.y + 400, { steps: 10 });
	await page.mouse.up();

	// The preset gives a tray a bottom finger pull, which at this position would
	// break through the deck edge and block export.
	await page.getByRole('checkbox', { name: 'Bottom' }).uncheck();
	await expect(page.locator('.status.ok')).toBeVisible();

	await page.getByRole('tab', { name: /Parts/ }).click();
	await expect(page.getByRole('button', { name: 'Simulate' })).toBeEnabled();
}

test('draws the whole programmed path before anything has run', async ({ page }) => {
	await openSimulation(page);

	// The stock design scores its down-folds in the same pass as the cutting.
	await expect(page.locator('.sim-phase')).toHaveCount(1);
	await expect(page.locator('.sim-phase')).toContainText('Score + cut');
	await expect(page.locator('.sim-phase')).toContainText('Drag knife');
	// Programs are per sheet, so the dialog says which one is being run.
	await expect(page.locator('#sim-title')).toContainText('Deck');

	// Cut, score, and travel are each drawn as their own layer.
	await expect(page.locator('.sim-layer.cut')).toHaveCount(1);
	await expect(page.locator('.sim-layer.score-down')).toHaveCount(1);
	await expect(page.locator('.sim-layer.travel')).toHaveCount(1);

	// Nothing has been cut yet, so there is no trail and the clock reads zero.
	expect(await trail(page).getAttribute('d')).toBe('');
	expect(await elapsed(page)).toBe(0);
	await expect(readout(page)).toContainText('X 0.000 Y 0.000');
});

test('runs the tool head along the path in real time', async ({ page }) => {
	await openSimulation(page);
	// 1x is real time: a second of wall clock is a second of machine time.
	await page.getByLabel('Speed').selectOption('1');

	await playButton(page).click();
	await expect(playButton(page)).toHaveText('Pause');
	await page.waitForTimeout(1200);
	await playButton(page).click();

	const seconds = await elapsed(page);
	// Roughly a second of program time, with generous slack for frame timing.
	expect(seconds).toBeGreaterThan(0.3);
	expect(seconds).toBeLessThan(3);
	await expect(playButton(page)).toHaveText('Play');
});

test('runs faster in hyper time, and the head and trail follow', async ({ page }) => {
	await openSimulation(page);
	await page.getByLabel('Speed').selectOption('100');

	const startX = await head(page).getAttribute('cx');
	await playButton(page).click();
	await page.waitForTimeout(1000);
	await playButton(page).click();

	// 100x covers far more of the program in the same wall-clock second.
	expect(await elapsed(page)).toBeGreaterThan(20);
	// The head has moved and the trail is being laid down behind it.
	expect(await head(page).getAttribute('cx')).not.toBe(startX);
	expect((await trail(page).getAttribute('d'))?.length ?? 0).toBeGreaterThan(0);
});

test('pauses where it was and resumes from there', async ({ page }) => {
	await openSimulation(page);
	await page.getByLabel('Speed').selectOption('20');

	await playButton(page).click();
	await page.waitForTimeout(600);
	await playButton(page).click();
	const paused = await elapsed(page);

	// Paused means paused: the clock must not creep.
	await page.waitForTimeout(500);
	expect(await elapsed(page)).toBe(paused);

	await playButton(page).click();
	await page.waitForTimeout(400);
	await playButton(page).click();
	expect(await elapsed(page)).toBeGreaterThan(paused);
});

test('scrubs to a position without playing, and restarts to the beginning', async ({ page }) => {
	await openSimulation(page);
	const scrub = page.getByLabel('Toolpath progress');

	await scrub.fill('0.5');
	const halfway = await elapsed(page);
	expect(halfway).toBeGreaterThan(0);
	// Scrubbing leaves it paused, wherever it landed.
	await expect(playButton(page)).toHaveText('Play');
	expect((await trail(page).getAttribute('d'))?.length ?? 0).toBeGreaterThan(0);

	// Scrubbing backwards shortens the trail again rather than leaving it drawn.
	const halfwayTrail = (await trail(page).getAttribute('d'))!.length;
	await scrub.fill('0.2');
	expect((await trail(page).getAttribute('d'))!.length).toBeLessThan(halfwayTrail);

	await page.getByRole('button', { name: 'Restart' }).click();
	expect(await elapsed(page)).toBe(0);
	expect(await trail(page).getAttribute('d')).toBe('');
});

test('reports the line, move type, and tool position as it goes', async ({ page }) => {
	await openSimulation(page);
	await page.getByLabel('Toolpath progress').fill('0.35');

	// Everything the operator needs to tie the animation back to the program.
	await expect(readout(page)).toContainText('Score + cut');
	await expect(readout(page)).toContainText(/line \d+/);
	await expect(readout(page)).toContainText(/X -?[\d.]+ Y -?[\d.]+ Z -?[\d.]+ in$/);
	await expect(readout(page)).toContainText(/(cut|down fold|up fold|travel)/);
});

test('stops at the tool change between passes and continues on request', async ({ page }) => {
	await gotoEditor(page);
	await openTrayParts(page);
	await page.getByRole('button', { name: 'Simulate' }).click();
	await expect(dialog(page)).toBeVisible();

	// A tray's walls fold up, so creasing is a separate first pass.
	await expect(page.locator('.sim-phase')).toHaveCount(2);
	await expect(page.locator('.sim-phase').first()).toContainText('Crease');
	await expect(page.locator('.sim-phase').nth(1)).toContainText('Score + cut');
	await expect(page.locator('.sim-checkpoint')).toHaveCount(0);

	// Run the crease pass to its end.
	await page.getByLabel('Speed').selectOption('100');
	await playButton(page).click();
	await expect(page.locator('.sim-checkpoint')).toBeVisible({ timeout: 20_000 });
	// It must not run on into a pass that needs a different tool fitted.
	await expect(page.locator('.sim-checkpoint')).toContainText(/drag knife/i);
	await expect(playButton(page)).toBeDisabled();

	await page.getByRole('button', { name: /Continue to/ }).click();
	await expect(page.locator('.sim-checkpoint')).toHaveCount(0);
	await expect(playButton(page)).toBeEnabled();
	// The second pass starts from the beginning, with its own program.
	expect(await elapsed(page)).toBe(0);
	await expect(page.locator('.sim-phase').nth(1)).toHaveAttribute('aria-current', 'step');
});

test('switches between passes and shows each tool', async ({ page }) => {
	await gotoEditor(page);
	await openTrayParts(page);
	await page.getByRole('button', { name: 'Simulate' }).click();

	const crease = page.locator('.sim-phase').first();
	const cut = page.locator('.sim-phase').nth(1);
	await expect(crease).toHaveAttribute('aria-current', 'step');

	await page.getByLabel('Toolpath progress').fill('0.4');
	expect(await elapsed(page)).toBeGreaterThan(0);

	// Choosing another pass loads that program from the start.
	await cut.click();
	await expect(cut).toHaveAttribute('aria-current', 'step');
	expect(await elapsed(page)).toBe(0);

	await crease.click();
	await expect(readout(page)).toContainText('01 Crease');
});

test('closes and is not left running in the background', async ({ page }) => {
	await openSimulation(page);
	await page.getByLabel('Speed').selectOption('100');
	await playButton(page).click();
	await page.waitForTimeout(300);

	await page.getByRole('button', { name: 'Close' }).click();
	await expect(dialog(page)).toBeHidden();

	// Reopening starts a fresh run rather than resuming the old one.
	await page.getByRole('button', { name: 'Simulate' }).click();
	await expect(dialog(page)).toBeVisible();
	expect(await elapsed(page)).toBe(0);
	await expect(playButton(page)).toHaveText('Play');
});

test('cannot be opened while the design fails validation', async ({ page }) => {
	await gotoEditor(page);
	// A wall taller than the sheet allows makes the design unmanufacturable.
	await page.getByLabel(/^Wall \(/).fill('40');
	await expect(page.locator('.status.error')).toBeVisible();

	await expect(page.getByRole('button', { name: 'Simulate' })).toBeDisabled();
	await expect(dialog(page)).toBeHidden();
});

test('fits a phone viewport with the controls and readout still visible', async ({ page }) => {
	await page.setViewportSize({ width: 420, height: 820 });
	await openSimulation(page);
	await page.getByLabel('Toolpath progress').fill('0.4');

	const box = await page.evaluate(() => {
		const el = document.querySelector('dialog.simulation') as HTMLElement;
		const rect = (selector: string) => {
			const found = document.querySelector(selector);
			return found ? found.getBoundingClientRect() : null;
		};
		return {
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			readoutBottom: rect('.sim-readout')?.bottom ?? Infinity,
			controlsBottom: rect('.sim-controls')?.bottom ?? Infinity,
			dialogBottom: el.getBoundingClientRect().bottom,
			pageScrollWidth: document.documentElement.scrollWidth,
			innerWidth: window.innerWidth
		};
	});

	// The whole dialog fits: the numbers are the point, so they must not be
	// hidden below a scroll the operator has to discover.
	expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight + 1);
	expect(box.controlsBottom).toBeLessThanOrEqual(box.dialogBottom + 1);
	expect(box.readoutBottom).toBeLessThanOrEqual(box.dialogBottom + 1);
	expect(box.pageScrollWidth).toBeLessThanOrEqual(box.innerWidth);

	await expect(page.locator('.sim-readout')).toBeVisible();
	await expect(playButton(page)).toBeVisible();
});
