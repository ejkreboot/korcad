import type { PackagingGeometry, PackagingPath } from './paths.js';
import { point, type Point } from '$lib/core/geometry/primitives.js';
import { flatPanel, type FoldSettings } from '$lib/core/design/fold.js';
import type { HoldingTab, SideFlags, SheetView } from '$lib/core/design/types.js';
import { splitSide } from './geometry.js';

type PathMeta = Omit<PackagingPath, 'points' | 'type' | 'closed'>;

const line = (
	a: Point,
	b: Point,
	type: PackagingPath['type'],
	meta: PathMeta = {}
): PackagingPath => ({
	points: [a, b],
	type,
	closed: false,
	...meta
});

const closedPath = (
	points: readonly Point[],
	type: PackagingPath['type'],
	meta: PathMeta = {}
): PackagingPath => ({
	points,
	type,
	closed: true,
	...meta
});

export type PerimeterSettings = FoldSettings &
	Pick<
		SheetView,
		| 'fabricationMode'
		| 'perimeterType'
		| 'perimeterWall'
		| 'perimeterFlange'
		| 'perimeterRelief'
		| 'perimeterSides'
		| 'deckX'
		| 'deckY'
		| 'deckW'
		| 'deckH'
		| 'tabWidth'
		| 'tabCount'
		| 'material'
		| 'joistAxis'
		| 'joistFolds'
		| 'joistHeight'
		| 'joistDepth'
		| 'joistLockWidth'
		| 'joistSlotClearance'
	>;

/** Joists run across the axis they stiffen, so only two opposite sides carry them. */
export function joistSides(settings: PerimeterSettings): SideFlags {
	return settings.joistAxis === 'horizontal'
		? { top: true, right: false, bottom: true, left: false }
		: { top: false, right: true, bottom: false, left: true };
}

/** Flat widths of the panels in one rolled joist edge, outermost last. */
export function joistPanelWidths(settings: PerimeterSettings): number[] {
	const widths = [
		flatPanel(settings.joistHeight, settings),
		flatPanel(settings.joistDepth, settings),
		flatPanel(settings.joistHeight, settings),
		flatPanel(settings.joistDepth, settings)
	];
	return widths.slice(0, Math.min(4, settings.joistFolds));
}

/** How far a joist edge extends past the deck when flat. */
export function joistFlatExtent(settings: PerimeterSettings): number {
	const panels = joistPanelWidths(settings).reduce((sum, width) => sum + width, 0);
	return panels + (settings.joistFolds === 5 ? flatPanel(settings.joistHeight, settings) : 0);
}

function perimeterExtent(settings: PerimeterSettings): {
	extent: number;
	sides: SideFlags;
	extended: boolean;
} {
	const knife = settings.fabricationMode === 'knife';
	const folded = knife && settings.perimeterType === 'folded';
	const joist = knife && settings.perimeterType === 'joist';
	const extent = folded
		? flatPanel(settings.perimeterWall, settings) + flatPanel(settings.perimeterFlange, settings)
		: joist
			? joistFlatExtent(settings)
			: 0;
	return {
		extent,
		sides: joist ? joistSides(settings) : settings.perimeterSides,
		extended: folded || joist
	};
}

/** Outer bounds of the flat blank, including any unfolded perimeter. */
export function perimeterBounds(settings: PerimeterSettings): {
	left: number;
	right: number;
	bottom: number;
	top: number;
} {
	const { extent, sides, extended } = perimeterExtent(settings);
	return {
		left: settings.deckX - (extended && sides.left ? extent : 0),
		right: settings.deckX + settings.deckW + (extended && sides.right ? extent : 0),
		bottom: settings.deckY - (extended && sides.bottom ? extent : 0),
		top: settings.deckY + settings.deckH + (extended && sides.top ? extent : 0)
	};
}

/** Per-side outward extension of the flat blank beyond the deck. */
export function perimeterExtents(settings: PerimeterSettings): {
	left: number;
	right: number;
	bottom: number;
	top: number;
} {
	const { extent, sides, extended } = perimeterExtent(settings);
	return {
		left: extended && sides.left ? extent : 0,
		right: extended && sides.right ? extent : 0,
		bottom: extended && sides.bottom ? extent : 0,
		top: extended && sides.top ? extent : 0
	};
}

/**
 * The exterior release geometry for the deck sheet, plus the holding tabs
 * that keep the blank attached to the stock. Tabs are returned separately
 * because they are gaps in the cut, not paths to machine.
 */
