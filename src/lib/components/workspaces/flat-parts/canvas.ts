import type { Point } from '$lib/core/geometry/primitives.js';
import type { EditorState } from '$lib/editor/state.svelte.js';
import type { ToolState } from '$lib/editor/tools.svelte.js';
import {
	findEntity,
	flatPartsActions,
	groupBox,
	groupChanges
} from '$lib/features/flat-parts/actions.js';
import { proportionalResize } from '$lib/core/geometry/outline.js';
import {
	MIN_FLAT_PARTS_DRAG,
	moveEntityBox,
	resizeEntityBox,
	type Corner
} from '$lib/features/flat-parts/manipulation.js';
import {
	createEntityFromPreset,
	flatPartsPreset,
	TOOL_KINDS
} from '$lib/features/flat-parts/presets.js';
import type { CanvasController } from '../index.js';

/**
 * Flat Parts on the 2D canvas. Hit targets carry `data-flat-parts-entity`, a group's
 * handles `data-flat-parts-group`, and a resize handle adds `data-handle`. Moving a part carries every hole inside it, so a
 * part is repositioned as one piece.
 */
export function createFlatPartsCanvas(editor: EditorState, tools: ToolState): CanvasController {
	const actions = flatPartsActions(editor);

	/**
	 * A press on an imported group, anywhere on it or on one of its handles. The
	 * group moves as one box, and a handle scales it proportionally about the
	 * opposite corner: each move is worked out from the entities as they were at
	 * the press, so the drag never compounds rounding.
	 */
	function pressGroup(id: string, handle: Corner | undefined, stock: Point) {
		const original = groupBox(editor.design, id);
		if (!original) return null;
		editor.select({ kind: 'group', id });
		const carried = actions.groupCarried(id);
		return {
			move(current: Point) {
				if (handle) {
					const resized = resizeEntityBox(original, handle, current, tools.snapEnabled);
					const { factor, anchor } = proportionalResize(original, resized, handle);
					actions.previewEntities(groupChanges(carried, anchor, factor));
					return;
				}
				const moved = moveEntityBox(original, stock, current, tools.snapEnabled);
				actions.previewEntities(
					groupChanges(carried, original, 1, { x: moved.x - original.x, y: moved.y - original.y })
				);
			}
		};
	}

	return {
		press(target, stock) {
			const groupHit = target.closest<HTMLElement>('[data-flat-parts-group]');
			const hit = target.closest<HTMLElement>('[data-flat-parts-entity]');
			const entity = hit ? findEntity(editor.design, hit.dataset.flatPartsEntity ?? '') : null;
			const groupId = groupHit?.dataset.flatPartsGroup ?? entity?.groupId ?? null;
			if (groupId)
				return pressGroup(groupId, groupHit?.dataset.handle as Corner | undefined, stock);
			if (!hit || !entity) return null;
			actions.select(entity);
			const handle = (hit.dataset.handle as Corner | undefined) ?? null;
			const original = { x: entity.x, y: entity.y, w: entity.w, h: entity.h };
			if (handle) {
				return {
					move(current: Point) {
						actions.previewEntities([
							{
								id: entity.id,
								values: resizeEntityBox(original, handle, current, tools.snapEnabled)
							}
						]);
					}
				};
			}
			const carried = actions.holesInside(entity);
			return {
				move(current: Point) {
					const moved = moveEntityBox(original, stock, current, tools.snapEnabled);
					const dx = moved.x - original.x;
					const dy = moved.y - original.y;
					actions.previewEntities([
						{ id: entity.id, values: moved },
						...carried.map((hole) => ({ id: hole.id, values: { x: hole.x + dx, y: hole.y + dy } }))
					]);
				}
			};
		},
		draftPoint: (stock) => stock,
		finishDraft(rect) {
			const kind = TOOL_KINDS[tools.tool];
			const preset = kind ? flatPartsPreset(kind, tools.preset) : null;
			if (!kind || !preset || rect.w < MIN_FLAT_PARTS_DRAG || rect.h < MIN_FLAT_PARTS_DRAG) return;
			const index = actions.view.entities.filter((entity) => entity.kind === kind).length + 1;
			actions.addEntity(createEntityFromPreset(kind, preset.id, rect, crypto.randomUUID(), index));
		}
	};
}
