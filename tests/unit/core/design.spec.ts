import { describe, expect, it } from 'vitest';
import { packagingData } from '$lib/features/packaging/view.js';
import { DEFAULT_MACHINE_PROFILE_ID } from '$lib/core/design/defaults.js';
import { createDefaultDesign } from '$lib/features/document.js';
import { normalizeState } from '$lib/features/document.js';
import {
	bendDeduction,
	flatPanel,
	foldAllowanceLabel,
	panelClamped
} from '$lib/features/packaging/fold.js';
import { view, patchDesign, withMachine } from '../../support/designs.js';
import { serializeDesign } from '$lib/core/export/design-file.js';
import { parseDesign } from '$lib/features/document.js';
import { DESIGN_FORMAT, DESIGN_VERSION } from '$lib/core/constants.js';
import { machineProfileFor } from '$lib/core/design/machine.js';

/** A minimal current document: one packaging deck and whatever packaging data is given. */
const saved = (packaging: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
	sheets: [{ id: 'deck', name: 'Deck', workspace: 'packaging', machineProfileId: 'default' }],
	workspaces: { packaging: { deckSheetId: 'deck', ...packaging } },
	...extra
});

const supportRead = (support: Record<string, unknown>) =>
	packagingData(
		normalizeState(
			saved({ supports: [{ id: 'r', name: 'R', w: 100, d: 80, h: 30, kind: 'riser', ...support }] })
		)
	).supports[0];

describe('normalization', () => {
	it('rejects anything that is not a design', () => {
		for (const bad of [null, {}, { sheets: [] }, 'nope', { pockets: [] }]) {
			expect(() => normalizeState(bad)).toThrow(/valid Voisee design/);
		}
	});

	it('defaults settings a document leaves out', () => {
		const design = normalizeState(saved());
		expect(design.stock.boardFinish).toBe('kraft');
		expect(design.stock.minimumWeb).toBe(6);
		expect(packagingData(design).foldCompensation).toBe('none');
	});

	it('rejects an unknown foldCompensation rather than trusting it', () => {
		expect(
			packagingData(normalizeState(saved({ foldCompensation: 'wishful' }))).foldCompensation
		).toBe('none');
	});

	it('keeps label offsets across a JSON roundtrip', () => {
		const design = patchDesign(createDefaultDesign(), {
			pockets: packagingData(
				normalizeState(
					saved({ pockets: [{ id: 'p', name: 'Tablet', labelOffset: { x: 12, y: -7 } }] })
				)
			).pockets
		});
		const roundTripped = parseDesign(serializeDesign(design));
		expect(packagingData(roundTripped).pockets[0]?.labelOffset).toEqual({ x: 12, y: -7 });
	});

	it('reads a mount written with a named anchor', () => {
		expect(
			supportRead({ mount: { anchor: 'support-top', supportId: 'p', offset: 3 } })?.mount
		).toEqual({
			anchor: 'support-top',
			supportId: 'p',
			offset: 3
		});
		expect(supportRead({ mount: { anchor: 'deck-underside', offset: 0 } })?.mount).toEqual({
			anchor: 'deck-underside',
			offset: 0
		});
	});

	it('falls back to the floor when a mount is missing or names nothing', () => {
		expect(supportRead({ mount: { anchor: 'support-top' } })?.mount.anchor).toBe('box-floor');
		expect(supportRead({ mount: { target: 'deck', face: 'top' } })?.mount).toEqual({
			anchor: 'box-floor',
			offset: 0
		});
		expect(supportRead({ kind: 'tray' })?.mount.anchor).toBe('deck-underside');
	});

	it('takes a saved height as fixed unless the file says it spans', () => {
		expect(supportRead({})).toMatchObject({ heightMode: 'fixed', h: 30 });
		expect(supportRead({ heightMode: 'span' })?.heightMode).toBe('span');
	});

	it('keeps a support net where the file placed it', () => {
		expect(supportRead({ kind: undefined, flatX: 100, flatY: 100 })?.flatY).toBe(100);
	});

	it('restores a deck sheet and a valid active sheet', () => {
		const design = normalizeState(
			saved(
				{},
				{
					sheets: [
						{
							id: 'parts',
							name: 'Parts',
							workspace: 'packaging',
							machineProfileId: DEFAULT_MACHINE_PROFILE_ID
						}
					],
					activeSheetId: 'gone'
				}
			)
		);
		expect(design.sheets[0]?.id).toBe('deck');
		expect(design.activeSheetId).toBe('deck');
	});

	it('gives a packaging sheet its data even when the namespace is missing', () => {
		const design = normalizeState({ ...saved(), workspaces: {} });
		expect(design.workspaces.packaging?.deckSheetId).toBe('deck');
	});

	it('re-tags a sheet whose workspace this build does not know', () => {
		const design = normalizeState({
			sheets: [{ id: 'deck', name: 'Deck', workspace: 'embroidery' }],
			workspaces: {}
		});
		expect(design.sheets[0]?.workspace).toBe('packaging');
	});

	it('follows a deck sheet with any id', () => {
		const design = normalizeState({
			sheets: [{ id: 'blank-a', name: 'Blank', workspace: 'packaging' }],
			activeSheetId: 'blank-a',
			workspaces: { packaging: { deckSheetId: 'blank-a' } }
		});
		expect(design.sheets.map((sheet) => sheet.id)).toEqual(['blank-a']);
		expect(design.activeSheetId).toBe('blank-a');
	});
});

