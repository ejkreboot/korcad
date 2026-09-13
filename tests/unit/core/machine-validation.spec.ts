import { describe, expect, it } from 'vitest';
import { addProfile } from '$lib/core/design/profiles.js';
import { validateMachineSettings } from '$lib/core/design/validation.js';
import type { DesignState, MachineSettings } from '$lib/core/design/types.js';
import { createDefaultDesign } from '$lib/features/document.js';
import { validateDocument } from '$lib/features/workspaces.js';
import { solidDesign } from '../../support/designs.js';

/** The Solid plate of `solidDesign`, moved onto a profile of its own with `settings`. */
function plateOnOwnProfile(settings: Partial<MachineSettings>): DesignState {
	const design = addProfile(solidDesign('router'), 'plate', 'plate-machine');
	return {
		...design,
		machineProfiles: design.machineProfiles.map((profile) =>
			profile.id === 'plate-machine'
				? { ...profile, name: 'Plate router', fabricationMode: 'router', ...settings }
				: profile
		)
	};
}

describe('machine settings validation', () => {
	it('accepts the default profile', () => {
		expect(validateMachineSettings(createDefaultDesign())).toEqual([]);
		expect(validateDocument(plateOnOwnProfile({}))).toEqual([]);
	});

	it('blocks a Solid sheet on its own unsafe profile, naming the profile', () => {
		const errors = validateDocument(
			plateOnOwnProfile({ safeZ: -2, cutFeed: 0, plungeFeed: -5, spindleSpeed: 0 })
		);
		expect(errors).toEqual(
			expect.arrayContaining([
				'Plate router: safe Z must be positive',
				'Plate router: cut feed must be positive',
				'Plate router: plunge feed must be positive',
				'Plate router: spindle speed must be positive'
			])
		);
	});

	it.each(['bitWidth', 'spindleSpeed', 'passDepth'] as const)(
		'checks %s only on a router',
		(field) => {
			const router = plateOnOwnProfile({ [field]: 0 });
			expect(validateMachineSettings(router)).toHaveLength(1);
			const knife = plateOnOwnProfile({ fabricationMode: 'knife', [field]: 0 });
			expect(validateMachineSettings(knife)).toEqual([]);
		}
	);

	it('rejects values that are not finite', () => {
		expect(validateMachineSettings(plateOnOwnProfile({ cutDepth: Number.NaN }))).toEqual([
			'Plate router: cut depth must be positive'
		]);
		expect(validateMachineSettings(plateOnOwnProfile({ overcut: -1 }))).toEqual([
			'Plate router: overcut must be zero or more'
		]);
	});

	it('ignores a profile no sheet is cut on', () => {
		const design = plateOnOwnProfile({ safeZ: -2 });
		const unused = {
			...design,
			sheets: design.sheets.map((sheet) => ({ ...sheet, machineProfileId: 'default' }))
		};
		expect(validateMachineSettings(unused)).toEqual([]);
	});
});
