import type { DesignPath, PathType, Side } from '$lib/core/design/types.js';
import {
	closedPath,
	foldIntent,
	INTERIOR_HOLE,
	line,
	ownerGroup,
	partReleaseIntent,
	supportOwner,
	type PathMeta
} from './paths.js';
import { point, type Point } from '$lib/core/geometry/primitives.js';
import { flatPanel, bendDeduction, type FoldSettings } from './fold.js';
import type { Support } from './types.js';
import type { PackagingView } from './view.js';

export type SupportSettings = FoldSettings & Pick<PackagingView, 'material'>;

export function flatSupport(support: Support, settings: FoldSettings): Support {
	if (!bendDeduction(settings)) return support;
	return {
		...support,
		h: flatPanel(support.h, settings),
		flange: flatPanel(support.flange, settings)
	};
}

export type TrayMetrics = {
	readonly overlap: number;
	readonly taper: number;
	readonly mouthW: number;
	readonly mouthD: number;
	readonly bottomW: number;
	readonly bottomD: number;
	/** Slant length of a tapered wall, which is longer than its height. */
	readonly wallReach: number;
};

export function trayMetrics(tray: Support): TrayMetrics {
	const overlap = Math.max(0, tray.overlap || 0);
	const taper = Math.max(0, tray.taper || 0);
	const mouthW = tray.w + overlap * 2;
	const mouthD = tray.d + overlap * 2;
	return {
		overlap,
		taper,
		mouthW,
		mouthD,
		bottomW: mouthW - taper * 2,
		bottomD: mouthD - taper * 2,
		wallReach: Math.hypot(tray.h, taper)
	};
}

export function trayHasPull(tray: Support, side: Side): boolean {
	return Boolean(tray.pulls[side] && tray.openSide !== side);
}

/**
 * Chord of the finger-pull circle where it crosses the deck opening edge. The
 * pull is centred on the tray mouth, which sits `overlap` outside the opening.
 */
export function trayPullWidthAtMouth(tray: Support): number {
	const radius = Math.max(0, tray.pullDiameter || 0) / 2;
	const overlap = Math.max(0, tray.overlap || 0);
	return radius > overlap ? 2 * Math.sqrt(radius * radius - overlap * overlap) : 0;
}

/** The flat footprint panel of a support, before its walls are unfolded. */
export function supportFlatPanel(support: Support): {
	x: number;
	y: number;
	w: number;
	d: number;
} {
	if (support.kind !== 'tray') {
		return { x: support.flatX, y: support.flatY, w: support.w, d: support.d };
	}
	const metrics = trayMetrics(support);
	return { x: support.flatX, y: support.flatY, w: metrics.bottomW, d: metrics.bottomD };
}

/**
 * An open line in a support's net: a fold, or a cut that frees the net. The
 * support's own lock slots are closed holes and are not drawn through here.
 */
function supportLineMeta(support: Support, type: PathType, role: string): PathMeta {
	const owner = supportOwner(support);
	const cam =
		type === 'score' ? foldIntent(ownerGroup(owner), role) : partReleaseIntent(support, false);
	return { cam, role, owner };
}

/**
 * Flat net for a recessed tray: a bottom panel with four tapered walls that
 * fold up and glue flanges that fold back out over the deck.
 */
