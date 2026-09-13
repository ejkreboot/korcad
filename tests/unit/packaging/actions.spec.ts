import { describe, expect, it } from 'vitest';
import { SHEET } from '$lib/core/constants.js';
import type { DesignState } from '$lib/core/design/types.js';
import type { Selection } from '$lib/core/design/workspace.js';
import {
	addPocket,
	addSupport,
	packagingActions,
	releaseSheet,
	removePocket,
	resizeSupport,
	updatePocket,
	type DocumentHost
} from '$lib/features/packaging/actions.js';
import { createPocket } from '$lib/features/packaging/defaults.js';
import { riserFlatBounds } from '$lib/features/packaging/supports.js';
import { packagingData, packagingSheetView } from '$lib/features/packaging/view.js';
import { foldedDesign, supportDesign } from '../../support/designs.js';

/** Packaging's verbs, as pure document changes and bound to an editor. */

describe('pure actions', () => {
	it('adds, updates, and removes an opening', () => {
		const pocket = createPocket({ id: 'p', name: 'P', x: 10, y: 10, w: 20, h: 20 });
		const added = addPocket(foldedDesign(), pocket);
		expect(packagingData(added).pockets.at(-1)).toEqual(pocket);
		expect(packagingData(updatePocket(added, 'p', { w: 30 })).pockets.at(-1)?.w).toBe(30);
		expect(packagingData(removePocket(added, 'p')).pockets).toEqual(
			packagingData(foldedDesign()).pockets
		);
	});

	it('places a tray net on a sheet other than the deck', () => {
		const design = supportDesign();
		const tray = { ...packagingData(design).supports[0]!, id: 'tray-2', sheetId: 'deck' };
		const next = addSupport(design, tray, () => 'new-sheet');
		const placed = packagingData(next).supports.at(-1)!;
		expect(placed.sheetId).not.toBe('deck');
		expect(next.sheets.map((sheet) => sheet.id)).toContain(placed.sheetId);
	});

	it('keeps a resized net on its sheet', () => {
		const design = { ...supportDesign(), activeSheetId: 'parts' };
		const next = resizeSupport(design, 'riser-1', { w: 400, d: 400 });
		const riser = packagingData(next).supports.find((support) => support.id === 'riser-1')!;
		const bounds = riserFlatBounds(riser, packagingSheetView(next));
		expect(bounds.left).toBeGreaterThanOrEqual(0);
		expect(bounds.right).toBeLessThanOrEqual(SHEET + 1e-6);
	});

	it('removes the supports cut from a released sheet and nothing else', () => {
		const design = supportDesign();
		expect(packagingData(releaseSheet(design, 'deck')).supports).toHaveLength(2);
		expect(packagingData(releaseSheet(design, 'parts')).supports).toEqual([]);
	});
});

function fakeHost(initial: DesignState) {
	const host = {
		design: initial,
		selection: null as Selection | null,
		steps: 0,
		update(change: (design: DesignState) => DesignState) {
			host.design = change(host.design);
			host.steps += 1;
		},
		preview(change: (design: DesignState) => DesignState) {
			host.design = change(host.design);
		},
		select(selection: Selection | null) {
			host.selection = selection;
		}
	};
	return host satisfies DocumentHost;
}

describe('bound actions', () => {
	it('select what they add, as one undo step', () => {
		const host = fakeHost(foldedDesign());
		const actions = packagingActions(host);
		actions.addPocket(createPocket({ id: 'p', name: 'P', x: 10, y: 10, w: 20, h: 20 }));
		expect(host.steps).toBe(1);
		expect(actions.selectedPocketId).toBe('p');
		expect(actions.selectedSupportId).toBeNull();
	});

	it('preview without recording a step', () => {
		const host = fakeHost(foldedDesign());
		const actions = packagingActions(host);
		actions.previewPackaging({ deckW: 321 });
		expect(host.steps).toBe(0);
		expect(actions.view.deckW).toBe(321);
	});
});
