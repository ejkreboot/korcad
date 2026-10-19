import { afterEach, describe, expect, it } from 'vitest';
import { createGrblController, isStopped, type GrblController } from '$lib/core/grbl/controller.js';
import {
	DEFAULT_PROBE_SETTINGS,
	jogFeed,
	parseProbeSettings,
	pointsToResume,
	probeOrder,
	probeSettingsErrors,
	probeTarget,
	serializeProbeSettings,
	surfaceReading
} from '$lib/core/grbl/probing.js';
import {
	alarmLosesPosition,
	alarmText,
	errorText,
	jogCommand,
	overrideCommand,
	parseLine,
	probeCommand,
	RX_BUFFER_SIZE,
	streamLines,
	workPosition,
	workZCommand,
	zeroCommand
} from '$lib/core/grbl/protocol.js';
import { createFakeGrbl } from '../../support/fake-grbl.js';

describe('reading GRBL', () => {
	it('reads answers, alarms, probes, and the start-up banner', () => {
		expect(parseLine('ok\r')).toEqual({ kind: 'ok' });
		expect(parseLine('error:15')).toEqual({ kind: 'error', code: 15 });
		expect(parseLine('ALARM:5')).toEqual({ kind: 'alarm', code: 5 });
		expect(parseLine('[PRB:-10.000,-20.000,-49.700:1]')).toEqual({
			kind: 'probe',
			machine: { x: -10, y: -20, z: -49.7 },
			touched: true
		});
		expect(parseLine("Grbl 1.1h ['$' for help]")).toEqual({ kind: 'banner', version: '1.1h' });
		expect(parseLine("[MSG:'$H'|'$X' to unlock]")).toEqual({
			kind: 'other',
			text: "[MSG:'$H'|'$X' to unlock]"
		});
	});

	it('reads a status report with a machine position and a work offset', () => {
		expect(parseLine('<Hold:0|MPos:1.000,2.000,-3.500|FS:0,0|WCO:0.500,0.000,-4.000>')).toEqual({
			kind: 'status',
			report: {
				state: 'Hold',
				substate: 0,
				machine: { x: 1, y: 2, z: -3.5 },
				work: null,
				offset: { x: 0.5, y: 0, z: -4 },
				overrides: null,
				probeTouching: false
			}
		});
		expect(parseLine('<Bogus|MPos:0,0,0>')).toMatchObject({ kind: 'other' });
	});

	it('reads the overrides and the probe input when a report carries them', () => {
		expect(parseLine('<Run|MPos:0,0,0|FS:500,0|Pn:PZ|Ov:120,100,90>')).toMatchObject({
			report: { overrides: { feed: 120, rapid: 100, spindle: 90 }, probeTouching: true }
		});
		expect(parseLine('<Idle|MPos:0,0,0|Pn:XZ>')).toMatchObject({
			report: { overrides: null, probeTouching: false }
		});
	});

	it('works out the work position from either kind of report', () => {
		const machine = parseLine('<Idle|MPos:1.000,2.000,-3.500|FS:0,0>');
		const work = parseLine('<Idle|WPos:5.000,6.000,7.000|FS:0,0>');
		if (machine.kind !== 'status' || work.kind !== 'status') throw new Error('not a status');
		expect(workPosition(machine.report, null)).toBeNull();
		expect(workPosition(machine.report, { x: 1, y: 1, z: -4 })).toEqual({ x: 0, y: 1, z: 0.5 });
		expect(workPosition(work.report, null)).toEqual({ x: 5, y: 6, z: 7 });
	});
});

