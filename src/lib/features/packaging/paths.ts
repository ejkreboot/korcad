import type { DesignPath, HoldingTab } from '$lib/core/design/types.js';

/**
 * A path as packaging draws it, before it has stated its manufacturing intent.
 *
 * Packaging builds its geometry from roles and ownership, then derives the
 * `CamIntent` for every path in one pass as it leaves `allGeometry` (see
 * `cam-intent.ts`). Everything upstream of that pass works in this type, so the
 * compiler proves no packaging path can reach CAM without intent attached.
 *
 * This is packaging-local on purpose. A workspace with no legacy role
 * vocabulary — Solid — declares intent where it draws a path and never needs a
 * pre-intent stage, so the concept does not belong in core.
 */
export type PackagingPath = Omit<DesignPath, 'cam'>;

/** Packaging geometry before intent is attached; see `PackagingPath`. */
export type PackagingGeometry = {
	readonly paths: readonly PackagingPath[];
	readonly tabs: readonly HoldingTab[];
};
