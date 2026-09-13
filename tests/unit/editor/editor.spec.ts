import { describe, expect, it } from 'vitest';
import { packagingData } from '$lib/features/packaging/view.js';
import { MM_PER_IN, SHEET } from '$lib/core/constants.js';
import { point } from '$lib/core/geometry/primitives.js';
import { createPocket } from '$lib/features/packaging/defaults.js';
import { createDefaultDesign } from '$lib/features/document.js';
import type { DesignState } from '$lib/core/design/types.js';
import type { Support } from '$lib/features/packaging/types.js';
import { supportDefaults } from '$lib/features/packaging/defaults.js';
import {
	clampView,
	fitView,
	gridLineKind,
	gridStep,
	horizontalGridLines,
	verticalGridLines,
	viewForBounds,
	visibleRect,
	VIEW_MAX_WIDTH,
	VIEW_MIN_WIDTH,
	viewScale,
	wheelWidth,
	zoomAtAnchor,
	zoomByFactor
} from '$lib/editor/viewport.js';
import {
	applyDeckDrag,
	applyPocketDrag,
	applySupportDrag,
	MIN_COMPONENT,
	MIN_DECK,
	type DeckOriginal
} from '$lib/editor/manipulation.js';
import { patchDesign, dragView } from '../../support/designs.js';
import { designHistorySignature, createHistory } from '$lib/editor/history.js';

const design = createDefaultDesign();

