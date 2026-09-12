import { describe, expect, it } from 'vitest';
import { SHEET } from '$lib/core/constants.js';
import {
	DEFAULT_MACHINE_PROFILE_ID,
	createDefaultDesign,
	supportDefaults
} from '$lib/core/design/defaults.js';
import type { DesignState, Support } from '$lib/core/design/types.js';
import {
	CUTOUT_PRESETS,
	SUPPORT_PRESETS,
	createPocketFromPreset,
	createSupportFromPreset,
	presetDrawsOnDeck,
	supportKindForPreset
} from '$lib/features/packaging/presets.js';
import { constrainSupportFlat, placeSupport } from '$lib/features/packaging/placement.js';
import { riserFlatBounds } from '$lib/features/packaging/supports.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { view } from '../../support/designs.js';
import { validate } from '$lib/features/packaging/validation.js';

const rect = { x: 200, y: 200, w: 120, h: 90 };
const design = createDefaultDesign();

describe('cutout presets', () => {
	it('offers a distinct semantic type for every preset', () => {
		expect(new Set(CUTOUT_PRESETS.map((p) => p.id)).size).toBe(CUTOUT_PRESETS.length);
	});

	it('gives a plain rectangle no walls and a folded pocket four', () => {
		const plain = createPocketFromPreset('rectangle', rect, 'a', 1);
		expect(plain.purpose).toBe('product');
		expect(Object.values(plain.sides).every((on) => !on)).toBe(true);

		const folded = createPocketFromPreset('folded', rect, 'b', 1);
		expect(folded.purpose).toBe('product');
		expect(Object.values(folded.sides).every((on) => on)).toBe(true);
		expect(folded.flangeEnabled).toBe(true);
	});

	it('keeps the preset identity as the purpose for functional openings', () => {
		for (const preset of ['slot', 'cable', 'registration', 'ellipse', 'rounded'] as const) {
			expect(createPocketFromPreset(preset, rect, 'p', 1).purpose).toBe(preset);
		}
	});

	it('forces a registration hole square so it locates in both axes', () => {
		const hole = createPocketFromPreset('registration', rect, 'p', 1);
		expect(hole.w).toBe(hole.h);
		expect(hole.w).toBe(Math.min(rect.w, rect.h));
		// It stays centred on what was drawn.
		expect(hole.x + hole.w / 2).toBeCloseTo(rect.x + rect.w / 2, 6);
	});

	it('maps presets onto drawable shapes', () => {
		expect(createPocketFromPreset('ellipse', rect, 'p', 1).shape).toBe('ellipse');
		expect(createPocketFromPreset('slot', rect, 'p', 1).shape).toBe('rounded');
		expect(createPocketFromPreset('rectangle', rect, 'p', 1).shape).toBe('rectangle');
	});

	it('produces geometry that validates', () => {
		const withPocket: DesignState = {
			...design,
			pockets: [createPocketFromPreset('folded', { x: 200, y: 200, w: 200, h: 150 }, 'p', 1)]
		};
		expect(validate(withPocket)).toEqual([]);
		expect(allGeometry(withPocket).paths.some((path) => path.role === 'top-fold')).toBe(true);
	});
});

describe('support presets', () => {
	const context = { activeSheetId: 'deck', deckX: design.deckX, deckY: design.deckY };

	it('offers a distinct semantic type for every preset', () => {
		expect(new Set(SUPPORT_PRESETS.map((p) => p.id)).size).toBe(SUPPORT_PRESETS.length);
	});

	it('maps presets onto support kinds and closures', () => {
		expect(supportKindForPreset('tray')).toBe('tray');
		expect(supportKindForPreset('platform')).toBe('platform');
		expect(supportKindForPreset('riser-glue')).toBe('riser');
		expect(createSupportFromPreset('riser-lock', rect, 'r', 1, context).cornerClosure).toBe('lock');
		expect(createSupportFromPreset('riser-glue', rect, 'r', 1, context).cornerClosure).toBe('glue');
	});

	it('only draws a tray on the deck, since it needs a deck opening', () => {
		expect(presetDrawsOnDeck('tray')).toBe(true);
		expect(presetDrawsOnDeck('riser-glue')).toBe(false);
	});

	it('positions a tray by where it was drawn on the deck', () => {
		const tray = createSupportFromPreset('tray', rect, 't', 1, context);
		expect(tray.kind).toBe('tray');
		expect(tray.assemblyX).toBe(rect.x - design.deckX);
		expect(tray.assemblyY).toBe(rect.y - design.deckY);
		expect(tray.mount).toEqual({ anchor: 'deck-underside', offset: 0 });
	});

	it('lays a riser out where it was drawn on its own sheet', () => {
		const riser = createSupportFromPreset('riser-glue', rect, 'r', 1, {
			...context,
			activeSheetId: 'parts'
		});
		expect(riser.sheetId).toBe('parts');
		expect(riser.flatX).toBe(rect.x);
		expect(riser.flatY).toBe(rect.y);
		expect(riser.mount.anchor).toBe('box-floor');
	});
});

