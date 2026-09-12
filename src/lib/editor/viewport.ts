import { MM_PER_IN, SHEET } from '$lib/core/constants.js';
import { clamp, round } from '$lib/core/units.js';

/** A square window onto the stock sheet, in SVG (y-down) coordinates. */
export type View = {
	readonly x: number;
	readonly y: number;
	readonly w: number;
	readonly h: number;
};

export type Bounds = {
	readonly left: number;
	readonly right: number;
	readonly bottom: number;
	readonly top: number;
};

/** The default view: the whole sheet plus a small margin on every side. */
export const VIEW_BASE: View = { x: -24, y: -24, w: 658, h: 658 };

/** Roughly half an inch across the viewport. */
export const VIEW_MIN_WIDTH = 12;
export const VIEW_MAX_WIDTH = 1400;

export function viewScale(view: View): number {
	return VIEW_BASE.w / view.w;
}

/**
 * Keeps the view square, within the zoom limits, and near the sheet.
 *
 * The centring branch is carried over from the original and is unreachable in
 * practice: the margin grows at 0.6x the view width, so `SHEET + margin * 2`
 * always exceeds the width. It is kept so that a future change to the margin
 * rule still behaves sensibly rather than parking the sheet against an edge.
 */
export function clampView(view: View): View {
	const w = clamp(view.w, VIEW_MIN_WIDTH, VIEW_MAX_WIDTH);
	const margin = Math.max(w * 0.6, 40);
	const spanX = SHEET + margin * 2 - w;
	const spanY = SHEET + margin * 2 - w;
	return {
		w,
		h: w,
		x: spanX <= 0 ? (SHEET - w) / 2 : clamp(view.x, -margin, SHEET + margin - w),
		y: spanY <= 0 ? (SHEET - w) / 2 : clamp(view.y, -margin, SHEET + margin - w)
	};
}

export function viewBoxAttr(view: View): string {
	return `${round(view.x)} ${round(view.y)} ${round(view.w)} ${round(view.h)}`;
}

export function fitView(): View {
	return clampView(VIEW_BASE);
}

/** Resizes the view about its centre; callers re-anchor to the pointer after. */
export function zoomedView(view: View, width: number): View {
	return clampView({ ...view, w: clamp(width, VIEW_MIN_WIDTH, VIEW_MAX_WIDTH), h: view.h });
}

export function zoomByFactor(view: View, factor: number): View {
	return zoomedView(view, view.w / factor);
}

/** The pixel size of the element the view is painted into. */
export type ViewportBox = { readonly width: number; readonly height: number };

/** A position within the viewport box, in pixels from its top-left. */
export type Anchor = { readonly x: number; readonly y: number };

/**
 * Where a viewport pixel lands in view coordinates.
 *
 * The SVG is drawn with the default `xMidYMid meet`, so the view is scaled
 * uniformly to fit and centred in whatever space is left over.
 */
function viewPointAt(view: View, anchor: Anchor, box: ViewportBox): { x: number; y: number } {
	const scale = Math.min(box.width / view.w, box.height / view.h);
	const offsetX = (box.width - view.w * scale) / 2;
	const offsetY = (box.height - view.h * scale) / 2;
	return {
		x: view.x + (anchor.x - offsetX) / scale,
		y: view.y + (anchor.y - offsetY) / scale
	};
}

/**
 * Zooms to `width` while holding whatever sits under `anchor` still, so the
 * drawing grows around the cursor rather than the corner.
 *
 * This is deliberately pure rather than measuring the live SVG: the element's
 * matrix still reflects the previous view until the framework flushes, so
 * reading it back mid-zoom yields no movement at all.
 */
export function zoomAtAnchor(view: View, width: number, anchor: Anchor, box: ViewportBox): View {
	if (!(box.width > 0) || !(box.height > 0)) return zoomedView(view, width);
	const target = viewPointAt(view, anchor, box);
	const zoomed = zoomedView(view, width);
	const scale = Math.min(box.width / zoomed.w, box.height / zoomed.h);
	const offsetX = (box.width - zoomed.w * scale) / 2;
	const offsetY = (box.height - zoomed.h * scale) / 2;
	return clampView({
		...zoomed,
		x: target.x - (anchor.x - offsetX) / scale,
		y: target.y - (anchor.y - offsetY) / scale
	});
}