export function trayPaths(nominalTray: Support, settings: SupportSettings): DesignPath[] {
	const tray = flatSupport(nominalTray, settings);
	const metrics = trayMetrics(tray);
	if (metrics.bottomW <= 0 || metrics.bottomD <= 0) return [];

	const paths: DesignPath[] = [];
	const addLine = (a: Point, b: Point, type: PathType, role: string) =>
		paths.push(line(a, b, type, supportLineMeta(tray, type, role)));

	const x = tray.flatX;
	const y = tray.flatY;
	const corners = {
		bl: point(x, y),
		br: point(x + metrics.bottomW, y),
		tr: point(x + metrics.bottomW, y + metrics.bottomD),
		tl: point(x, y + metrics.bottomD)
	};

	const wall = (side: Side, a: Point, b: Point, outward: Point) => {
		if (tray.openSide === side) {
			addLine(a, b, 'cut', 'tray-open-edge');
			return;
		}
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const length = Math.hypot(dx, dy) || 1;
		const tangent = point(dx / length, dy / length);
		const topA = point(
			a.x + outward.x * metrics.wallReach - tangent.x * metrics.taper,
			a.y + outward.y * metrics.wallReach - tangent.y * metrics.taper
		);
		const topB = point(
			b.x + outward.x * metrics.wallReach + tangent.x * metrics.taper,
			b.y + outward.y * metrics.wallReach + tangent.y * metrics.taper
		);
		addLine(a, b, 'score', 'tray-wall-fold');
		addLine(a, topA, 'cut', 'tray-wall-edge');
		addLine(topB, b, 'cut', 'tray-wall-edge');

		if (tray.flange > 0) {
			const chamfer = Math.min(tray.flange, (length + metrics.taper * 2) / 3);
			const outerA = point(
				topA.x + outward.x * tray.flange + tangent.x * chamfer,
				topA.y + outward.y * tray.flange + tangent.y * chamfer
			);
			const outerB = point(
				topB.x + outward.x * tray.flange - tangent.x * chamfer,
				topB.y + outward.y * tray.flange - tangent.y * chamfer
			);
			addLine(topA, outerA, 'cut', 'tray-flange-edge');
			addLine(outerB, topB, 'cut', 'tray-flange-edge');

			if (trayHasPull(tray, side)) {
				const pullRadius = Math.min(
					trayPullWidthAtMouth(tray) / 2,
					(length + metrics.taper * 2) * 0.42
				);
				// The pull must not reach the flange fold, or the wall loses its hinge.
				const pullDepth = Math.min(
					Math.max(0, tray.pullDepth || 0),
					Math.max(0, metrics.wallReach - settings.material / 2)
				);
				const center = point((topA.x + topB.x) / 2, (topA.y + topB.y) / 2);
				const at = (along: number, inward = 0, flange = 0) =>
					point(
						center.x + tangent.x * along - outward.x * inward + outward.x * flange,
						center.y + tangent.y * along - outward.y * inward + outward.y * flange
					);
				const leftHinge = at(-pullRadius);
				const rightHinge = at(pullRadius);
				const leftOuter = at(-pullRadius, 0, tray.flange);
				const rightOuter = at(pullRadius, 0, tray.flange);
				addLine(topA, leftHinge, 'score', 'tray-flange-fold');
				addLine(rightHinge, topB, 'score', 'tray-flange-fold');
				addLine(outerA, leftOuter, 'cut', 'tray-flange-edge');

				const radiusY = Math.min(pullRadius, pullDepth);
				const straightDepth = pullDepth - radiusY;
				const pullPoints: Point[] = [leftOuter, leftHinge];
				if (straightDepth > 0) pullPoints.push(at(-pullRadius, straightDepth));
				for (let i = 0; i <= 12; i++) {
					const angle = Math.PI - (Math.PI * i) / 12;
					pullPoints.push(
						at(Math.cos(angle) * pullRadius, straightDepth + Math.sin(angle) * radiusY)
					);
				}
				if (straightDepth > 0) pullPoints.push(at(pullRadius, straightDepth));
				pullPoints.push(rightHinge, rightOuter);
				paths.push({
					points: pullPoints,
					type: 'cut',
					closed: false,
					cam: partReleaseIntent(tray, false),
					role: `tray-finger-pull-${side}`,
					owner: supportOwner(tray)
				});
				addLine(rightOuter, outerB, 'cut', 'tray-flange-edge');
			} else {
				addLine(topA, topB, 'score', 'tray-flange-fold');
				addLine(outerA, outerB, 'cut', 'tray-flange-edge');
			}
		} else {
			addLine(topA, topB, 'cut', 'tray-wall-edge');
		}
	};

	wall('bottom', corners.bl, corners.br, point(0, -1));
	wall('right', corners.br, corners.tr, point(1, 0));
	wall('top', corners.tr, corners.tl, point(0, 1));
	wall('left', corners.tl, corners.bl, point(-1, 0));
	return paths;
}

