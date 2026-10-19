import {
	createGrblController,
	isStopped,
	type ControllerSnapshot,
	type GrblController
} from '$lib/core/grbl/controller.js';
import {
	DEFAULT_JOG_SPEED,
	DEFAULT_PROBE_SETTINGS,
	JOG_FEED_Z,
	jogFeed,
	type ProbePoint,
	type ProbeSettings
} from '$lib/core/grbl/probing.js';
import type { SurfaceMap } from '$lib/core/cam/surface.js';
import { jobPrograms, needsZero, workTopAt, type JobProgram } from '$lib/core/grbl/job.js';
import type { Override, Position } from '$lib/core/grbl/protocol.js';
import { round, type Units } from '$lib/core/units.js';
import { openSerialLink, serialAvailable, type SerialLink } from './serial.js';

export type MachineLink = ReturnType<typeof createMachineLink>;

/**
 * A sheet's programs being run: `setup` while the operator loads the tool and
 * sets Z0 for program `index`, `running` while it streams, then `done`, or
 * `failed` if anything stopped it. A failed job is not resumed partway: the
 * operator starts it again, or exports it to finish elsewhere.
 */
export type Job = {
	readonly sheet: string;
	readonly programs: readonly JobProgram[];
	/** The map the programs were bent to follow, for working out Z0 wherever it is set. */
	readonly map: SurfaceMap;
	readonly index: number;
	readonly phase: 'setup' | 'running' | 'done' | 'failed';
	/** Z0 has been set since this program's setup began. */
	readonly zeroSet: boolean;
	/** Lines of the current program the controller has answered. */
	readonly answered: number;
	readonly paused: boolean;
	readonly message: string;
};

/**
 * The editor's connection to a GRBL controller over USB, for jogging,
 * measuring the table, and running a sheet's programs with a stop for each
 * tool change.
 *
 * Every action reports a failure in `problem` rather than throwing, since each
 * one starts from a button. `units` are the document's, which jog speeds are
 * picked in.
 */
