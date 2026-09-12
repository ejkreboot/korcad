import type { CamIntent, DesignPath, OffsetSide, SheetView } from '$lib/core/design/types.js';
import type { MachiningStage } from '$lib/core/cam/stages.js';
import type { PackagingPath } from './paths.js';

/**
 * Packaging's manufacturing intent: what each of its path roles means to a
 * machine.
 *
 * This table used to live inside core CAM, which matched packaging role strings
 * — some of them composed at runtime, like `perimeter-${side}-fold` — to decide
 * machining order and which side of the line to cut. That made CAM unusable for
 * anything that is not a packaging insert, and made the role strings an
 * accidental cross-module API.
 *
 * The knowledge belongs here, with the feature that invents the vocabulary. CAM
 * now reads only the resulting `CamIntent`.
 */

type IntentSettings = Pick<SheetView, 'activeSheetId'>;
type OwnerSettings = Pick<SheetView, 'pockets' | 'risers'>;

/**
 * Which stage a path belongs to.
 *
 * Ported verbatim from the former `machiningStage` role table so that the
 * emitted program cannot move; the order of these tests is load-bearing. Note
 * that a tray's deck opening is `part-release` because it is owned by a
 * support, and that a riser's locking slot is deliberately excluded from that
 * rule so it is cut before the riser is freed.
 */
export function packagingStage(path: PackagingPath): MachiningStage {
	if (path.type === 'score') return 'score';
	if (path.role === 'joist-lock-slot') return 'interior';
	if (path.role?.startsWith('joist-')) return 'sheet-release';
	if (path.role === 'exterior' || path.role === 'router-deck-perimeter') return 'sheet-release';
	if (path.role?.startsWith('perimeter-')) return 'frame';
	if (path.riserId && path.role !== 'riser-lock-slot') return 'part-release';
	// Pocket features and riser locking slots, before any release cut.
	return 'interior';
}

/**
 * Which side of the line the tool runs.
 *
 * Only the deck perimeter is a part outline; every other closed contour in a
 * packaging design is a hole. Scores are cut on the line itself. Under a drag
 * knife this is unused — blade compensation is a trailing offset, not a side —
 * but it is stated for every path so the contract holds for any machine.
 */
export function packagingOffsetSide(path: PackagingPath): OffsetSide {
	if (path.type === 'score') return 'on';
	return path.role === 'router-deck-perimeter' ? 'outside' : 'inside';
}

/**
 * Which paths machine as one continuous chain.
 *
 * Ported from the former `routeChainKey`. Only the equality classes matter, not
 * the strings themselves: paths sharing a key are chained, and `null` means
 * "stand alone" — which is what the old unique `single:${index}` keys expressed.
 */
export function packagingChainKey(path: PackagingPath, settings: IntentSettings): string | null {
	if (path.closed) return null;
	const sheet = `sheet:${settings.activeSheetId}`;
	const owner = path.pocketId
		? `pocket:${path.pocketId}`
		: path.riserId
			? `riser:${path.riserId}`
			: sheet;
	if (path.type === 'score') return `${owner}:score:${path.role || 'fold'}`;
	if (path.role === 'exterior') return `${sheet}:exterior`;
	if (path.role?.startsWith('joist-') && path.role !== 'joist-lock-slot') {
		return `${sheet}:exterior`;
	}
	if (path.riserId && packagingStage(path) === 'part-release') {
		return `riser:${path.riserId}:release`;
	}
	if (path.role?.startsWith('perimeter-')) {
		return `${sheet}:perimeter:${packagingStage(path)}`;
	}
	return null;
}

export function packagingCamIntent(path: PackagingPath, settings: IntentSettings): CamIntent {
	return {
		offsetSide: packagingOffsetSide(path),
		stage: packagingStage(path),
		chainKey: packagingChainKey(path, settings)
	};
}

/**
 * The named entity a path belongs to, for the operator's G-code comment.
 *
 * Resolved here, where packaging knows its own collections, so the G-code
 * generator no longer needs them. An id that names no entity still yields an
 * owner with an empty name: the program has always printed ` ()` in that case,
 * and a comment is part of the golden output like any other line.
 */
function packagingOwner(path: PackagingPath, settings: OwnerSettings): DesignPath['owner'] {
	if (path.pocketId) {
		const name = settings.pockets.find((pocket) => pocket.id === path.pocketId)?.name ?? '';
		return { kind: 'pocket', id: path.pocketId, name };
	}
	if (path.riserId) {
		const name = settings.risers.find((support) => support.id === path.riserId)?.name ?? '';
		return { kind: 'support', id: path.riserId, name };
	}
	return undefined;
}

/** States the manufacturing intent and owner of every path in a sheet's geometry. */
export function annotateCamIntent(
	paths: readonly PackagingPath[],
	settings: IntentSettings & OwnerSettings
): readonly DesignPath[] {
	return paths.map((path) => {
		const owner = packagingOwner(path, settings);
		const cam = packagingCamIntent(path, settings);
		return owner ? { ...path, cam, owner } : { ...path, cam };
	});
}
