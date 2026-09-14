import type { Point } from '$lib/core/geometry/primitives.js';

/**
 * Orders the stops of a tool route to shorten rapid travel: a travelling
 * salesman search that knows three things a textbook one does not.
 *
 * - **Blocks.** Stops come in contiguous blocks (machining stages) that keep
 *   their order; a stop only ever moves within its own block, so no search move
 *   can put a release cut before the interior work it depends on.
 * - **Variants.** A stop can be machined several ways (a closed contour from
 *   any of its start points, an open path in either direction), each with its
 *   own start, end, and travel inside it. Travel is therefore asymmetric.
 * - **Repeatability.** The same stops always yield the same order, since the
 *   route becomes a program an operator may compare between exports. The only
 *   randomness is a fixed-seed generator.
 *
 * The search is 2-opt (reverse a run of stops) and Or-opt (move a run of one to
 * three stops elsewhere, either way round), each costed in constant time from
 * prefix sums and tried only beside a stop's nearest neighbours, with each
 * stop's variant repaired between its neighbours as the order settles. It then
 * kicks the route out of its local optimum with seeded double-bridge moves and
 * searches again, keeping only a strictly shorter route (iterated local
 * search), and finally chooses every variant exactly for the order it found.
 *
 * The tool starts and ends at the origin.
 */

export type StopVariant = {
	readonly start: Point;
	readonly end: Point;
	/** Rapid travel between the variant's own pieces, such as the fragments of a chain. */
	readonly internalTravel: number;
};

export type Stop = { readonly variants: readonly StopVariant[] };

export type Sequence = {
	/** Indices into the stops, in machining order. */
	readonly order: readonly number[];
	/** The chosen variant of each stop, indexed by stop. */
	readonly variants: readonly number[];
	readonly travel: number;
};

/** Double-bridge kicks tried after the first local optimum. */
const KICKS = 100;
/** Below this many stops a block has no room for a double bridge. */
const MIN_KICK_BLOCK = 5;
/** Nearest stops each stop considers joining in a move; exact search beyond them rarely pays. */
const NEIGHBOURS = 10;
/** Longest run Or-opt moves at once. */
const OR_OPT_LENGTH = 3;
/** Improvements smaller than this are float noise, and taking them could cycle. */
const EPSILON = 1e-7;
const SEED = 0x4b6f7243;

const ORIGIN: Point = { x: 0, y: 0 };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** mulberry32: small, fast, and the same sequence on every platform. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The variant that best runs a stop backwards: its start nearest the given
 * variant's end and its end nearest its start. A closed contour is its own
 * reverse; an open path's reverse is its other direction; a path that may not
 * be reversed has only itself.
 */
function flipOf(stop: Stop, index: number): number {
	const current = stop.variants[index]!;
	let best = index;
	let bestScore = Infinity;
	stop.variants.forEach((variant, candidate) => {
		const score = distance(variant.start, current.end) + distance(variant.end, current.start);
		if (score < bestScore - EPSILON) {
			best = candidate;
			bestScore = score;
		}
	});
	return best;
}

/** Every variant's reverse, by stop and variant, worked out once per search. */
type Flips = readonly (readonly number[])[];

const flipTable = (stops: readonly Stop[]): Flips =>
	stops.map((stop) => stop.variants.map((_, index) => flipOf(stop, index)));

type Box = { left: number; right: number; bottom: number; top: number };

/** The box around every point a stop can start or end at. */
function stopBox(stop: Stop): Box {
	const points = stop.variants.flatMap((variant) => [variant.start, variant.end]);
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	return {
		left: Math.min(...xs),
		right: Math.max(...xs),
		bottom: Math.min(...ys),
		top: Math.max(...ys)
	};
}

/** Gap between two boxes, zero where they overlap, then centre distance to break ties. */
function boxGap(a: Box, b: Box): [number, number] {
	const dx = Math.max(0, a.left - b.right, b.left - a.right);
	const dy = Math.max(0, a.bottom - b.top, b.bottom - a.top);
	const centre = Math.hypot(
		(a.left + a.right - b.left - b.right) / 2,
		(a.bottom + a.top - b.bottom - b.top) / 2
	);
	return [Math.hypot(dx, dy), centre];
}

/**
 * Each stop's nearest stops in its own block, by the gap between where they
 * can start and end. Moves are only tried that set a stop beside one of these:
 * an improving move almost always joins near neighbours, and it keeps a sweep
 * linear in the stops rather than quadratic.
 */
