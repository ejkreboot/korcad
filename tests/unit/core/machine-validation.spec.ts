import { describe, expect, it } from 'vitest';
import { addProfile } from '$lib/core/design/profiles.js';
import { validateMachineSettings } from '$lib/core/design/validation.js';
import type { DesignState, MachineSettings } from '$lib/core/design/types.js';
import { createDefaultDesign } from '$lib/features/document.js';
import { validateDocument } from '$lib/features/workspaces.js';
import { flatPartsDesign } from '../../support/designs.js';

/** The Flat Parts sheet of `flatPartsDesign`, moved onto a profile of its own with `settings`. */
function partsOnOwnProfile(settings: Partial<MachineSettings>): DesignState {
	const design = addProfile(flatPartsDesign('router'), 'sheet', 'parts-machine');
	return {
		...design,
		machineProfiles: design.machineProfiles.map((profile) =>
			profile.id === 'parts-machine'
				? { ...profile, name: 'Parts router', fabricationMode: 'router', ...settings }
				: profile
		)
	};
}

describe('machine settings validation', () => {
	it('accepts the default profile', () => {
		expect(validateMachineSettings(createDefaultDesign())).toEqual([]);
		expect(validateDocument(partsOnOwnProfile({}))).toEqual([]);
	});

	it('blocks a Flat Parts sheet on its own unsafe profile, naming the profile', () => {
		const errors = validateDocument(
			partsOnOwnProfile({ safeZ: -2, cutFeed: 0, plungeFeed: -5, spindleSpeed: 0 })
		);
		expect(errors).toEqual(
			expect.arrayContaining([
				'Parts router: safe Z must be positive',
				'Parts router: cut feed must be positive',
				'Parts router: plunge feed must be positive',
				'Parts router: spindle speed must be positive'
			])
		);
	});

	it.each(['bitWidth', 'spindleSpeed', 'passDepth'] as const)(
		'checks %s only on a router',
		(field) => {
			const router = partsOnOwnProfile({ [field]: 0 });
			expect(validateMachineSettings(router)).toHaveLength(1);
			const knife = partsOnOwnProfile({ fabricationMode: 'knife', [field]: 0 });
			expect(validateMachineSettings(knife)).toEqual([]);
		}
	);

	it('rejects values that are not finite', () => {
		expect(validateMachineSettings(partsOnOwnProfile({ cutDepth: Number.NaN }))).toEqual([
			'Parts router: cut depth must be positive'
		]);
		expect(validateMachineSettings(partsOnOwnProfile({ overcut: -1 }))).toEqual([
			'Parts router: overcut must be zero or more'
		]);
	});

	it('ignores a profile no sheet is cut on', () => {
		const design = partsOnOwnProfile({ safeZ: -2 });
		const unused = {
			...design,
			sheets: design.sheets.map((sheet) => ({ ...sheet, machineProfileId: 'default' }))
		};
		expect(validateMachineSettings(unused)).toEqual([]);
	});
});
