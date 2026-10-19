import {
	alarmLosesPosition,
	alarmText,
	errorText,
	HOME,
	jogCommand,
	overrideCommand,
	parseLine,
	probeCommand,
	REALTIME,
	RX_BUFFER_SIZE,
	UNLOCK,
	workPosition,
	workZCommand,
	zeroCommand,
	type Override,
	type Overrides,
	type Position,
	type StatusReport
} from './protocol.js';
import {
	JOG_FEED_XY,
	JOG_FEED_Z,
	MAX_Z_JOG,
	POINT_TOLERANCE,
	PROBE_AGREEMENT,
	PROBE_BACKOFF,
	PROBE_CLEARANCE,
	PROBE_SEEK_FEED,
	PROBE_TOUCH_FEED,
	PROBE_Z_SEARCH,
	probeSettingsErrors,
	probeTarget,
	surfaceReading,
	type ProbePoint,
	type ProbeSettings
} from './probing.js';
import { round } from '$lib/core/units.js';

/** What the operator sees of the controller. */
export type ControllerSnapshot = {
	readonly status: StatusReport | null;
	/** Where the tool is in work coordinates, once a work offset has been seen. */
	readonly work: Position | null;
	/**
	 * The operator has said X0 Y0 is the sheet's lower-left corner and Z0 is on
	 * the table. Nothing moves to a grid point without it, and anything that
	 * may have lost the position takes it back.
	 */
	readonly originConfirmed: boolean;
	/** A move or probe KorCad started is running. */
	readonly busy: boolean;
	/** The last alarm, in words, until the controller is next reset. */
	readonly alarm: string | null;
	/** The feed, rapid, and spindle overrides last reported, in percent. */
	readonly overrides: Overrides | null;
};

export type GrblController = ReturnType<typeof createGrblController>;

/** How often the controller is asked for its status, in milliseconds. */
export const STATUS_INTERVAL = 200;
/** The longest a move across the table may take before KorCad stops waiting, in milliseconds. */
const MOVE_TIMEOUT = 180_000;
const RESET_TIMEOUT = 3_000;
/** How long a feed hold has to bring the machine to rest before the reset, in milliseconds. */
const HOLD_TIMEOUT = 1_500;

class Stopped extends Error {
	constructor() {
		super('Stopped');
	}
}

/** GRBL answered a line with `error:N`: it skipped that line and went on with the rest. */
class Refused extends Error {}

type Waiter = {
	/** Resolves or rejects the waiter when a report settles it; false keeps waiting. */
	readonly settle: (report: StatusReport) => boolean;
	readonly fail: (error: Error) => void;
};

/**
 * Drives a GRBL 1.1 controller over a line link. `write` sends text exactly
 * as given; whatever reads the link hands each line it receives to `receive`.
 *
 * Lines are sent one at a time, each waiting for its `ok`, so GRBL's 128-byte
 * receive buffer can never overflow and every answer pairs with its command.
 * After an alarm the pairing cannot be trusted, so recovering resets the
 * controller, which empties its buffers, before sending anything else.
 */