export function exteriorPaths(settings: PerimeterSettings): PackagingGeometry {
	const bounds = perimeterBounds(settings);
	const paths: PackagingPath[] = [];
	const tabs: HoldingTab[] = [];
	const outerCuts: PackagingPath[] = [];

	const cut = (a: Point, b: Point, role = 'perimeter-side') =>
		paths.push(line(a, b, 'cut', { role }));
	const score = (a: Point, b: Point, role: string) => paths.push(line(a, b, 'score', { role }));
	const tabbedEdge = (a: Point, b: Point) =>
		splitSide(a, b, settings.tabCount, settings.tabWidth).forEach((span) => {
			if (span.tab) tabs.push({ points: span.points });
			else outerCuts.push(line(span.points[0], span.points[1], 'cut', { role: 'exterior' }));
		});

	if (settings.perimeterType === 'plain') {
		const pts = [
			point(bounds.left, bounds.bottom),
			point(bounds.right, bounds.bottom),
			point(bounds.right, bounds.top),
			point(bounds.left, bounds.top)
		];
		for (let i = 0; i < 4; i++) tabbedEdge(pts[i]!, pts[(i + 1) % 4]!);
	} else if (settings.perimeterType === 'joist') {
		buildJoistPerimeter(settings, { cut, score, tabbedEdge, paths });
	} else {
		buildFoldedPerimeter(settings, { cut, score, tabbedEdge });
	}

	// Exterior release cuts come last so interior features are already done.
	paths.push(...outerCuts);
	return { paths, tabs };
}

type EdgeBuilders = {
	cut: (a: Point, b: Point, role?: string) => void;
	score: (a: Point, b: Point, role: string) => void;
	tabbedEdge: (a: Point, b: Point) => void;
};

/**
 * Walls that fold up from the deck edge and glue flanges that fold back in.
 * Each deck edge is gapped by half the relief at both ends so adjacent walls
 * clear each other when folded.
 */
function buildFoldedPerimeter(
	settings: PerimeterSettings,
	{ cut, score, tabbedEdge }: EdgeBuilders
): void {
	const x = settings.deckX;
	const y = settings.deckY;
	const w = settings.deckW;
	const h = settings.deckH;
	const wall = flatPanel(settings.perimeterWall, settings);
	const flange = flatPanel(settings.perimeterFlange, settings);
	const gap = settings.perimeterRelief / 2;
	const sides = settings.perimeterSides;
	const horizontalChamfer = Math.min(flange, Math.max(0, (w - gap * 2) / 3));
	const verticalChamfer = Math.min(flange, Math.max(0, (h - gap * 2) / 3));

	const deckEdges = [
		{
			enabled: sides.bottom,
			start: point(x, y),
			hingeStart: point(x + gap, y),
			hingeEnd: point(x + w - gap, y),
			end: point(x + w, y)
		},
		{
			enabled: sides.right,
			start: point(x + w, y),
			hingeStart: point(x + w, y + gap),
			hingeEnd: point(x + w, y + h - gap),
			end: point(x + w, y + h)
		},
		{
			enabled: sides.top,
			start: point(x + w, y + h),
			hingeStart: point(x + w - gap, y + h),
			hingeEnd: point(x + gap, y + h),
			end: point(x, y + h)
		},
		{
			enabled: sides.left,
			start: point(x, y + h),
			hingeStart: point(x, y + h - gap),
			hingeEnd: point(x, y + gap),
			end: point(x, y)
		}
	];
	deckEdges.forEach((edge) => {
		if (edge.enabled) {
			cut(edge.start, edge.hingeStart, 'perimeter-corner-clearance');
			cut(edge.hingeEnd, edge.end, 'perimeter-corner-clearance');
		} else {
			tabbedEdge(edge.start, edge.end);
		}
	});

	const wallAndFlange = (a: Point, b: Point, wa: Point, wb: Point, fa: Point, fb: Point) => {
		score(a, b, 'perimeter-deck-fold');
		score(wa, wb, 'perimeter-flange-fold');
		cut(a, wa);
		cut(wa, fa, 'perimeter-flange-chamfer');
		tabbedEdge(fa, fb);
		cut(fb, wb, 'perimeter-flange-chamfer');
		cut(wb, b);
	};

	if (sides.top) {
		const a = point(x + gap, y + h);
		const b = point(x + w - gap, y + h);
		const wa = point(a.x, a.y + wall);
		const wb = point(b.x, b.y + wall);
		wallAndFlange(
			a,
			b,
			wa,
			wb,
			point(wa.x + horizontalChamfer, wa.y + flange),
			point(wb.x - horizontalChamfer, wb.y + flange)
		);
	}
	if (sides.bottom) {
		const a = point(x + gap, y);
		const b = point(x + w - gap, y);
		const wa = point(a.x, a.y - wall);
		const wb = point(b.x, b.y - wall);
		wallAndFlange(
			a,
			b,
			wa,
			wb,
			point(wa.x + horizontalChamfer, wa.y - flange),
			point(wb.x - horizontalChamfer, wb.y - flange)
		);
	}
	if (sides.left) {
		const a = point(x, y + gap);
		const b = point(x, y + h - gap);
		const wa = point(a.x - wall, a.y);
		const wb = point(b.x - wall, b.y);
		wallAndFlange(
			a,
			b,
			wa,
			wb,
			point(wa.x - flange, wa.y + verticalChamfer),
			point(wb.x - flange, wb.y - verticalChamfer)
		);
	}
	if (sides.right) {
		const a = point(x + w, y + gap);
		const b = point(x + w, y + h - gap);
		const wa = point(a.x + wall, a.y);
		const wb = point(b.x + wall, b.y);
		wallAndFlange(
			a,
			b,
			wa,
			wb,
			point(wa.x + flange, wa.y + verticalChamfer),
			point(wb.x + flange, wb.y - verticalChamfer)
		);
	}
}

