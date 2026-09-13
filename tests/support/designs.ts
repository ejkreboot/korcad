import { DEFAULT_MACHINE_PROFILE_ID } from '$lib/core/design/defaults.js';
import type { DesignState, MachineSettings, Sheet, StockSettings } from '$lib/core/design/types.js';
import { createPocket, supportDefaults } from '$lib/features/packaging/defaults.js';
import { createDefaultDesign } from '$lib/features/document.js';
import type { PackagingData, Support } from '$lib/features/packaging/types.js';
import {
	packagingData,
	packagingSheetView,
	type PackagingView
} from '$lib/features/packaging/view.js';
import type { DragView } from '$lib/editor/manipulation.js';

/**
 * Any field of the document, written flat the way tests think about it:
 * a stock setting, a packaging setting, or a top-level document field.
 */
export type DesignPatch = Partial<StockSettings> &
	Partial<PackagingData> &
	Partial<Pick<DesignState, 'toolpathOrder' | 'machineProfiles' | 'sheets' | 'activeSheetId'>>;

const STOCK_KEYS: readonly (keyof StockSettings)[] = [
	'units',
	'material',
	'boardFinish',
	'grainDirection',
	'minimumWeb',
	'tabWidth',
	'tabCount'
];
const DOCUMENT_KEYS: readonly string[] = [
	'toolpathOrder',
	'machineProfiles',
	'sheets',
	'activeSheetId'
];

/**
 * The document with flat fields routed to where they live: `stock`, the top
 * level, or `workspaces.packaging`. Keeps test setup readable now that the
 * document is namespaced.
 */
export function patchDesign(design: DesignState, patch: DesignPatch): DesignState {
	const stock: Record<string, unknown> = {};
	const top: Record<string, unknown> = {};
	const packaging: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(patch)) {
		if ((STOCK_KEYS as readonly string[]).includes(key)) stock[key] = value;
		else if (DOCUMENT_KEYS.includes(key)) top[key] = value;
		else packaging[key] = value;
	}
	return {
		...design,
		...top,
		stock: { ...design.stock, ...stock },
		workspaces: {
			...design.workspaces,
			packaging: { ...packagingData(design), ...packaging }
		}
	};
}

/** The default document with `patch` applied. */
export function makeDesign(patch: DesignPatch = {}): DesignState {
	return patchDesign(createDefaultDesign(), patch);
}

/** A packaging sheet on the default profile. */
export function packagingSheet(id: string, name: string): Sheet {
	return { id, name, workspace: 'packaging', machineProfileId: DEFAULT_MACHINE_PROFILE_ID };
}

/**
 * The reviewed fixture designs, shared by the golden output tests and the CAM
 * characterization snapshots so both describe the same four documents.
 *
 * Between them they exercise every branch of `machiningStage` in
 * `core/cam/routing.ts` — scores, joist lock slots, joist cuts, the exterior
 * release, the router deck perimeter, perimeter framing, support release, and
 * the interior default. That coverage is the precondition for generalizing CAM:
 * "the emitted program did not change" is only as strong as the fixtures
 * proving it.
 */

/**
 * The same design cut on a different machine. Every sheet of these fixtures
 * shares one profile, so overriding it changes the whole document's machine.
 */
export function withMachine(design: DesignState, settings: Partial<MachineSettings>): DesignState {
	return {
		...design,
		machineProfiles: design.machineProfiles.map((profile) => ({ ...profile, ...settings }))
	};
}

/** The default document: a folded perimeter with one folded pocket. */
export function foldedDesign(): DesignState {
	return patchDesign(createDefaultDesign(), {
		pockets: [
			createPocket({
				id: 'pocket-1',
				name: 'Folded pocket 1',
				x: 135.6,
				y: 119,
				w: 254.7,
				h: 149.4,
				wallDepth: 25.4,
				flange: 10,
				relief: 3.5,
				flangeEnabled: true,
				sides: { top: true, right: true, bottom: true, left: true }
			})
		]
	});
}

/**
 * A rolled edge joist with the locking return. Adds derived lock slots (cut,
 * stage 1) and the joist end/tab/terminal cuts that release with the exterior.
 */
export function joistDesign(): DesignState {
	return patchDesign(foldedDesign(), {
		perimeterType: 'joist',
		joistAxis: 'vertical',
		joistFolds: 5,
		joistHeight: 12.7,
		joistDepth: 6.35,
		joistLockWidth: 25.4
	});
}

/**
 * A recessed tray and a locking riser, cut from a parts sheet. The tray also
 * puts an opening on the deck, which is the only deck path owned by a support.
 */
