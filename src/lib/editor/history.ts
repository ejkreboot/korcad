import type { DesignState } from '$lib/core/design/types.js';

/**
 * Identity of a design for undo purposes. Selection, the active sheet, and
 * the snap toggle are editor state: changing them must not create an undo
 * step, and must not mark the design dirty.
 */
const TRANSIENT_KEYS = ['selectedId', 'selectedRiserId', 'activeSheetId', 'snapEnabled'] as const;

export function designHistorySignature(design: DesignState): string {
	const durable = Object.fromEntries(
		Object.entries(design).filter(([key]) => !(TRANSIENT_KEYS as readonly string[]).includes(key))
	);
	return JSON.stringify(durable);
}

export type History = {
	readonly canUndo: boolean;
	readonly canRedo: boolean;
	/** Number of recorded steps, so a caller can mirror depth into UI state. */
	readonly depth: number;
	/** Records `design` if it differs from the last committed signature. */
	commit(design: DesignState): void;
	undo(current: DesignState): DesignState | null;
	redo(current: DesignState): DesignState | null;
};

const clone = (design: DesignState): DesignState =>
	JSON.parse(JSON.stringify(design)) as DesignState;

export function createHistory(initial: DesignState, limit = 100): History {
	const past: DesignState[] = [];
	const future: DesignState[] = [];
	let signature = designHistorySignature(initial);
	let baseline = clone(initial);

	return {
		get canUndo() {
			return past.length > 0;
		},
		get canRedo() {
			return future.length > 0;
		},
		get depth() {
			return past.length + future.length;
		},
		commit(design) {
			const next = designHistorySignature(design);
			if (next === signature) return;
			past.push(baseline);
			if (past.length > limit) past.shift();
			future.length = 0;
			baseline = clone(design);
			signature = next;
		},
		undo(current) {
			const previous = past.pop();
			if (!previous) return null;
			future.push(clone(current));
			baseline = clone(previous);
			signature = designHistorySignature(previous);
			return clone(previous);
		},
		redo(current) {
			const next = future.pop();
			if (!next) return null;
			past.push(clone(current));
			baseline = clone(next);
			signature = designHistorySignature(next);
			return clone(next);
		}
	};
}
