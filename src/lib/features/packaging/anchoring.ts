import { round, snapWithin } from '$lib/core/units.js';
import type { Support, SupportAnchor, SupportMount, SheetView } from '$lib/core/design/types.js';
import { canSpanToDeck, supportTopZ, type LevelSettings } from './levels.js';
import { supportAssemblyOrigin, supportHasAncestor, supportParent } from './mounting.js';

/**
 * What a support becomes anchored to when it is dropped somewhere.
 *
 * Dropping decides a *relationship*, never a raw Z height: land a support on
 * top of another and it stacks on it; drag it off and it falls back to whatever
 * base that stack stood on. The floor/deck-top choice stays a deliberate one in
 * the inspector, because a camera looking down at a closed box cannot tell the
 * two apart — the deck hides everything under it.
 *
 * Pure, so the gesture's meaning is unit-testable without a renderer.
 */

export type DropSettings = LevelSettings &
	Pick<SheetView, 'risers' | 'deckW' | 'deckH' | 'snapEnabled'>;

export type Drop = Pick<Support, 'mount' | 'heightMode' | 'assemblyX' | 'assemblyY'>;

/** Anchors that stand on the box itself rather than on another support. */
type BaseAnchor = Exclude<SupportAnchor, 'support-top'>;

/**
 * The base a support ultimately stands on, following its mount chain past any
 * supports it is stacked on. Guarded against a cycle in a saved file.
 */
export function baseAnchorOf(
	support: Support,
	supports: readonly Support[],
	seen: ReadonlySet<string> = new Set()
): BaseAnchor {
	if (support.mount.anchor !== 'support-top') return support.mount.anchor;
	const parent = supportParent(support, supports);
	if (!parent || seen.has(parent.id)) return 'box-floor';
	return baseAnchorOf(parent, supports, new Set([...seen, support.id]));
}

/** Whether `candidate` could carry `dragged` without creating a cycle. */
export function canStackOn(
	dragged: Support,
	candidate: Support,
	supports: readonly Support[]
): boolean {
	if (candidate.id === dragged.id) return false;
	// A tray has no top face to stand on: it is a hole in the deck.
	if (candidate.kind === 'tray') return false;
	if (dragged.kind === 'tray') return false;
	return !supportHasAncestor(candidate, dragged.id, supports);
}

/**
 * The support a footprint centred at (`x`, `y`) lands on, or null for the base.
 * When stacks overlap, the highest top wins, which is what dropping onto a
 * pile means.
 */
export function supportUnderPoint(
	dragged: Support,
	x: number,
	y: number,
	settings: DropSettings
): Support | null {
	let best: Support | null = null;
	let bestTop = -Infinity;
	for (const candidate of settings.risers) {
		if (!canStackOn(dragged, candidate, settings.risers)) continue;
		const origin = supportAssemblyOrigin(candidate, settings.risers);
		const inside =
			x >= origin.x && x <= origin.x + candidate.w && y >= origin.y && y <= origin.y + candidate.d;
		if (!inside) continue;
		const top = supportTopZ(candidate, settings);
		if (top > bestTop) {
			best = candidate;
			bestTop = top;
		}
	}
	return best;
}

/**
 * Resolves a drop at a global assembly position into a mount, a height mode,
 * and a parent-relative placement.
 *
 * `assemblyX`/`assemblyY` are always relative to whatever the support ends up
 * mounted to, and are clamped to that surface, so a part can never be left
 * hanging off the thing it is supposed to be sitting on.
 */
export function resolveDrop(
	dragged: Support,
	globalX: number,
	globalY: number,
	settings: DropSettings
): Drop {
	const centre = { x: globalX + dragged.w / 2, y: globalY + dragged.d / 2 };
	const host =
		dragged.kind === 'tray' ? null : supportUnderPoint(dragged, centre.x, centre.y, settings);

	const mount: SupportMount = host
		? { anchor: 'support-top', supportId: host.id, offset: 0 }
		: dragged.mount.anchor === 'support-top'
			? // Dragged clear of its stack, so it falls back to the base that stack
				// stood on rather than jumping to the box floor.
				{ anchor: baseAnchorOf(dragged, settings.risers), offset: 0 }
			: dragged.mount;

	// A part re-anchored onto a surface with no deck above it cannot span, so it
	// keeps the height it was showing instead of collapsing to nothing.
	const landed: Support = { ...dragged, mount };
	const heightMode: Support['heightMode'] =
		dragged.heightMode === 'span' && !canSpanToDeck(landed, settings)
			? 'fixed'
			: dragged.heightMode;

	const hostOrigin = host ? supportAssemblyOrigin(host, settings.risers) : { x: 0, y: 0 };
	const maxX = Math.max(0, (host?.w ?? settings.deckW) - dragged.w);
	const maxY = Math.max(0, (host?.d ?? settings.deckH) - dragged.d);

	return {
		mount,
		heightMode,
		assemblyX: round(snapWithin(globalX - hostOrigin.x, 0, maxX, settings.snapEnabled)),
		assemblyY: round(snapWithin(globalY - hostOrigin.y, 0, maxY, settings.snapEnabled))
	};
}