export function supportDesign(): DesignState {
	const common = {
		...supportDefaults(),
		heightMode: 'fixed' as const,
		sheetId: 'parts'
	};
	const tray: Support = {
		...common,
		kind: 'tray',
		id: 'tray-1',
		name: 'Tablet tray',
		w: 120,
		d: 80,
		h: 25,
		overlap: 6,
		taper: 8,
		flange: 12,
		openSide: 'none',
		flatX: 60,
		flatY: 60,
		// Clear of the pocket, which spans deck-local 59..314 x 43..192.
		assemblyX: 60,
		assemblyY: 230,
		mount: { anchor: 'deck-underside', offset: 0 }
	};
	const riser: Support = {
		...common,
		kind: 'riser',
		id: 'riser-1',
		name: 'Riser 1',
		w: 90,
		d: 70,
		h: 30,
		cornerClosure: 'lock',
		flatX: 300,
		flatY: 60,
		assemblyX: 220,
		assemblyY: 60,
		mount: { anchor: 'box-floor', offset: 0 }
	};
	return patchDesign(foldedDesign(), {
		sheets: [packagingSheet('deck', 'Deck'), packagingSheet('parts', 'Parts 1')],
		supports: [tray, riser]
	});
}

/** Router work: openings and a deck perimeter, cut rather than folded. */
export function routerDesign(): DesignState {
	return withMachine(foldedDesign(), { fabricationMode: 'router' });
}

/** Every fixture, with the slug its golden artifacts are named after. */
export const FIXTURE_DESIGNS: readonly (readonly [string, () => DesignState])[] = [
	['folded-pocket', foldedDesign],
	['joist-perimeter', joistDesign],
	['tray-and-riser', supportDesign],
	['router-openings', routerDesign]
];

/**
 * Every packaging option combination that changes which paths are drawn:
 * machine, perimeter style, joist depth, pocket shape, support kind, corner
 * closure, and an open tray side — each with walls, flanges, and finger pulls
 * switched on. 648 documents.
 *
 * This is not a set of legal designs; several overlap or fail validation. It
 * exists to enumerate the vocabulary packaging can emit, so a test can hold
 * that vocabulary closed.
 */
export function* everyPackagingVariant(): Generator<DesignState> {
	const sides = { top: true, right: true, bottom: true, left: true };
	for (const fabricationMode of ['knife', 'router'] as const)
		for (const perimeterType of ['plain', 'folded', 'joist'] as const)
			for (const joistFolds of [2, 4, 5])
				for (const shape of ['rectangle', 'rounded', 'ellipse'] as const)
					for (const kind of ['riser', 'platform', 'tray'] as const)
						for (const cornerClosure of ['glue', 'lock'] as const)
							for (const openSide of ['none', 'left'] as const) {
								const support: Support = {
									...supportDefaults(),
									kind,
									id: 'support',
									name: 'Support',
									w: 90,
									d: 70,
									h: 30,
									heightMode: 'fixed',
									cornerClosure,
									openSide,
									sheetId: 'parts',
									flatX: 80,
									flatY: 80,
									assemblyX: 300,
									assemblyY: 300,
									pulls: sides,
									pullDiameter: 30,
									bottomFlange: true,
									mount:
										kind === 'tray'
											? { anchor: 'deck-underside', offset: 0 }
											: { anchor: 'box-floor', offset: 0 }
								};
								yield withMachine(
									patchDesign(createDefaultDesign(), {
										perimeterType,
										joistFolds,
										sheets: [packagingSheet('deck', 'Deck'), packagingSheet('parts', 'Parts')],
										pockets: [
											createPocket({
												id: 'pocket',
												name: 'Pocket',
												shape,
												x: 150,
												y: 150,
												w: 120,
												h: 90,
												flangeEnabled: true,
												sides,
												pulls: sides,
												pullDiameter: 30,
												pullDepth: 10
											})
										],
										supports: [support]
									}),
									{ fabricationMode }
								);
							}
}

/**
 * A document as one packaging sheet sees it: stock, packaging data, and the
 * machine settings of the profile that sheet is cut on.
 *
 * Geometry, CAM, and the packaging level model are all answered per sheet, so
 * a test that calls them directly hands over a view rather than the document.
 * Defaults to the active sheet, which is what the editor would pass.
 */
export function view(design: DesignState, sheetId: string = design.activeSheetId): PackagingView {
	return packagingSheetView(design, sheetId);
}

/** What a canvas drag reads: the sheet view plus the snap toggle, off by default. */
export function dragView(design: DesignState, snapEnabled = false): DragView {
	return { ...view(design), snapEnabled };
}
