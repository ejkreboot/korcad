import { point, type Point } from '$lib/core/geometry/primitives.js';
import type { Support } from './types.js';

/** The support this one stands on, or null when it is anchored to the box itself. */
export function supportParent(support: Support, supports: readonly Support[]): Support | null {
	const { mount } = support;
	if (mount.anchor !== 'support-top') return null;
	return supports.find((candidate) => candidate.id === mount.supportId) ?? null;
}

/**
 * Whether `ancestorId` appears anywhere up `support`'s mount chain. Used to
 * reject cycles, and guarded against pre-existing cycles in saved files.
 */
export function supportHasAncestor(
	support: Support,
	ancestorId: string,
	supports: readonly Support[],
	seen: ReadonlySet<string> = new Set()
): boolean {
	const parent = supportParent(support, supports);
	if (!parent || seen.has(parent.id)) return false;
	if (parent.id === ancestorId) return true;
	return supportHasAncestor(parent, ancestorId, supports, new Set([...seen, parent.id]));
}

/** Assembly position accumulated through the mount chain. */
export function supportAssemblyOrigin(
	support: Support,
	supports: readonly Support[],
	ancestors: ReadonlySet<string> = new Set()
): Point {
	const parent = supportParent(support, supports);
	if (!parent || ancestors.has(parent.id)) return point(support.assemblyX, support.assemblyY);
	const parentOrigin = supportAssemblyOrigin(parent, supports, new Set([...ancestors, support.id]));
	return point(parentOrigin.x + support.assemblyX, parentOrigin.y + support.assemblyY);
}

/** How far a support may be moved before it leaves its mounting surface. */
export function supportPlacementLimits(
	support: Support,
	supports: readonly Support[],
	deck: { readonly deckW: number; readonly deckH: number }
): { maxX: number; maxY: number } {
	const parent = supportParent(support, supports);
	return {
		maxX: Math.max(0, (parent?.w || deck.deckW) - support.w),
		maxY: Math.max(0, (parent?.d || deck.deckH) - support.d)
	};
}