describe('viewport', () => {
	it('starts framing the whole sheet at 100%', () => {
		const view = fitView();
		expect(viewScale(view)).toBeCloseTo(1, 6);
		expect(view.x).toBeLessThan(0);
		expect(view.x + view.w).toBeGreaterThan(SHEET);
	});

	it('keeps the view square and within the zoom limits', () => {
		expect(clampView({ x: 0, y: 0, w: 1, h: 900 }).w).toBe(VIEW_MIN_WIDTH);
		expect(clampView({ x: 0, y: 0, w: 9000, h: 1 }).w).toBe(VIEW_MAX_WIDTH);
		const view = clampView({ x: 0, y: 0, w: 200, h: 999 });
		expect(view.h).toBe(view.w);
	});

	it('keeps the sheet within reach however far the view is dragged', () => {
		const view = clampView({ x: -9000, y: 9000, w: 200, h: 200 });
		const margin = Math.max(200 * 0.6, 40);
		expect(view.x).toBe(-margin);
		expect(view.y).toBe(SHEET + margin - 200);
	});

	it('zooms in by shrinking the view width', () => {
		const zoomed = zoomByFactor(fitView(), 1.35);
		expect(zoomed.w).toBeLessThan(fitView().w);
		expect(viewScale(zoomed)).toBeGreaterThan(1);
	});

	it('treats a wheel notch up as zoom in and down as zoom out', () => {
		const view = fitView();
		expect(wheelWidth(view, -100, 0)).toBeLessThan(view.w);
		expect(wheelWidth(view, 100, 0)).toBeGreaterThan(view.w);
		// Line-mode deltas are much coarser than pixel deltas.
		expect(wheelWidth(view, 3, 1)).toBeGreaterThan(wheelWidth(view, 3, 0));
	});

	it('frames bounds with padding and never below the zoom floor', () => {
		const view = viewForBounds({ left: 100, right: 200, bottom: 100, top: 150 });
		expect(view.w).toBeGreaterThan(100);
		expect(view.x).toBeLessThan(100);
		expect(viewForBounds({ left: 0, right: 0.1, bottom: 0, top: 0.1 }).w).toBeGreaterThanOrEqual(
			VIEW_MIN_WIDTH
		);
	});

	it('holds the point under the anchor still while zooming', () => {
		const box = { width: 900, height: 900 };
		const view = fitView();
		// A square box and a square view: the anchor maps linearly.
		const anchor = { x: 225, y: 675 };
		const before = {
			x: view.x + (anchor.x / box.width) * view.w,
			y: view.y + (anchor.y / box.height) * view.h
		};
		const zoomed = zoomAtAnchor(view, view.w / 2, anchor, box);
		const after = {
			x: zoomed.x + (anchor.x / box.width) * zoomed.w,
			y: zoomed.y + (anchor.y / box.height) * zoomed.h
		};
		expect(zoomed.w).toBeCloseTo(view.w / 2, 6);
		expect(after.x).toBeCloseTo(before.x, 6);
		expect(after.y).toBeCloseTo(before.y, 6);
	});

	it('zooms toward the anchor rather than the view origin', () => {
		const box = { width: 900, height: 900 };
		const view = fitView();
		// An anchor in the lower right must pull the view that way, which a
		// corner-anchored zoom would not do.
		const zoomed = zoomAtAnchor(view, view.w / 2, { x: 800, y: 800 }, box);
		expect(zoomed.x).toBeGreaterThan(view.x);
		expect(zoomed.y).toBeGreaterThan(view.y);
	});

	it('centres the zoom when the anchor is the middle of the viewport', () => {
		const box = { width: 900, height: 900 };
		const view = fitView();
		const zoomed = zoomAtAnchor(view, view.w / 2, { x: 450, y: 450 }, box);
		expect(zoomed.x + zoomed.w / 2).toBeCloseTo(view.x + view.w / 2, 6);
		expect(zoomed.y + zoomed.h / 2).toBeCloseTo(view.y + view.h / 2, 6);
	});

	it('accounts for letterboxing when the viewport is not square', () => {
		// A wide box meets the square view on height, leaving side margins.
		const box = { width: 1200, height: 600 };
		const view = fitView();
		const anchor = { x: 300, y: 150 };
		const scale = Math.min(box.width / view.w, box.height / view.h);
		const offsetX = (box.width - view.w * scale) / 2;
		const offsetY = (box.height - view.h * scale) / 2;
		const before = {
			x: view.x + (anchor.x - offsetX) / scale,
			y: view.y + (anchor.y - offsetY) / scale
		};
		const zoomed = zoomAtAnchor(view, view.w / 2, anchor, box);
		const nextScale = Math.min(box.width / zoomed.w, box.height / zoomed.h);
		const nextOffsetX = (box.width - zoomed.w * nextScale) / 2;
		const nextOffsetY = (box.height - zoomed.h * nextScale) / 2;
		expect(zoomed.x + (anchor.x - nextOffsetX) / nextScale).toBeCloseTo(before.x, 6);
		expect(zoomed.y + (anchor.y - nextOffsetY) / nextScale).toBeCloseTo(before.y, 6);
	});

	it('falls back to a plain zoom before the viewport has been measured', () => {
		const view = fitView();
		const zoomed = zoomAtAnchor(view, view.w / 2, { x: 0, y: 0 }, { width: 0, height: 0 });
		expect(zoomed.w).toBeCloseTo(view.w / 2, 6);
	});

	it('refines the grid as the view narrows', () => {
		expect(gridStep({ x: 0, y: 0, w: 658, h: 658 })).toBe(MM_PER_IN);
		expect(gridStep({ x: 0, y: 0, w: 300, h: 300 })).toBe(MM_PER_IN / 2);
		expect(gridStep({ x: 0, y: 0, w: 100, h: 100 })).toBe(MM_PER_IN / 4);
		expect(gridStep({ x: 0, y: 0, w: 40, h: 40 })).toBe(MM_PER_IN / 8);
	});

	it('marks whole inches, every sixth inch, and fractions apart', () => {
		expect(gridLineKind(MM_PER_IN)).toBe('normal');
		expect(gridLineKind(MM_PER_IN * 6)).toBe('major');
		expect(gridLineKind(MM_PER_IN * 0.5)).toBe('minor');
	});

	it('emits grid lines only inside the sheet', () => {
		const view = fitView();
		const box = { width: 800, height: 800 };
		for (const lines of [verticalGridLines(view, box), horizontalGridLines(view, box)]) {
			expect(lines.length).toBeGreaterThan(10);
			expect(Math.min(...lines.map((l) => l.position))).toBeGreaterThan(0);
			expect(Math.max(...lines.map((l) => l.position))).toBeLessThan(SHEET);
		}
	});

	it('reports more world than the view on the long axis of a wide viewport', () => {
		const view = fitView();
		const wide = visibleRect(view, { width: 1600, height: 500 });
		expect(wide.w).toBeGreaterThan(view.w);
		expect(wide.h).toBeCloseTo(view.h, 6);
		// It stays centred on the same point.
		expect(wide.x + wide.w / 2).toBeCloseTo(view.x + view.w / 2, 6);

		const tall = visibleRect(view, { width: 500, height: 1600 });
		expect(tall.h).toBeGreaterThan(view.h);
		expect(tall.w).toBeCloseTo(view.w, 6);
	});

	it('falls back to the view before the viewport has been measured', () => {
		expect(visibleRect(fitView(), { width: 0, height: 0 })).toEqual(fitView());
	});

	it('covers the whole visible width on a wide viewport, not just the view rect', () => {
		// A square view letterboxed into a wide window shows far more world
		// horizontally; drawing only across `view.w` leaves bare margins.
		// Zoomed in, so the sheet edges are not what limits the grid.
		const view = { x: 200, y: 200, w: 100, h: 100 };
		const wide = { width: 1600, height: 500 };
		const visible = visibleRect(view, wide);
		const lines = verticalGridLines(view, wide);
		const step = gridStep(view);

		expect(visible.w).toBeGreaterThan(view.w * 3);
		expect(Math.min(...lines.map((l) => l.position))).toBeLessThan(view.x);
		expect(Math.max(...lines.map((l) => l.position))).toBeGreaterThan(view.x + view.w);
		// Reaching the visible edges, within one step.
		expect(Math.min(...lines.map((l) => l.position))).toBeLessThanOrEqual(visible.x + step);
		expect(Math.max(...lines.map((l) => l.position))).toBeGreaterThanOrEqual(
			visible.x + visible.w - step
		);
		// Strictly more than a square viewport at the same zoom would need.
		expect(lines.length).toBeGreaterThan(
			verticalGridLines(view, { width: 500, height: 500 }).length
		);
	});

	it('keeps a stable identity for a line as the view moves within a band', () => {
		const box = { width: 1600, height: 500 };
		const a = verticalGridLines({ x: 100, y: 100, w: 300, h: 300 }, box);
		const b = verticalGridLines({ x: 104, y: 100, w: 300, h: 300 }, box);
		const shared = a.filter((line) => b.some((other) => other.index === line.index));
		expect(shared.length).toBeGreaterThan(5);
		// The same index always means exactly the same position.
		for (const line of shared) {
			expect(b.find((o) => o.index === line.index)!.position).toBe(line.position);
		}
	});

	it('spaces lines exactly, without accumulating drift', () => {
		const view = fitView();
		const step = gridStep(view);
		for (const line of verticalGridLines(view, { width: 1600, height: 500 })) {
			expect(line.position).toBeCloseTo(line.index * step, 9);
		}
	});
});

