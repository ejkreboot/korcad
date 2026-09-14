import { expect, test, type Page } from '@playwright/test';
import { gotoEditor, readPackagingDraft } from './helpers.js';

/** Drags on the canvas in client coordinates relative to the SVG box. */
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

const deckWidth = (page: Page) => page.getByLabel(/Deck width/);

test('renders the sheet with a grid, deck area, origin and legend', async ({ page }) => {
	await gotoEditor(page);
	const drawing = page.locator('svg.drawing');
	await expect(drawing).toBeVisible();
	// Axis-aligned segments have a zero-area box, so count rather than assert visibility.
	expect(await drawing.locator('.grid-line').count()).toBeGreaterThan(10);
	// A sub-pixel stroke antialiases away at some positions, which reads as a
	// grid that drops lines; keep every weight at a crisp whole pixel.
	for (const kind of ['minor', '', 'major']) {
		const line = drawing.locator(`.grid-line${kind ? `.${kind}` : ''}`).first();
		if ((await line.count()) === 0) continue;
		expect(
			Number(await line.evaluate((el) => getComputedStyle(el).strokeWidth.replace('px', '')))
		).toBeGreaterThanOrEqual(1);
	}
	expect(await drawing.locator('.deck-area').count()).toBe(1);
	// The deck is an outline only, so the grid reads through it.
	await expect(drawing.locator('.deck-area')).toHaveCSS('fill', 'none');
	expect(await drawing.locator('.origin').count()).toBe(1);
	expect(await drawing.locator('.score-down').count()).toBeGreaterThan(0);
	expect(await drawing.locator('.cut').count()).toBeGreaterThan(0);
	await expect(page.locator('.status.ok')).toContainText('geometry valid');
});

test('draws grid lines across the whole canvas on a wide window', async ({ page }) => {
	// A square viewBox letterboxed into a wide window shows much more world
	// horizontally than the view rect describes. Generating lines over the view
	// rect alone leaves bare vertical bands at the sides, and the wider the
	// window the wider the bands.
	await page.setViewportSize({ width: 1800, height: 700 });
	await gotoEditor(page);
	const drawing = page.locator('svg.drawing');
	const box = (await drawing.boundingBox())!;

	// Zoom in until the stock more than fills the canvas, so anything unpainted
	// is a missing line rather than the edge of the sheet.
	await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
	for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -200);
	await page.waitForTimeout(200);

	const spread = await drawing.evaluate((svg) => {
		const rect = svg.getBoundingClientRect();
		const ctm = (svg as SVGSVGElement).getScreenCTM()!;
		const sheet = [0, 609.6].map((x) => new DOMPoint(x, 0).matrixTransform(ctm).x - rect.left);
		const xs = [...svg.querySelectorAll('line.grid-line')]
			.filter((l) => l.getAttribute('y1') === '0')
			.map((l) => new DOMPoint(Number(l.getAttribute('x1')), 0).matrixTransform(ctm).x - rect.left);
		return { min: Math.min(...xs), max: Math.max(...xs), count: xs.length, sheet };
	});

	// Precondition: the sheet really does overhang the canvas on both sides.
	expect(spread.sheet[0]).toBeLessThan(0);
	expect(spread.sheet[1]).toBeGreaterThan(box.width);
	// So the grid must reach both edges.
	expect(spread.count).toBeGreaterThan(10);
	expect(spread.min).toBeLessThan(box.width * 0.08);
	expect(spread.max).toBeGreaterThan(box.width * 0.92);
});

