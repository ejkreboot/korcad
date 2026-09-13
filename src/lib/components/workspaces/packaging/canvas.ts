import { point, type Point } from '$lib/core/geometry/primitives.js';
import { clamp } from '$lib/core/units.js';
import type { EditorState } from '$lib/editor/state.svelte.js';
import type { ToolState } from '$lib/editor/tools.svelte.js';
import { packagingActions } from '$lib/features/packaging/actions.js';
import {
	applyDeckDrag,
	applyPocketDrag,
	applySupportDrag,
	applySupportPlacement,
	MIN_COMPONENT,
	type Corner,
	type DeckAction
} from '$lib/features/packaging/manipulation.js';
import { supportAssemblyOrigin } from '$lib/features/packaging/mounting.js';
import {
	createPocketFromPreset,
	createSupportFromPreset,
	isCutoutPreset,
	isSupportPreset,
	presetDrawsOnDeck
} from '$lib/features/packaging/presets.js';
import type { CanvasController, CanvasGesture } from '../index.js';

/**
 * Packaging on the 2D canvas: what a press on one of its hit targets starts,
 * and what a drawn rectangle becomes. Hit targets are found by the `data-*`
 * attributes `PackagingCanvasLayer` puts on them.
 *
 * Every read goes back to the editor at call time, so a gesture always works
 * from the document as it is now.
 */
export function createPackagingCanvas(editor: EditorState, tools: ToolState): CanvasController {
	const actions = packagingActions(editor);
	/** What a drag reads: the sheet view plus the snap toggle. */
	const dragView = () => ({ ...actions.view, snapEnabled: tools.snapEnabled });
	const supportById = (id: string | undefined) =>
		actions.view.supports.find((support) => support.id === id);

	/** Clamped to the finished top deck, for anything that must live on it. */
	function toDeck(stock: Point): Point {
		const view = actions.view;
		return point(
			clamp(stock.x, view.deckX, view.deckX + view.deckW),
			clamp(stock.y, view.deckY, view.deckY + view.deckH)
		);
	}

	/** An opening, and a tray's deck opening, are drawn on the deck; other supports on the sheet. */
	const drawsOnDeck = () =>
		tools.tool === 'cutout' ||
		(tools.tool === 'support' && isSupportPreset(tools.preset) && presetDrawsOnDeck(tools.preset));

	function press(target: Element, stock: Point): CanvasGesture | null {
		const deckTarget = target.closest<HTMLElement>('[data-deck-action]');
		const pocketTarget = target.closest<HTMLElement>('[data-pocket]');
		const supportTarget = target.closest<HTMLElement>('[data-support]');
		const placementTarget = target.closest<HTMLElement>('[data-support-placement]');

		if (placementTarget) {
			const support = supportById(placementTarget.dataset.supportPlacement);
			if (!support) return null;
			actions.selectSupport(support.id);
			const origin = supportAssemblyOrigin(support, actions.view.supports);
			return {
				move(current) {
					const live = supportById(support.id);
					if (!live) return;
					actions.previewSupport(
						support.id,
						applySupportPlacement(dragView(), live, origin, stock, current)
					);
				}
			};
		}
		if (supportTarget) {
			const support = supportById(supportTarget.dataset.support);
			if (!support) return null;
			actions.selectSupport(support.id);
			const type = supportTarget.dataset.supportHeight
				? 'height'
				: supportTarget.dataset.handle
					? 'resize'
					: 'move';
			const handle = (supportTarget.dataset.handle as Corner | undefined) ?? null;
			const original = {
				flatX: support.flatX,
				flatY: support.flatY,
				w: support.w,
				d: support.d,
				h: support.h
			};
			return {
				move(current) {
					const live = supportById(support.id);
					if (!live) return;
					actions.previewSupport(
						support.id,
						applySupportDrag(dragView(), live, type, handle, original, stock, current)
					);
				}
			};
		}
		if (pocketTarget) {
			const pocket = actions.view.pockets.find((p) => p.id === pocketTarget.dataset.pocket);
			if (!pocket) return null;
			actions.selectPocket(pocket.id);
			const type = pocketTarget.dataset.handle ? 'resize' : 'move';
			const handle = (pocketTarget.dataset.handle as Corner | undefined) ?? null;
			const original = { x: pocket.x, y: pocket.y, w: pocket.w, h: pocket.h };
			const start = toDeck(stock);
			return {
				move(current) {
					actions.previewPocket(
						pocket.id,
						applyPocketDrag(dragView(), type, handle, original, start, toDeck(current))
					);
				}
			};
		}
		if (deckTarget) {
			actions.selectPocket(null);
			const view = actions.view;
			const action = deckTarget.dataset.deckAction as DeckAction;
			const original = {
				x: view.deckX,
				y: view.deckY,
				w: view.deckW,
				h: view.deckH,
				wall: view.perimeterWall,
				pockets: view.pockets.map((p) => ({ id: p.id, x: p.x, y: p.y }))
			};
			return {
				move(current) {
					actions.previewPackaging(applyDeckDrag(dragView(), action, original, stock, current));
				}
			};
		}
		return null;
	}

	return {
		press,
		draftPoint: (stock) => (drawsOnDeck() ? toDeck(stock) : stock),
		finishDraft(rect) {
			if (rect.w < MIN_COMPONENT || rect.h < MIN_COMPONENT) return;
			const view = actions.view;
			if (tools.tool === 'cutout' && isCutoutPreset(tools.preset)) {
				actions.addPocket(
					createPocketFromPreset(tools.preset, rect, crypto.randomUUID(), view.pockets.length + 1)
				);
			} else if (tools.tool === 'support' && isSupportPreset(tools.preset)) {
				actions.addSupport(
					createSupportFromPreset(
						tools.preset,
						rect,
						crypto.randomUUID(),
						view.supports.length + 1,
						view
					)
				);
			}
		}
	};
}