function neighbourTable(stops: readonly Stop[], blockOf: readonly number[]): number[][] {
	const boxes = stops.map(stopBox);
	return stops.map((_, stop) =>
		stops
			.map((_, other) => other)
			.filter((other) => other !== stop && blockOf[other] === blockOf[stop])
			.map((other) => ({ other, gap: boxGap(boxes[stop]!, boxes[other]!) }))
			.sort((a, b) => a.gap[0] - b.gap[0] || a.gap[1] - b.gap[1] || a.other - b.other)
			.slice(0, NEIGHBOURS)
			.map(({ other }) => other)
	);
}

/** What a search knows about its stops, fixed for its whole run. */
type Problem = {
	readonly stops: readonly Stop[];
	readonly flips: Flips;
	readonly neighbours: readonly (readonly number[])[];
	readonly blocks: readonly Block[];
	/** The block each stop belongs to, which never changes. */
	readonly blockOf: readonly number[];
};

/** Travel of an order with its variants fixed, from the origin and back. */
export function sequenceTravel(
	stops: readonly Stop[],
	order: readonly number[],
	variants: readonly number[]
): number {
	let position = ORIGIN;
	let travel = 0;
	for (const stop of order) {
		const variant = stops[stop]!.variants[variants[stop]!]!;
		travel += distance(position, variant.start) + variant.internalTravel;
		position = variant.end;
	}
	return travel + distance(position, ORIGIN);
}

/**
 * The cheapest variant of every stop for a fixed order, by dynamic programming
 * over the order: the best cost of arriving at each variant of each stop, and
 * which variant of the stop before it came from. Flat arrays, since the search
 * runs this after every kick.
 */
export function bestVariants(stops: readonly Stop[], order: readonly number[]): number[] {
	const chosen = stops.map(() => 0);
	if (!order.length) return chosen;
	const from: Int32Array[] = [];
	let costs = new Float64Array(0);
	let previous: readonly StopVariant[] = [];
	for (const stop of order) {
		const variants = stops[stop]!.variants;
		const next = new Float64Array(variants.length);
		const came = new Int32Array(variants.length);
		for (let v = 0; v < variants.length; v++) {
			const { start, internalTravel } = variants[v]!;
			if (!previous.length) {
				next[v] = Math.hypot(start.x, start.y) + internalTravel;
				came[v] = -1;
				continue;
			}
			let best = Infinity;
			let bestFrom = 0;
			for (let u = 0; u < previous.length; u++) {
				const end = previous[u]!.end;
				const cost = costs[u]! + Math.hypot(start.x - end.x, start.y - end.y);
				if (cost < best) {
					best = cost;
					bestFrom = u;
				}
			}
			next[v] = best + internalTravel;
			came[v] = bestFrom;
		}
		from.push(came);
		costs = next;
		previous = variants;
	}
	let index = 0;
	let bestCost = Infinity;
	for (let v = 0; v < previous.length; v++) {
		const end = previous[v]!.end;
		const cost = costs[v]! + Math.hypot(end.x, end.y);
		if (cost < bestCost) {
			bestCost = cost;
			index = v;
		}
	}
	for (let position = order.length - 1; position >= 0; position--) {
		chosen[order[position]!] = index;
		index = from[position]![index]!;
	}
	return chosen;
}

/**
 * The route as arrays over positions, with the origin as a stop of its own at
 * both ends (positions 0 and n + 1), and prefix sums that cost any move in
 * constant time.
 */
class Route {
	readonly size: number;
	private starts: Point[] = [];
	private ends: Point[] = [];
	private flipStarts: Point[] = [];
	private flipEnds: Point[] = [];
	/** forward[k]: sum of travel from position 0's end to position k's start, plus internals before k. */
	private forward: number[] = [];
	/** backward[k]: the same sum for the run reversed, over the edges and internals before k. */
	private backward: number[] = [];
	private internal: number[] = [];
	private flipInternal: number[] = [];

	/** The 1-based position of each stop. */
	positions: number[] = [];

	private readonly stops: readonly Stop[];
	private readonly flips: Flips;

	constructor(
		problem: Problem,
		public order: number[],
		public variants: number[]
	) {
		this.stops = problem.stops;
		this.flips = problem.flips;
		this.size = order.length;
		this.rebuild();
	}

