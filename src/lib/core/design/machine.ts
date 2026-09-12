import type { DesignState, MachineProfile, MachineSettings, SheetView } from './types.js';

/** Every machine setting, in the order a profile lists them. */
export const MACHINE_SETTING_KEYS = [
	'fabricationMode',
	'safeZ',
	'cutDepth',
	'scoreDepth',
	'scoreTool',
	'cutFeed',
	'scoreFeed',
	'plungeFeed',
	'bladeOffset',
	'overcut',
	'cornerStep',
	'bitWidth',
	'spindleSpeed'
] as const satisfies readonly (keyof MachineSettings)[];

/**
 * The profile a sheet is cut on. A dangling reference falls back to the first
 * profile rather than throwing: normalization repairs references on load, so
 * this only matters for a document mid-edit, where a sensible answer beats a
 * crash.
 */
export function machineProfileFor(design: DesignState, sheetId: string): MachineProfile {
	const sheet = design.sheets.find((candidate) => candidate.id === sheetId);
	const profile =
		design.machineProfiles.find((candidate) => candidate.id === sheet?.machineProfileId) ??
		design.machineProfiles[0];
	if (!profile) throw new Error('A design must have at least one machine profile');
	return profile;
}

/** Only the machine settings of a profile, without its identity. */
export function machineSettings(profile: MachineProfile): MachineSettings {
	return {
		fabricationMode: profile.fabricationMode,
		safeZ: profile.safeZ,
		cutDepth: profile.cutDepth,
		scoreDepth: profile.scoreDepth,
		scoreTool: profile.scoreTool,
		cutFeed: profile.cutFeed,
		scoreFeed: profile.scoreFeed,
		plungeFeed: profile.plungeFeed,
		bladeOffset: profile.bladeOffset,
		overcut: profile.overcut,
		cornerStep: profile.cornerStep,
		bitWidth: profile.bitWidth,
		spindleSpeed: profile.spindleSpeed
	};
}

/** The document as seen from one sheet; see `SheetView`. */
export function sheetView(design: DesignState, sheetId: string = design.activeSheetId): SheetView {
	return {
		...design.stock,
		...machineSettings(machineProfileFor(design, sheetId)),
		toolpathOrder: design.toolpathOrder,
		sheets: design.sheets,
		activeSheetId: sheetId
	};
}

/** Profiles that at least one sheet is actually cut on, in sheet order. */
export function referencedProfiles(design: DesignState): readonly MachineProfile[] {
	const ids = [...new Set(design.sheets.map((sheet) => sheet.machineProfileId))];
	return ids.flatMap((id) => design.machineProfiles.filter((profile) => profile.id === id));
}
