import { describe, expect, it } from 'vitest';
import type { MachiningStage } from '$lib/core/cam/stages.js';
import type { DesignPath, OffsetSide } from '$lib/core/design/types.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import {
	packagingChainKey,
	packagingOffsetSide,
	packagingStage
} from '$lib/features/packaging/cam-intent.js';
import type { PackagingPath } from '$lib/features/packaging/paths.js';
import { everyPackagingVariant, FIXTURE_DESIGNS } from '../../support/designs.js';

/**
 * Packaging's manufacturing intent.
 *
 * Packaging derives each path's intent from its role and ownership in one pass
 * as geometry leaves `allGeometry`. That keeps role strings out of core CAM, but
 * it means a new role would silently take the `interior` default and machine in
 * the wrong order. The vocabulary below holds the set of roles closed: every
 * role packaging can emit must be listed with the intent it is meant to have,
 * and every listed role must still be emitted.
 */

/**
 * Every path packaging draws, keyed `type:role`, with its intended stage and
 * side of the line. A trailing `*` stands for a side name or fold number.
 *
 * If you are here because a test failed: decide what the new role is for and
 * add it. Do not pick whatever the default happened to produce.
 */
const VOCABULARY: Readonly<Record<string, readonly [MachiningStage, OffsetSide]>> = {
	// Folds, all creased or scored on the line before anything is cut.
	'score:flange-fold': ['score', 'on'],
	'score:top-fold': ['score', 'on'],
	'score:perimeter-deck-fold': ['score', 'on'],
	'score:perimeter-flange-fold': ['score', 'on'],
	'score:joist-fold-*': ['score', 'on'],
	'score:riser-top-fold': ['score', 'on'],
	'score:riser-bottom-flange-fold': ['score', 'on'],
	'score:riser-corner-tab-fold': ['score', 'on'],
	'score:riser-lock-tab-fold': ['score', 'on'],
	'score:tray-wall-fold': ['score', 'on'],
	'score:tray-flange-fold': ['score', 'on'],

	// Interior features, cut while the blank is still held by the sheet.
	'cut:central-cutout': ['interior', 'inside'],
	'cut:corner-relief': ['interior', 'inside'],
	'cut:finger-pull-*': ['interior', 'inside'],
	'cut:router-opening': ['interior', 'inside'],
	'cut:joist-lock-slot': ['interior', 'inside'],
	// A riser's lock slot is cut before the riser is released around it.
	'cut:riser-lock-slot': ['interior', 'inside'],

	// Everything that frees a support's net from the blank.
	'cut:riser-wall-edge': ['part-release', 'inside'],
	'cut:riser-bottom-flange': ['part-release', 'inside'],
	'cut:riser-corner-tab': ['part-release', 'inside'],
	'cut:riser-lock-edge': ['part-release', 'inside'],
	'cut:riser-lock-tab': ['part-release', 'inside'],
	'cut:tray-wall-edge': ['part-release', 'inside'],
	'cut:tray-flange-edge': ['part-release', 'inside'],
	'cut:tray-open-edge': ['part-release', 'inside'],
	'cut:tray-finger-pull-*': ['part-release', 'inside'],
	// The deck opening a tray drops through is owned by the tray.
	'cut:tray-opening': ['part-release', 'inside'],

	// Perimeter framing inside the blank outline.
	'cut:perimeter-side': ['frame', 'inside'],
	'cut:perimeter-corner-clearance': ['frame', 'inside'],
	'cut:perimeter-flange-chamfer': ['frame', 'inside'],

	// The outline that frees the blank, last of all.
	'cut:exterior': ['sheet-release', 'inside'],
	'cut:joist-end': ['sheet-release', 'inside'],
	'cut:joist-lock-tab': ['sheet-release', 'inside'],
	'cut:joist-terminal': ['sheet-release', 'inside'],
	// The only part outline in packaging, so the only path cut outside the line.
	'cut:router-deck-perimeter': ['sheet-release', 'outside']
};

const entryFor = (path: DesignPath): string | undefined => {
	const key = `${path.type}:${path.role ?? '-'}`;
	if (VOCABULARY[key]) return key;
	return Object.keys(VOCABULARY).find(
		(pattern) => pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))
	);
};

