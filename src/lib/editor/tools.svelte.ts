import type { Point } from '$lib/core/geometry/primitives.js';
import {
	clampView,
	fitView,
	viewForBounds,
	viewScale,
	zoomAtAnchor,
	type Anchor,
	type Bounds,
	type View,
	type ViewportBox
} from './viewport.js';
import type { CutoutPreset, SupportPreset } from '$lib/features/packaging/presets.js';

export type Tool = 'select' | 'cutout' | 'support';

/** The flat cutting sheet, or the assembled 3D preview of the same design. */
export type ViewMode = 'flat' | 'assembly';

/**
 * How solid the deck is drawn in the assembly view. Anything below 1 lets the
 * operator see the supports that sit inside the box.
 */
export const DECK_OPACITIES = [
	{ value: 1, label: 'Solid' },
	{ value: 0.58, label: 'Translucent' },
	{ value: 0.22, label: 'Ghosted' },
	{ value: 0, label: 'Hidden' }
] as const;

/** Transient editor state: the active tool, the cursor, and the viewport. */
export function createToolState() {
	let tool = $state<Tool>('select');
	let cutoutPreset = $state<CutoutPreset>('rectangle');
	let supportPreset = $state<SupportPreset>('riser-glue');
	let cursor = $state<Point | null>(null);
	let view = $state<View>(fitView());
	let panArmed = $state(false);
	let viewMode = $state<ViewMode>('flat');
	let deckOpacity = $state(1);
	// A drawing aid rather than a property of the design, so it is not saved.
	let snapEnabled = $state(false);
	// Kept current by the canvas; zooming needs it to anchor on a pixel.
	let box = $state<ViewportBox>({ width: 0, height: 0 });

	return {
		get tool() {
			return tool;
		},
		get cutoutPreset() {
			return cutoutPreset;
		},
		get supportPreset() {
			return supportPreset;
		},
		get cursor() {
			return cursor;
		},
		get view() {
			return view;
		},
		get scale() {
			return viewScale(view);
		},
		get panArmed() {
			return panArmed;
		},
		get viewMode() {
			return viewMode;
		},
		get deckOpacity() {
			return deckOpacity;
		},
		get snapEnabled() {
			return snapEnabled;
		},
		/** Painted size of the canvas, needed to know what is actually on screen. */
		get viewportBox() {
			return box;
		},

		select() {
			tool = 'select';
		},
		drawCutout(preset: CutoutPreset) {
			cutoutPreset = preset;
			tool = 'cutout';
		},
		drawSupport(preset: SupportPreset) {
			supportPreset = preset;
			tool = 'support';
		},
		setCursor(next: Point | null) {
			cursor = next;
		},
		setView(next: View) {
			view = clampView(next);
		},
		setViewportBox(next: ViewportBox) {
			box = next;
		},
		/** Zooms about a pixel in the viewport, such as the pointer. */
		zoomAt(width: number, anchor: Anchor) {
			view = zoomAtAnchor(view, width, anchor, box);
		},
		/** Zooms about the middle of the viewport, for the zoom buttons. */
		zoomBy(factor: number) {
			view = zoomAtAnchor(view, view.w / factor, { x: box.width / 2, y: box.height / 2 }, box);
		},
		fit() {
			view = fitView();
		},
		frame(bounds: Bounds) {
			view = viewForBounds(bounds);
		},
		armPan(armed: boolean) {
			panArmed = armed;
		},
		setViewMode(next: ViewMode) {
			viewMode = next;
			// The 3D view owns its own camera, so pan must not stay armed behind it.
			if (next === 'assembly') panArmed = false;
		},
		setSnap(enabled: boolean) {
			snapEnabled = enabled;
		},
		setDeckOpacity(next: number) {
			deckOpacity = next;
		}
	};
}

export type ToolState = ReturnType<typeof createToolState>;
