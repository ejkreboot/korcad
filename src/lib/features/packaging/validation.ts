import { SHEET } from '$lib/core/constants.js';
import type { DesignState, Side, SideFlags } from '$lib/core/design/types.js';
import { perimeterBounds } from './perimeter.js';
import { riserFlatBounds, trayHasPull, trayMetrics, trayPullWidthAtMouth } from './supports.js';
import { supportHasAncestor, supportPlacementLimits } from './mounting.js';
import { deckUndersideZ, resolveSupportHeight, sitsInsideBox, supportTopZ } from './levels.js';
import { machineProfileFor } from '$lib/core/design/machine.js';
import { packagingView } from './view.js';
import { cutoutPoints } from './geometry.js';
import type { Pocket } from './types.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import { onRegion, regionOf, sameRegion } from './regions.js';
import { outlineDistance, outlineInside } from '$lib/core/geometry/contour.js';

const NO_SIDES: SideFlags = { top: false, right: false, bottom: false, left: false };
const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

/**
 * How far a support may poke past the deck underside before it is called an
 * interference. Board is compressible and the deck is glued down over it, so a
 * few tenths of a millimetre is assembly slop rather than a mistake.
 */
const DECK_INTERFERENCE_TOLERANCE = 0.5;

/**
 * Validates a design for manufacturability. Returns human-readable messages,
 * deduplicated and in a stable order. An empty result is the precondition for
 * any export: nothing is silently clamped or dropped.
 */