describe('writing GRBL', () => {
	it('jogs in millimetres without touching the modal state', () => {
		expect(jogCommand('relative', { z: -0.0254 }, 300)).toBe('$J=G21 G91 Z-0.025 F300');
		expect(jogCommand('absolute', { x: 304.8, y: 0 }, 1500)).toBe('$J=G21 G90 X304.8 Y0 F1500');
		expect(() => jogCommand('relative', {}, 300)).toThrow();
	});

	it('streams a program without its comments, and refuses one GRBL could not take whole', () => {
		const program = ['; KorCad v1.0', 'G21 ; millimeters', '', 'G0 Z3', '  ', 'M2', ''].join('\n');
		expect(streamLines(program)).toEqual(['G21', 'G0 Z3', 'M2']);
		expect(() => streamLines('G21\nG0 Z3')).toThrow('A program must end with M2');
		expect(() => streamLines(`G1 X${'1'.repeat(80)}\nM2`)).toThrow(/Line 1 is longer/);
		expect(() => streamLines('$H\nM2')).toThrow(/not plain G-code/);
		expect(() => streamLines('G0 (comment) X1\nM2')).toThrow(/not plain G-code/);
	});

	it('nudges overrides with single real-time bytes, and sets any work Z', () => {
		expect(overrideCommand('feed', 'up')).toBe('\x91');
		expect(overrideCommand('feed', 'down')).toBe('\x92');
		expect(overrideCommand('spindle', 'reset')).toBe('\x99');
		expect(workZCommand(15.25)).toBe('G10 L20 P0 Z15.25');
		expect(workZCommand(0)).toBe(zeroCommand('z'));
	});

	it('probes to an absolute work Z, and zeroes the active work coordinates', () => {
		expect(probeCommand(-3, 50)).toBe('G21 G90 G38.2 Z-3 F50');
		expect(zeroCommand('xy')).toBe('G10 L20 P0 X0 Y0');
		expect(zeroCommand('z')).toBe('G10 L20 P0 Z0');
	});

	it('says what an error or alarm means, and which alarms lose the position', () => {
		expect(errorText(15)).toBe('The controller refused a jog beyond the machine travel (error 15)');
		expect(alarmText(5)).toBe('Alarm 5: the probe reached the end of its travel without touching');
		expect([1, 2, 3, 4, 5, 9].map(alarmLosesPosition)).toEqual([
			true,
			false,
			true,
			false,
			false,
			true
		]);
	});
});

describe('probe settings', () => {
	it('needs the plate to fit under the tool at travel height', () => {
		expect(probeSettingsErrors(DEFAULT_PROBE_SETTINGS)).toEqual([]);
		expect(probeSettingsErrors({ plateThickness: 15, travelHeight: 16 })).toEqual([
			'Travel height must clear the plate by at least 2 mm (17 mm)'
		]);
		expect(probeSettingsErrors({ plateThickness: -1, travelHeight: 20 })).toEqual([
			'Plate thickness must be zero or more'
		]);
	});

	it('resumes what a run left only while the grid still puts those points where they were', () => {
		const grid = [0, 1, 3, 2].map((index) => ({
			index,
			x: (index % 2) * 584.2 + 12.7,
			y: Math.floor(index / 2) * 584.2 + 12.7
		}));
		const left = grid.slice(1);
		expect(pointsToResume(left, grid)).toEqual(left);
		expect(pointsToResume([], grid)).toEqual([]);
		// A new inset moves the points, and a smaller grid loses one.
		const moved = grid.map((point) => ({ ...point, x: point.x + 12.7 }));
		expect(pointsToResume(left, moved)).toEqual([]);
		expect(pointsToResume(left, grid.slice(0, 2))).toEqual([]);
	});

	it('picks jog speeds in the document units, and falls back to the default for an unknown one', () => {
		expect(jogFeed('mm', 3)).toBe(6000);
		expect(jogFeed('in', 1)).toBeCloseTo(1524, 6);
		expect(jogFeed('mm', 9)).toBe(1500);
	});

	it('probes no further than the map allows below the plate, and reads the table under it', () => {
		expect(probeTarget({ plateThickness: 15, travelHeight: 20 })).toBe(12);
		expect(surfaceReading(15.3, { plateThickness: 15, travelHeight: 20 })).toBe(0.3);
	});

	it('visits the grid back and forth, row by row', () => {
		expect(probeOrder({ columns: 3, rows: 3 })).toEqual([0, 1, 2, 5, 4, 3, 6, 7, 8]);
	});

	it('reads back what it stored, and nothing else', () => {
		const settings = { plateThickness: 15.2, travelHeight: 25 };
		expect(parseProbeSettings(serializeProbeSettings(settings))).toEqual(settings);
		expect(parseProbeSettings('{"format":"korcad-probe-settings","version":2}')).toBeNull();
		expect(parseProbeSettings('nope')).toBeNull();
	});
});

