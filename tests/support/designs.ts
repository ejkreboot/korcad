import {
	createDefaultDesign,
	createPocket,
	DEFAULT_MACHINE_PROFILE_ID,
	supportDefaults
} from '$lib/core/design/defaults.js';
import type { MachineSettings, SheetView } from '$lib/core/design/types.js';
import { sheetView } from '$lib/core/design/machine.js';
import type { DesignState, Support } from '$lib/core/design/types.js';

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
	return {
		...createDefaultDesign(),
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
	};
}

/**
 * A rolled edge joist with the locking return. Adds derived lock slots (cut,
 * stage 1) and the joist end/tab/terminal cuts that release with the exterior.
 */
export function joistDesign(): DesignState {
	return {
		...foldedDesign(),
		perimeterType: 'joist',
		joistAxis: 'vertical',
		joistFolds: 5,
		joistHeight: 12.7,
		joistDepth: 6.35,
		joistLockWidth: 25.4
	};
}

/**
 * A recessed tray and a locking riser, cut from a parts sheet. The tray also
 * puts an opening on the deck, which is the only deck path owned by a support.
 */
export function supportDesign(): DesignState {
	const common = {
		...supportDefaults(),
		heightMode: 'fixed' as const,
		sheetId: 'parts',
		netVersion: 3
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
		mount: { anchor: 'box-floor', offset: 0 },
		netVersion: 2
	};
	return {
		...foldedDesign(),
		sheets: [
			{ id: 'deck', name: 'Deck', machineProfileId: DEFAULT_MACHINE_PROFILE_ID },
			{ id: 'parts', name: 'Parts 1', machineProfileId: DEFAULT_MACHINE_PROFILE_ID }
		],
		risers: [tray, riser]
	};
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
											: { anchor: 'box-floor', offset: 0 },
									netVersion: kind === 'tray' ? 3 : 2
								};
								yield withMachine(
									{
										...createDefaultDesign(),
										perimeterType,
										joistFolds,
										sheets: [
											{ id: 'deck', name: 'Deck', machineProfileId: DEFAULT_MACHINE_PROFILE_ID },
											{ id: 'parts', name: 'Parts', machineProfileId: DEFAULT_MACHINE_PROFILE_ID }
										],
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
										risers: [support]
									},
									{ fabricationMode }
								);
							}
}

/**
 * A document as one sheet sees it: the design plus the machine settings of the
 * profile that sheet is cut on.
 *
 * Geometry, CAM, and the packaging level model are all answered per sheet, so
 * a test that calls them directly hands over a view rather than the document.
 * Defaults to the active sheet, which is what the editor would pass.
 */
export function view(design: DesignState, sheetId: string = design.activeSheetId): SheetView {
	return sheetView(design, sheetId);
}
