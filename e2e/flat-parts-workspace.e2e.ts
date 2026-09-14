import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { gotoEditor, readDraft } from './helpers.js';

/**
 * The Flat Parts workspace in the browser: a sheet chosen when it is added brings
 * its own tools and panels, leaves out folding and the 3D preview, and a part
 * with a hole exports one cut program. Packaging sheets beside it are
 * untouched.
 */

async function dragOnCanvas(
	page: Page,
	from: [number, number],
	to: [number, number]
): Promise<void> {
	const box = (await page.locator('svg.drawing').boundingBox())!;
	await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 12 });
	await page.mouse.up();
}

async function draw(
	page: Page,
	tool: string,
	preset: RegExp,
	from: [number, number],
	to: [number, number]
) {
	await page.getByRole('button', { name: tool, exact: true }).click();
	await page.getByRole('menuitem', { name: preset }).click();
	await dragOnCanvas(page, from, to);
}

async function addFlatPartsSheet(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Add a sheet' }).click();
	await page.getByRole('menuitem', { name: /Flat Parts sheet/ }).click();
	await expect(page.getByRole('tab', { name: 'Sheet 1' })).toHaveAttribute('aria-selected', 'true');
}

test('a Flat Parts sheet has its own tools, and no folding or 3D', async ({ page }) => {
	await gotoEditor(page);
	await expect(page.getByRole('button', { name: 'Cutout' })).toBeVisible();
	await expect(page.getByRole('button', { name: '3D' })).toBeVisible();

	await addFlatPartsSheet(page);
	await expect(page.getByRole('button', { name: 'Part', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Hole', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Cutout' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: '3D' })).toHaveCount(0);
	await expect(page.locator('.legend').getByText('Down fold')).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Sheet', exact: true })).toBeVisible();

	// The packaging deck is exactly as it was.
	await page.getByRole('tab', { name: 'Deck' }).click();
	await expect(page.getByRole('button', { name: 'Cutout' })).toBeVisible();
	await expect(page.getByLabel(/Deck width/)).toBeVisible();
	await expect(page.locator('.legend').getByText('Down fold')).toBeVisible();
});

test('a part with a hole exports one cut program, the hole first', async ({ page }) => {
	await gotoEditor(page);
	await addFlatPartsSheet(page);

	await draw(page, 'Part', /Rounded rectangle/, [0.2, 0.3], [0.7, 0.7]);
	await expect(page.getByRole('heading', { name: 'Part 1' })).toBeVisible();
	await draw(page, 'Hole', /^Hole/, [0.35, 0.45], [0.45, 0.55]);
	await expect(page.getByRole('heading', { name: 'Hole 1' })).toBeVisible();
	await expect(page.locator('.status.ok')).toContainText('geometry valid');

	const download = page.waitForEvent('download');
	await page.getByRole('button', { name: 'G-code' }).click();
	const file = await download;
	expect(file.suggestedFilename()).toBe('sheet-1.nc');
	const program = readFileSync((await file.path())!, 'utf8');
	expect(program).toContain('tool: drag knife');
	expect(program.indexOf('(Hole 1)')).toBeGreaterThan(0);
	expect(program.indexOf('(Part 1)')).toBeGreaterThan(program.indexOf('(Hole 1)'));
	expect(program).not.toContain('crease');
});

test('moving a part carries its hole, as one undo step', async ({ page }) => {
	await gotoEditor(page);
	await addFlatPartsSheet(page);
	await draw(page, 'Part', /^Rectangle/, [0.2, 0.3], [0.7, 0.7]);
	await draw(page, 'Hole', /^Hole/, [0.35, 0.45], [0.45, 0.55]);

	const entities = async () => {
		const design = (await readDraft(page))!;
		const flatParts = (
			design.workspaces as {
				flatParts: { sheets: Record<string, { entities: { name: string; x: number }[] }> };
			}
		).flatParts;
		return Object.values(flatParts.sheets)[0]!.entities;
	};
	const before = await entities();
	// Grab the part between its edge and the hole.
	await dragOnCanvas(page, [0.25, 0.4], [0.3, 0.4]);
	await expect.poll(async () => (await entities())[0]!.x).toBeGreaterThan(before[0]!.x);
	const after = await entities();
	expect(after[1]!.x - before[1]!.x).toBeCloseTo(after[0]!.x - before[0]!.x, 3);

	await page.getByRole('button', { name: 'Undo' }).click();
	await expect
		.poll(async () => (await entities()).map((entity) => entity.x))
		.toEqual(before.map((entity) => entity.x));
});

