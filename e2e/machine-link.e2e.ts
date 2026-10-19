import { expect, test, type Page } from '@playwright/test';
import { gotoEditor } from './helpers.js';

/**
 * Jogging and probing the table over USB serial. There is no machine in CI, so
 * `navigator.serial` is replaced before the page loads with a port wired to a
 * scripted GRBL 1.1: it moves at once, reports a jog as running until the next
 * status report, and probes down to a table that rises 0.3 mm from X0 to X24.
 * What needs a browser is the whole path: the port chooser, the panels, the
 * readings landing in the grid, and the Stop button.
 */

async function fakeSerial(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const encoder = new TextEncoder();
		let machine = { x: -500, y: -500, z: -5 };
		let offset = { x: -600, y: -600, z: -50 };
		let state = 'Idle';
		let jogging = false;
		let line = '';
		let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
		const written: string[] = [];
		// Which probe cycles, counted from 1, find nothing and end in alarm 5.
		const failProbes: number[] = [];
		let probes = 0;
		Object.assign(window, { grblWritten: written, grblFailProbes: failProbes });
		const table = (x: number) => -50 + (0.3 * (x - offset.x)) / 609.6;
		const fixed = (p: { x: number; y: number; z: number }) =>
			`${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;
		const send = (text: string) =>
			setTimeout(() => stream?.enqueue(encoder.encode(`${text}\r\n`)), 0);
		const value = (text: string, letter: string) => {
			const match = new RegExp(`${letter}(-?\\d+(?:\\.\\d+)?)`).exec(text);
			return match ? Number(match[1]) : undefined;
		};

		function execute(command: string): void {
			written.push(command);
			if (command.startsWith('$J=')) {
				const relative = command.includes('G91');
				const axis = (key: 'x' | 'y' | 'z', letter: string) => {
					const v = value(command.slice(3), letter);
					if (v === undefined) return machine[key];
					return relative ? machine[key] + v : v + offset[key];
				};
				machine = { x: axis('x', 'X'), y: axis('y', 'Y'), z: axis('z', 'Z') };
				state = 'Jog';
				jogging = true;
				send('ok');
			} else if (command.includes('G38.2')) {
				probes++;
				if (failProbes.includes(probes)) {
					state = 'Alarm';
					send('ALARM:5');
					return;
				}
				const surface = table(machine.x);
				machine = { ...machine, z: surface };
				send(`[PRB:${fixed(machine)}:1]`);
				send('ok');
			} else if (command.startsWith('G10 L20 P0')) {
				if (command.includes('X0')) offset = { ...offset, x: machine.x, y: machine.y };
				if (command.includes('Z0')) offset = { ...offset, z: machine.z };
				send('ok');
			} else send('ok');
		}

		function receive(char: string): void {
			if (char === '?') {
				send(`<${state}|MPos:${fixed(machine)}|FS:0,0|WCO:${fixed(offset)}>`);
				if (jogging) {
					jogging = false;
					state = 'Idle';
				}
			} else if (char === '\x18') {
				written.push('reset');
				state = 'Idle';
				send("Grbl 1.1h ['$' for help]");
			} else if (char === '!' || char === '\x85') {
				written.push(char === '!' ? 'hold' : 'jog cancel');
			} else if (char === '\n') {
				execute(line);
				line = '';
			} else line += char;
		}

		const port = {
			readable: new ReadableStream<Uint8Array>({
				start(controller) {
					stream = controller;
				}
			}),
			writable: new WritableStream<Uint8Array>({
				write(chunk) {
					for (const byte of chunk) receive(String.fromCharCode(byte));
				}
			}),
			open: async () => {
				send("Grbl 1.1h ['$' for help]");
			},
			close: async () => undefined
		};
		Object.defineProperty(navigator, 'serial', {
			configurable: true,
			value: { requestPort: async () => port }
		});
	});
}

const written = (page: Page) =>
	page.evaluate(() => (window as unknown as { grblWritten: string[] }).grblWritten);

test('jogs, goes to a grid point, probes it into the map, and stops', async ({ page }) => {
	await fakeSerial(page);
	await gotoEditor(page);

	await page.getByRole('button', { name: 'Machine', exact: true }).click();
	await page.getByRole('button', { name: 'Connect' }).click();
	// The document is in inches: work X100 Y100 Z45 mm.
	await expect(page.locator('.machine-state')).toContainText('Idle');
	await expect(page.locator('.machine-state')).toContainText('X3.937 Y3.937 Z1.7717 in');
	await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

	// Down an inch, to 19.6 mm: below the 20 mm travel height.
	await page.getByLabel('Jog step').selectOption('1');
	await page.getByRole('button', { name: 'Jog Z−' }).click();
	await expect(page.locator('.machine-state')).toContainText('Z0.7717 in');

	await page.getByRole('button', { name: 'Table surface', exact: true }).click();
	await page.getByLabel('Z at X23.5 Y0.5').focus();
	const go = page.getByRole('button', { name: 'Go to point' });
	// Nothing goes to a point before the origin is confirmed.
	await expect(go).toBeDisabled();
	await page.getByLabel(/X0 Y0 is the sheet's lower-left corner/).check();
	await go.click();
	await expect(page.locator('.surface-point')).toContainText('the tool is here');
	// It rose to the 20 mm travel height before crossing.
	expect((await written(page)).slice(-2)).toEqual([
		'$J=G21 G90 Z20 F300',
		'$J=G21 G90 X596.9 Y12.7 F1524'
	]);

	await page.getByRole('button', { name: 'Probe', exact: true }).click();
	// The table stands 0.2938 mm (0.0116 in) above Z0 at X23.5.
	await expect(page.getByLabel('Z at X23.5 Y0.5')).toHaveValue('0.0116');
	// A quick seek, a back-off, and a slow touch for the reading.
	expect(await written(page)).toEqual(
		expect.arrayContaining([
			'G21 G90 G38.2 Z-3 F200',
			'$J=G21 G91 Z2 F300',
			'G21 G90 G38.2 Z-3 F25'
		])
	);
	// The next point in probing order is the one behind it.
	await expect(page.locator('.surface-point')).toContainText('X23.5 Y12');

	// Go to a typed point at the fastest speed, back near the origin. The tool is at the
	// 20 mm travel height already, so it goes straight across.
	await page.getByLabel('Jog speed').selectOption('240');
	await page.getByLabel('Go to X').fill('0.5');
	await page.getByLabel('Go to Y').fill('-0.25');
	await page.getByRole('button', { name: 'Go to', exact: true }).click();
	await expect(page.locator('.machine-state')).toContainText('X0.5 Y-0.25');
	expect((await written(page)).at(-1)).toBe('$J=G21 G90 X12.7 Y-6.35 F6096');

	// A 5 in step crosses the table at the picked speed, but Z will not jog that far.
	await page.getByLabel('Jog step').selectOption('5');
	await expect(page.getByRole('button', { name: 'Jog Z−' })).toBeDisabled();
	await page.getByRole('button', { name: 'Jog X+' }).click();
	await expect(page.locator('.machine-state')).toContainText('X5.5 Y-0.25');
	expect((await written(page)).at(-1)).toBe('$J=G21 G91 X127 F6096');

	await page.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect(page.getByLabel(/X0 Y0 is the sheet's lower-left corner/)).not.toBeChecked();
	expect((await written(page)).slice(-3)).toEqual(['jog cancel', 'hold', 'reset']);

	await page.getByRole('button', { name: 'Disconnect' }).click();
	await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});

test('finishes the points a run of Probe every point stopped short of', async ({ page }) => {
	await fakeSerial(page);
	await gotoEditor(page);
	page.on('dialog', (dialog) => void dialog.accept());
	// The second point's seek, the run's third probe cycle, touches nothing.
	await page.evaluate(() =>
		(window as unknown as { grblFailProbes: number[] }).grblFailProbes.push(3)
	);

	await page.getByRole('button', { name: 'Machine', exact: true }).click();
	await page.getByRole('button', { name: 'Connect' }).click();
	await expect(page.locator('.machine-state')).toContainText('Idle');
	await page.getByRole('button', { name: 'Table surface', exact: true }).click();
	await page.getByLabel('Columns').selectOption('2');
	await page.getByLabel('Rows').selectOption('2');
	const origin = page.getByLabel(/X0 Y0 is the sheet's lower-left corner/);
	await origin.check();

	await page.getByRole('button', { name: 'Probe every point' }).click();
	await expect(page.locator('.machine-alarm')).toContainText('Alarm 5');
	// The first point was read; the other three are outlined, waiting.
	await expect(page.getByLabel('Z at X23.5 Y0.5')).toHaveValue('0');
	await expect(page.locator('.surface-grid input.missed')).toHaveCount(3);
	const finish = page.getByRole('button', { name: 'Finish the 3 missed' });
	await expect(finish).toBeDisabled();

	// Clearing the alarm resets the controller, so the origin is confirmed again first.
	await page.getByRole('button', { name: 'Unlock' }).click();
	await expect(page.locator('.machine-state')).toContainText('Idle');
	await origin.check();
	await finish.click();
	await expect(finish).toHaveCount(0);
	await expect(page.locator('.surface-grid input.missed')).toHaveCount(0);
	// The table stands 0.2938 mm (0.0116 in) above Z0 at X23.5.
	await expect(page.getByLabel('Z at X23.5 Y23.5')).toHaveValue('0.0116');
	await expect(page.getByLabel('Z at X23.5 Y0.5')).toHaveValue('0.0116');
});

test("runs the sheet's program once Z0 is set for its tool", async ({ page }) => {
	await fakeSerial(page);
	await gotoEditor(page);

	await page.getByRole('button', { name: 'Machine', exact: true }).click();
	await page.getByRole('button', { name: 'Connect' }).click();
	await expect(page.locator('.machine-state')).toContainText('Idle');
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	const prepare = page.getByRole('button', { name: 'Prepare to run' });
	// Nothing runs before the origin is confirmed.
	await expect(prepare).toBeDisabled();
	await page.getByLabel(/X0 Y0 is the sheet's lower-left corner/).check();
	await prepare.click();

	await expect(page.getByRole('list', { name: 'Programs' })).toContainText('cut · drag knife');
	const start = page.getByRole('button', { name: 'Start cut' });
	// The first program waits for Z0 to be set for the tool loaded.
	await expect(start).toBeDisabled();
	await page.getByRole('button', { name: 'Touch off here' }).click();
	await expect(page.getByText('Z0 is set for this tool.')).toBeVisible();
	expect((await written(page)).at(-1)).toBe('G10 L20 P0 Z0');

	const before = (await written(page)).length;
	await start.click();
	await expect(page.getByRole('status')).toContainText('Job finished');
	const sent = (await written(page)).slice(before);
	// The program went as export writes it, less its comments, ending in M2.
	expect(sent.slice(0, 3)).toEqual(['G21', 'G90', 'G17']);
	expect(sent.at(-1)).toBe('M2');
	expect(sent.some((line) => line.includes(';'))).toBe(false);
	expect(sent.length).toBeGreaterThan(20);

	await page.getByRole('button', { name: 'Close' }).click();
	await expect(prepare).toBeVisible();
});

test('shows what running a sheet looks like before a machine is connected, all switched off', async ({
	page
}) => {
	await gotoEditor(page);
	await page.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(page.getByRole('list', { name: 'Programs' })).toContainText('cut · drag knife');
	for (const name of ['Prepare to run', 'Touch off here', 'Probe Z0', 'Start cut', 'Pause']) {
		await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
	}
	await expect(page.getByRole('button', { name: 'Feed up 10%' })).toBeDisabled();
	await expect(page.getByLabel('Z0 is already set on the work for this tool')).toBeDisabled();
});

test('points to another browser when this one cannot reach a serial port', async ({ page }) => {
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined });
	});
	await gotoEditor(page);
	await page.getByRole('button', { name: 'Machine', exact: true }).click();
	await expect(page.getByText('Connecting to the machine needs Chrome or Edge')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Connect' })).toHaveCount(0);
});
