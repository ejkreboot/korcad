/**
 * Machining dependency stages, in execution order.
 *
 * Interior work precedes the release cuts that free a part, so nothing moves
 * under the tool while it still has work left on it. Stages are *process*
 * concepts, not feature concepts: a workspace chooses one per path, it does not
 * get to invent new ones. That is what lets routing order a sheet without
 * knowing what the parts on it are for.
 */
export type MachiningStage =
	/** Creases and scores, cut while the board is still fully supported. */
	| 'score'
	/** Holes, slots, and features wholly inside a part. */
	| 'interior'
	/** Cuts that free one part from the blank. */
	| 'part-release'
	/** Structural framing cuts inside the blank outline. */
	| 'frame'
	/** The outline that frees the blank from the stock. */
	| 'sheet-release';

/**
 * Execution order. The index of a stage is its priority, and these indices
 * deliberately match the integers the original per-role priorities used before
 * stages were named, so route bucketing is unchanged.
 */
export const STAGE_ORDER: readonly MachiningStage[] = [
	'score',
	'interior',
	'part-release',
	'frame',
	'sheet-release'
];

export const STAGE_COUNT = STAGE_ORDER.length;

export function stageIndex(stage: MachiningStage): number {
	const index = STAGE_ORDER.indexOf(stage);
	// An unknown stage would silently reorder machining, so fail loudly.
	if (index < 0) throw new Error(`Unknown machining stage: ${stage}`);
	return index;
}