describe('deck manipulation', () => {
	const original: DeckOriginal = {
		x: packagingData(design).deckX,
		y: packagingData(design).deckY,
		w: packagingData(design).deckW,
		h: packagingData(design).deckH,
		wall: packagingData(design).perimeterWall,
		pockets: []
	};

	it('carries openings along when the deck is moved', () => {
		const withPocket: DesignState = patchDesign(design, {
			pockets: [
				{
					...createPocket({ id: 'p', name: 'P' }),
					x: 200,
					y: 200,
					w: 50,
					h: 50
				}
			]
		});
		const patch = applyDeckDrag(
			dragView(withPocket),
			'move',
			{ ...original, pockets: [{ id: 'p', x: 200, y: 200 }] },
			point(100, 100),
			point(120, 120)
		);
		expect(patch.deckX).toBe(packagingData(design).deckX + 20);
		expect(patch.deckY).toBe(packagingData(design).deckY + 20);
		expect(patch.pockets?.[0]).toMatchObject({ x: 220, y: 220 });
	});

	it('stops the deck where the unfolded perimeter would leave the stock', () => {
		const patch = applyDeckDrag(
			dragView(design),
			'move',
			original,
			point(100, 100),
			point(100, 9000)
		);
		// Wall plus flange must still fit above the deck.
		expect(
			(patch.deckY ?? 0) +
				packagingData(design).deckH +
				packagingData(design).perimeterWall +
				packagingData(design).perimeterFlange
		).toBeCloseTo(SHEET, 6);
	});

	it('never lets an edge drag shrink the deck below the minimum', () => {
		const patch = applyDeckDrag(
			dragView(design),
			'right',
			original,
			point(500, 100),
			point(0, 100)
		);
		expect(patch.deckW).toBe(MIN_DECK);
	});

	it('keeps the unfolded blank on the stock when an edge is dragged out', () => {
		const patch = applyDeckDrag(
			dragView(design),
			'right',
			original,
			point(100, 100),
			point(9000, 100)
		);
		expect(packagingData(design).deckX + (patch.deckW ?? 0)).toBeLessThanOrEqual(SHEET);
	});

	it('limits the wall grip so the flange still fits the stock', () => {
		const patch = applyDeckDrag(
			dragView(design),
			'wall-right',
			original,
			point(100, 100),
			point(9000, 100)
		);
		const wall = patch.perimeterWall ?? 0;
		expect(
			packagingData(design).deckX +
				packagingData(design).deckW +
				wall +
				packagingData(design).perimeterFlange
		).toBeCloseTo(SHEET, 6);
	});

	it('never produces a wall below one millimeter', () => {
		const patch = applyDeckDrag(
			dragView(design),
			'wall-right',
			original,
			point(500, 100),
			point(0, 100)
		);
		expect(patch.perimeterWall).toBeGreaterThanOrEqual(1);
	});
});