describe('the packaging path vocabulary is closed', () => {
	const emitted = new Map<string, DesignPath>();
	for (const design of everyPackagingVariant()) {
		for (const sheet of design.sheets) {
			for (const path of allGeometry({ ...design, activeSheetId: sheet.id }).paths) {
				emitted.set(`${path.type}:${path.role ?? '-'}`, path);
			}
		}
	}

	it('sweeps enough of the option space to be meaningful', () => {
		expect(emitted.size).toBeGreaterThanOrEqual(45);
	});

	it('lists every role packaging emits', () => {
		const unlisted = [...emitted.keys()].filter((key) => !entryFor(emitted.get(key)!));
		expect(unlisted, 'unclassified packaging roles — see VOCABULARY').toEqual([]);
	});

	it('gives every emitted role exactly the intent the vocabulary declares', () => {
		const wrong = [...emitted.values()].flatMap((path) => {
			const entry = entryFor(path);
			if (!entry) return [];
			const [stage, side] = VOCABULARY[entry]!;
			return path.cam.stage === stage && path.cam.offsetSide === side
				? []
				: [`${entry}: declared ${stage}/${side}, got ${path.cam.stage}/${path.cam.offsetSide}`];
		});
		expect(wrong).toEqual([]);
	});

	it('lists no role packaging has stopped emitting', () => {
		const stale = Object.keys(VOCABULARY).filter(
			(entry) => ![...emitted.values()].some((path) => entryFor(path) === entry)
		);
		expect(stale, 'vocabulary entries no design emits any more').toEqual([]);
	});
});

describe('packaging stage rules', () => {
	const cut = (role: string, extra: Partial<PackagingPath> = {}): PackagingPath => ({
		points: [],
		type: 'cut',
		closed: false,
		role,
		...extra
	});

	it('scores before anything, whatever the role', () => {
		expect(packagingStage({ points: [], type: 'score', closed: false, role: 'exterior' })).toBe(
			'score'
		);
	});

	it('releases a support after its own lock slots', () => {
		expect(packagingStage(cut('riser-wall-edge', { riserId: 'r' }))).toBe('part-release');
		expect(packagingStage(cut('riser-lock-slot', { riserId: 'r' }))).toBe('interior');
	});

	it('distinguishes a joist lock slot from the joist cuts that release the blank', () => {
		expect(packagingStage(cut('joist-lock-slot'))).toBe('interior');
		expect(packagingStage(cut('joist-terminal'))).toBe('sheet-release');
	});

	it('cuts only the router deck perimeter outside the line', () => {
		expect(packagingOffsetSide(cut('router-deck-perimeter'))).toBe('outside');
		expect(packagingOffsetSide(cut('exterior'))).toBe('inside');
		expect(packagingOffsetSide({ points: [], type: 'score', closed: false })).toBe('on');
	});

	it('defaults an unknown role to an interior hole, which is why the vocabulary is closed', () => {
		expect(packagingStage(cut('some-new-role'))).toBe('interior');
	});
});

describe('packaging chain keys', () => {
	const fixturePaths = FIXTURE_DESIGNS.flatMap(([, build]) => {
		const design = build();
		return design.sheets.flatMap(
			(sheet) => allGeometry({ ...design, activeSheetId: sheet.id }).paths
		);
	});

	it('never chains a closed contour', () => {
		const closed = fixturePaths.filter((path) => path.closed);
		expect(closed.length).toBeGreaterThan(0);
		expect(closed.every((path) => path.cam.chainKey === null)).toBe(true);
	});

	/**
	 * Routing merges a chain into one contour that keeps its head's intent, so a
	 * chain spanning two stages would machine part of itself out of order.
	 */
	it('only groups paths that share a machining stage', () => {
		const byKey = new Map<string, Set<string>>();
		for (const path of fixturePaths) {
			if (!path.cam.chainKey) continue;
			const stages = byKey.get(path.cam.chainKey) ?? new Set<string>();
			stages.add(path.cam.stage);
			byKey.set(path.cam.chainKey, stages);
		}
		expect(byKey.size).toBeGreaterThan(0);
		const mixed = [...byKey].filter(([, stages]) => stages.size > 1);
		expect(mixed.map(([key, stages]) => `${key}: ${[...stages].join(', ')}`)).toEqual([]);
	});

	it('keys folds by their owner, so each pocket creases as one pass', () => {
		const fold: PackagingPath = {
			points: [],
			type: 'score',
			closed: false,
			role: 'top-fold',
			pocketId: 'p1'
		};
		expect(packagingChainKey(fold, { activeSheetId: 'deck' })).toBe('pocket:p1:score:top-fold');
		expect(packagingChainKey({ ...fold, pocketId: 'p2' }, { activeSheetId: 'deck' })).not.toBe(
			'pocket:p1:score:top-fold'
		);
	});
});
