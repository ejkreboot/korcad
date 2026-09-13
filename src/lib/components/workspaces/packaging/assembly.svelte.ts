import type { Point } from '$lib/core/geometry/primitives.js';
import { display } from '$lib/core/units.js';
import type { EditorState } from '$lib/editor/state.svelte.js';
import type { ToolState } from '$lib/editor/tools.svelte.js';
import { packagingActions } from '$lib/features/packaging/actions.js';
import { resolveDrop, supportUnderPoint } from '$lib/features/packaging/anchoring.js';
import { supportAssemblyOrigin } from '$lib/features/packaging/mounting.js';
import type { Support } from '$lib/features/packaging/types.js';
import { packagingView } from '$lib/features/packaging/view.js';
import type { AssemblyController } from '../index.js';

/**
 * Packaging in the 3D viewer: supports are the draggable groups. A drop picks
 * the surface the support lands on — never a bare Z — and while dragging, the
 * readout says which support it would stack on.
 */
export function createPackagingAssembly(editor: EditorState, tools: ToolState): AssemblyController {
	const actions = packagingActions(editor);
	/** Dropping resolves anchors and heights, which depend on the machine, and snaps when snap is on. */
	const dropView = () => ({ ...packagingView(editor.design), snapEnabled: tools.snapEnabled });
	const supportById = (id: string | null) =>
		actions.view.supports.find((support) => support.id === id) ?? null;

	let dragging = $state<{ id: string; hostName: string | null } | null>(null);

	/** Plain-language name for the surface a support is built from. */
	function anchorLabel(item: Support): string {
		const { mount } = item;
		switch (mount.anchor) {
			case 'box-floor':
				return 'on the box floor';
			case 'deck-top':
				return 'on the top deck';
			case 'deck-underside':
				return 'under the top deck';
			case 'support-top': {
				const host = supportById(mount.supportId);
				return host ? `on ${host.name}` : 'on a missing support';
			}
		}
	}

	return {
		get readout() {
			const selected = supportById(actions.selectedSupportId);
			if (!selected) return 'Drag a support to position it';
			const units = editor.design.stock.units;
			const origin = supportAssemblyOrigin(selected, actions.view.supports);
			const places = units === 'in' ? 3 : 1;
			const position = `X ${display(origin.x, units).toFixed(places)} · Y ${display(
				origin.y,
				units
			).toFixed(places)} ${units}`;
			// Dropping picks a surface, so say which one before the button comes up.
			if (dragging?.id === selected.id && dragging.hostName) {
				return `${selected.name} · ${position} · drop to stack on ${dragging.hostName}`;
			}
			return `${selected.name} · ${position} · ${anchorLabel(selected)}`;
		},
		grab(id) {
			const support = supportById(id);
			if (!support) return null;
			actions.selectSupport(support.id);
			// The 2D view follows to the sheet the support is cut from.
			editor.setActiveSheet(support.sheetId);
			dragging = { id: support.id, hostName: null };
			return {
				origin: supportAssemblyOrigin(support, actions.view.supports),
				drag: {
					move(global: Point) {
						const live = supportById(support.id);
						if (!live) return null;
						// The mount itself is only decided on release, so the part does not
						// re-parent and change height under the pointer mid-gesture.
						const host = supportUnderPoint(
							live,
							global.x + live.w / 2,
							global.y + live.d / 2,
							dropView()
						);
						dragging = { id: support.id, hostName: host?.name ?? null };
						const placed = resolveDrop(live, global.x, global.y, dropView());
						actions.previewSupport(support.id, {
							assemblyX: placed.assemblyX,
							assemblyY: placed.assemblyY
						});
						const moved = supportById(support.id);
						return moved ? supportAssemblyOrigin(moved, actions.view.supports) : null;
					},
					drop(global: Point) {
						const live = supportById(support.id);
						if (live)
							actions.previewSupport(support.id, resolveDrop(live, global.x, global.y, dropView()));
						dragging = null;
					}
				}
			};
		}
	};
}
