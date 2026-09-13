import { createDefaultMachineProfile } from './defaults.js';
import { machineProfileFor } from './machine.js';
import type { DesignState, MachineProfile } from './types.js';

/**
 * Adding, duplicating, assigning, and deleting machine profiles.
 *
 * Each is a pure change to the document. A profile an operator creates is put
 * straight onto the sheet they are looking at, because a profile no sheet uses
 * would be edited without changing anything that gets cut.
 */

/** A name not already taken: `base`, else `base 2`, `base 3`, … */
export function uniqueProfileName(design: DesignState, base: string): string {
	const taken = new Set(design.machineProfiles.map((profile) => profile.name));
	if (!taken.has(base)) return base;
	let index = 2;
	while (taken.has(`${base} ${index}`)) index += 1;
	return `${base} ${index}`;
}

/** Points one sheet at a profile. An unknown profile id changes nothing. */
export function assignProfile(
	design: DesignState,
	sheetId: string,
	profileId: string
): DesignState {
	if (!design.machineProfiles.some((profile) => profile.id === profileId)) return design;
	return {
		...design,
		sheets: design.sheets.map((sheet) =>
			sheet.id === sheetId ? { ...sheet, machineProfileId: profileId } : sheet
		)
	};
}

function addAndAssign(design: DesignState, profile: MachineProfile, sheetId: string): DesignState {
	return assignProfile(
		{ ...design, machineProfiles: [...design.machineProfiles, profile] },
		sheetId,
		profile.id
	);
}

/** A new profile with the stock drag-knife settings, cut on by `sheetId`. */
export function addProfile(design: DesignState, sheetId: string, id: string): DesignState {
	const profile = createDefaultMachineProfile(id, uniqueProfileName(design, 'New profile'));
	return addAndAssign(design, profile, sheetId);
}

/**
 * A copy of the profile `sheetId` is cut on, then cut on by that sheet — the
 * way to vary one sheet's machine without touching the others sharing it.
 */
export function duplicateProfile(design: DesignState, sheetId: string, id: string): DesignState {
	const source = machineProfileFor(design, sheetId);
	const copy = { ...source, id, name: uniqueProfileName(design, `${source.name} copy`) };
	return addAndAssign(design, copy, sheetId);
}

/** What deleting a profile would do: `null` when it is the last one and cannot go. */
export type ProfileDeletion = {
	/** The profile its sheets move to. */
	readonly replacement: MachineProfile;
	/** Names of the sheets that would change machine. */
	readonly movedSheets: readonly string[];
};

export function profileDeletion(design: DesignState, profileId: string): ProfileDeletion | null {
	const replacement = design.machineProfiles.find((profile) => profile.id !== profileId);
	if (!replacement) return null;
	return {
		replacement,
		movedSheets: design.sheets
			.filter((sheet) => sheet.machineProfileId === profileId)
			.map((sheet) => sheet.name)
	};
}

/**
 * Deletes a profile. A document always keeps one, so the last cannot be
 * deleted; sheets that were cut on it move to the first remaining profile,
 * which `profileDeletion` names so the operator can be told first.
 */
export function deleteProfile(design: DesignState, profileId: string): DesignState {
	const deletion = profileDeletion(design, profileId);
	if (!deletion) return design;
	return {
		...design,
		machineProfiles: design.machineProfiles.filter((profile) => profile.id !== profileId),
		sheets: design.sheets.map((sheet) =>
			sheet.machineProfileId === profileId
				? { ...sheet, machineProfileId: deletion.replacement.id }
				: sheet
		)
	};
}
