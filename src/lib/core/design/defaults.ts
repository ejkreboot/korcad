import type { MachineProfile, StockSettings } from './types.js';

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
 * updated fixtures.
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

/** Ported verbatim from the monolith's `defaults()`; see above. */
export function createDefaultStock(): StockSettings {
	return {
		units: 'in',
		material: 3,
		boardFinish: 'kraft',
		grainDirection: 'y',
		minimumWeb: 6,
		tabWidth: 5,
		tabCount: 2
	};
}
