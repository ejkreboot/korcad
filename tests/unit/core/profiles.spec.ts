import { describe, expect, it } from 'vitest';
import { machineProfileFor } from '$lib/core/design/machine.js';
import {
	addProfile,
	addStockProfile,
	assignProfile,
	deleteProfile,
	duplicateProfile,
	profileDeletion,
	setFabricationMode,
	uniqueProfileName
} from '$lib/core/design/profiles.js';
import { createDefaultDesign } from '$lib/features/document.js';
import { parseDesign } from '$lib/features/document.js';
import { serializeDesign } from '$lib/core/export/design-file.js';
import { supportDesign } from '../../support/designs.js';

/**
 * Machine profile management. Each operation changes which machine a sheet is
 * cut on, which changes its program, so what moves where is pinned exactly.
 */

describe('machine profiles', () => {
	it('never reuse a name', () => {
		const design = addProfile(supportDesign(), 'deck', 'a');
		expect(uniqueProfileName(design, 'Router')).toBe('Router');
		expect(uniqueProfileName(design, 'New tool')).toBe('New tool 2');
	});

	it('add a stock profile of either kind, named for its tool, to a project without one', () => {
		const design = addStockProfile(createDefaultDesign('packaging'), 'deck', 'r', 'router');
		expect(machineProfileFor(design, 'deck')).toMatchObject({
			id: 'r',
			name: 'Router',
			fabricationMode: 'router'
		});
		const knives = addStockProfile(design, 'deck', 'k', 'knife');
		expect(machineProfileFor(knives, 'deck')).toMatchObject({
			name: 'Drag knife 2',
			fabricationMode: 'knife'
		});
	});

	it('rename a stock-named profile when its kind of machine changes, and keep a chosen name', () => {
		const flatParts = createDefaultDesign('flatParts');
		const knife = setFabricationMode(flatParts, 'default', 'knife');
		expect(knife.machineProfiles[0]).toMatchObject({
			name: 'Drag knife',
			fabricationMode: 'knife'
		});
		expect(setFabricationMode(knife, 'default', 'router').machineProfiles[0]?.name).toBe('Router');

		const numbered = {
			...flatParts,
			machineProfiles: [{ ...flatParts.machineProfiles[0]!, name: 'Router 3' }]
		};
		expect(setFabricationMode(numbered, 'default', 'knife').machineProfiles[0]?.name).toBe(
			'Drag knife'
		);
		const chosen = {
			...flatParts,
			machineProfiles: [{ ...flatParts.machineProfiles[0]!, name: 'Shapeoko' }]
		};
		expect(setFabricationMode(chosen, 'default', 'knife').machineProfiles[0]).toMatchObject({
			name: 'Shapeoko',
			fabricationMode: 'knife'
		});
		expect(setFabricationMode(flatParts, 'default', 'router')).toBe(flatParts);
	});

	it('add a stock profile cut on by the active sheet only', () => {
		const design = addProfile(supportDesign(), 'deck', 'fresh');
		expect(design.machineProfiles.map((profile) => profile.id)).toEqual(['default', 'fresh']);
		expect(machineProfileFor(design, 'deck').id).toBe('fresh');
		expect(machineProfileFor(design, 'parts').id).toBe('default');
	});

	it('duplicate the active sheet’s profile with every setting, and move only that sheet', () => {
		const base = supportDesign();
		const tuned = {
			...base,
			machineProfiles: base.machineProfiles.map((profile) => ({ ...profile, cutDepth: 2.2 }))
		};
		const design = duplicateProfile(tuned, 'parts', 'copy');
		const copy = machineProfileFor(design, 'parts');
		expect(copy).toEqual({ ...tuned.machineProfiles[0], id: 'copy', name: 'Drag knife copy' });
		expect(machineProfileFor(design, 'deck').id).toBe('default');
	});

	it('assign an existing profile, and ignore one that does not exist', () => {
		const design = addProfile(supportDesign(), 'deck', 'fresh');
		expect(machineProfileFor(assignProfile(design, 'parts', 'fresh'), 'parts').id).toBe('fresh');
		expect(assignProfile(design, 'parts', 'missing')).toBe(design);
	});

	it('refuse to delete the last profile', () => {
		const design = supportDesign();
		expect(profileDeletion(design, 'default')).toBeNull();
		expect(deleteProfile(design, 'default')).toBe(design);
	});

	it('say which sheets a deletion moves, and move them to the first remaining profile', () => {
		const design = assignProfile(addProfile(supportDesign(), 'deck', 'fresh'), 'parts', 'fresh');
		expect(profileDeletion(design, 'fresh')).toEqual({
			replacement: design.machineProfiles[0],
			movedSheets: ['Deck', 'Parts 1']
		});
		const deleted = deleteProfile(design, 'fresh');
		expect(deleted.machineProfiles.map((profile) => profile.id)).toEqual(['default']);
		expect(deleted.sheets.every((sheet) => sheet.machineProfileId === 'default')).toBe(true);
		// The result is a complete document that reads back unchanged.
		expect(parseDesign(serializeDesign(deleted))).toEqual(deleted);
	});
});