export function createGrblController(
	write: (data: string) => void | Promise<void>,
	onChange: (snapshot: ControllerSnapshot) => void = () => {}
) {
	let status: StatusReport | null = null;
	let offset: Position | null = null;
	let originConfirmed = false;
	let busy = false;
	let alarm: string | null = null;
	let overrides: Overrides | null = null;
	let probe: { readonly machine: Position; readonly touched: boolean } | null = null;
	/** Each stop starts a new generation; a sequence from an older one gives up. */
	let generation = 0;
	let queue: Promise<void> = Promise.resolve();
	const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
	const waiters = new Set<Waiter>();
	const bannerWaiters = new Set<() => void>();
	let poll: ReturnType<typeof setInterval> | undefined;

	const work = () => (status ? workPosition(status, offset) : null);
	const lastProbe = () => probe;
	const snapshot = (): ControllerSnapshot => ({
		status,
		work: work(),
		originConfirmed,
		busy,
		alarm,
		overrides
	});
	const changed = () => onChange(snapshot());
	const send = (data: string) => Promise.resolve(write(data));

	function failPending(error: Error): void {
		for (const entry of pending.splice(0)) entry.reject(error);
	}

	function failWaiters(error: Error): void {
		for (const waiter of [...waiters]) waiter.fail(error);
		waiters.clear();
	}

	function receive(line: string): void {
		const message = parseLine(line);
		switch (message.kind) {
			case 'ok':
				pending.shift()?.resolve();
				return;
			case 'error':
				pending.shift()?.reject(new Refused(errorText(message.code)));
				return;
			case 'alarm': {
				alarm = alarmText(message.code);
				if (alarmLosesPosition(message.code)) originConfirmed = false;
				const error = new Error(alarm);
				failPending(error);
				failWaiters(error);
				changed();
				return;
			}
			case 'status':
				status = message.report;
				if (message.report.offset) offset = message.report.offset;
				if (message.report.overrides) overrides = message.report.overrides;
				for (const waiter of [...waiters])
					if (waiter.settle(message.report)) waiters.delete(waiter);
				changed();
				return;
			case 'probe':
				probe = message;
				return;
			case 'banner': {
				// A reset empties GRBL's buffers, so nothing sent before it will be answered.
				const error = new Error('The controller was reset');
				failPending(error);
				failWaiters(error);
				// The offset is reported again after a reset; until then the work position is unknown.
				offset = null;
				originConfirmed = false;
				alarm = null;
				// A reset puts every override back to 100%.
				overrides = null;
				for (const resume of [...bannerWaiters]) resume();
				bannerWaiters.clear();
				changed();
				return;
			}
			case 'other':
				return;
		}
	}

	/** Sends one line and resolves on its `ok`, after every line sent before it. */
	function command(line: string): Promise<void> {
		const run = queue.then(
			() =>
				new Promise<void>((resolve, reject) => {
					pending.push({ resolve, reject });
					send(`${line}\n`).catch((error: unknown) => {
						const index = pending.findIndex((entry) => entry.reject === reject);
						if (index >= 0) pending.splice(index, 1);
						reject(error instanceof Error ? error : new Error(String(error)));
					});
				})
		);
		queue = run.catch(() => undefined);
		return run;
	}

	/** Resolves with the first report from now on that `accept` takes. */
	function report(
		accept: (report: StatusReport) => boolean,
		timeout: number
	): Promise<StatusReport> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error('The controller stopped answering'));
			}, timeout);
			const waiter: Waiter = {
				settle: (next) => {
					if (!accept(next)) return false;
					clearTimeout(timer);
					resolve(next);
					return true;
				},
				fail: (error) => {
					clearTimeout(timer);
					reject(error);
				}
			};
			waiters.add(waiter);
		});
	}

	/** Waits for the motion queued so far to finish, by a report of idle after it. */
	async function settled(): Promise<void> {
		await report((next) => next.state === 'Idle', MOVE_TIMEOUT);
	}

	function requireIdle(): Position {
		if (busy) throw new Error('Wait for the current move to finish');
		if (status?.state !== 'Idle') {
			throw new Error(
				status?.state === 'Alarm'
					? 'The machine is in alarm; home or unlock it first'
					: 'The machine must be idle'
			);
		}
		const position = work();
		if (!position) throw new Error('Still reading where the tool is');
		return position;
	}

	/**
	 * Where the tool is now, read from a report made after every line sent so
	 * far was answered and any jog finished, so a move, reading, or zero never
	 * acts on a position from before the operator's last nudge.
	 */
	async function current(): Promise<Position> {
		if (busy) throw new Error('Wait for the current move to finish');
		await queue;
		await report((next) => next.state !== 'Jog', MOVE_TIMEOUT);
		return requireIdle();
	}

	function requireOrigin(): void {
		if (!originConfirmed) {
			throw new Error(
				'Confirm the origin is at the sheet’s lower-left corner and Z0 is on the table'
			);
		}
	}

	/** Runs a sequence of moves as one busy spell that a stop abandons. */
	async function sequence<T>(steps: (check: () => void) => Promise<T>): Promise<T> {
		const started = generation;
		busy = true;
		changed();
		try {
			return await steps(() => {
				if (generation !== started) throw new Stopped();
			});
		} catch (error) {
			// After a stop, whatever went wrong next was the stop.
			throw generation === started ? error : new Stopped();
		} finally {
			if (generation === started) {
				busy = false;
				changed();
			}
		}
	}

	/**
	 * Goes to a point at travel height: up first if the tool is lower, never
	 * down, then across. The tool never crosses the table below travel height.
	 */
	async function travelTo(
		point: { x: number; y: number },
		travelHeight: number,
		feed: number,
		check: () => void
	) {
		const from = work();
		if (!from) throw new Error('Still reading where the tool is');
		if (from.z < travelHeight) {
			await command(jogCommand('absolute', { z: travelHeight }, JOG_FEED_Z));
			check();
		}
		await command(jogCommand('absolute', { x: point.x, y: point.y }, feed));
		check();
		await settled();
		check();
	}

	/** One probe cycle straight down towards `target`, returning the work Z where it touched. */
	async function touch(target: number, feed: number, check: () => void): Promise<number> {
		probe = null;
		await command(probeCommand(target, feed));
		check();
		// GRBL reports where it touched just before the probe's `ok`.
		const touched = lastProbe();
		if (!touched?.touched || !offset) throw new Error('The probe did not report where it touched');
		return touched.machine.z - offset.z;
	}

	/**
	 * Seeks the plate quickly, backs off, and touches it again slowly, both
	 * passes going no lower than work Z `target`. Leaves the tool at the slow
	 * touch and returns the work Z of each.
	 */
	async function touchTwice(
		target: number,
		check: () => void
	): Promise<{ readonly seek: number; readonly touched: number }> {
		const seek = await touch(target, PROBE_SEEK_FEED, check);
		await command(jogCommand('relative', { z: PROBE_BACKOFF }, JOG_FEED_Z));
		check();
		// GRBL refuses G-code while a jog is still running.
		await settled();
		check();
		const touched = await touch(target, PROBE_TOUCH_FEED, check);
		return { seek, touched };
	}

	function requireAgreement(seek: number, touched: number): void {
		const disagreement = Math.abs(touched - seek);
		if (disagreement > PROBE_AGREEMENT) {
			throw new Error(
				`The two touches differ by ${round(disagreement)} mm; clear the plate and probe again`
			);
		}
	}

	async function rise(z: number, check: () => void): Promise<void> {
		await command(jogCommand('absolute', { z }, JOG_FEED_Z));
		check();
		await settled();
		check();
	}

	/**
	 * Probes straight down from where the tool is: seeks the plate quickly,
	 * backs off, and touches it again slowly for the reading. Then rises to
	 * travel height and returns the table height.
	 */
	async function probeHere(settings: ProbeSettings, check: () => void): Promise<number> {
		const from = work();
		if (!from) throw new Error('Still reading where the tool is');
		if (from.z < settings.plateThickness + PROBE_CLEARANCE) {
			throw new Error('Raise the tool above the plate before probing');
		}
		// Both passes stop at the same depth, so neither goes past PROBE_MARGIN under the plate.
		const { seek, touched } = await touchTwice(probeTarget(settings), check);
		await rise(settings.travelHeight, check);
		requireAgreement(seek, touched);
		return surfaceReading(touched, settings);
	}

	/** Sends `lines` as a stream, resolving once the last is answered. */
	function stream(lines: readonly string[], onProgress: (answered: number) => void): Promise<void> {
		return new Promise((resolve, reject) => {
			let next = 0;
			let answered = 0;
			// Characters sent and not yet answered, each line's newline included.
			let unanswered = 0;
			let failed = false;
			const fail = (error: Error) => {
				if (failed) return;
				failed = true;
				reject(error);
			};
			const pump = () => {
				while (!failed && next < lines.length) {
					const line = lines[next]!;
					const size = line.length + 1;
					// GRBL's ring buffer holds one character fewer than its size.
					if (unanswered + size > RX_BUFFER_SIZE - 1) return;
					const number = next + 1;
					next++;
					unanswered += size;
					pending.push({
						resolve: () => {
							unanswered -= size;
							answered++;
							onProgress(answered);
							if (answered === lines.length) resolve();
							else pump();
						},
						reject: (error) =>
							fail(
								error instanceof Refused
									? new Refused(`Line ${number}, ${line}: ${error.message}`)
									: error
							)
					});
					send(`${line}\n`).catch((error: unknown) =>
						fail(error instanceof Error ? error : new Error(String(error)))
					);
				}
			};
			pump();
		});
	}

	/** Holds any motion, and once the machine has come to rest, resets the controller. */
	async function halt(): Promise<void> {
		await send(REALTIME.feedHold);
		const resting = (next: StatusReport) =>
			next.state === 'Idle' ||
			next.state === 'Alarm' ||
			(next.state === 'Hold' && next.substate === 0);
		if (!status || !resting(status)) {
			await report(resting, HOLD_TIMEOUT).catch(() => undefined);
		}
		await send(REALTIME.softReset);
	}

	function requireSettings(settings: ProbeSettings): void {
		const [problem] = probeSettingsErrors(settings);
		if (problem) throw new Error(problem);
	}

	return {
		receive,
		snapshot,

		/** Starts asking for status, which also shows whether anything is listening. */
		start(interval = STATUS_INTERVAL) {
			clearInterval(poll);
			void send(REALTIME.status).catch(() => undefined);
			poll = setInterval(() => void send(REALTIME.status).catch(() => undefined), interval);
		},

		dispose() {
			clearInterval(poll);
			generation++;
			const error = new Error('Disconnected');
			failPending(error);
			failWaiters(error);
		},

		/** Whether the tool stands over a point in XY. */
		at(point: { x: number; y: number }): boolean {
			const position = work();
			return (
				position !== null &&
				Math.abs(position.x - point.x) <= POINT_TOLERANCE &&
				Math.abs(position.y - point.y) <= POINT_TOLERANCE
			);
		},

		confirmOrigin(confirmed: boolean) {
			originConfirmed = confirmed && work() !== null;
			changed();
		},

		/** Nudges the tool by `axes`, relative to where it is. Jogs queue behind one another. */
		async jog(axes: Partial<Position>, feed: number) {
			if (busy) throw new Error('Wait for the current move to finish');
			if (status?.state !== 'Idle' && status?.state !== 'Jog') {
				throw new Error('The machine must be idle to jog');
			}
			if (Math.abs(axes.z ?? 0) > MAX_Z_JOG) {
				throw new Error(`Jog Z at most ${round(MAX_Z_JOG)} mm at a time`);
			}
			await command(jogCommand('relative', axes, feed));
		},

		/** Sets the work origin at the tool on `axes`. The position is unknown until GRBL reports the new offset. */
		async setZero(axes: 'xy' | 'z') {
			await current();
			await command(zeroCommand(axes));
			offset = null;
			changed();
		},

		/** Goes to a grid point, which means nothing until the origin is confirmed. */
		async moveTo(point: { x: number; y: number }, travelHeight: number, feed = JOG_FEED_XY) {
			requireOrigin();
			await current();
			await sequence((check) => travelTo(point, travelHeight, feed, check));
		},

		/**
		 * Goes to a point the operator typed, in work coordinates as the status
		 * shows them. Unlike a grid point it needs no confirmed origin, since
		 * bringing the tool near the origin is how one gets confirmed; like a
		 * jog, it is only as right as the offsets the controller holds.
		 */
		async goTo(point: { x: number; y: number }, travelHeight: number, feed = JOG_FEED_XY) {
			if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
				throw new Error('Enter X and Y to go to');
			}
			if (!(Number.isFinite(travelHeight) && travelHeight > 0)) {
				throw new Error('Set a travel height above Z0 first');
			}
			await current();
			await sequence((check) => travelTo(point, travelHeight, feed, check));
		},

		/** The tool's work Z, as a reading of the table where it touches by hand. */
		async reading(): Promise<number> {
			return (await current()).z;
		},

		/** Probes down to the table where the tool stands, and rises again. */
		async probe(settings: ProbeSettings): Promise<number> {
			requireOrigin();
			requireSettings(settings);
			await current();
			return sequence((check) => probeHere(settings, check));
		},

		/**
		 * Visits each point in turn and probes it, reporting each reading as it
		 * comes, for a conductive sheet that lies under every point at once.
		 */
		async probeEach(
			points: readonly ProbePoint[],
			settings: ProbeSettings,
			onReading: (index: number, reading: number) => void,
			feed = JOG_FEED_XY
		) {
			requireOrigin();
			requireSettings(settings);
			await current();
			await sequence(async (check) => {
				for (const point of points) {
					await travelTo(point, settings.travelHeight, feed, check);
					onReading(point.index, await probeHere(settings, check));
				}
			});
		},

		/**
		 * Stops everything: cancels a jog, holds any other motion, and once the
		 * machine has come to rest, resets the controller to empty its queue. A
		 * reset at rest keeps the position, but the origin must be confirmed again.
		 */
		async stop() {
			generation++;
			busy = false;
			failWaiters(new Stopped());
			changed();
			await send(REALTIME.jogCancel);
			await halt();
		},

		/**
		 * Runs a program's lines (see `streamLines`), keeping GRBL's receive
		 * buffer full so that it always has the next moves planned, and reports
		 * each line answered. A line GRBL refuses stops the machine, since it
		 * would carry on without it; an alarm has stopped it already. Resolves
		 * once the machine is idle after the last line.
		 */
		async run(lines: readonly string[], onProgress: (answered: number) => void = () => {}) {
			requireOrigin();
			if (lines.at(-1) !== 'M2') throw new Error('A program must end with M2');
			await current();
			await sequence(async (check) => {
				try {
					await stream(lines, onProgress);
				} catch (error) {
					if (error instanceof Refused) {
						await halt();
						throw new Error(`${error.message}. The machine was stopped.`, { cause: error });
					}
					throw error;
				}
				check();
				await settled();
				check();
			});
		},

		/** Holds motion where it is, decelerating; the spindle keeps turning. */
		pause: () => send(REALTIME.feedHold),

		/** Carries on from a hold. */
		resume: () => send(REALTIME.cycleStart),

		/** Nudges the feed or spindle override 10%, or puts it back to 100%. */
		override: (which: Override, change: 'up' | 'down' | 'reset') =>
			send(overrideCommand(which, change)),

		/** Makes the tool's height here work Z `z`, as when its tip touches the work at a point that stands `z` above Z0. */
		async setWorkZ(z: number) {
			await current();
			await command(workZCommand(z));
			offset = null;
			changed();
		},

		/**
		 * Sets Z0 with a touch plate under a tool of unknown length: probes down
		 * no more than `PROBE_Z_SEARCH` from where the tool stands, makes the
		 * plate's top work Z `plateThickness + height`, where `height` is how far
		 * the work there stands above Z0, and rises to travel height.
		 */
		async probeZero(settings: ProbeSettings, height: number) {
			requireSettings(settings);
			const from = await current();
			await sequence(async (check) => {
				const { seek, touched } = await touchTwice(from.z - PROBE_Z_SEARCH, check);
				await settled();
				check();
				try {
					requireAgreement(seek, touched);
				} catch (error) {
					await rise(from.z, check);
					throw error;
				}
				const now = work();
				if (!now) throw new Error('Still reading where the tool is');
				// The tool may have come to rest a hair past where the probe tripped.
				await command(workZCommand(round(settings.plateThickness + height + now.z - touched, 4)));
				check();
				offset = null;
				changed();
				await rise(settings.travelHeight, check);
			});
		},

		/**
		 * Clears an alarm by homing or unlocking. The controller is reset first,
		 * so that no answer to a line sent before the alarm can be taken for an
		 * answer to this one.
		 */
		async recover(action: 'home' | 'unlock') {
			if (busy) throw new Error('Wait for the current move to finish');
			const reset = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					bannerWaiters.delete(resume);
					reject(new Error('The controller did not come back from its reset'));
				}, RESET_TIMEOUT);
				const resume = () => {
					clearTimeout(timer);
					resolve();
				};
				bannerWaiters.add(resume);
			});
			await send(REALTIME.softReset);
			await reset;
			if (action === 'home') await sequence(() => command(HOME));
			else await command(UNLOCK);
		}
	};
}

/** Whether an error is only the consequence of the operator pressing Stop. */
export function isStopped(error: unknown): boolean {
	return error instanceof Stopped;
}