/** Converts a wheel delta into a new view width. */
export function wheelWidth(view: View, deltaY: number, deltaMode: number): number {
	const unitScale = deltaMode === 1 ? 0.04 : 0.0018;
	return clamp(view.w * Math.exp(deltaY * unitScale), VIEW_MIN_WIDTH, VIEW_MAX_WIDTH);
}

/** Frames CAM-space bounds (y up from the sheet floor) with padding. */
export function viewForBounds(bounds: Bounds, pad = 0.22): View {
	const span = Math.max(bounds.right - bounds.left, bounds.top - bounds.bottom, VIEW_MIN_WIDTH);
	const width = clamp(span * (1 + pad * 2), VIEW_MIN_WIDTH, VIEW_MAX_WIDTH);
	const cx = (bounds.left + bounds.right) / 2;
	const cy = SHEET - (bounds.bottom + bounds.top) / 2;
	return clampView({ x: cx - width / 2, y: cy - width / 2, w: width, h: width });
}

export type GridLineKind = 'major' | 'normal' | 'minor';

/** Grid density follows the zoom: 1 in, 1/2 in, 1/4 in, 1/8 in. */
export function gridStep(view: View): number {
	if (view.w > 380) return MM_PER_IN;
	if (view.w > 170) return MM_PER_IN / 2;
	if (view.w > 70) return MM_PER_IN / 4;
	return MM_PER_IN / 8;
}

/** Whole inches read as normal lines, every sixth inch as a major one. */
export function gridLineKind(mm: number): GridLineKind {
	const inches = mm / MM_PER_IN;
	if (Math.abs(inches - Math.round(inches)) >= 1e-6) return 'minor';
	return Math.round(inches) % 6 === 0 ? 'major' : 'normal';
}

/**
 * The world-space rectangle actually on screen.
 *
 * The view is square but the viewport usually is not, and `xMidYMid meet`
 * fits the view to the shorter axis. The longer axis therefore shows *more*
 * world than the view rect describes. Anything drawn to fill the canvas has
 * to cover this, not the view.
 */
export function visibleRect(view: View, box: ViewportBox): View {
	if (!(box.width > 0) || !(box.height > 0)) return view;
	const scale = Math.min(box.width / view.w, box.height / view.h);
	const width = box.width / scale;
	const height = box.height / scale;
	return {
		x: view.x + view.w / 2 - width / 2,
		y: view.y + view.h / 2 - height / 2,
		w: width,
		h: height
	};
}

/**
 * One grid line. The index is its whole multiple of the current step, which
 * makes a stable key: the same line keeps its identity across frames instead
 * of being torn down and rebuilt whenever accumulation shifts the last bits.
 */
export type GridLine = { readonly index: number; readonly position: number };

function gridLinesBetween(step: number, low: number, high: number): GridLine[] {
	const firstIndex = Math.max(1, Math.ceil(low / step));
	const limit = Math.min(SHEET - step / 2, high);
	const lines: GridLine[] = [];
	for (let index = firstIndex; index * step <= limit + 1e-6; index++) {
		lines.push({ index, position: index * step });
	}
	return lines;
}

/** Vertical grid lines, in stock X, across everything on screen. */
export function verticalGridLines(view: View, box: ViewportBox): GridLine[] {
	const visible = visibleRect(view, box);
	return gridLinesBetween(gridStep(view), visible.x, visible.x + visible.w);
}

/** Horizontal grid lines, in stock Y (CAM orientation), across everything on screen. */
export function horizontalGridLines(view: View, box: ViewportBox): GridLine[] {
	const visible = visibleRect(view, box);
	return gridLinesBetween(gridStep(view), SHEET - (visible.y + visible.h), SHEET - visible.y);
}