describe('support placement', () => {
	const support = (overrides: Partial<Support> = {}): Support => ({
		...supportDefaults(),
		kind: 'riser',
		id: 'r',
		name: 'Riser',
		w: 100,
		d: 80,
		h: 40,
		mount: { anchor: 'box-floor', offset: 0 },
		netVersion: 2,
		...overrides
	});

	it('places a net in free space clear of the deck blank', () => {
		const placed = placeSupport(support(), view(design), () => 'new-sheet');
		const bounds = riserFlatBounds(
			{ ...support(), flatX: placed.flatX, flatY: placed.flatY },
			view(design)
		);
		expect(bounds.left).toBeGreaterThanOrEqual(0);
		expect(bounds.bottom).toBeGreaterThanOrEqual(0);
		expect(bounds.right).toBeLessThanOrEqual(SHEET);
		expect(bounds.top).toBeLessThanOrEqual(SHEET);
	});

	it('proposes a new sheet when nothing has room', () => {
		// A net far larger than the stock cannot fit anywhere.
		const huge = support({ w: SHEET, d: SHEET });
		const placed = placeSupport(huge, view(design), () => 'new-sheet');
		// The new sheet is cut on the same machine as the one it was drawn from.
		expect(placed.newSheet).toEqual({
			id: 'new-sheet',
			name: 'Parts 1',
			machineProfileId: DEFAULT_MACHINE_PROFILE_ID
		});
		expect(placed.sheetId).toBe('new-sheet');
	});

	it('does not treat the support being placed as its own obstacle', () => {
		// A parts sheet carries no deck blank, so the only candidate obstacle is
		// the support itself; re-placing it must still find room.
		const existing = support({ sheetId: 'parts', flatX: 200, flatY: 200 });
		const withSelf: DesignState = {
			...design,
			sheets: [
				...design.sheets,
				{ id: 'parts', name: 'Parts 1', machineProfileId: DEFAULT_MACHINE_PROFILE_ID }
			],
			risers: [existing],
			activeSheetId: 'parts'
		};
		const placed = placeSupport(existing, view(withSelf), () => 'new-sheet');
		expect(placed.newSheet).toBeUndefined();
		expect(placed.sheetId).toBe('parts');
	});

	it('keeps a second net clear of one already on the sheet', () => {
		const first = support({ id: 'a', sheetId: 'parts', flatX: 120, flatY: 120 });
		const withFirst: DesignState = {
			...design,
			sheets: [
				...design.sheets,
				{ id: 'parts', name: 'Parts 1', machineProfileId: DEFAULT_MACHINE_PROFILE_ID }
			],
			risers: [first],
			activeSheetId: 'parts'
		};
		const second = support({ id: 'b', sheetId: 'parts' });
		const placed = placeSupport(second, view(withFirst), () => 'new-sheet');
		const a = riserFlatBounds(first, view(withFirst));
		const b = riserFlatBounds(
			{ ...second, flatX: placed.flatX, flatY: placed.flatY },
			view(withFirst)
		);
		const disjoint =
			b.right <= a.left || b.left >= a.right || b.top <= a.bottom || b.bottom >= a.top;
		expect(disjoint).toBe(true);
	});

	it('nudges a net that a resize pushed off the sheet back on', () => {
		const offSheet = support({ flatX: -80, flatY: SHEET - 10 });
		const fixed = constrainSupportFlat(offSheet, view(design));
		const bounds = riserFlatBounds({ ...offSheet, ...fixed }, view(design));
		expect(bounds.left).toBeGreaterThanOrEqual(-1e-6);
		expect(bounds.top).toBeLessThanOrEqual(SHEET + 1e-6);
	});
});
