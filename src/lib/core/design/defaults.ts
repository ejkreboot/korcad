import type { FabricationMode, MachineProfile, StockSettings } from './types.js';

/**
 * Generic document defaults. A workspace's own defaults live with the
 * workspace; the default document is assembled in `features/document.ts`,
 * because choosing which workspace a new design opens in is not core's call.
 */

/** Id of the profile every design starts with. */
export const DEFAULT_MACHINE_PROFILE_ID = 'default';

/**
 * The drag-knife setup the monolith shipped with. Ported verbatim: these values
 * are part of the manufactured result, so do not "clean them up" without
 * updated fixtures. `passDepth` is newer: the monolith routed every cut in one
 * pass. 3 mm suits a 6.35 mm bit in wood or board, a little under its radius.
 */
export function createDefaultMachineProfile(
	id: string = DEFAULT_MACHINE_PROFILE_ID,
	name = 'Drag knife'
): MachineProfile {
	return {
		id,
		name,
		fabricationMode: 'knife',
		safeZ: 3,
		cutDepth: 3.2,
		passDepth: 3,
		scoreDepth: 0.9,
		scoreTool: 'knife',
		cutFeed: 800,
		scoreFeed: 1000,
		plungeFeed: 250,
		bladeOffset: 0.25,
		overcut: 1.5,
		cornerStep: 10,
		bitWidth: 6.35,
		spindleSpeed: 18000
	};
}

/**
 * The stock profile for a kind of machine, named for its tool: the settings
 * above, with only the fabrication mode changed.
 */
export function createStockMachineProfile(
	fabricationMode: FabricationMode,
	id: string = DEFAULT_MACHINE_PROFILE_ID
): MachineProfile {
	return { ...createDefaultMachineProfile(id, stockProfileName(fabricationMode)), fabricationMode };
}

/** The name a stock profile of a kind of machine gets. */
export function stockProfileName(fabricationMode: FabricationMode): string {
	return fabricationMode === 'router' ? 'Router' : 'Drag knife';
}

/**
 * Ported verbatim from the monolith's `defaults()`; see above. `tabHeight` is
 * newer: the monolith had no router bridge tabs.
 */
export function createDefaultStock(): StockSettings {
	return {
		units: 'in',
		material: 3,
		boardFinish: 'kraft',
		grainDirection: 'y',
		minimumWeb: 6,
		tabWidth: 5,
		tabCount: 2,
		tabHeight: 1
	};
}