test('shows a CAD cursor readout that follows the pointer', async ({ page }) => {
	await gotoEditor(page);
	await expect(page.locator('.readout')).toContainText('—');
	const box = (await page.locator('svg.drawing').boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await expect(page.locator('.readout')).toContainText('X ');
	expect(await page.locator('svg.drawing .cursor-guide').count()).toBe(2);
});

test('zooms with the buttons and the wheel, and fits back to the sheet', async ({ page }) => {
	await gotoEditor(page);
	const readout = page.locator('.zoom-readout');
	const start = await readout.textContent();

	await page.getByRole('button', { name: 'Zoom in' }).click();
	await expect(readout).not.toHaveText(start!);

	await page.getByRole('button', { name: /Fit sheet/ }).click();
	await expect(readout).toHaveText(start!);

	const box = (await page.locator('svg.drawing').boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, -400);
	await expect(readout).not.toHaveText(start!);
});

/** The stock coordinate currently under the pointer, from the readout. */
async function cursorReadout(page: Page): Promise<{ x: number; y: number }> {
	const text = (await page.locator('.readout').textContent())!;
	const [x, y] = [...text.matchAll(/-?\d+\.\d+/g)].map((match) => Number(match[0]));
	return { x: x!, y: y! };
}

test('wheel zoom keeps the point under the cursor in place', async ({ page }) => {
	await gotoEditor(page);
	const box = (await page.locator('svg.drawing').boundingBox())!;

	// Whole pixels: a wheel event reports an integer clientX/clientY, so a
	// fractional position would anchor a hair away from where we then measure.
	// A point well off-centre, where a corner-anchored zoom drifts visibly.
	const cursor = {
		x: Math.round(box.x + box.width * 0.3),
		y: Math.round(box.y + box.height * 0.72)
	};
	await page.mouse.move(cursor.x, cursor.y);
	const before = await cursorReadout(page);

	await page.mouse.wheel(0, -500);
	await page.mouse.move(cursor.x + 1, cursor.y);
	await page.mouse.move(cursor.x, cursor.y);
	const after = await cursorReadout(page);

	expect(after.x).toBeCloseTo(before.x, 2);
	expect(after.y).toBeCloseTo(before.y, 2);
});

test('button zoom keeps the middle of the view in place', async ({ page }) => {
	await gotoEditor(page);
	const box = (await page.locator('svg.drawing').boundingBox())!;
	const centre = {
		x: Math.round(box.x + box.width / 2),
		y: Math.round(box.y + box.height / 2)
	};
	await page.mouse.move(centre.x, centre.y);
	const before = await cursorReadout(page);

	await page.getByRole('button', { name: 'Zoom in' }).click();
	await page.mouse.move(centre.x + 1, centre.y);
	await page.mouse.move(centre.x, centre.y);
	const after = await cursorReadout(page);

	expect(after.x).toBeCloseTo(before.x, 2);
	expect(after.y).toBeCloseTo(before.y, 2);
});

test('pans the view with the middle mouse button', async ({ page }) => {
	await gotoEditor(page);
	const drawing = page.locator('svg.drawing');
	const before = await drawing.getAttribute('viewBox');
	const box = (await drawing.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down({ button: 'middle' });
	await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
	await page.mouse.up({ button: 'middle' });
	await expect(drawing).not.toHaveAttribute('viewBox', before!);
});

test('resizes the top deck by dragging its edge', async ({ page }) => {
	await gotoEditor(page);
	const width = deckWidth(page);
	const before = Number(await width.inputValue());

	// The deck edge resizes the deck. Press the middle of its wide hit stroke:
	// its edge is a sub-pixel boundary that shifts whenever the layout above moves.
	const edge = page.locator('.deck-edge-hit[data-deck-action="right"]').first();
	const box = (await edge.boundingBox())!;
	const x = box.x + box.width / 2;
	await page.mouse.move(x, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(x - 60, box.y + box.height / 2, { steps: 10 });
	await page.mouse.up();

	const after = Number(await width.inputValue());
	expect(after).toBeLessThan(before);

	// The whole drag is one undo step.
	await page.getByRole('button', { name: 'Undo' }).click();
	expect(Number(await width.inputValue())).toBeCloseTo(before, 2);
});

test('drags the perimeter wall grip to change the wall height', async ({ page }) => {
	await gotoEditor(page);
	const wall = page.getByLabel(/^Wall /);
	const before = Number(await wall.inputValue());

	// On a folded perimeter the outer grip adjusts the wall, not the deck.
	const grip = page.locator('.deck-edge-handle[data-deck-action="wall-right"]').first();
	const box = (await grip.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 10 });
	await page.mouse.up();

	expect(Number(await wall.inputValue())).toBeGreaterThan(before);
	expect(Number(await deckWidth(page).inputValue())).toBeCloseTo(18, 2);
});

test('draws, moves and resizes an opening', async ({ page }) => {
	await gotoEditor(page);
	await page.getByRole('button', { name: /^Cutout/ }).click();
	await page.getByRole('menuitem', { name: /Product opening/ }).click();
	await dragOnCanvas(page, { x: 300, y: 300 }, { x: 420, y: 380 });

	await expect(page.getByRole('heading', { name: /^Pocket 1$/ })).toBeVisible();
	const x = page.getByLabel(/X from left/);
	const w = page.getByLabel(/^Width/);
	const drawnX = Number(await x.inputValue());
	const drawnW = Number(await w.inputValue());
	expect(drawnW).toBeGreaterThan(0);

	// Move it by dragging the body.
	await dragOnCanvas(page, { x: 360, y: 340 }, { x: 400, y: 340 });
	expect(Number(await x.inputValue())).toBeGreaterThan(drawnX);

	// Resize it by dragging a corner handle.
	const handle = page.locator('.resize-handle[data-handle="ne"]').first();
	const box = (await handle.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 - 20, { steps: 10 });
	await page.mouse.up();
	expect(Number(await w.inputValue())).toBeGreaterThan(drawnW);
});

test('carries semantic type through from the preset that drew it', async ({ page }) => {
	await gotoEditor(page);
	await page.getByRole('button', { name: /^Cutout/ }).click();
	await page.getByRole('menuitem', { name: /Registration hole/ }).click();
	await dragOnCanvas(page, { x: 300, y: 300 }, { x: 400, y: 360 });

	await expect(page.locator('.badge')).toHaveText('Registration hole');
	await expect(page.getByLabel('Opening type')).toHaveValue('registration');
	// A registration hole is forced square so it locates in both axes.
	const w = Number(await page.getByLabel(/^Width/).inputValue());
	const h = Number(await page.getByLabel(/^Height/).inputValue());
	expect(w).toBeCloseTo(h, 3);
});

test('adds a support, which lands on its own parts sheet', async ({ page }) => {
	await gotoEditor(page);
	await page.getByRole('button', { name: /^Support/ }).click();
	await page.getByRole('menuitem', { name: /Recessed tray/ }).click();
	await dragOnCanvas(page, { x: 320, y: 320 }, { x: 440, y: 400 });

	await expect(page.locator('.badge')).toHaveText('Recessed tray');
	await expect(page.getByLabel('Support type')).toHaveValue('tray');
	// A tray is drawn on the deck but cut from a parts sheet, so one is added.
	await expect(page.getByRole('tab', { name: /Parts/ })).toBeVisible();
	// Its deck opening is cut on the deck sheet.
	expect(await page.locator('svg.drawing .cut').count()).toBeGreaterThan(0);
});

test('the Delete key removes the selection, and not while typing in a field', async ({ page }) => {
	await gotoEditor(page);
	await page.getByRole('button', { name: /^Cutout/ }).click();
	await page.getByRole('menuitem', { name: /Product opening/ }).click();
	await dragOnCanvas(page, { x: 300, y: 300 }, { x: 420, y: 380 });
	const heading = page.getByRole('heading', { name: /^Pocket 1$/ });
	await expect(heading).toBeVisible();

	// Deleting a character in a field edits the field, not the document.
	await page.getByLabel(/^Width/).press('Backspace');
	await expect(heading).toBeVisible();

	// Pressing the shape on the canvas hands the keyboard back to the drawing.
	const box = (await page.locator('svg.drawing').boundingBox())!;
	await page.mouse.click(box.x + 360, box.y + 340);
	await page.keyboard.press('Delete');
	await expect(heading).toHaveCount(0);

	// One undo step brings it back.
	await page.getByRole('button', { name: /^Undo/ }).click();
	await expect(heading).toBeVisible();
});

test('sizes the finger pulls of a recessed tray', async ({ page }) => {
	await gotoEditor(page);
	await page.getByRole('button', { name: /^Support/ }).click();
	await page.getByRole('menuitem', { name: /Recessed tray/ }).click();
	await dragOnCanvas(page, { x: 320, y: 320 }, { x: 440, y: 400 });

	// A tray starts with a pull on its bottom wall; the size fields follow the pulls.
	const diameter = page.getByLabel(/^Pull diameter/);
	await expect(diameter).toBeVisible();
	await expect(page.getByLabel(/^Wall reach/)).toBeVisible();
	await page.getByRole('checkbox', { name: 'bottom' }).uncheck();
	await expect(diameter).toHaveCount(0);
	await page.getByRole('checkbox', { name: 'bottom' }).check();

	const before = await diameter.inputValue();
	await diameter.fill(String(Number(before) * 0.8));
	await expect(diameter).not.toHaveValue(before);
});

test('cuts an opening into a part, which moves with it and goes when deleted', async ({ page }) => {
	const failures: string[] = [];
	page.on('pageerror', (error) => failures.push(error.message));
	await gotoEditor(page);
	await page.getByRole('button', { name: 'Add a sheet' }).click();
	await page.getByRole('menuitem', { name: /Folded Packaging sheet/ }).click();
	await page.getByRole('button', { name: /^Support/ }).click();
	await page.getByRole('menuitem', { name: /Glued riser box/ }).click();
	await dragOnCanvas(page, { x: 300, y: 140 }, { x: 420, y: 230 });
	await expect(page.locator('.badge')).toHaveText('Glued riser box');

	// Drawn inside the riser's top panel, the opening belongs to the riser.
	await page.getByRole('button', { name: /^Cutout/ }).click();
	await page.getByRole('menuitem', { name: /Product opening/ }).click();
	await dragOnCanvas(page, { x: 340, y: 165 }, { x: 380, y: 205 });
	await expect(page.getByText('Cut into Riser 1')).toBeVisible();

	type Saved = { id: string; x: number; host: { kind: string; supportId?: string } };
	const openings = async () =>
		((await readPackagingDraft(page))?.pockets as Saved[]).filter(
			(pocket) => pocket.host.kind === 'support'
		);
	await expect.poll(async () => (await openings()).length).toBe(1);
	const before = (await openings())[0]!.x;

	// Dragging the riser by its wall carries the opening along.
	await page.keyboard.press('Escape');
	await dragOnCanvas(page, { x: 360, y: 145 }, { x: 400, y: 145 });
	await expect.poll(async () => (await openings())[0]!.x).toBeGreaterThan(before);

	await page.getByRole('button', { name: '3D', exact: true }).click();
	await expect(page.locator('.viewer-loading')).toHaveCount(0);
	await page.getByRole('button', { name: '2D', exact: true }).click();

	// The riser is still selected from the drag; deleting it takes its opening too.
	await expect(page.getByRole('heading', { name: 'Riser 1' })).toBeVisible();
	await page.keyboard.press('Delete');
	await expect.poll(async () => (await openings()).length).toBe(0);
	expect(failures).toEqual([]);
});

test('adds, renames and removes a sheet', async ({ page }) => {
	await gotoEditor(page);
	await page.getByRole('button', { name: 'Add a sheet' }).click();
	await page.getByRole('menuitem', { name: /Folded Packaging sheet/ }).click();
	const tab = page.getByRole('tab', { name: 'Parts 1' });
	await expect(tab).toBeVisible();
	await expect(tab).toHaveAttribute('aria-selected', 'true');

	await tab.dblclick();
	const rename = page.locator('.sheet-rename');
	await rename.fill('Risers');
	await rename.press('Enter');
	await expect(page.getByRole('tab', { name: 'Risers' })).toBeVisible();

	await page.getByRole('button', { name: /^Delete Risers/ }).click();
	await expect(page.getByRole('tab', { name: 'Risers' })).toHaveCount(0);
	await expect(page.getByRole('tab', { name: 'Deck' })).toHaveAttribute('aria-selected', 'true');
});

test('exposes material properties that reach the G-code header', async ({ page }) => {
	await gotoEditor(page);
	// Material is a once-per-job panel, so it starts folded away.
	await page.getByRole('button', { name: 'Material' }).click();
	await page.getByLabel('Grain direction').selectOption('x');
	await page.getByLabel('Board appearance').selectOption('white');
	await page.getByLabel('Fold allowance').selectOption('manual');
	await expect(page.getByLabel(/Deduction per fold/)).toBeVisible();
	await expect(page.getByLabel('Grain direction')).toHaveValue('x');
});

test('folds the once-per-job settings away, above the selection panel', async ({ page }) => {
	await gotoEditor(page);

	const material = page.getByRole('button', { name: 'Material' });
	const machine = page.getByRole('button', { name: 'Tool', exact: true });

	// Both sit at the top of the sidebar, ahead of the contextual panel.
	const order = await page
		.locator('.sidebar h2')
		.evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
	expect(order.slice(0, 3)).toEqual(['Material', 'Tool', 'Stock and top deck']);

	// Collapsed by default: the headers are there, the fields are not.
	await expect(material).toHaveAttribute('aria-expanded', 'false');
	await expect(machine).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByLabel('Board appearance')).toHaveCount(0);
	await expect(page.getByLabel('Fabrication')).toHaveCount(0);
	// The panel the operator actually works in stays open.
	await expect(page.getByLabel(/Deck width/)).toBeVisible();

	await material.click();
	await expect(material).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByLabel('Board appearance')).toBeVisible();
	// Opening one leaves the other alone.
	await expect(machine).toHaveAttribute('aria-expanded', 'false');

	await machine.click();
	await expect(page.getByLabel('Fabrication')).toBeVisible();

	await material.click();
	await expect(material).toHaveAttribute('aria-expanded', 'false');
	await expect(page.getByLabel('Board appearance')).toHaveCount(0);
});