	rebuild(): void {
		const n = this.size;
		const starts = [ORIGIN];
		const ends = [ORIGIN];
		const flipStarts = [ORIGIN];
		const flipEnds = [ORIGIN];
		const internal = [0];
		const flipInternal = [0];
		for (const stop of this.order) {
			const variants = this.stops[stop]!.variants;
			const variant = variants[this.variants[stop]!]!;
			const flip = variants[this.flips[stop]![this.variants[stop]!]!]!;
			starts.push(variant.start);
			ends.push(variant.end);
			flipStarts.push(flip.start);
			flipEnds.push(flip.end);
			internal.push(variant.internalTravel);
			flipInternal.push(flip.internalTravel);
		}
		starts.push(ORIGIN);
		ends.push(ORIGIN);
		flipStarts.push(ORIGIN);
		flipEnds.push(ORIGIN);
		internal.push(0);
		flipInternal.push(0);
		Object.assign(this, { starts, ends, flipStarts, flipEnds, internal, flipInternal });
		this.positions = [];
		this.order.forEach((stop, index) => (this.positions[stop] = index + 1));

		// forward[k] = sum over j < k of (edge j -> j+1) + internal[j + 1], so the
		// cost of positions i..j with their inner edges is forward[j] - forward[i] + internal[i].
		this.forward = [0];
		this.backward = [0];
		for (let k = 0; k <= n; k++) {
			this.forward.push(this.forward[k]! + distance(ends[k]!, starts[k + 1]!) + internal[k + 1]!);
			// Reversed, stop k + 1 runs before stop k: from its flipped end to k's flipped start.
			this.backward.push(
				this.backward[k]! + distance(flipEnds[k + 1]!, flipStarts[k]!) + flipInternal[k + 1]!
			);
		}
	}

	/**
	 * Gives each stop in turn its cheapest variant between the stops either
	 * side of it. Much cheaper than choosing every variant at once, and enough
	 * to repair the few joins a move or kick disturbs; the exact choice is made
	 * once, on the final route. Returns the stops that changed.
	 */
	descendVariants(): number[] {
		const changed: number[] = [];
		this.order.forEach((stop, index) => {
			const k = index + 1;
			const before = this.ends[k - 1]!;
			const after = this.starts[k + 1]!;
			const variants = this.stops[stop]!.variants;
			const cost = (variant: StopVariant) =>
				distance(before, variant.start) + variant.internalTravel + distance(variant.end, after);
			let best = this.variants[stop]!;
			let bestCost = cost(variants[best]!);
			variants.forEach((variant, candidate) => {
				const candidateCost = cost(variant);
				if (candidateCost < bestCost - EPSILON) {
					best = candidate;
					bestCost = candidateCost;
				}
			});
			if (best === this.variants[stop]) return;
			this.variants[stop] = best;
			this.starts[k] = variants[best]!.start;
			this.ends[k] = variants[best]!.end;
			changed.push(stop);
		});
		if (changed.length) this.rebuild();
		return changed;
	}

	get travel(): number {
		return this.forward[this.size + 1]!;
	}

	/** Travel inside positions i..j as they run now: their internals and the edges between them. */
	private runForward(i: number, j: number): number {
		return this.forward[j]! - this.forward[i]! + this.internal[i]!;
	}

	/** Travel inside positions i..j run backwards, with each stop flipped. */
	private runBackward(i: number, j: number): number {
		return this.backward[j]! - this.backward[i]! + this.flipInternal[i]!;
	}

	private edge(k: number): number {
		return distance(this.ends[k]!, this.starts[k + 1]!);
	}

	/** Change in travel from reversing positions i..j. */
	twoOptDelta(i: number, j: number): number {
		const before = this.edge(i - 1) + this.runForward(i, j) + this.edge(j);
		const after =
			distance(this.ends[i - 1]!, this.flipStarts[j]!) +
			this.runBackward(i, j) +
			distance(this.flipEnds[i]!, this.starts[j + 1]!);
		return after - before;
	}

	/**
	 * Change in travel from lifting positions i..j out and setting them down
	 * between positions p and p + 1 (p outside i - 1..j), forwards or reversed.
	 */
	orOptDelta(i: number, j: number, p: number, reversed: boolean): number {
		const removed =
			this.edge(i - 1) +
			this.runForward(i, j) +
			this.edge(j) -
			distance(this.ends[i - 1]!, this.starts[j + 1]!);
		const inserted = reversed
			? distance(this.ends[p]!, this.flipStarts[j]!) +
				this.runBackward(i, j) +
				distance(this.flipEnds[i]!, this.starts[p + 1]!)
			: distance(this.ends[p]!, this.starts[i]!) +
				this.runForward(i, j) +
				distance(this.ends[j]!, this.starts[p + 1]!);
		return inserted - this.edge(p) - removed;
	}