describe('machine profiles in a saved document', () => {
	it('repairs a sheet that names a profile the document does not have', () => {
		// Losing the sheet would lose the parts cut from it, so it is re-pointed.
		const design = normalizeState(
			saved(
				{},
				{
					machineProfiles: [{ id: 'real', name: 'Real' }],
					sheets: [
						{ id: 'deck', name: 'Deck', workspace: 'packaging', machineProfileId: 'missing' }
					]
				}
			)
		);
		expect(design.sheets[0]?.machineProfileId).toBe('real');
	});

	it('always leaves at least one profile, however broken the input', () => {
		for (const machineProfiles of [[], undefined, 'nonsense', [null], [{}]]) {
			const design = normalizeState(saved({}, { machineProfiles }));
			expect(design.machineProfiles.length).toBeGreaterThanOrEqual(1);
			expect(() => machineProfileFor(design, 'deck')).not.toThrow();
		}
	});

	it('drops a duplicate profile id rather than leaving the reference ambiguous', () => {
		const design = normalizeState(
			saved(
				{},
				{
					machineProfiles: [
						{ id: 'a', name: 'First', cutFeed: 111 },
						{ id: 'a', name: 'Second', cutFeed: 222 }
					]
				}
			)
		);
		expect(design.machineProfiles).toHaveLength(1);
		expect(design.machineProfiles[0]?.cutFeed).toBe(111);
	});

	it('defaults an unreadable field rather than making the program nonsense', () => {
		const design = normalizeState(
			saved({}, { machineProfiles: [{ id: 'partial', name: 'Partial', cutFeed: 'fast' }] })
		);
		expect(design.machineProfiles[0]?.cutFeed).toBe(800);
	});
});

describe('the design file envelope', () => {
	const file = (fields: Record<string, unknown>) =>
		JSON.stringify({ format: DESIGN_FORMAT, version: DESIGN_VERSION, design: saved(), ...fields });

	it('reads a file of the current version', () => {
		expect(parseDesign(file({})).sheets[0]?.id).toBe('deck');
	});

	it('rejects a file of any other version with a clear error', () => {
		for (const version of [DESIGN_VERSION - 1, DESIGN_VERSION + 1, undefined, '8']) {
			expect(() => parseDesign(file({ version }))).toThrow(/this build reads version/);
		}
	});

	it('rejects a bare document or a foreign format', () => {
		expect(() => parseDesign(JSON.stringify(saved()))).toThrow(/not a Voisee insert design/);
		expect(() => parseDesign(file({ format: 'something-else' }))).toThrow(
			/not a Voisee insert design/
		);
		expect(() => parseDesign('[]')).toThrow(/must contain an object/);
	});
});

describe('fold allowance', () => {
	const base = createDefaultDesign();

	it('deducts nothing unless compensation is switched on', () => {
		expect(bendDeduction(view(base))).toBe(0);
		expect(foldAllowanceLabel(view(base))).toMatch(/none/);
	});

	it('never deducts for router work, which is cut rather than folded', () => {
		const design = patchDesign(withMachine(base, { fabricationMode: 'router' }), {
			foldCompensation: 'manual' as const,
			foldDeduction: 3
		});
		expect(bendDeduction(view(design))).toBe(0);
	});

	it('uses the measured deduction in manual mode', () => {
		expect(
			bendDeduction(view(patchDesign(base, { foldCompensation: 'manual', foldDeduction: 1.25 })))
		).toBe(1.25);
	});

	it('computes a positive deduction from radius and K factor', () => {
		const design = patchDesign(base, { foldCompensation: 'computed' as const, material: 3 });
		expect(bendDeduction(view(design))).toBeGreaterThan(0);
		expect(foldAllowanceLabel(view(design))).toMatch(/computed/);
	});

	it('never shrinks a panel below the folding minimum', () => {
		const design = patchDesign(base, { foldCompensation: 'manual' as const, foldDeduction: 1000 });
		expect(flatPanel(10, view(design))).toBe(0.4);
		expect(panelClamped(10, view(design))).toBe(true);
	});
});
