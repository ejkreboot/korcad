import { point, type Point } from '$lib/core/geometry/primitives.js';
import { clamp } from '$lib/core/units.js';
import type { EditorState } from '$lib/editor/state.svelte.js';
import type { ToolState } from '$lib/editor/tools.svelte.js';
import {
	packagingActions,
	pocketGroupBox,
	pocketGroupChanges,
	pocketGroupMembers
} from '$lib/features/packaging/actions.js';
import { proportionalResize } from '$lib/core/geometry/outline.js';
import {
	applyDeckDrag,
	applyPocketDrag,
	applySupportDrag,
	applySupportPlacement,
	MIN_COMPONENT,
	type Area,
	type Corner,
	type DeckAction
} from '$lib/features/packaging/manipulation.js';
import { supportAssemblyOrigin } from '$lib/features/packaging/mounting.js';
import { hostFor } from '$lib/features/packaging/regions.js';
import { openingOutline } from '$lib/features/packaging/geometry.js';
import { SHEET } from '$lib/core/constants.js';
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

	const deckArea = (): Area => {
		const view = actions.view;
		return {
			left: view.deckX,
			right: view.deckX + view.deckW,
			bottom: view.deckY,
			top: view.deckY + view.deckH
		};
	};

	/** An opening may go anywhere on the stock: it is only a path the knife cuts. */
	const SHEET_AREA: Area = { left: 0, right: SHEET, bottom: 0, top: SHEET };

	const inArea = (stock: Point, area: Area): Point =>
		point(clamp(stock.x, area.left, area.right), clamp(stock.y, area.bottom, area.top));

	/** Clamped to the finished top deck, for anything that must live on it. */
	const toDeck = (stock: Point): Point => inArea(stock, deckArea());

	/**
	 * A press on a group of imported openings, or one of its handles. The group
	 * moves as one box kept on the deck, and a handle scales it proportionally
	 * about the opposite corner, worked out from the openings as they were at
	 * the press.
	 */
	function pressPocketGroup(id: string, handle: Corner | undefined, stock: Point) {
		const original = pocketGroupBox(editor.design, id);
		if (!original) return null;
		actions.selectPocketGroup(id);
		const members = pocketGroupMembers(editor.design, id);
		const area = SHEET_AREA;
		const start = inArea(stock, area);
		return {
			move(current: Point) {
				const dragged = applyPocketDrag(
					dragView(),
					handle ? 'resize' : 'move',
					handle ?? null,
					original,
					start,
					inArea(current, area),
					area
				);
				if (handle) {
					const { factor, anchor } = proportionalResize(original, dragged, handle);
					actions.previewPockets(pocketGroupChanges(members, anchor, factor));
				} else {
					const offset = { x: dragged.x - original.x, y: dragged.y - original.y };
					actions.previewPockets(pocketGroupChanges(members, original, 1, offset));
				}
			}
		};
	}

	/** A tray's deck opening is drawn on the deck; other supports on the sheet. */
	const drawsOnDeck = () =>
		tools.tool === 'support' && isSupportPreset(tools.preset) && presetDrawsOnDeck(tools.preset);

	/** Where a draft corner may go: a tray's opening stays on the deck, anything else on the sheet. */
	function draftPoint(stock: Point): Point {
		if (drawsOnDeck()) return toDeck(stock);
		return tools.tool === 'cutout' ? inArea(stock, SHEET_AREA) : stock;
	}

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
		const groupTarget = target.closest<HTMLElement>('[data-pocket-group]');
		const pressedPocket = pocketTarget
			? actions.view.pockets.find((p) => p.id === pocketTarget.dataset.pocket)
			: undefined;
		const groupId = groupTarget?.dataset.pocketGroup ?? pressedPocket?.groupId ?? null;
		if (groupId) {
			return pressPocketGroup(groupId, groupTarget?.dataset.handle as Corner | undefined, stock);
		}
		if (pocketTarget) {
			const pocket = pressedPocket;
			if (!pocket) return null;
			actions.selectPocket(pocket.id);
			const type = pocketTarget.dataset.handle ? 'resize' : 'move';
			const handle = (pocketTarget.dataset.handle as Corner | undefined) ?? null;
			const original = { x: pocket.x, y: pocket.y, w: pocket.w, h: pocket.h };
			const area = SHEET_AREA;
			const start = inArea(stock, area);
			return {
				move(current) {
					actions.previewPocket(
						pocket.id,
						applyPocketDrag(dragView(), type, handle, original, start, inArea(current, area), area)
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
		draftPoint,
		finishDraft(rect) {
			if (rect.w < MIN_COMPONENT || rect.h < MIN_COMPONENT) return;
			const view = actions.view;
			if (tools.tool === 'cutout' && isCutoutPreset(tools.preset)) {
				// An opening belongs to the part it lies wholly on, or else to the sheet's stock.
				const drawn = createPocketFromPreset(
					tools.preset,
					rect,
					crypto.randomUUID(),
					view.pockets.length + 1
				);
				const host = hostFor(view, editor.design.activeSheetId, [openingOutline(drawn)]);
				actions.addPocket({ ...drawn, host });
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
