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

describe('normalization', () => {
	it('rejects anything that is not a design', () => {
		expect(() => normalizeState(null)).toThrow(/valid Voisee design/);
		expect(() => normalizeState({})).toThrow(/valid Voisee design/);
	});

	it('defaults new settings for legacy designs', () => {
		const design = normalizeState({ pockets: [] });
		expect(design.stock.boardFinish).toBe('kraft');
		expect(design.stock.minimumWeb).toBe(6);
		expect(packagingData(design).foldCompensation).toBe('none');
	});

	it('rejects an unknown foldCompensation rather than trusting it', () => {
		expect(
			packagingData(normalizeState({ pockets: [], foldCompensation: 'wishful' })).foldCompensation
		).toBe('none');
	});

	it('keeps label offsets across a JSON roundtrip', () => {
		const design = patchDesign(createDefaultDesign(), {
			pockets: packagingData(
				normalizeState({
					pockets: [{ id: 'p', name: 'Tablet', labelOffset: { x: 12, y: -7 } }]
				})
			).pockets
		});
		const roundTripped = parseDesign(serializeDesign(design));
		expect(packagingData(roundTripped).pockets[0]?.labelOffset).toEqual({ x: 12, y: -7 });
	});

	it('migrates legacy supports to floor mounts without changing their height offset', () => {
		const design = normalizeState({
			pockets: [],
			risers: [
				{
					id: 'old',
					name: 'Old riser',
					w: 100,
					d: 80,
					h: 30,
					assemblyZ: 12,
					flatX: 100,
					flatY: 100,
					netVersion: 2
				}
			]
		});
		expect(packagingData(design).supports[0]?.kind).toBe('riser');
		expect(packagingData(design).supports[0]?.mount.anchor).toBe('box-floor');
		expect(packagingData(design).supports[0]?.mount.offset).toBe(12);
	});

	it('maps the older target/face mount pair onto the named anchors', () => {
		const support = (mount: unknown) => ({
			id: 'r',
			name: 'R',
			w: 100,
			d: 80,
			h: 30,
			flatX: 100,
			flatY: 100,
			netVersion: 2,
			kind: 'riser',
			mount
		});
		const anchorOf = (mount: unknown) =>
			packagingData(normalizeState({ pockets: [], risers: [support(mount)] })).supports[0]?.mount;

		expect(anchorOf({ target: 'deck', face: 'top', offset: 4 })).toEqual({
			anchor: 'deck-top',
			offset: 4
		});
		expect(anchorOf({ target: 'deck', face: 'underside', offset: 0 })).toEqual({
			anchor: 'deck-underside',
			offset: 0
		});
		expect(anchorOf({ target: 'box-floor', face: 'top', offset: 7 })).toEqual({
			anchor: 'box-floor',
			offset: 7
		});
		// Any other target named another support by id.
		expect(anchorOf({ target: 'parent-id', face: 'top', offset: 2 })).toEqual({
			anchor: 'support-top',
			supportId: 'parent-id',
			offset: 2
		});
	});

	it('reads a mount already written with a named anchor', () => {
		const design = normalizeState({
			pockets: [],
			risers: [
				{
					id: 'r',
					name: 'R',
					w: 100,
					d: 80,
					h: 30,
					kind: 'riser',
					netVersion: 2,
					mount: { anchor: 'support-top', supportId: 'p', offset: 3 }
				}
			]
		});
		expect(packagingData(design).supports[0]?.mount).toEqual({
			anchor: 'support-top',
			supportId: 'p',
			offset: 3
		});
	});

	it('falls back to the floor when a support-top mount names nothing', () => {
		const design = normalizeState({
			pockets: [],
			risers: [
				{
					id: 'r',
					name: 'R',
					w: 100,
					d: 80,
					h: 30,
					kind: 'riser',
					mount: { anchor: 'support-top' }
				}
			]
		});
		expect(packagingData(design).supports[0]?.mount.anchor).toBe('box-floor');
	});

	it('takes a saved height as fixed unless the file says it spans', () => {
		const read = (extra: Record<string, unknown>) =>
			packagingData(
				normalizeState({
					pockets: [],
					risers: [{ id: 'r', name: 'R', w: 100, d: 80, h: 30, kind: 'riser', ...extra }]
				})
			).supports[0];
		// A file predating spanning heights keeps the height it recorded.
		expect(read({})).toMatchObject({ heightMode: 'fixed', h: 30 });
		expect(read({ heightMode: 'span' })?.heightMode).toBe('span');
	});

	it('shifts a pre-v2 riser net up by its height', () => {
		const legacy = normalizeState({
			pockets: [],
			risers: [{ id: 'old', name: 'Old', w: 100, d: 80, h: 30, flatX: 100, flatY: 100 }]
		});
		expect(packagingData(legacy).supports[0]?.flatY).toBe(130);
	});

	it('restores a deck sheet and a valid active sheet', () => {
		// A version 7 document, whose sheets carry no workspace tag yet.
		const design = normalizeState({
			pockets: [],
			sheets: [{ id: 'parts', name: 'Parts', machineProfileId: DEFAULT_MACHINE_PROFILE_ID }],
			activeSheetId: 'gone'
		});
		expect(design.sheets[0]?.id).toBe('deck');
		expect(design.activeSheetId).toBe('deck');
	});

	it('refuses a design file from a newer version', () => {
		expect(() =>
			parseDesign(
				JSON.stringify({ format: 'voisee-insert-design', version: 99, design: { pockets: [] } })
			)
		).toThrow(/newer version/);
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