describe('opening manipulation', () => {
	const original = { x: 200, y: 200, w: 100, h: 80 };

	it('keeps a moved opening inside the finished deck', () => {
		const moved = applyPocketDrag(
			dragView(design),
			'move',
			null,
			original,
			point(0, 0),
			point(-9000, -9000)
		);
		expect(moved.x).toBe(packagingData(design).deckX);
		expect(moved.y).toBe(packagingData(design).deckY);
		expect(moved.w).toBe(original.w);
	});

	it('resizes from the anchored corner', () => {
		const resized = applyPocketDrag(
			dragView(design),
			'resize',
			'ne',
			original,
			point(0, 0),
			point(360, 330)
		);
		expect(resized.x).toBe(original.x);
		expect(resized.y).toBe(original.y);
		expect(resized.w).toBe(160);
		expect(resized.h).toBe(130);
	});

	it('moves the anchor when dragging a west or south handle', () => {
		const resized = applyPocketDrag(
			dragView(design),
			'resize',
			'sw',
			original,
			point(0, 0),
			point(250, 240)
		);
		expect(resized.x).toBe(250);
		expect(resized.y).toBe(240);
		expect(resized.w).toBe(50);
		expect(resized.h).toBe(40);
	});

	it('never resizes an opening below the minimum', () => {
		const resized = applyPocketDrag(
			dragView(design),
			'resize',
			'ne',
			original,
			point(0, 0),
			point(0, 0)
		);
		expect(resized.w).toBe(MIN_COMPONENT);
		expect(resized.h).toBe(MIN_COMPONENT);
	});

	it('snaps to the quarter-inch grid when snapping is on', () => {
		const snapped = applyPocketDrag(
			dragView(design, true),
			'move',
			null,
			original,
			point(200, 200),
			point(203, 200)
		);
		expect(snapped.x % (MM_PER_IN / 4)).toBeCloseTo(0, 6);
	});
});

describe('support manipulation', () => {
	const support: Support = {
		...supportDefaults(),
		kind: 'riser',
		id: 'r',
		name: 'Riser',
		w: 100,
		d: 80,
		h: 40,
		flatX: 200,
		flatY: 200,
		mount: { anchor: 'box-floor', offset: 0 }
	};
	const original = { flatX: 200, flatY: 200, w: 100, d: 80, h: 40 };

	it('keeps the whole unfolded net on the sheet when moved', () => {
		const moved = applySupportDrag(
			dragView(design),
			support,
			'move',
			null,
			original,
			point(0, 0),
			point(-9000, -9000)
		);
		expect(moved.flatX).toBeGreaterThan(0);
		expect(moved.flatY).toBeGreaterThan(0);
	});

	it('raises the support with the height handle', () => {
		const taller = applySupportDrag(
			dragView(design),
			support,
			'height',
			null,
			original,
			point(0, 0),
			point(0, 15)
		);
		expect(taller.h).toBe(55);
		expect(taller.w).toBe(original.w);
	});

	it('re-anchors the net when a west handle shrinks it', () => {
		const resized = applySupportDrag(
			dragView(design),
			support,
			'resize',
			'sw',
			original,
			point(0, 0),
			point(20, 10)
		);
		expect(resized.w).toBe(80);
		expect(resized.flatX).toBe(220);
		expect(resized.d).toBe(70);
		expect(resized.flatY).toBe(210);
	});
});

describe('history', () => {
	it('ignores a change of active sheet, which is a view choice', () => {
		const base = designHistorySignature(design);
		expect(designHistorySignature({ ...design, activeSheetId: 'parts' })).toBe(base);
		expect(designHistorySignature(patchDesign(design, { deckW: 1 }))).not.toBe(base);
	});

	it('records one step per committed change and restores it', () => {
		const history = createHistory(design);
		expect(history.canUndo).toBe(false);

		const wider = patchDesign(design, { deckW: 300 });
		history.commit(wider);
		// Committing an unchanged design must not add a second step.
		history.commit(wider);
		expect(history.depth).toBe(1);

		expect(packagingData(history.undo(wider)!).deckW).toBe(packagingData(design).deckW);
		expect(history.canRedo).toBe(true);
		expect(packagingData(history.redo(design)!).deckW).toBe(300);
	});
});