test('a routed part keeps bridge holding tabs unless they are turned off', async ({ page }) => {
	await gotoEditor(page);
	await addFlatPartsSheet(page);
	await page.getByRole('button', { name: 'Tool', exact: true }).click();
	await page.getByLabel('Fabrication').selectOption('router');
	// Collapse it again, so the canvas is where the drag expects it.
	await page.getByRole('button', { name: 'Tool', exact: true }).click();

	// Well inside the sheet: a router's bit runs outside the line, so a part
	// clamped to the sheet edge would not fit.
	await draw(page, 'Part', /Rounded rectangle/, [0.42, 0.35], [0.58, 0.6]);
	await expect(page.getByRole('heading', { name: 'Part 1' })).toBeVisible();
	await expect(page.getByLabel('Holding tabs')).toHaveValue('4');
	await expect(page.locator('.tab-mark')).toHaveCount(4);
	await expect(page.locator('.status.ok')).toContainText('geometry valid');

	const exported = async () => {
		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: 'G-code' }).click();
		return readFileSync((await (await download).path())!, 'utf8');
	};
	const tabbed = await exported();
	expect(tabbed).toContain('; Holding tabs: 5 mm wide bridges, 1 mm thick');
	expect(tabbed.match(/; holding tab$/gm)).toHaveLength(4);

	await page.getByLabel('Holding tabs').fill('0');
	await expect(page.locator('.tab-mark')).toHaveCount(0);
	const untabbed = await exported();
	expect(untabbed).not.toContain('; holding tab');
	expect(untabbed).toContain('; No holding tabs on: Part 1');
});

test('an imported SVG becomes a tabbed part with its holes', async ({ page }) => {
	await gotoEditor(page);
	await addFlatPartsSheet(page);

	const drawing = `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 200 100">
		<path d="M0 0 H200 V100 H0 Z"/>
		<circle cx="50" cy="50" r="20"/>
		<rect x="120" y="30" width="40" height="40"/>
		<line x1="0" y1="0" x2="10" y2="10"/>
	</svg>`;
	const chooser = page.waitForEvent('filechooser');
	await page.getByRole('button', { name: 'Part', exact: true }).click();
	await page.getByRole('menuitem', { name: /Import SVG/ }).click();
	await (
		await chooser
	).setFiles({ name: 'plate.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(drawing) });

	await expect(page.getByRole('heading', { name: 'Part 1' })).toBeVisible();
	await expect(page.getByText('Part · Imported outline')).toBeVisible();
	await expect(page.getByLabel('Shape')).toHaveCount(0);
	await expect(page.getByLabel('Holding tabs')).toHaveValue('4');
	await expect(page.locator('.status.ok')).toContainText(
		'Imported 1 part and 2 holes from plate.svg (200 × 100 mm). Skipped 1 open path.'
	);

	const design = (await readDraft(page))!;
	const flatParts = (
		design.workspaces as {
			flatParts: { sheets: Record<string, { entities: { kind: string; shape: string }[] }> };
		}
	).flatParts;
	const saved = Object.values(flatParts.sheets)[0]!.entities;
	expect(saved.map((entity) => [entity.kind, entity.shape])).toEqual([
		['profile', 'path'],
		['hole', 'path'],
		['hole', 'path']
	]);
});

test('keeping proportions scales a part and the holes inside it', async ({ page }) => {
	await gotoEditor(page);
	await addFlatPartsSheet(page);
	await page.getByRole('button', { name: 'Part', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Rectangle/ }).click();
	await dragOnCanvas(page, [0.2, 0.3], [0.7, 0.7]);
	await page.getByRole('button', { name: 'Hole', exact: true }).click();
	await page.getByRole('menuitem', { name: /^Hole/ }).click();
	await dragOnCanvas(page, [0.35, 0.45], [0.45, 0.55]);

	const entities = async () => {
		const design = (await readDraft(page))!;
		const flatParts = (
			design.workspaces as {
				flatParts: {
					sheets: Record<string, { entities: { name: string; x: number; w: number; h: number }[] }>;
				};
			}
		).flatParts;
		return Object.values(flatParts.sheets)[0]!.entities;
	};
	const [part, hole] = await entities();

	await page
		.locator('[data-flat-parts-entity]')
		.first()
		.click({ position: { x: 6, y: 6 } });
	await expect(page.getByRole('heading', { name: 'Part 1' })).toBeVisible();
	await page.getByLabel('Keep proportions and scale holes').check();
	const width = page.getByLabel(/^Width/);
	await width.fill(String(Number(await width.inputValue()) * 2));
	await width.press('Enter');

	await expect.poll(async () => (await entities())[0]!.w).toBeCloseTo(part!.w * 2, 1);
	const [scaledPart, scaledHole] = await entities();
	expect(scaledPart!.h).toBeCloseTo(part!.h * 2, 1);
	expect(scaledHole!.w).toBeCloseTo(hole!.w * 2, 1);
	expect(scaledHole!.x - scaledPart!.x).toBeCloseTo((hole!.x - part!.x) * 2, 1);
});