test('exports one program for a deck with nothing to crease from the back', async ({ page }) => {
	await gotoEditor(page);
	const downloads: string[] = [];
	page.on('download', (file) => downloads.push(file.suggestedFilename()));
	const first = page.waitForEvent('download');
	await page.getByRole('button', { name: 'G-code' }).click();
	await first;
	await expect(page.getByText('Cut program exported.')).toBeAttached();
	expect(downloads).toEqual(['deck.nc']);
});

test('drives the toolbar by icon buttons that keep their accessible names', async ({ page }) => {
	await gotoEditor(page);

	// Every control is an icon, and every icon still has a name and a tooltip.
	for (const name of [
		'Select',
		'Cutout',
		'Support',
		'2D',
		'3D',
		'Undo',
		'Redo',
		'Snap',
		'Simulate',
		'SVG',
		'G-code'
	]) {
		const button = page.getByRole('button', { name, exact: true });
		await expect(button).toHaveCount(1);
		await expect(button).toHaveAttribute('title', /.+/);
		// The glyph is decorative: the button carries the name.
		expect(await button.locator('.icon').count()).toBeGreaterThan(0);
		await expect(button.locator('.icon').first()).toHaveAttribute('aria-hidden', 'true');
	}

	// File commands are words in a menu, so "new" cannot be mistaken for "add a sheet".
	await page.getByRole('button', { name: 'File', exact: true }).click();
	for (const name of [
		/New Folded Packaging project/,
		/New Flat Parts project/,
		/Open design file/,
		/Save design file/
	]) {
		await expect(page.getByRole('menuitem', { name })).toBeVisible();
	}
	await page.getByRole('button', { name: 'File', exact: true }).click();
	await expect(page.getByRole('menuitem', { name: /Open design file/ })).toHaveCount(0);

	// Toggles report their state rather than relying on colour alone.
	await expect(page.getByRole('button', { name: '2D', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	const snap = page.getByRole('button', { name: 'Snap', exact: true });
	const before = await snap.getAttribute('aria-pressed');
	await snap.click();
	await expect(snap).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');

	// Preset menus carry an icon per row.
	await page.getByRole('button', { name: 'Cutout', exact: true }).click();
	const rows = page.getByRole('menuitem');
	expect(await rows.count()).toBeGreaterThan(3);
	expect(await rows.first().locator('svg.icon').count()).toBe(1);
});