/**
 * A rolled edge: a strip of alternating height and depth panels that folds
 * into a closed box section stiffening the deck edge. With five folds the
 * strip ends in a locking tab that engages a slot cut in the same edge.
 */
function buildJoistPerimeter(
	settings: PerimeterSettings,
	{ cut, score, tabbedEdge, paths }: EdgeBuilders & { paths: PackagingPath[] }
): void {
	const x = settings.deckX;
	const y = settings.deckY;
	const w = settings.deckW;
	const h = settings.deckH;
	const sides = joistSides(settings);
	const panelWidths = joistPanelWidths(settings);
	const fullStripExtent = panelWidths.reduce((sum, width) => sum + width, 0);

	const edges = {
		bottom: {
			start: point(x, y),
			end: point(x + w, y),
			tangent: point(1, 0),
			outward: point(0, -1)
		},
		right: {
			start: point(x + w, y),
			end: point(x + w, y + h),
			tangent: point(0, 1),
			outward: point(1, 0)
		},
		top: {
			start: point(x + w, y + h),
			end: point(x, y + h),
			tangent: point(-1, 0),
			outward: point(0, 1)
		},
		left: {
			start: point(x, y + h),
			end: point(x, y),
			tangent: point(0, -1),
			outward: point(-1, 0)
		}
	} as const;

	const shifted = (edge: (typeof edges)[keyof typeof edges], along: number, outward: number) =>
		point(
			edge.start.x + edge.tangent.x * along + edge.outward.x * outward,
			edge.start.y + edge.tangent.y * along + edge.outward.y * outward
		);

	(Object.entries(edges) as [keyof typeof edges, (typeof edges)[keyof typeof edges]][]).forEach(
		([side, edge]) => {
			const length = side === 'top' || side === 'bottom' ? w : h;
			if (!sides[side]) {
				tabbedEdge(edge.start, edge.end);
				return;
			}
			let offset = 0;
			panelWidths.forEach((width, index) => {
				score(shifted(edge, 0, offset), shifted(edge, length, offset), `joist-fold-${index + 1}`);
				offset += width;
			});
			cut(edge.start, shifted(edge, 0, fullStripExtent), 'joist-end');
			cut(edge.end, shifted(edge, length, fullStripExtent), 'joist-end');

			if (settings.joistFolds !== 5) {
				tabbedEdge(shifted(edge, 0, fullStripExtent), shifted(edge, length, fullStripExtent));
				return;
			}

			const lockWidth = Math.min(settings.joistLockWidth, length * 0.8);
			const lockStart = (length - lockWidth) / 2;
			const lockEnd = lockStart + lockWidth;
			const terminalStart = shifted(edge, 0, fullStripExtent);
			const tabStart = shifted(edge, lockStart, fullStripExtent);
			const tabEnd = shifted(edge, lockEnd, fullStripExtent);
			const terminalEnd = shifted(edge, length, fullStripExtent);
			cut(terminalStart, tabStart, 'joist-terminal');
			cut(tabEnd, terminalEnd, 'joist-terminal');
			score(tabStart, tabEnd, 'joist-fold-5');
			const tabTipStart = shifted(edge, lockStart, fullStripExtent + settings.joistHeight);
			const tabTipEnd = shifted(edge, lockEnd, fullStripExtent + settings.joistHeight);
			cut(tabStart, tabTipStart, 'joist-lock-tab');
			tabbedEdge(tabTipStart, tabTipEnd);
			cut(tabTipEnd, tabEnd, 'joist-lock-tab');

			const slotWidth = settings.material + settings.joistSlotClearance;
			const slotCenter = settings.joistHeight + slotWidth;
			const slotAlongStart = (length - settings.joistLockWidth - settings.joistSlotClearance) / 2;
			const slotAlongEnd = (length + settings.joistLockWidth + settings.joistSlotClearance) / 2;
			paths.push(
				closedPath(
					[
						shifted(edge, slotAlongStart, slotCenter - slotWidth / 2),
						shifted(edge, slotAlongEnd, slotCenter - slotWidth / 2),
						shifted(edge, slotAlongEnd, slotCenter + slotWidth / 2),
						shifted(edge, slotAlongStart, slotCenter + slotWidth / 2)
					],
					'cut',
					{ role: 'joist-lock-slot' }
				)
			);
		}
	);
}
