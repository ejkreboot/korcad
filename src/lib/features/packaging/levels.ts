import type { DesignState } from '$lib/core/design/types.js';
import type { Support } from './types.js';
import type { PackagingView } from './view.js';
import { supportParent } from './mounting.js';
import { packagingView, withPackaging } from './view.js';

/**
 * Where things sit in Z once the design is folded up.
 *
 * Mount planes and spanning heights are mutually recursive — a support stacked
 * on another needs its parent's top, which needs its parent's height, which may
 * itself be a span — so they live together here. Every function is pure and
 * guards against a mount cycle in a saved file.
 */

/** Everything a Z level depends on. */
export type LevelSettings = Pick<
	PackagingView,
	'fabricationMode' | 'perimeterType' | 'perimeterWall' | 'joistHeight' | 'material' | 'supports'
>;

/** Nominal standoff used where no perimeter holds the deck up. */
const NOMINAL_DECK_HEIGHT = 8;

/**
 * Height of the deck's underside above the surface the box rests on. A folded
 * perimeter holds it up by its wall and a joist perimeter by its joist height;
 * plain and routed work sit on a nominal standoff so the model stays readable.
 */
export function raisedDeckHeight(settings: LevelSettings): number {
	if (settings.fabricationMode !== 'knife') return NOMINAL_DECK_HEIGHT;
	if (settings.perimeterType === 'folded') return settings.perimeterWall;
	if (settings.perimeterType === 'joist') return settings.joistHeight;
	return NOMINAL_DECK_HEIGHT;
}

/** Z of the deck's underside: the ceiling of the box interior. */
export function deckUndersideZ(settings: LevelSettings): number {
	return raisedDeckHeight(settings);
}

/** Z of the deck's top face: what a deck-mounted support stands on. */
export function deckSurfaceZ(settings: LevelSettings): number {
	return raisedDeckHeight(settings) + settings.material;
}

/** +1 for a support built upward, -1 for one built down from the deck. */
export function supportBuildDirection(support: Support): 1 | -1 {
	return support.mount.anchor === 'deck-underside' ? -1 : 1;
}

/**
 * Z of the surface a support is built from, walking up the mount chain.
 * `ancestors` guards against a cycle in a saved file, which would otherwise
 * recurse forever.
 */
export function supportMountPlane(
	support: Support,
	settings: LevelSettings,
	ancestors: ReadonlySet<string> = new Set()
): number {
	const { mount } = support;
	const offset = Number.isFinite(mount.offset) ? mount.offset : 0;
	// Offset always runs away from the anchoring surface, along the support's
	// own build direction.
	const along = supportBuildDirection(support) * offset;
	switch (mount.anchor) {
		case 'box-floor':
			return along;
		case 'deck-top':
			return deckSurfaceZ(settings) + along;
		case 'deck-underside':
			return deckUndersideZ(settings) + along;
		case 'support-top': {
			const parent = supportParent(support, settings.supports);
			if (!parent || ancestors.has(parent.id)) return along;
			return supportTopZ(parent, settings, new Set([...ancestors, support.id])) + along;
		}
	}
}

/**
 * The nominal height of a support. A spanning support fills the gap from its
 * anchor to the underside of the deck, so its height is a consequence of the
 * assembly rather than an independent input.
 */
export function resolveSupportHeight(
	support: Support,
	settings: LevelSettings,
	ancestors: ReadonlySet<string> = new Set()
): number {
	if (support.heightMode !== 'span') return support.h;
	const gap = deckUndersideZ(settings) - supportMountPlane(support, settings, ancestors);
	// A negative gap means the anchor is already at or above the deck. Clamped
	// here so geometry stays finite; validation reports it as an error.
	return Math.max(0, gap);
}

/** Z of the surface on top of a support, which is what can be stacked on it. */
export function supportTopZ(
	support: Support,
	settings: LevelSettings,
	ancestors: ReadonlySet<string> = new Set()
): number {
	const plane = supportMountPlane(support, settings, ancestors);
	// A tray hangs down from its mouth, so its mount plane is already its top.
	if (support.kind === 'tray') return plane;
	return plane + resolveSupportHeight(support, settings, ancestors);
}

/**
 * The design with every spanning height written back into `h`.
 *
 * Keeping `h` resolved in the document means each geometry consumer — nets,
 * assembly, CAM — reads one number and never needs to know how it was decided.
 * Applied on every editor mutation and at the design-file import boundary, so
 * a stored `h` can never drift from the deck it is meant to meet.
 */
export function resolveSupportHeights(document: DesignState): DesignState {
	const data = document.workspaces.packaging;
	// A document with no packaging workspace has nothing to resolve.
	if (!data?.supports.some((support) => support.heightMode === 'span')) return document;
	const design = packagingView(document);
	const supports = data.supports.map((support) => {
		if (support.heightMode !== 'span') return support;
		const resolved = resolveSupportHeight(support, design);
		return resolved === support.h ? support : { ...support, h: resolved };
	});
	return withPackaging(document, (packaging) => ({ ...packaging, supports }));
}

/** Whether a support is inside the box, and so has the deck above it. */
export function sitsInsideBox(support: Support, supports: readonly Support[]): boolean {
	if (support.mount.anchor === 'deck-top') return false;
	if (support.mount.anchor !== 'support-top') return true;
	const parent = supportParent(support, supports);
	// Follow the chain: a stack standing on the deck is outside the box.
	return parent
		? sitsInsideBox(
				parent,
				supports.filter((item) => item.id !== support.id)
			)
		: true;
}

/**
 * Whether a spanning height is meaningful for this support: its anchor has to
 * sit below the deck for there to be a gap to fill.
 *
 * Geometric rather than a judgement about the kind of anchor, because standing
 * on another support only leaves room if that support is itself inside the box.
 */
export function canSpanToDeck(
	support: Support,
	settings: LevelSettings,
	ancestors: ReadonlySet<string> = new Set()
): boolean {
	return supportMountPlane(support, settings, ancestors) < deckUndersideZ(settings);
}
