import { describe, expect, it } from 'vitest';
import type { MachiningStage } from '$lib/core/cam/stages.js';
import type { DesignPath, OffsetSide } from '$lib/core/design/types.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { createPocket } from '$lib/features/packaging/defaults.js';
import { pocketPaths } from '$lib/features/packaging/geometry.js';
import { packagingData } from '$lib/features/packaging/view.js';
import { exteriorPaths } from '$lib/features/packaging/perimeter.js';
import { riserPaths } from '$lib/features/packaging/supports.js';
import {
	everyPackagingVariant,
	FIXTURE_DESIGNS,
	supportDesign,
	joistDesign,
	view
} from '../../support/designs.js';

/**
 * Packaging's manufacturing intent.
 *
 * Every packaging constructor states its path's `CamIntent` where it draws it
 * (`features/packaging/paths.ts`). The vocabulary below is the reviewed record
 * of what each role is for: every role packaging can emit must be listed with
 * the intent it is meant to have, and every listed role must still be emitted.
 * A new path therefore cannot ship until someone decides what it is for.
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

	// The outline that frees the blank, last of all: a folded perimeter's notched
	// corners are stretches of it.
	'cut:perimeter-side': ['sheet-release', 'inside'],
	'cut:perimeter-corner-clearance': ['sheet-release', 'inside'],
	'cut:perimeter-flange-chamfer': ['sheet-release', 'inside'],
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

/** A pocket with a folded wall on every side, so it draws folds, reliefs, and a cutout. */
const ALL_WALLS = {
	x: 100,
	y: 100,
	w: 90,
	h: 60,
	wallDepth: 12,
	sides: { top: true, right: true, bottom: true, left: true }
};

describe('packaging constructors state their own intent and owner', () => {
	it('releases a support after its own lock slots', () => {
		const design = supportDesign();
		const riser = packagingData(design).supports.find(
			(support) => support.kind !== 'tray' && support.cornerClosure === 'lock'
		);
		expect(riser).toBeDefined();
		const paths = riserPaths(riser!, view(design));
		const slots = paths.filter((path) => path.role === 'riser-lock-slot');
		expect(slots.length).toBeGreaterThan(0);
		expect(slots.every((path) => path.cam.stage === 'interior')).toBe(true);
		const walls = paths.filter((path) => path.role === 'riser-wall-edge');
		expect(walls.length).toBeGreaterThan(0);
		expect(walls.every((path) => path.cam.stage === 'part-release')).toBe(true);
		expect(
			paths.every((path) => path.owner?.kind === 'support' && path.owner.id === riser!.id)
		).toBe(true);
	});

	it('distinguishes a joist lock slot from the joist cuts that release the blank', () => {
		const paths = exteriorPaths(view(joistDesign())).paths;
		const stageOf = (role: string) =>
			new Set(paths.filter((p) => p.role === role).map((p) => p.cam.stage));
		expect(stageOf('joist-lock-slot')).toEqual(new Set(['interior']));
		expect(stageOf('joist-terminal')).toEqual(new Set(['sheet-release']));
		expect(paths.every((path) => path.owner === undefined)).toBe(true);
	});

	it('names the pocket that drew each of its paths', () => {
		const pocket = createPocket({ ...ALL_WALLS, id: 'p1', name: 'Phone' });
		const paths = pocketPaths(pocket, view(FIXTURE_DESIGNS[0]![1]()));
		expect(paths.length).toBeGreaterThan(1);
		expect(
			paths.every((path) => path.owner?.kind === 'pocket' && path.owner.name === 'Phone')
		).toBe(true);
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
		const settings = view(FIXTURE_DESIGNS[0]![1]());
		const folds = (id: string) =>
			pocketPaths(createPocket({ ...ALL_WALLS, id, name: id }), settings)
				.filter((path) => path.role === 'top-fold')
				.map((path) => path.cam.chainKey);
		expect(new Set(folds('p1'))).toEqual(new Set(['pocket:p1:score:top-fold']));
		expect(new Set(folds('p2'))).toEqual(new Set(['pocket:p2:score:top-fold']));
	});
});