	/** Stops at positions i..j (1-based), flipped, in reverse. */
	private flippedRun(i: number, j: number): number[] {
		const run = this.order.slice(i - 1, j).reverse();
		for (const stop of run) this.variants[stop] = this.flips[stop]![this.variants[stop]!]!;
		return run;
	}

	reverse(i: number, j: number): void {
		this.order.splice(i - 1, j - i + 1, ...this.flippedRun(i, j));
		this.rebuild();
	}

	move(i: number, j: number, p: number, reversed: boolean): void {
		const run = reversed ? this.flippedRun(i, j) : this.order.slice(i - 1, j);
		const rest = [...this.order.slice(0, i - 1), ...this.order.slice(j)];
		// p counts positions in the full route; with the run lifted out, those after it shift down.
		const at = p > j ? p - (j - i + 1) : p;
		rest.splice(at, 0, ...run);
		this.order = rest;
		this.rebuild();
	}
}

type Block = { readonly first: number; readonly last: number };

/** Positions (1-based) of each block, from the block sizes. */
function blockRanges(sizes: readonly number[]): Block[] {
	const blocks: Block[] = [];
	let first = 1;
	for (const size of sizes) {
		if (size > 0) blocks.push({ first, last: first + size - 1 });
		first += size;
	}
	return blocks;
}

/** A move the search can make, costed. */
type Move =
	| { readonly kind: 'reverse'; readonly i: number; readonly j: number }
	| {
			readonly kind: 'move';
			readonly i: number;
			readonly j: number;
			readonly p: number;
			readonly reversed: boolean;
	  };

/**
 * The first improving move that involves the stop at position `at`: reversing
 * or relocating a run that starts or ends there, beside a neighbour of an end.
 */
function improvingMove(problem: Problem, route: Route, at: number): Move | null {
	const { first, last } = problem.blocks[problem.blockOf[route.order[at - 1]!]!]!;
	const stopAt = (position: number) => route.order[position - 1]!;
	const near = (position: number) => problem.neighbours[stopAt(position)]!;
	const positionsOf = (position: number, offset: number) =>
		position >= first && position <= last
			? near(position).map((q) => route.positions[q]! + offset)
			: [];

	// Reversing i..j joins i - 1 to j and i to j + 1; here `at` is i, then j.
	for (const j of [...positionsOf(at - 1, 0), ...positionsOf(at, -1)]) {
		if (j > at && j <= last && route.twoOptDelta(at, j) < -EPSILON)
			return { kind: 'reverse', i: at, j };
	}
	for (const i of [...positionsOf(at, 1), ...positionsOf(at + 1, 0)]) {
		if (i >= first && i < at && route.twoOptDelta(i, at) < -EPSILON)
			return { kind: 'reverse', i, j: at };
	}

	for (let length = 1; length <= OR_OPT_LENGTH; length++) {
		for (const i of new Set([at, at - length + 1])) {
			const j = i + length - 1;
			if (i < first || j > last) continue;
			// Set down beside a neighbour of either end of the run, or at either end
			// of the block, where it meets the next.
			const places = new Set([first - 1, last]);
			for (const q of [...near(i), ...near(j)]) {
				places.add(route.positions[q]!);
				places.add(route.positions[q]! - 1);
			}
			for (const p of places) {
				if (p < first - 1 || p > last || (p >= i - 1 && p <= j)) continue;
				for (const reversed of [false, true]) {
					if (route.orOptDelta(i, j, p, reversed) < -EPSILON)
						return { kind: 'move', i, j, p, reversed };
				}
			}
		}
	}
	return null;
}

/**
 * Improves the route until no stop in the queue, or woken by a move, has an
 * improving move left: a local optimum. A stop is looked at again only when a
 * move changes one of the edges beside it ("don't-look bits"), so repairing a
 * route after a kick costs about as much as the kick disturbed.
 */