/** Bounding box of a support's unfolded net on its sheet. */
export function riserFlatBounds(
	nominalSupport: Support,
	settings: SupportSettings
): { left: number; right: number; bottom: number; top: number } {
	const r = flatSupport(nominalSupport, settings);
	if (r.kind === 'tray') {
		const metrics = trayMetrics(r);
		const reach = metrics.wallReach + Math.max(0, r.flange || 0);
		return {
			left: r.flatX - reach,
			right: r.flatX + metrics.bottomW + reach,
			bottom: r.flatY - reach,
			top: r.flatY + metrics.bottomD + reach
		};
	}
	const horizontalReach = Math.max(r.h + (r.bottomFlange ? r.flange : 0), r.seam);
	const verticalReach = r.h + (r.bottomFlange ? r.flange : 0);
	return {
		left: r.flatX - horizontalReach,
		right: r.flatX + r.w + horizontalReach,
		bottom: r.flatY - verticalReach,
		top: r.flatY + r.d + verticalReach
	};
}

/**
 * Flat net for a riser or platform: a top panel with four walls folding down
 * and corner closures that are either glue tabs or interlocking tabs.
 */
export function riserPaths(nominalRiser: Support, settings: SupportSettings): DesignPath[] {
	if (nominalRiser.kind === 'tray') return trayPaths(nominalRiser, settings);
	const r = flatSupport(nominalRiser, settings);
	const paths: DesignPath[] = [];
	const ox = r.flatX;
	const oy = r.flatY;
	const addLine = (a: Point, b: Point, type: PathType, role: string) =>
		paths.push(line(a, b, type, supportLineMeta(r, type, role)));

	const flangeEdge = (a: Point, b: Point, nx: number, ny: number) => {
		addLine(a, b, 'score', 'riser-bottom-flange-fold');
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const length = Math.hypot(dx, dy);
		const tx = dx / length;
		const ty = dy / length;
		const chamfer = Math.min(r.flange, length / 3);
		const outerA = point(a.x + nx * r.flange + tx * chamfer, a.y + ny * r.flange + ty * chamfer);
		const outerB = point(b.x + nx * r.flange - tx * chamfer, b.y + ny * r.flange - ty * chamfer);
		addLine(a, outerA, 'cut', 'riser-bottom-flange');
		addLine(outerA, outerB, 'cut', 'riser-bottom-flange');
		addLine(outerB, b, 'cut', 'riser-bottom-flange');
	};
	const outerEdge = (a: Point, b: Point, nx: number, ny: number) => {
		if (r.bottomFlange) flangeEdge(a, b, nx, ny);
		else addLine(a, b, 'cut', 'riser-wall-edge');
	};
	const glueTab = (a: Point, b: Point, direction: number) => {
		const inset = Math.min(r.seam / 2, r.h / 4);
		const outerX = a.x + direction * r.seam;
		addLine(a, b, 'score', 'riser-corner-tab-fold');
		addLine(a, point(outerX, a.y + inset), 'cut', 'riser-corner-tab');
		addLine(point(outerX, a.y + inset), point(outerX, b.y - inset), 'cut', 'riser-corner-tab');
		addLine(point(outerX, b.y - inset), b, 'cut', 'riser-corner-tab');
	};
	const lockingTab = (a: Point, b: Point, direction: number) => {
		const tabWidth = Math.min(r.h * 0.55, 25.4);
		const centerY = (a.y + b.y) / 2;
		const start = point(a.x, centerY - tabWidth / 2);
		const end = point(a.x, centerY + tabWidth / 2);
		const tipX = a.x + direction * r.seam;
		const shoulder = Math.min(tabWidth * 0.18, r.seam * 0.35);
		addLine(a, start, 'cut', 'riser-lock-edge');
		addLine(start, end, 'score', 'riser-lock-tab-fold');
		addLine(start, point(tipX, start.y + shoulder), 'cut', 'riser-lock-tab');
		addLine(
			point(tipX, start.y + shoulder),
			point(tipX, end.y - shoulder),
			'cut',
			'riser-lock-tab'
		);
		addLine(point(tipX, end.y - shoulder), end, 'cut', 'riser-lock-tab');
		addLine(end, b, 'cut', 'riser-lock-edge');
	};
	const cornerTab = r.cornerClosure === 'lock' ? lockingTab : glueTab;

	const center = {
		bl: point(ox, oy),
		br: point(ox + r.w, oy),
		tr: point(ox + r.w, oy + r.d),
		tl: point(ox, oy + r.d)
	};
	addLine(center.bl, center.br, 'score', 'riser-top-fold');
	addLine(center.br, center.tr, 'score', 'riser-top-fold');
	addLine(center.tr, center.tl, 'score', 'riser-top-fold');
	addLine(center.tl, center.bl, 'score', 'riser-top-fold');

	const bottomOuterA = point(ox, oy - r.h);
	const bottomOuterB = point(ox + r.w, oy - r.h);
	cornerTab(bottomOuterA, center.bl, -1);
	cornerTab(bottomOuterB, center.br, 1);
	outerEdge(bottomOuterB, bottomOuterA, 0, -1);

	const topOuterA = point(ox, oy + r.d + r.h);
	const topOuterB = point(ox + r.w, oy + r.d + r.h);
	cornerTab(center.tl, topOuterA, -1);
	cornerTab(center.tr, topOuterB, 1);
	outerEdge(topOuterA, topOuterB, 0, 1);

	const leftOuterBottom = point(ox - r.h, oy);
	const leftOuterTop = point(ox - r.h, oy + r.d);
	addLine(center.bl, leftOuterBottom, 'cut', 'riser-wall-edge');
	outerEdge(leftOuterBottom, leftOuterTop, -1, 0);
	addLine(leftOuterTop, center.tl, 'cut', 'riser-wall-edge');

	const rightOuterBottom = point(ox + r.w + r.h, oy);
	const rightOuterTop = point(ox + r.w + r.h, oy + r.d);
	addLine(center.br, rightOuterBottom, 'cut', 'riser-wall-edge');
	outerEdge(rightOuterTop, rightOuterBottom, 1, 0);
	addLine(rightOuterTop, center.tr, 'cut', 'riser-wall-edge');

	if (r.cornerClosure === 'lock') {
		const slotLength = Math.min(r.h * 0.55, 25.4);
		const slotWidth = settings.material + 0.4;
		const edgeInset = Math.min(r.seam, r.d / 3);
		const addSlot = (cx: number, cy: number) =>
			paths.push(
				closedPath(
					[
						point(cx - slotLength / 2, cy - slotWidth / 2),
						point(cx + slotLength / 2, cy - slotWidth / 2),
						point(cx + slotLength / 2, cy + slotWidth / 2),
						point(cx - slotLength / 2, cy + slotWidth / 2)
					],
					'cut',
					{ cam: INTERIOR_HOLE, role: 'riser-lock-slot', owner: supportOwner(r) }
				)
			);
		addSlot(ox - r.h / 2, oy + edgeInset);
		addSlot(ox - r.h / 2, oy + r.d - edgeInset);
		addSlot(ox + r.w + r.h / 2, oy + edgeInset);
		addSlot(ox + r.w + r.h / 2, oy + r.d - edgeInset);
	}
	return paths;
}