export function validate(document: DesignState): string[] {
	const design = packagingView(document);
	const errors: string[] = [];
	const router = design.fabricationMode === 'router';
	const bounds = perimeterBounds(design);

	/*
	 * A packaging insert is one assembled object, so every sheet it is cut from
	 * has to agree on whether the board folds. A support net creased on a drag
	 * knife and a deck released on a router do not go together, and the
	 * difference is invisible on either sheet alone.
	 */
	const sheetsWithParts = design.sheets.filter(
		(sheet) =>
			sheet.id === design.deckSheetId ||
			design.supports.some((support) => support.sheetId === sheet.id)
	);
	const modes = new Set(
		sheetsWithParts.map((sheet) => machineProfileFor(document, sheet.id).fabricationMode)
	);
	if (modes.size > 1) {
		errors.push('Sheets of one insert must all be cut with the same fabrication mode');
	}
	const deck = {
		left: design.deckX,
		right: design.deckX + design.deckW,
		bottom: design.deckY,
		top: design.deckY + design.deckH
	};

	if (design.deckW <= 0 || design.deckH <= 0) errors.push('Top-deck dimensions must be positive');
	if (bounds.left < 0 || bounds.bottom < 0 || bounds.right > SHEET || bounds.top > SHEET) {
		errors.push('The unfolded perimeter does not fit the 24-inch stock');
	}
	if (!router && design.perimeterType === 'folded') {
		if (design.perimeterWall <= 0 || design.perimeterFlange <= 0) {
			errors.push('Perimeter wall and flange dimensions must be positive');
		}
		if (design.perimeterRelief <= 0) errors.push('Perimeter corner relief must be positive');
		if (
			design.deckW <= design.perimeterRelief + design.perimeterFlange * 2 ||
			design.deckH <= design.perimeterRelief + design.perimeterFlange * 2
		) {
			errors.push('Top deck is too small for 45-degree perimeter flanges');
		}
	}
	if (!router && design.perimeterType === 'joist') {
		if (!Number.isInteger(design.joistFolds) || design.joistFolds < 1 || design.joistFolds > 5) {
			errors.push('Joist profile must contain one to five folds');
		}
		if (design.joistHeight <= 0 || design.joistDepth <= 0) {
			errors.push('Joist height and depth must be positive');
		}
		const acrossJoists = design.joistAxis === 'horizontal' ? design.deckH : design.deckW;
		if (design.joistFolds >= 3 && acrossJoists <= design.joistDepth * 2) {
			errors.push('Opposing joists overlap beneath the deck');
		}
		if (design.joistFolds === 5) {
			const joistLength = design.joistAxis === 'horizontal' ? design.deckW : design.deckH;
			if (
				design.joistLockWidth <= 0 ||
				design.joistLockWidth + design.minimumWeb * 2 >= joistLength
			) {
				errors.push('Joist locking tab leaves too little end material');
			}
			if (
				design.joistSlotClearance < 0 ||
				design.material + design.joistSlotClearance * 1.5 >= design.joistDepth
			) {
				errors.push('Joist locking slot does not fit the bottom panel');
			}
		}
	}
	if (!router && design.scoreDepth >= design.cutDepth) {
		errors.push('Score depth must be less than cut depth');
	}
	if (
		!router &&
		design.tabWidth * (design.tabCount || 0) >=
			Math.min(bounds.right - bounds.left, bounds.top - bounds.bottom)
	) {
		errors.push('Exterior tabs consume an entire side');
	}
	if (router) {
		const radius = design.bitWidth / 2;
		if (
			design.deckX - radius < 0 ||
			design.deckY - radius < 0 ||
			design.deckX + design.deckW + radius > SHEET ||
			design.deckY + design.deckH + radius > SHEET
		) {
			errors.push('The compensated deck perimeter exceeds the stock');
		}
	}

	for (const p of design.pockets) {
		const region = regionOf(design, p.host);
		if (!region) {
			errors.push(`${p.name}: the part it is cut into is missing`);
			continue;
		}
		// An opening may go anywhere on its region's net; the knife does not care
		// what the board it cuts becomes. The deck keeps its own wording.
		const onNet = (outline: readonly Point[]) => onRegion(region, outline);
		const offNet =
			p.host.kind === 'deck'
				? `${p.name}: pocket crosses the finished top deck`
				: `${p.name}: opening runs off ${region.name}`;
		const sides = router ? NO_SIDES : p.sides;
		const f = !router && p.flangeEnabled ? p.flange : 0;
		const il = p.x + (sides.left ? p.wallDepth + f : 0);
		const ir = p.x + p.w - (sides.right ? p.wallDepth + f : 0);
		const ib = p.y + (sides.bottom ? p.wallDepth + f : 0);
		const it = p.y + p.h - (sides.top ? p.wallDepth + f : 0);

		if (!p.name.trim()) errors.push('A pocket needs a name');
		if (p.w <= 0 || p.h <= 0) errors.push(`${p.name}: opening dimensions must be positive`);
		if (router && (p.w <= design.bitWidth || p.h <= design.bitWidth)) {
			errors.push(`${p.name}: opening is too small for the router bit`);
		}
		const onDeckPanel =
			p.host.kind === 'deck' &&
			p.x >= deck.left &&
			p.y >= deck.bottom &&
			p.x + p.w <= deck.right &&
			p.y + p.h <= deck.top;
		if (!onDeckPanel && !onNet(boxOutline(p.x, p.y, p.x + p.w, p.y + p.h))) errors.push(offNet);
		const hostSupport =
			p.host.kind === 'support' ? design.supports.find((item) => item.id === hostId(p)) : null;
		// Walls folded from a riser's top panel hang inside it and must clear its floor.
		if (
			hostSupport &&
			hostSupport.kind !== 'tray' &&
			SIDES.some((side) => sides[side]) &&
			p.wallDepth >= hostSupport.h
		) {
			errors.push(`${p.name}: folded walls reach past the floor of ${hostSupport.name}`);
		}
		if (ir <= il || it <= ib) errors.push(`${p.name}: walls and flanges consume the entire pocket`);
		if (p.wallDepth <= 0 && SIDES.some((side) => sides[side])) {
			errors.push(`${p.name}: wall depth must be positive`);
		}
		if (!router && p.relief <= 0) errors.push(`${p.name}: corner relief must be positive`);

		const activePulls = SIDES.filter((side) => p.pulls[side]);
		if (activePulls.length && p.pullDiameter <= 0) {
			errors.push(`${p.name}: finger-pull diameter must be positive`);
		}
		for (const side of activePulls) {
			const available =
				side === 'top' || side === 'bottom'
					? sides[side]
						? p.w - p.relief * 2
						: ir - il
					: sides[side]
						? p.h - p.relief * 2
						: it - ib;
			if (p.pullDiameter >= available) errors.push(`${p.name}: ${side} finger pull is too wide`);
			if (sides[side] && p.pullDepth <= 0) {
				errors.push(`${p.name}: finger-pull wall reach must be positive`);
			}
			if (sides[side] && p.pullDepth >= p.wallDepth - p.relief / 2) {
				errors.push(`${p.name}: ${side} finger pull reaches the flange fold`);
			}
			const radius = p.pullDiameter / 2;
			const reach = {
				top: boxOutline(p.x, p.y + p.h, p.x + p.w, p.y + p.h + radius),
				right: boxOutline(p.x + p.w, p.y, p.x + p.w + radius, p.y + p.h),
				bottom: boxOutline(p.x, p.y - radius, p.x + p.w, p.y),
				left: boxOutline(p.x - radius, p.y, p.x, p.y + p.h)
			}[side];
			const withinDeck =
				p.host.kind === 'deck' &&
				!(
					(side === 'top' && p.y + p.h + radius > deck.top) ||
					(side === 'right' && p.x + p.w + radius > deck.right) ||
					(side === 'bottom' && p.y - radius < deck.bottom) ||
					(side === 'left' && p.x - radius < deck.left)
				);
			if (!withinDeck && !onNet(reach)) {
				errors.push(
					p.host.kind === 'deck'
						? `${p.name}: ${side} finger pull crosses the finished top deck`
						: `${p.name}: ${side} finger pull runs off ${region.name}`
				);
			}
		}
	}

	for (let i = 0; i < design.pockets.length; i++) {
		for (let j = i + 1; j < design.pockets.length; j++) {
			const a = design.pockets[i]!;
			const b = design.pockets[j]!;
			if (!sameRegion(a.host, b.host)) continue;
			const boxesOverlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
			if (boxesOverlap && openingsOverlap(a, b)) errors.push(`${a.name} overlaps ${b.name}`);
		}
	}

	const trayOpenings = design.supports
		.filter((support) => support.kind === 'tray')
		.map((tray) => ({
			item: tray,
			x: design.deckX + tray.assemblyX,
			y: design.deckY + tray.assemblyY,
			w: tray.w,
			h: tray.d
		}));
	for (const tray of trayOpenings) {
		if (router && (tray.w <= design.bitWidth || tray.h <= design.bitWidth)) {
			errors.push(`${tray.item.name}: opening is too small for the router bit`);
		}
		for (const pocket of design.pockets) {
			if (pocket.host.kind !== 'deck') continue;
			if (
				tray.x < pocket.x + pocket.w &&
				tray.x + tray.w > pocket.x &&
				tray.y < pocket.y + pocket.h &&
				tray.y + tray.h > pocket.y
			) {
				errors.push(`${tray.item.name} overlaps ${pocket.name}`);
			}
		}
	}
	for (let i = 0; i < trayOpenings.length; i++) {
		for (let j = i + 1; j < trayOpenings.length; j++) {
			const a = trayOpenings[i]!;
			const b = trayOpenings[j]!;
			if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
				errors.push(`${a.item.name} overlaps ${b.item.name}`);
			}
		}
	}

	for (const r of design.supports) {
		if (!r.name.trim()) errors.push('A support needs a name');
		if (r.w <= 0 || r.d <= 0 || r.h <= 0) {
			errors.push(`${r.name}: assembled dimensions must be positive`);
		}
		if (r.kind !== 'tray' && r.seam <= 0)
			errors.push(`${r.name}: corner tab depth must be positive`);
		if (
			r.kind !== 'tray' &&
			r.cornerClosure === 'lock' &&
			r.d - 2 * Math.min(r.seam, r.d / 3) <= design.material + 0.4
		) {
			errors.push(`${r.name}: depth is too small for separated locking slots`);
		}
		if ((r.kind === 'tray' || r.bottomFlange) && r.flange <= 0) {
			errors.push(`${r.name}: glue flange must be positive`);
		}

		if (r.kind === 'tray') {
			const metrics = trayMetrics(r);
			if (r.overlap < 0 || r.taper < 0)
				errors.push(`${r.name}: overlap and taper cannot be negative`);
			if (metrics.bottomW <= 0 || metrics.bottomD <= 0) {
				errors.push(`${r.name}: wall taper consumes the tray bottom`);
			}
			if (r.mount.anchor !== 'deck-underside') {
				errors.push(`${r.name}: recessed tray must mount under the deck`);
			}
			const activePulls = SIDES.filter((side) => trayHasPull(r, side));
			if (activePulls.length && r.pullDiameter <= 0) {
				errors.push(`${r.name}: finger-pull diameter must be positive`);
			}
			for (const side of activePulls) {
				const radius = r.pullDiameter / 2;
				const mouthLength = side === 'top' || side === 'bottom' ? metrics.mouthW : metrics.mouthD;
				const reliefWidth = trayPullWidthAtMouth(r);
				if (radius <= metrics.overlap) {
					errors.push(`${r.name}: ${side} finger-pull radius must exceed the deck overlap`);
				}
				if (reliefWidth + design.minimumWeb * 2 >= mouthLength) {
					errors.push(`${r.name}: ${side} finger pull leaves too little corner flange`);
				}
				if (r.pullDepth <= 0) errors.push(`${r.name}: finger-pull wall reach must be positive`);
				if (r.pullDepth >= metrics.wallReach - design.material / 2) {
					errors.push(`${r.name}: ${side} finger pull reaches the tray bottom fold`);
				}
				const x = design.deckX + r.assemblyX;
				const y = design.deckY + r.assemblyY;
				if (
					(side === 'top' && y + r.d + radius > deck.top) ||
					(side === 'right' && x + r.w + radius > deck.right) ||
					(side === 'bottom' && y - radius < deck.bottom) ||
					(side === 'left' && x - radius < deck.left)
				) {
					errors.push(`${r.name}: ${side} finger pull crosses the finished top deck`);
				}
			}
		} else if (r.mount.anchor === 'support-top') {
			const { supportId } = r.mount;
			if (!design.supports.some((candidate) => candidate.id === supportId)) {
				errors.push(`${r.name}: assembly mount is missing`);
			}
		}

		if (supportHasAncestor(r, r.id, design.supports)) {
			errors.push(`${r.name}: assembly mounts contain a cycle`);
		}

		// A spanning support derives its height from the gap up to the deck, so an
		// anchor at or above the deck leaves it nothing to fill.
		if (r.heightMode === 'span' && resolveSupportHeight(r, design) <= 0) {
			errors.push(`${r.name}: spanning height leaves no room below the top deck`);
		}

		// Anything built inside the box has the deck as its ceiling. A fixed
		// height taller than the cavity stops the deck seating flat, which is an
		// assembly fault the flat nets cannot reveal on their own.
		if (
			r.kind !== 'tray' &&
			r.heightMode === 'fixed' &&
			sitsInsideBox(r, design.supports) &&
			!supportHasAncestor(r, r.id, design.supports) &&
			supportTopZ(r, design) > deckUndersideZ(design) + DECK_INTERFERENCE_TOLERANCE
		) {
			errors.push(`${r.name}: stands taller than the space under the top deck`);
		}
		if (!design.sheets.some((sheet) => sheet.id === r.sheetId && sheet.workspace === 'packaging')) {
			errors.push(`${r.name}: manufacturing sheet is missing`);
		}

		const flat = riserFlatBounds(r, design);
		if (!router && (flat.left < 0 || flat.bottom < 0 || flat.right > SHEET || flat.top > SHEET)) {
			errors.push(`${r.name}: flat pattern does not fit its sheet`);
		}
		if (
			!router &&
			r.sheetId === design.deckSheetId &&
			flat.left < bounds.right &&
			flat.right > bounds.left &&
			flat.bottom < bounds.top &&
			flat.top > bounds.bottom
		) {
			errors.push(`${r.name}: flat pattern overlaps the top deck`);
		}

		const placementLimits = supportPlacementLimits(r, design.supports, design);
		if (
			r.assemblyX < 0 ||
			r.assemblyY < 0 ||
			r.assemblyX > placementLimits.maxX ||
			r.assemblyY > placementLimits.maxY
		) {
			errors.push(`${r.name}: assembly footprint crosses its mount surface`);
		}
	}

	if (!router) {
		for (let i = 0; i < design.supports.length; i++) {
			for (let j = i + 1; j < design.supports.length; j++) {
				const a = design.supports[i]!;
				const b = design.supports[j]!;
				if (a.sheetId !== b.sheetId) continue;
				const ab = riserFlatBounds(a, design);
				const bb = riserFlatBounds(b, design);
				if (ab.left < bb.right && ab.right > bb.left && ab.bottom < bb.top && ab.top > bb.bottom) {
					errors.push(`${a.name} overlaps ${b.name} on their sheet`);
				}
			}
		}
	}

	return [...new Set(errors)];
}

const hostId = (pocket: Pocket) => (pocket.host.kind === 'support' ? pocket.host.supportId : null);
const boxOutline = (left: number, bottom: number, right: number, top: number): Point[] => [
	{ x: left, y: bottom },
	{ x: right, y: bottom },
	{ x: right, y: top },
	{ x: left, y: top }
];

/**
 * Whether two openings whose boxes overlap really do. Imported outlines are
 * compared as drawn, so the letters of a kerned logo, whose boxes overlap but
 * whose lines do not, are not reported; any other pair is judged by its box,
 * as it always has been.
 */
function openingsOverlap(a: Pocket, b: Pocket): boolean {
	if (a.shape !== 'profile' || b.shape !== 'profile') return true;
	const first = cutoutPoints(a);
	const second = cutoutPoints(b);
	return (
		outlineDistance(first, second) === 0 ||
		outlineInside(first, second) ||
		outlineInside(second, first)
	);
}
