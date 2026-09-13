import type { Point } from '$lib/core/geometry/primitives.js';
import { outlineInside } from '$lib/core/geometry/contour.js';
import type { EditorState } from '$lib/editor/state.svelte.js';
import type { ToolState } from '$lib/editor/tools.svelte.js';
import { findEntity, solidActions } from '$lib/features/solid/actions.js';
import { entityOutline } from '$lib/features/solid/geometry.js';
import {
	MIN_SOLID_DRAG,
	moveEntityBox,
	resizeEntityBox,
	type Corner
} from '$lib/features/solid/manipulation.js';
import { createEntityFromPreset, solidPreset, TOOL_KINDS } from '$lib/features/solid/presets.js';
import type { CanvasController } from '../index.js';

/**
 * Solid on the 2D canvas. Hit targets carry `data-solid-entity`, and a resize
 * handle adds `data-handle`. Moving a part carries every hole inside it, so a
 * plate is repositioned as one piece.
 */
export function createSolidCanvas(editor: EditorState, tools: ToolState): CanvasController {
	const actions = solidActions(editor);

	return {
		press(target, stock) {
			const hit = target.closest<HTMLElement>('[data-solid-entity]');
			const entity = hit ? findEntity(editor.design, hit.dataset.solidEntity ?? '') : null;
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
			const outline = entityOutline(entity);
			const carried =
				entity.kind === 'profile'
					? actions.view.entities.filter(
							(other) => other.kind === 'hole' && outlineInside(entityOutline(other), outline)
						)
					: [];
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
			const preset = kind ? solidPreset(kind, tools.preset) : null;
			if (!kind || !preset || rect.w < MIN_SOLID_DRAG || rect.h < MIN_SOLID_DRAG) return;
			const index = actions.view.entities.filter((entity) => entity.kind === kind).length + 1;
			actions.addEntity(createEntityFromPreset(kind, preset.id, rect, crypto.randomUUID(), index));
		}
	};
}
