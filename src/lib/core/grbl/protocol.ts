import { round } from '$lib/core/units.js';

/**
 * The parts of the GRBL 1.1 serial protocol KorCad speaks, as plain data:
 * reading what the controller sends and writing what it accepts. Nothing here
 * touches a port; `controller.ts` drives a link with it.
 *
 * GRBL answers each line it is sent with `ok` or `error:N`, in order, and
 * reports its state in `<...>` lines when sent the real-time `?`. Machine
 * positions are in the controller's own frame; work positions are those less
 * the work coordinate offset (`WCO`), which is where the operator has set
 * X0 Y0 Z0. Every length here is in millimetres.
 */

export type Position = { readonly x: number; readonly y: number; readonly z: number };

/** GRBL's machine states. `Hold` and `Door` carry a sub-state after a colon. */
export type GrblState =
	'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | 'Door' | 'Check' | 'Home' | 'Sleep';

const STATES: readonly GrblState[] = [
	'Idle',
	'Run',
	'Hold',
	'Jog',
	'Alarm',
	'Door',
	'Check',
	'Home',
	'Sleep'
];

/**
 * One status report. GRBL sends either the machine or the work position,
 * depending on its `$10` setting, and the work offset only every few reports,
 * or at once after it changes.
 */
export type StatusReport = {
	readonly state: GrblState;
	/** `Hold:0` is a hold complete; `Hold:1` is still decelerating. */
	readonly substate: number | null;
	readonly machine: Position | null;
	readonly work: Position | null;
	readonly offset: Position | null;
	/** Feed, rapid, and spindle overrides in percent, reported only every so often or on a change. */
	readonly overrides: Overrides | null;
	/** Whether the probe input reads as touching (`Pn:P`). */
	readonly probeTouching: boolean;
};

export type Overrides = { readonly feed: number; readonly rapid: number; readonly spindle: number };

export type GrblMessage =
	| { readonly kind: 'ok' }
	| { readonly kind: 'error'; readonly code: number }
	| { readonly kind: 'alarm'; readonly code: number }
	| { readonly kind: 'status'; readonly report: StatusReport }
	/** Where a probe cycle stopped, in machine coordinates, and whether it touched. */
	| { readonly kind: 'probe'; readonly machine: Position; readonly touched: boolean }
	/** The start-up line, sent on power-up and after every reset. */
	| { readonly kind: 'banner'; readonly version: string }
	| { readonly kind: 'other'; readonly text: string };

function position(text: string | undefined): Position | null {
	if (text === undefined) return null;
	const values = text.split(',').map(Number);
	const [x, y, z] = values;
	if (values.length < 3 || x === undefined || y === undefined || z === undefined) return null;
	if (![x, y, z].every(Number.isFinite)) return null;
	return { x, y, z };
}

function statusReport(body: string): StatusReport | null {
	const [head, ...fields] = body.split('|');
	const [name, sub] = (head ?? '').split(':');
	const state = STATES.find((candidate) => candidate === name);
	if (!state) return null;
	const field = (key: string) =>
		fields.find((entry) => entry.startsWith(`${key}:`))?.slice(key.length + 1);
	const ov = field('Ov')?.split(',').map(Number);
	const [feed, rapid, spindle] = ov ?? [];
	const overrides =
		feed !== undefined &&
		rapid !== undefined &&
		spindle !== undefined &&
		[feed, rapid, spindle].every(Number.isFinite)
			? { feed, rapid, spindle }
			: null;
	return {
		state,
		substate: sub === undefined ? null : Number(sub),
		machine: position(field('MPos')),
		work: position(field('WPos')),
		offset: position(field('WCO')),
		overrides,
		probeTouching: field('Pn')?.includes('P') ?? false
	};
}

/** Reads one line from the controller, without its line ending. */
export function parseLine(raw: string): GrblMessage {
	const line = raw.trim();
	if (line === 'ok') return { kind: 'ok' };
	const error = /^error:(\d+)$/.exec(line);
	if (error) return { kind: 'error', code: Number(error[1]) };
	const alarm = /^ALARM:(\d+)$/.exec(line);
	if (alarm) return { kind: 'alarm', code: Number(alarm[1]) };
	const status = /^<(.*)>$/.exec(line);
	if (status) {
		const report = statusReport(status[1]!);
		return report ? { kind: 'status', report } : { kind: 'other', text: line };
	}
	const probe = /^\[PRB:([^:]+):([01])\]$/.exec(line);
	if (probe) {
		const machine = position(probe[1]);
		if (machine) return { kind: 'probe', machine, touched: probe[2] === '1' };
	}
	const banner = /^Grbl (\S+)/.exec(line);
	if (banner) return { kind: 'banner', version: banner[1]! };
	return { kind: 'other', text: line };
}

/** The work position a report implies, given the last work offset seen. */
export function workPosition(report: StatusReport, offset: Position | null): Position | null {
	if (report.work) return report.work;
	if (!report.machine || !offset) return null;
	return {
		x: report.machine.x - offset.x,
		y: report.machine.y - offset.y,
		z: report.machine.z - offset.z
	};
}

/** Real-time commands: single bytes GRBL acts on at once, outside the line queue. */
export const REALTIME = {
	status: '?',
	feedHold: '!',
	cycleStart: '~',
	softReset: '\x18',
	jogCancel: '\x85',
	feedOverrideReset: '\x90',
	feedOverrideUp: '\x91',
	feedOverrideDown: '\x92',
	spindleOverrideReset: '\x99',
	spindleOverrideUp: '\x9a',
	spindleOverrideDown: '\x9b'
} as const;

