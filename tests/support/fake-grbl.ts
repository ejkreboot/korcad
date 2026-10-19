import type { Position } from '$lib/core/grbl/protocol.js';

/**
 * A stand-in GRBL 1.1 controller, enough to drive `createGrblController`
 * without hardware. It answers asynchronously, as a serial link would, moves
 * instantly but reports a jog as running until the next status report, and
 * probes down to a table whose machine Z at each point `table` gives. It
 * counts the characters of lines sent and not yet answered, as GRBL's receive
 * buffer holds them.
 */
export function createFakeGrbl(
	deliver: (line: string) => void,
	options: {
		readonly table?: (x: number, y: number) => number;
		readonly machine?: Position;
		readonly offset?: Position;
	} = {}
) {
	const table = options.table ?? (() => -50);
	let machine: Position = options.machine ?? { x: -500, y: -500, z: -5 };
	let offset: Position = options.offset ?? { x: -600, y: -600, z: -60 };
	let state = 'Idle';
	let jogging = false;
	/** Everything written, real-time bytes and lines alike, in order. */
	const written: string[] = [];
	let buffer = '';
	/** Lines that answer with an alarm or an error instead of running, for testing failures. */
	const alarms = new Map<string, number>();
	const errors = new Map<string, number>();
	/** Keeps a jog running until it is cancelled, to stop a move partway. */
	let holdMotion = false;
	/** The sizes of lines received and not yet answered, newline included. */
	const unanswered: number[] = [];
	let mostUnanswered = 0;
	let feedOverride = 100;
	let spindleOverride = 100;

	const later = (line: string): void => {
		setTimeout(() => deliver(line), 0);
	};
	/** Answers the oldest line received, freeing its room in the buffer. */
	const answer = (line: string): void => {
		setTimeout(() => {
			unanswered.shift();
			deliver(line);
		}, 0);
	};
	const fixed = (p: Position) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`;

	function status(): void {
		later(
			`<${state}|MPos:${fixed(machine)}|FS:0,0|WCO:${fixed(offset)}|Ov:${feedOverride},100,${spindleOverride}>`
		);
		if (jogging && !holdMotion) {
			jogging = false;
			state = 'Idle';
		}
	}

	function words(line: string): Record<string, number> {
		return Object.fromEntries(
			[...line.matchAll(/([XYZF])(-?\d+(?:\.\d+)?)/g)].map((m) => [m[1]!, Number(m[2])])
		);
	}

	function execute(line: string): void {
		unanswered.push(line.length + 1);
		mostUnanswered = Math.max(
			mostUnanswered,
			unanswered.reduce((sum, size) => sum + size, 0)
		);
		const error = errors.get(line);
		if (error !== undefined) return answer(`error:${error}`);
		const alarm = alarms.get(line);
		if (alarm !== undefined) {
			state = 'Alarm';
			later(`ALARM:${alarm}`);
			return;
		}
		if (line.startsWith('$J=')) {
			if (state === 'Alarm') return answer('error:9');
			const w = words(line.slice(3));
			const relative = line.includes('G91');
			const axis = (key: 'x' | 'y' | 'z', letter: string) => {
				const value = w[letter];
				if (value === undefined) return machine[key];
				return relative ? machine[key] + value : value + offset[key];
			};
			machine = { x: axis('x', 'X'), y: axis('y', 'Y'), z: axis('z', 'Z') };
			state = 'Jog';
			jogging = true;
			return answer('ok');
		}
		if (line.includes('G38.2')) {
			const target = words(line).Z! + offset.z;
			const surface = table(machine.x, machine.y);
			if (machine.z <= surface) {
				state = 'Alarm';
				return later('ALARM:4');
			}
			if (surface < target) {
				machine = { ...machine, z: target };
				state = 'Alarm';
				return later('ALARM:5');
			}
			machine = { ...machine, z: surface };
			later(`[PRB:${fixed(machine)}:1]`);
			return answer('ok');
		}
		if (line.startsWith('G10 L20 P0')) {
			// The tool's position becomes the value given on each axis named.
			const w = words(line.slice('G10 L20 P0'.length));
			offset = {
				x: w.X === undefined ? offset.x : machine.x - w.X,
				y: w.Y === undefined ? offset.y : machine.y - w.Y,
				z: w.Z === undefined ? offset.z : machine.z - w.Z
			};
			return answer('ok');
		}
		if (line === '$X' || line === '$H') state = 'Idle';
		answer('ok');
	}

	function write(data: string): void {
		for (const char of data) {
			if (char === '?') status();
			else if (char === '\x85') {
				written.push(char);
				if (state === 'Jog') {
					state = 'Idle';
					jogging = false;
				}
			} else if (char === '!') {
				written.push(char);
				if (state === 'Jog' || state === 'Run') state = 'Hold:0';
			} else if (char === '~') {
				written.push(char);
				if (state.startsWith('Hold')) state = 'Idle';
			} else if (char === '\x91' || char === '\x92' || char === '\x90') {
				written.push(char);
				feedOverride = char === '\x90' ? 100 : feedOverride + (char === '\x91' ? 10 : -10);
			} else if (char === '\x9a' || char === '\x9b' || char === '\x99') {
				written.push(char);
				spindleOverride = char === '\x99' ? 100 : spindleOverride + (char === '\x9a' ? 10 : -10);
			} else if (char === '\x18') {
				written.push(char);
				buffer = '';
				unanswered.length = 0;
				if (state !== 'Alarm') state = 'Idle';
				later("Grbl 1.1h ['$' for help]");
			} else if (char === '\n') {
				written.push(buffer);
				execute(buffer);
				buffer = '';
			} else buffer += char;
		}
	}

	return {
		write,
		written,
		alarms,
		errors,
		set holdMotion(next: boolean) {
			holdMotion = next;
		},
		get machine() {
			return machine;
		},
		/** The most characters that were ever sent and not yet answered at once. */
		get mostUnanswered() {
			return mostUnanswered;
		},
		get offset() {
			return offset;
		},
		set state(next: string) {
			state = next;
		}
	};
}
