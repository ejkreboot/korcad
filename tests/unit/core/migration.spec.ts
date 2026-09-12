import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DESIGN_VERSION } from '$lib/core/constants.js';
import {
	CURRENT_DOCUMENT_VERSION,
	detectVersion,
	MIGRATIONS,
	migrateDocument,
	OLDEST_STEPPED_VERSION
} from '$lib/core/design/migrate.js';
import { machineProfileFor, MACHINE_SETTING_KEYS } from '$lib/core/design/machine.js';
import { normalizeState } from '$lib/core/design/normalize.js';
import { parseDesign } from '$lib/core/export/design-file.js';

/**
 * Document migrations.
 *
 * A saved design has to keep producing the result it produced when it was
 * saved, so each version step is tested against the exact shape it was written
 * for. The end-to-end proof that output has not moved lives in
 * `golden.spec.ts`, which cuts a frozen version 6 file and compares the
 * programs byte for byte; this file checks the shape of the step itself.
 */

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

/** A version 6 document: thirteen machine settings on the document itself. */
const v6 = () => ({
	units: 'in',
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
	spindleSpeed: 18000,
	deckW: 457.2,
	sheets: [
		{ id: 'deck', name: 'Deck' },
		{ id: 'parts', name: 'Parts 1' }
	],
	pockets: [],
	risers: []
});

describe('the migration pipeline', () => {
	it('agrees with the version this build writes', () => {
		expect(CURRENT_DOCUMENT_VERSION).toBe(DESIGN_VERSION);
	});

	it('is a connected chain with no gaps', () => {
		let version = OLDEST_STEPPED_VERSION;
		for (const step of MIGRATIONS) {
			expect(step.from).toBe(version);
			expect(step.to).toBe(version + 1);
			expect(step.describe).not.toBe('');
			version = step.to;
		}
		expect(version).toBe(CURRENT_DOCUMENT_VERSION);
	});

	it('reads a version from the document shape, for drafts that record none', () => {
		expect(detectVersion(v6())).toBe(6);
		expect(detectVersion({ ...v6(), machineProfiles: [] })).toBe(7);
	});

	it('does not re-run an old step over a document already in the new shape', () => {
		// A file can claim an old version while carrying a newer shape; running
		// the step again would overwrite the profile it already has.
		const modern = {
			...v6(),
			machineProfiles: [{ id: 'mine', name: 'My router', fabricationMode: 'router' }]
		};
		const migrated = migrateDocument(modern, 6);
		expect(migrated.machineProfiles).toEqual(modern.machineProfiles);
	});

	it('leaves a current document alone', () => {
		const current = migrateDocument(v6(), 6);
		expect(migrateDocument(current, CURRENT_DOCUMENT_VERSION)).toEqual(current);
	});
});

describe('version 7: machine settings become a named profile', () => {
	const migrated = migrateDocument(v6(), 6);

	it('moves every machine setting off the document', () => {
		for (const key of MACHINE_SETTING_KEYS) {
			expect(migrated, `${key} still on the document`).not.toHaveProperty(key);
		}
	});

	it('carries every setting across unchanged', () => {
		const [profile] = migrated.machineProfiles as Record<string, unknown>[];
		const source = v6() as Record<string, unknown>;
		for (const key of MACHINE_SETTING_KEYS) {
			expect(profile?.[key], key).toBe(source[key]);
		}
	});

	it('names the profile after the machine it describes', () => {
		const [knife] = migrated.machineProfiles as { name: string }[];
		expect(knife?.name).toBe('Drag knife');
		const routed = migrateDocument({ ...v6(), fabricationMode: 'router' }, 6);
		expect((routed.machineProfiles as { name: string }[])[0]?.name).toBe('Router');
	});

	it('points every existing sheet at the migrated profile', () => {
		const profileId = (migrated.machineProfiles as { id: string }[])[0]!.id;
		expect(migrated.sheets).toEqual([
			{ id: 'deck', name: 'Deck', machineProfileId: profileId },
			{ id: 'parts', name: 'Parts 1', machineProfileId: profileId }
		]);
	});

	it('leaves everything that is not a machine setting where it was', () => {
		expect(migrated.deckW).toBe(457.2);
		expect(migrated.units).toBe('in');
		expect(migrated.pockets).toEqual([]);
	});
});

describe('normalizing a migrated document', () => {
	it('gives every sheet a machine to be cut on', () => {
		const design = normalizeState(v6(), 6);
		expect(design.machineProfiles).toHaveLength(1);
		for (const sheet of design.sheets) {
			expect(machineProfileFor(design, sheet.id).cutFeed).toBe(800);
		}
	});

	it('repairs a sheet that names a profile the document does not have', () => {
		// Losing the sheet would lose the parts cut from it, so it is re-pointed.
		const design = normalizeState({
			...v6(),
			machineProfiles: [{ id: 'real', name: 'Real' }],
			sheets: [{ id: 'deck', name: 'Deck', machineProfileId: 'missing' }]
		});
		expect(design.sheets[0]?.machineProfileId).toBe('real');
	});

	it('always leaves at least one profile, however broken the input', () => {
		for (const machineProfiles of [[], undefined, 'nonsense', [null], [{}]]) {
			const design = normalizeState({ ...v6(), machineProfiles });
			expect(design.machineProfiles.length).toBeGreaterThanOrEqual(1);
			expect(() => machineProfileFor(design, 'deck')).not.toThrow();
		}
	});

	it('drops a duplicate profile id rather than leaving the reference ambiguous', () => {
		const design = normalizeState({
			...v6(),
			machineProfiles: [
				{ id: 'a', name: 'First', cutFeed: 111 },
				{ id: 'a', name: 'Second', cutFeed: 222 }
			]
		});
		expect(design.machineProfiles).toHaveLength(1);
		expect(design.machineProfiles[0]?.cutFeed).toBe(111);
	});

	it('defaults a profile field exactly as the document setting was defaulted', () => {
		const design = normalizeState({
			...v6(),
			machineProfiles: [{ id: 'partial', name: 'Partial', cutFeed: 'fast' }]
		});
		// An unreadable value falls back rather than making the program nonsense.
		expect(design.machineProfiles[0]?.cutFeed).toBe(800);
	});

	it('still rejects a file that is not a design at all', () => {
		for (const bad of [null, {}, { sheets: [] }, 'nope']) {
			expect(() => normalizeState(bad)).toThrow('This file does not contain a valid Voisee design');
		}
	});
});

describe('a saved version 6 file', () => {
	const saved = readFileSync(fixture('designs/legacy/v6-folded-pocket.voisee.json'), 'utf8');

	it('loads through the file envelope and gains a profile', () => {
		const design = parseDesign(saved);
		expect(design.machineProfiles).toHaveLength(1);
		expect(design.machineProfiles[0]?.fabricationMode).toBe('knife');
		expect(design.sheets.every((sheet) => sheet.machineProfileId)).toBe(true);
	});

	it('keeps every machine value the file recorded', () => {
		const source = JSON.parse(saved).design as Record<string, unknown>;
		const profile = machineProfileFor(parseDesign(saved), 'deck') as Record<string, unknown>;
		for (const key of MACHINE_SETTING_KEYS) {
			expect(profile[key], key).toBe(source[key]);
		}
	});
});