/** Polls until `condition` holds, letting the fake controller's answers arrive. */
async function until(condition: () => boolean, timeout = 2000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeout) throw new Error('Timed out');
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

let open: GrblController | null = null;
afterEach(() => {
	open?.dispose();
	open = null;
});

/**
 * A controller talking to a fake GRBL. The work origin is 600 mm in from the
 * machine origin on X and Y and 50 mm down on Z, so the tool starts at work
 * X100 Y100 Z45 over a table level with Z0, unless `table` says otherwise.
 */
async function connect(table?: (x: number, y: number) => number) {
	let controller: GrblController | null = null;
	const grbl = createFakeGrbl((line) => controller?.receive(line), {
		machine: { x: -500, y: -500, z: -5 },
		offset: { x: -600, y: -600, z: -50 },
		...(table ? { table } : {})
	});
	controller = createGrblController(grbl.write);
	open = controller;
	controller.start(2);
	await until(() => controller.snapshot().work !== null);
	return { controller, grbl };
}

const lines = (written: readonly string[]) => written.filter((entry) => entry.length > 1);

describe('the controller', () => {
	it('reads where the tool is in work coordinates', async () => {
		const { controller } = await connect();
		expect(controller.snapshot()).toMatchObject({
			status: { state: 'Idle' },
			work: { x: 100, y: 100, z: 45 },
			originConfirmed: false,
			busy: false
		});
	});

	it('will not go to a point until the origin is confirmed', async () => {
		const { controller, grbl } = await connect();
		await expect(controller.moveTo({ x: 0, y: 0 }, 20)).rejects.toThrow(/Confirm the origin/);
		expect(lines(grbl.written)).toEqual([]);
	});

	it('rises to travel height before crossing the table, and never comes down to it', async () => {
		const { controller, grbl } = await connect();
		controller.confirmOrigin(true);
		// Straight after a jog down, before any report shows where it ended.
		await controller.jog({ z: -25.4 }, 300);
		await controller.moveTo({ x: 300, y: 200 }, 20);
		expect(lines(grbl.written).slice(1)).toEqual([
			'$J=G21 G90 Z20 F300',
			'$J=G21 G90 X300 Y200 F1500'
		]);
		expect(controller.snapshot().work).toEqual({ x: 300, y: 200, z: 20 });
		expect(controller.at({ x: 300, y: 200 })).toBe(true);

		// Already above travel height, it goes straight across.
		await controller.jog({ z: 25 }, 300);
		await controller.moveTo({ x: 0, y: 0 }, 20);
		expect(lines(grbl.written).at(-1)).toBe('$J=G21 G90 X0 Y0 F1500');
		expect(controller.snapshot().work).toEqual({ x: 0, y: 0, z: 45 });
	});

	it('goes to a typed point before the origin is confirmed, rising first, at the speed asked', async () => {
		const { controller, grbl } = await connect();
		await controller.jog({ z: -25.4 }, 300);
		await controller.goTo({ x: 5, y: -2.5 }, 20, 6000);
		expect(lines(grbl.written).slice(1)).toEqual([
			'$J=G21 G90 Z20 F300',
			'$J=G21 G90 X5 Y-2.5 F6000'
		]);
		expect(controller.snapshot()).toMatchObject({
			work: { x: 5, y: -2.5, z: 20 },
			originConfirmed: false,
			busy: false
		});
	});

	it('refuses a go-to without both coordinates or a travel height, sending nothing', async () => {
		const { controller, grbl } = await connect();
		await expect(controller.goTo({ x: Number.NaN, y: 0 }, 20)).rejects.toThrow(/Enter X and Y/);
		await expect(controller.goTo({ x: 0, y: 0 }, 0)).rejects.toThrow(/travel height/);
		expect(lines(grbl.written)).toEqual([]);
	});

	it('jogs Z no more than an inch at a time, either way', async () => {
		const { controller, grbl } = await connect();
		await expect(controller.jog({ z: -25.5 }, 300)).rejects.toThrow(/at most 25.4 mm/);
		await expect(controller.jog({ z: 100 }, 300)).rejects.toThrow(/at most 25.4 mm/);
		await controller.jog({ z: -25.4 }, 300);
		await controller.jog({ x: 254 }, 6000);
		expect(lines(grbl.written)).toEqual(['$J=G21 G91 Z-25.4 F300', '$J=G21 G91 X254 F6000']);
	});

	it('seeks the plate quickly, backs off, touches it slowly, and rises back to travel height', async () => {
		// The table stands 0.3 mm above Z0 at work X300 Y200, and the plate is 15 mm thick.
		const { controller, grbl } = await connect((x) => -50 + 0.3 * ((x + 600) / 300) + 15);
		const settings = { plateThickness: 15, travelHeight: 20 };
		controller.confirmOrigin(true);
		await controller.moveTo({ x: 300, y: 200 }, 20);
		expect(await controller.probe(settings)).toBeCloseTo(0.3, 4);
		expect(lines(grbl.written).slice(-4)).toEqual([
			'G21 G90 G38.2 Z12 F200',
			'$J=G21 G91 Z2 F300',
			'G21 G90 G38.2 Z12 F25',
			'$J=G21 G90 Z20 F300'
		]);
		expect(controller.snapshot()).toMatchObject({ work: { z: 20 }, busy: false });
	});

	it('takes the reading from the slow touch, and refuses touches that disagree', async () => {
		// Each probe cycle finds the plate where the next value says, in work Z.
		const touches: number[] = [];
		const { controller } = await connect(() => -50 + (touches.shift() ?? 0));
		controller.confirmOrigin(true);
		touches.push(0.25, 0.21);
		expect(await controller.probe(DEFAULT_PROBE_SETTINGS)).toBeCloseTo(0.21, 4);

		// A chip under the plate on the seek, gone by the touch.
		touches.push(0.6, 0.21);
		await expect(controller.probe(DEFAULT_PROBE_SETTINGS)).rejects.toThrow(
			'The two touches differ by 0.39 mm; clear the plate and probe again'
		);
		// It still rose clear of the plate.
		expect(controller.snapshot()).toMatchObject({ work: { z: 20 }, busy: false });
	});

	it('takes the work Z as a reading of the table touched by hand, once the last jog is done', async () => {
		const { controller } = await connect();
		await controller.jog({ z: -25 }, 300);
		await controller.jog({ z: -19.9 }, 300);
		expect(await controller.reading()).toBeCloseTo(0.1, 6);
	});

	it('refuses to probe from below the plate', async () => {
		const { controller, grbl } = await connect();
		controller.confirmOrigin(true);
		await expect(controller.probe({ plateThickness: 50, travelHeight: 60 })).rejects.toThrow(
			/Raise the tool above the plate/
		);
		expect(lines(grbl.written)).toEqual([]);
	});

	it('stops at an alarm when the probe never touches, keeping the origin', async () => {
		// Nothing to touch above work Z -10: the clip has come off.
		const { controller } = await connect(() => -60);
		controller.confirmOrigin(true);
		await expect(controller.probe(DEFAULT_PROBE_SETTINGS)).rejects.toThrow(
			'Alarm 5: the probe reached the end of its travel without touching'
		);
		// The probe stopped 3 mm under the plate's top, as far as the map allows.
		await until(() => controller.snapshot().work?.z === -3);
		expect(controller.snapshot()).toMatchObject({
			work: { z: -3 },
			busy: false,
			originConfirmed: true,
			alarm: 'Alarm 5: the probe reached the end of its travel without touching'
		});
		await until(() => controller.snapshot().status?.state === 'Alarm');
		await expect(controller.moveTo({ x: 0, y: 0 }, 20)).rejects.toThrow(/in alarm/);
	});

	it('resets before unlocking, so no stale answer pairs with the unlock', async () => {
		const { controller, grbl } = await connect(() => -60);
		controller.confirmOrigin(true);
		await controller.probe(DEFAULT_PROBE_SETTINGS).catch(() => undefined);
		await controller.recover('unlock');
		expect(grbl.written.slice(-2)).toEqual(['\x18', '$X']);
		await until(() => controller.snapshot().status?.state === 'Idle');
		// A reset may have lost the position, so the origin must be confirmed again.
		expect(controller.snapshot()).toMatchObject({
			status: { state: 'Idle' },
			alarm: null,
			originConfirmed: false
		});
	});

	it('forgets the origin after an alarm that loses the position', async () => {
		const { controller } = await connect();
		controller.confirmOrigin(true);
		controller.receive('ALARM:1');
		expect(controller.snapshot()).toMatchObject({
			originConfirmed: false,
			alarm: 'Alarm 1: a hard limit switch was hit; the position is lost, so home or set zero again'
		});
	});

	it('stops a move: cancels the jog, holds, and resets once at rest', async () => {
		const { controller, grbl } = await connect();
		controller.confirmOrigin(true);
		// Keep the jog running so that it can be stopped partway.
		grbl.holdMotion = true;
		const move = controller.moveTo({ x: 200, y: 200 }, 20).catch((error: unknown) => error);
		await until(() => controller.snapshot().status?.state === 'Jog');
		await controller.stop();
		expect(isStopped(await move)).toBe(true);
		expect(grbl.written.filter((entry) => entry.length === 1)).toEqual(['\x85', '!', '\x18']);
		await until(() => !controller.snapshot().originConfirmed);
		expect(controller.snapshot()).toMatchObject({ busy: false, status: { state: 'Idle' } });
	});

	it('probes every point in turn, reporting each reading as it comes', async () => {
		const { controller } = await connect((x, y) => -50 + (x + 600) / 1000 + (y + 600) / 2000);
		controller.confirmOrigin(true);
		const readings: [number, number][] = [];
		await controller.probeEach(
			[
				{ index: 0, x: 0, y: 0 },
				{ index: 1, x: 100, y: 0 },
				{ index: 3, x: 100, y: 100 }
			],
			DEFAULT_PROBE_SETTINGS,
			(index, reading) => readings.push([index, reading])
		);
		expect(readings).toEqual([
			[0, 0],
			[1, 0.1],
			[3, 0.15]
		]);
	});

	it("streams a program, keeping GRBL's receive buffer full but never over", async () => {
		const { controller, grbl } = await connect();
		controller.confirmOrigin(true);
		const program = [
			...Array.from({ length: 200 }, (_, index) => `G1 X${index} Y${index / 2} F800`),
			'M5',
			'M2'
		];
		const progress: number[] = [];
		await controller.run(program, (answered) => progress.push(answered));
		expect(lines(grbl.written)).toEqual(program);
		expect(progress.at(-1)).toBe(program.length);
		// Several lines were waiting at once, which is the point of streaming,
		// and never more characters than the buffer holds.
		expect(grbl.mostUnanswered).toBeGreaterThan(RX_BUFFER_SIZE / 2);
		expect(grbl.mostUnanswered).toBeLessThan(RX_BUFFER_SIZE);
		expect(controller.snapshot()).toMatchObject({ busy: false, status: { state: 'Idle' } });
	});

	it('runs nothing before the origin is confirmed, and nothing without M2 to end it', async () => {
		const { controller, grbl } = await connect();
		await expect(controller.run(['G0 Z3', 'M2'])).rejects.toThrow(/Confirm the origin/);
		controller.confirmOrigin(true);
		await expect(controller.run(['G0 Z3'])).rejects.toThrow(/end with M2/);
		expect(lines(grbl.written)).toEqual([]);
	});

	it('stops the machine when GRBL refuses a line, rather than run on without it', async () => {
		const { controller, grbl } = await connect();
		controller.confirmOrigin(true);
		grbl.errors.set('G1 X5 Y5 F800', 20);
		await expect(
			controller.run(['G21', 'G90', 'G1 X5 Y5 F800', 'G1 X6 Y6 F800', 'M2'])
		).rejects.toThrow(/^Line 3, G1 X5 Y5 F800: .*error 20.*The machine was stopped\.$/);
		expect(grbl.written.filter((entry) => entry.length === 1)).toEqual(['!', '\x18']);
		await until(() => !controller.snapshot().originConfirmed);
	});

	it('holds, carries on, and nudges overrides while a program runs', async () => {
		const { controller, grbl } = await connect();
		await controller.pause();
		await controller.resume();
		await controller.override('feed', 'up');
		await controller.override('spindle', 'down');
		expect(grbl.written).toEqual(['!', '~', '\x91', '\x9b']);
		await until(() => controller.snapshot().overrides?.feed === 110);
		expect(controller.snapshot().overrides).toEqual({ feed: 110, rapid: 100, spindle: 90 });
	});

	it('sets Z0 with a plate under a tool of unknown length, searching only a short way down', async () => {
		// The plate's top stands at machine Z -12, 7 mm under the tool at work Z45.
		const { controller, grbl } = await connect(() => -12);
		const settings = { plateThickness: 15, travelHeight: 20 };
		// The work's top here stands 0.2 mm above its top at X0 Y0.
		await controller.probeZero(settings, 0.2);
		expect(lines(grbl.written)).toEqual([
			'G21 G90 G38.2 Z35 F200',
			'$J=G21 G91 Z2 F300',
			'G21 G90 G38.2 Z35 F25',
			'G10 L20 P0 Z15.2',
			'$J=G21 G90 Z20 F300'
		]);
		// The plate's top is now work Z 15.2, so the tool is 4.8 mm above where it touched.
		await until(() => controller.snapshot().work?.z === 20);
		expect(grbl.offset.z).toBeCloseTo(-12 - 15.2, 6);
	});

	it('refuses to set Z0 when nothing is within reach under the tool', async () => {
		const { controller, grbl } = await connect(() => -30);
		await expect(controller.probeZero(DEFAULT_PROBE_SETTINGS, 0)).rejects.toThrow(/Alarm 5/);
		expect(lines(grbl.written)).toEqual(['G21 G90 G38.2 Z35 F200']);
		expect(grbl.machine.z).toBe(-15);
	});

	it("sets the tool's height as any work Z", async () => {
		const { controller, grbl } = await connect();
		await controller.setWorkZ(0.35);
		await until(() => controller.snapshot().work !== null);
		expect(controller.snapshot().work?.z).toBeCloseTo(0.35, 6);
		expect(lines(grbl.written)).toEqual(['G10 L20 P0 Z0.35']);
	});

	it('sets zero where the tool is, and waits for the new offset before trusting the position', async () => {
		const { controller, grbl } = await connect();
		await controller.setZero('xy');
		expect(controller.snapshot().work).toBeNull();
		await until(() => controller.snapshot().work !== null);
		expect(controller.snapshot().work).toEqual({ x: 0, y: 0, z: 45 });
		expect(lines(grbl.written)).toEqual(['G10 L20 P0 X0 Y0']);
	});

	it('passes on a refusal in words', async () => {
		const { controller, grbl } = await connect();
		grbl.errors.set('$J=G21 G91 X1 F1500', 15);
		await expect(controller.jog({ x: 1 }, 1500)).rejects.toThrow(
			'The controller refused a jog beyond the machine travel (error 15)'
		);
	});
});