export type Override = 'feed' | 'spindle';

/** The real-time byte that nudges an override 10% `up` or `down`, or puts it back to 100%. */
export function overrideCommand(which: Override, change: 'up' | 'down' | 'reset'): string {
	if (which === 'feed') {
		return change === 'up'
			? REALTIME.feedOverrideUp
			: change === 'down'
				? REALTIME.feedOverrideDown
				: REALTIME.feedOverrideReset;
	}
	return change === 'up'
		? REALTIME.spindleOverrideUp
		: change === 'down'
			? REALTIME.spindleOverrideDown
			: REALTIME.spindleOverrideReset;
}

/**
 * GRBL's serial receive buffer. A streamed program keeps the lines sent but
 * not yet answered within it, counting each line's newline, so that GRBL
 * always has the next moves to plan and never drops a character.
 */
export const RX_BUFFER_SIZE = 128;

/** GRBL's longest line, newline excluded. */
export const MAX_LINE_LENGTH = 79;

/**
 * The lines of a program as they are streamed: comments and blank lines left
 * out, since GRBL ignores them and they would only take room in its buffer.
 * A program must end with M2, which GRBL answers only once every move before
 * it has finished, so the last `ok` means the work is done. Anything GRBL
 * could not take whole is refused before a line is sent.
 */
export function streamLines(program: string): string[] {
	const lines = program
		.split('\n')
		.map((line) => {
			const comment = line.indexOf(';');
			return (comment < 0 ? line : line.slice(0, comment)).trim();
		})
		.filter((line) => line !== '');
	lines.forEach((line, index) => {
		if (line.length > MAX_LINE_LENGTH) {
			throw new Error(`Line ${index + 1} is longer than GRBL takes: "${line}"`);
		}
		if (line.startsWith('$') || /[()]/.test(line)) {
			throw new Error(`Line ${index + 1} is not plain G-code: "${line}"`);
		}
	});
	if (lines.at(-1) !== 'M2') throw new Error('A program must end with M2');
	return lines;
}

const word = (letter: string, value: number) => `${letter}${round(value)}`;

/**
 * A jog: GRBL's own command for interactive moves. It never changes the
 * program's modal state, is refused if it would pass a soft limit, and is
 * cancelled at once by `REALTIME.jogCancel`.
 */
export function jogCommand(
	mode: 'absolute' | 'relative',
	axes: Partial<Position>,
	feed: number
): string {
	const words = (['x', 'y', 'z'] as const)
		.filter((axis) => axes[axis] !== undefined)
		.map((axis) => word(axis.toUpperCase(), axes[axis]!));
	if (!words.length) throw new Error('A jog needs at least one axis');
	return `$J=G21 ${mode === 'absolute' ? 'G90' : 'G91'} ${words.join(' ')} F${round(feed)}`;
}

/**
 * A straight probe down to work Z `target`, stopping where the probe touches.
 * GRBL raises an alarm, rather than reporting, if it reaches the target
 * without touching or starts already touching.
 */
export function probeCommand(target: number, feed: number): string {
	return `G21 G90 G38.2 ${word('Z', target)} F${round(feed)}`;
}

/** Makes the tool's current position work Z `z` in the active work coordinates. */
export function workZCommand(z: number): string {
	return `G10 L20 P0 ${word('Z', z)}`;
}

/** Makes the tool's current position zero on the given axes of the active work coordinates. */
export function zeroCommand(axes: 'xy' | 'z'): string {
	return axes === 'xy' ? 'G10 L20 P0 X0 Y0' : 'G10 L20 P0 Z0';
}

export const UNLOCK = '$X';
export const HOME = '$H';

const ERRORS: Readonly<Record<number, string>> = {
	1: 'a command letter it does not know',
	2: 'a number it could not read',
	3: 'a $ command it does not support',
	5: 'homing, which is not enabled on this controller',
	8: 'a command it only takes while idle',
	9: 'a command while it is in alarm or jogging; unlock or wait',
	15: 'a jog beyond the machine travel',
	16: 'a jog command it could not read',
	20: 'a G-code it does not support',
	22: 'a move with no feed rate'
};

/** A GRBL error code in words. */
export function errorText(code: number): string {
	return `The controller refused ${ERRORS[code] ?? 'the command'} (error ${code})`;
}

const ALARMS: Readonly<Record<number, string>> = {
	1: 'a hard limit switch was hit; the position is lost, so home or set zero again',
	2: 'a move would have passed a soft limit',
	3: 'it was reset while moving; the position may be lost, so home or set zero again',
	4: 'the probe was already touching before the probe began',
	5: 'the probe reached the end of its travel without touching',
	6: 'homing was reset while it ran',
	7: 'the safety door opened during homing',
	8: 'homing could not pull off its switch',
	9: 'homing could not find its switch'
};

/** A GRBL alarm code in words. */
export function alarmText(code: number): string {
	return `Alarm ${code}: ${ALARMS[code] ?? 'the controller stopped'}`;
}

/**
 * Alarms that leave the controller's idea of where the tool is untrustworthy.
 * GRBL stops a soft-limit or probe alarm before moving, so those keep it.
 */
export function alarmLosesPosition(code: number): boolean {
	return code !== 2 && code !== 4 && code !== 5;
}
