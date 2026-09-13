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
/**
 * `select`, or the id of one of the active workspace's drawing tools. Which
 * tools exist is the workspace's business; see `WorkspaceTool`.
 */
export type Tool = 'select' | (string & {});

/** The flat cutting sheet, or the assembled 3D preview of the same design. */
export type ViewMode = 'flat' | 'assembly';

/** Transient editor state: the active tool, the cursor, and the viewport. */
export function createToolState() {
	let tool = $state<Tool>('select');
	/** The preset of the drawing tool, meaningless while selecting. */
	let preset = $state('');
	let cursor = $state<Point | null>(null);
	let view = $state<View>(fitView());
	let panArmed = $state(false);
	let viewMode = $state<ViewMode>('flat');
	/** How solid the assembly preview draws its fading parts; below 1 shows what is inside. */
	let fadeOpacity = $state(1);
	// A drawing aid rather than a property of the design, so it is not saved.
	let snapEnabled = $state(false);
	// Kept current by the canvas; zooming needs it to anchor on a pixel.
	let box = $state<ViewportBox>({ width: 0, height: 0 });

	return {
		get tool() {
			return tool;
		},
		get preset() {
			return preset;
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
		get fadeOpacity() {
			return fadeOpacity;
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
		/** Arms a workspace drawing tool with one of its presets. */
		draw(toolId: string, presetId: string) {
			tool = toolId;
			preset = presetId;
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
		setFadeOpacity(next: number) {
			fadeOpacity = next;
		}
	};
}

export type ToolState = ReturnType<typeof createToolState>;