export function createMachineLink(units: () => Units) {
	let snapshot = $state.raw<ControllerSnapshot | null>(null);
	let connecting = $state(false);
	let problem = $state('');
	let probeSettings = $state.raw<ProbeSettings>(DEFAULT_PROBE_SETTINGS);
	/** An index into `JOG_SPEEDS`, for jogs and moves across the table. */
	let jogSpeed = $state(DEFAULT_JOG_SPEED);
	const travelFeed = () => jogFeed(units(), jogSpeed);
	/**
	 * The points the last run of `probeEach` did not read, in the order it would
	 * have visited them, so that one stopped short can be finished. Kept across
	 * a disconnect, since a lost cable is one way a run stops.
	 */
	let unread = $state.raw<readonly ProbePoint[]>([]);
	let job = $state.raw<Job | null>(null);
	let link: SerialLink | null = null;
	let controller: GrblController | null = null;

	// A screen that sleeps can take the computer with it, and the job with it:
	// keep it awake while a program runs, asking again whenever the tab comes
	// back into view, since a hidden tab loses its lock.
	let wakeLock: WakeLockSentinel | null = null;
	async function requestWake(): Promise<void> {
		if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
		wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
	}
	const rewake = () => void requestWake();
	async function keepAwake(on: boolean): Promise<void> {
		if (typeof document === 'undefined') return;
		if (on) {
			document.addEventListener('visibilitychange', rewake);
			await requestWake();
		} else {
			document.removeEventListener('visibilitychange', rewake);
			await wakeLock?.release().catch(() => undefined);
			wakeLock = null;
		}
	}

	function forget(): void {
		controller?.dispose();
		controller = null;
		link = null;
		snapshot = null;
	}

	async function run<T>(task: (controller: GrblController) => Promise<T>): Promise<T | undefined> {
		if (!controller) return undefined;
		problem = '';
		try {
			return await task(controller);
		} catch (error) {
			problem = isStopped(error)
				? 'Stopped.'
				: error instanceof Error
					? error.message
					: String(error);
			return undefined;
		}
	}

	return {
		get available() {
			return serialAvailable();
		},
		get connected() {
			return snapshot !== null;
		},
		get connecting() {
			return connecting;
		},
		get snapshot() {
			return snapshot;
		},
		get problem() {
			return problem;
		},
		get probeSettings() {
			return probeSettings;
		},
		setProbeSettings(next: ProbeSettings) {
			probeSettings = next;
		},
		get jogSpeed() {
			return jogSpeed;
		},
		setJogSpeed(next: number) {
			jogSpeed = next;
		},

		async connect() {
			if (controller || connecting) return;
			connecting = true;
			problem = '';
			try {
				let next: GrblController | null = null;
				const opened = await openSerialLink(
					(line) => next?.receive(line),
					() => {
						forget();
						problem = 'The machine disconnected.';
					}
				);
				next = createGrblController(
					(data) => opened.write(data),
					(state) => (snapshot = state)
				);
				link = opened;
				controller = next;
				snapshot = next.snapshot();
				next.start();
			} catch (error) {
				// Closing the port chooser without picking one is not a problem to report.
				if (!(error instanceof DOMException && error.name === 'NotFoundError')) {
					problem = error instanceof Error ? error.message : String(error);
				}
			} finally {
				connecting = false;
			}
		},

		async disconnect() {
			const closing = link;
			forget();
			problem = '';
			await closing?.close().catch(() => undefined);
		},

		stop: () => run((c) => c.stop()),
		/** Nudges one axis: across the table at the picked speed, up and down gently. */
		jog: (axes: Partial<Position>) =>
			run((c) => c.jog(axes, axes.z === undefined ? travelFeed() : JOG_FEED_Z)),
		setZero: (axes: 'xy' | 'z') => run((c) => c.setZero(axes)),
		recover: (action: 'home' | 'unlock') => run((c) => c.recover(action)),
		confirmOrigin(confirmed: boolean) {
			controller?.confirmOrigin(confirmed);
		},
		at(point: { x: number; y: number }): boolean {
			// Read through the snapshot so the answer updates with each report.
			return snapshot !== null && (controller?.at(point) ?? false);
		},
		moveTo: (point: { x: number; y: number }) =>
			run((c) => c.moveTo(point, probeSettings.travelHeight, travelFeed())),
		goTo: (point: { x: number; y: number }) =>
			run((c) => c.goTo(point, probeSettings.travelHeight, travelFeed())),
		reading: () => run((c) => c.reading()),
		probe: () => run((c) => c.probe(probeSettings)),
		get unread() {
			return unread;
		},
		/** Takes a point off what is left to probe, once it has been read some other way. */
		markRead(index: number) {
			if (unread.some((point) => point.index === index)) {
				unread = unread.filter((point) => point.index !== index);
			}
		},
		/** Forgets the points a run did not reach, once the map they belong to is replaced. */
		forgetUnread() {
			unread = [];
		},
		async probeEach(
			points: readonly ProbePoint[],
			onReading: (index: number, reading: number) => void
		) {
			const read: number[] = [];
			await run((c) =>
				c.probeEach(
					points,
					probeSettings,
					(index, reading) => {
						read.push(index);
						onReading(index, reading);
					},
					travelFeed()
				)
			);
			unread = points.filter((point) => !read.includes(point.index));
		},

		get job() {
			return job;
		},

		/**
		 * Gets a sheet's programs ready to run, from the text G-code export would
		 * write. Nothing moves until the operator starts the first program.
		 */
		prepareJob(
			sheet: string,
			programs: readonly {
				readonly operation: 'crease' | 'cut';
				readonly tool: string;
				readonly spindle: boolean;
				readonly text: string;
			}[],
			map: SurfaceMap
		) {
			if (job?.phase === 'running') return;
			problem = '';
			try {
				job = {
					sheet,
					programs: jobPrograms(programs),
					map,
					index: 0,
					phase: 'setup',
					zeroSet: false,
					answered: 0,
					paused: false,
					message: ''
				};
			} catch (error) {
				problem = error instanceof Error ? error.message : String(error);
			}
		},

		/** Puts a job that is not running away. */
		closeJob() {
			if (job?.phase !== 'running') job = null;
		},

		/**
		 * Sets Z0 for the program about to run, at the work's top where the tool
		 * stands: by its tip touching the work, or with the touch plate on the
		 * work under it. With the surface map on, Z0 is still the work's top at
		 * X0 Y0, worked out from the map.
		 */
		async setJobZero(how: 'touch' | 'plate') {
			const current = job;
			const at = snapshot?.work;
			if (!current || current.phase !== 'setup' || !at) return;
			if (current.map.enabled && !snapshot?.originConfirmed) {
				problem = 'Confirm the origin first: the surface map is measured from X0 Y0';
				return;
			}
			const top = round(workTopAt(current.map, at), 4);
			const done = await run(async (c) => {
				if (how === 'touch') await c.setWorkZ(top);
				else await c.probeZero(probeSettings, top);
				return true;
			});
			if (done && job === current) job = { ...current, zeroSet: true };
		},

		/**
		 * Runs the program the job is set up for. Z0 must have been set for it,
		 * unless the tool is the one the last program used or the operator says
		 * Z0 already holds for it.
		 */
		async startProgram(zeroConfirmed = false) {
			const current = job;
			const program = current?.programs[current.index];
			if (!current || current.phase !== 'setup' || !program) return;
			if (needsZero(current.programs, current.index) && !current.zeroSet && !zeroConfirmed) {
				problem = `Set Z0 for the ${program.tool} first`;
				return;
			}
			job = { ...current, phase: 'running', answered: 0, paused: false, message: '' };
			await keepAwake(true);
			const finished = await run(async (c) => {
				await c.run(program.lines, (answered) => {
					if (job) job = { ...job, answered };
				});
				return true;
			});
			await keepAwake(false);
			const after = job;
			if (!after) return;
			const next = after.index + 1;
			if (!finished) {
				job = {
					...after,
					phase: 'failed',
					paused: false,
					message: `${problem} The ${program.operation} program stopped after line ${after.answered} of ${program.lines.length}.`
				};
			} else if (next < after.programs.length) {
				job = { ...after, index: next, phase: 'setup', zeroSet: false, answered: 0, paused: false };
			} else {
				job = { ...after, phase: 'done', paused: false };
			}
		},

		async pauseJob() {
			if (job?.phase !== 'running') return;
			await run((c) => c.pause());
			if (job) job = { ...job, paused: true };
		},

		async resumeJob() {
			if (job?.phase !== 'running') return;
			await run((c) => c.resume());
			if (job) job = { ...job, paused: false };
		},

		override: (which: Override, change: 'up' | 'down' | 'reset') =>
			run((c) => c.override(which, change))
	};
}