function settle(problem: Problem, route: Route, active: Iterable<number>): void {
	const queue: number[] = [];
	const queued = new Set<number>();
	const wake = (stop: number | undefined) => {
		if (stop === undefined || queued.has(stop)) return;
		queued.add(stop);
		queue.push(stop);
	};
	for (const stop of active) wake(stop);
	while (queue.length) {
		const stop = queue.shift()!;
		queued.delete(stop);
		const move = improvingMove(problem, route, route.positions[stop]!);
		if (!move) continue;
		const touched =
			move.kind === 'reverse'
				? [move.i - 1, move.i, move.j, move.j + 1]
				: [move.i - 1, move.i, move.j, move.j + 1, move.p, move.p + 1];
		const stops = touched.map((position) => route.order[position - 1]);
		if (move.kind === 'reverse') route.reverse(move.i, move.j);
		else route.move(move.i, move.j, move.p, move.reversed);
		wake(stop);
		stops.forEach(wake);
	}
}

/** Local search to a local optimum of both order and variants, waking the stops a variant change moves. */
function localSearch(problem: Problem, route: Route, active: Iterable<number>): Route {
	settle(problem, route, active);
	for (let changed = route.descendVariants(); changed.length; changed = route.descendVariants()) {
		settle(problem, route, changed);
	}
	return route;
}

/** The route with every variant chosen exactly for its order, searched again while that helps. */
function polish(problem: Problem, route: Route): Route {
	let current = route;
	for (;;) {
		const variants = bestVariants(problem.stops, current.order);
		const rechosen = new Route(problem, [...current.order], variants);
		if (rechosen.travel >= current.travel - EPSILON) return current;
		const changed = current.order.filter((stop) => variants[stop] !== current.variants[stop]);
		current = localSearch(problem, rechosen, changed);
	}
}

/**
 * A double bridge in one block: runs A B C D become A C B D, which no 2-opt or
 * Or-opt move undoes. Returns the new order and the stops beside its three new
 * junctions, which are where the search should look first.
 */
function doubleBridge(
	order: readonly number[],
	block: Block,
	random: () => number
): { order: number[]; junctions: number[] } {
	const { first, last } = block;
	const size = last - first + 1;
	const cuts = new Set<number>();
	while (cuts.size < 3) cuts.add(1 + Math.floor(random() * (size - 1)));
	const [a, b, c] = [...cuts].sort((x, y) => x - y) as [number, number, number];
	const inner = order.slice(first - 1, last);
	const kicked = [
		...inner.slice(0, a),
		...inner.slice(b, c),
		...inner.slice(a, b),
		...inner.slice(c)
	];
	const next = [...order.slice(0, first - 1), ...kicked, ...order.slice(last)];
	const junctions = [a, a + c - b, c].flatMap((cut) => [
		next[first - 2 + cut]!,
		next[first - 1 + cut]!
	]);
	return { order: next, junctions };
}

/**
 * The shortest order found for the stops, starting from `seed` (every stop
 * once, each block's stops contiguous and in block order) and its variants.
 */
export function sequenceStops(
	stops: readonly Stop[],
	blockSizes: readonly number[],
	seed: readonly number[],
	seedVariants: readonly number[] = bestVariants(stops, seed)
): Sequence {
	if (!seed.length) return { order: [], variants: [], travel: sequenceTravel(stops, [], []) };
	const blocks = blockRanges(blockSizes);
	const blockOf: number[] = [];
	blocks.forEach(({ first, last }, block) => {
		for (let position = first; position <= last; position++) blockOf[seed[position - 1]!] = block;
	});
	const problem: Problem = {
		stops,
		flips: flipTable(stops),
		neighbours: neighbourTable(stops, blockOf),
		blocks,
		blockOf
	};
	let best = localSearch(problem, new Route(problem, [...seed], [...seedVariants]), seed);

	const kickable = blocks.filter((block) => block.last - block.first + 1 >= MIN_KICK_BLOCK);
	if (kickable.length) {
		const random = seededRandom(SEED);
		const weights = kickable.map((block) => block.last - block.first + 1);
		const total = weights.reduce((sum, weight) => sum + weight, 0);
		for (let kick = 0; kick < KICKS; kick++) {
			// Larger blocks have more to gain, so they are kicked in proportion to their size.
			let pick = random() * total;
			const block = kickable.find((_, index) => (pick -= weights[index]!) < 0) ?? kickable.at(-1)!;
			const { order, junctions } = doubleBridge(best.order, block, random);
			const candidate = localSearch(
				problem,
				// The variants still describe every stop, so the kick keeps them for the
				// search to repair.
				new Route(problem, order, [...best.variants]),
				junctions
			);
			if (candidate.travel < best.travel - EPSILON) best = candidate;
		}
	}
	best = polish(problem, best);
	return { order: best.order, variants: best.variants, travel: best.travel };
}
