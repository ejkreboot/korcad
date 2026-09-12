import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MACHINE_PROFILE_ID,
	createDefaultDesign,
	createDefaultMachineProfile,
	supportDefaults
} from '$lib/core/design/defaults.js';
import type { DesignState, Support } from '$lib/core/design/types.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import {
	baseAnchorOf,
	canStackOn,
	resolveDrop,
	supportUnderPoint
} from '$lib/features/packaging/anchoring.js';
import {
	canSpanToDeck,
	deckSurfaceZ,
	deckUndersideZ,
	resolveSupportHeight,
	resolveSupportHeights,
	sitsInsideBox,
	supportTopZ
} from '$lib/features/packaging/levels.js';
import { view, withMachine } from '../../support/designs.js';
import { validate } from '$lib/features/packaging/validation.js';

const riser = (overrides: Partial<Support> = {}): Support => ({
	...supportDefaults(),
	kind: 'riser',
	id: 'r1',
	name: 'Riser 1',
	w: 80,
	d: 60,
	h: 30,
	heightMode: 'fixed',
	mount: { anchor: 'box-floor', offset: 0 },
	netVersion: 2,
	...overrides
});

/** A folded-perimeter deck 40mm up on 2mm board: cavity 40, top face 42. */
const design = (overrides: Partial<DesignState> = {}): DesignState => ({
	...createDefaultDesign(),
	perimeterType: 'folded',
	perimeterWall: 40,
	material: 2,
	snapEnabled: false,
	...overrides
});

describe('spanning heights', () => {
	it('fills the cavity from the box floor up to the deck underside', () => {
		const spanning = riser({ heightMode: 'span', h: 999 });
		const base = design({ risers: [spanning] });
		expect(deckUndersideZ(view(base))).toBe(40);
		expect(deckSurfaceZ(view(base))).toBe(42);
		expect(resolveSupportHeight(spanning, view(base))).toBe(40);
	});

	it('follows the wall height, which is the point of spanning', () => {
		const spanning = riser({ heightMode: 'span' });
		const tall = design({ risers: [spanning], perimeterWall: 55 });
		expect(resolveSupportHeight(spanning, view(tall))).toBe(55);
	});

	it('follows the joist height when the perimeter is a joist', () => {
		const spanning = riser({ heightMode: 'span' });
		const joist = design({ risers: [spanning], perimeterType: 'joist', joistHeight: 22 });
		expect(resolveSupportHeight(spanning, view(joist))).toBe(22);
	});

	it('spans only the gap left above its mount offset', () => {
		const spanning = riser({ heightMode: 'span', mount: { anchor: 'box-floor', offset: 15 } });
		expect(resolveSupportHeight(spanning, view(design({ risers: [spanning] })))).toBe(25);
	});

	it('spans the remaining gap when stacked on another support', () => {
		const lower = riser({ id: 'lower', h: 12 });
		const upper = riser({
			id: 'upper',
			heightMode: 'span',
			mount: { anchor: 'support-top', supportId: 'lower', offset: 0 }
		});
		const stacked = design({ risers: [lower, upper] });
		expect(resolveSupportHeight(upper, view(stacked))).toBe(28);
		// The stack still reaches the deck exactly.
		expect(supportTopZ(upper, view(stacked))).toBe(40);
	});

	it('leaves a fixed height alone', () => {
		const fixed = riser({ h: 17 });
		expect(resolveSupportHeight(fixed, view(design({ risers: [fixed] })))).toBe(17);
	});

	it('clamps to zero rather than going negative above the deck', () => {
		const impossible = riser({ heightMode: 'span', mount: { anchor: 'deck-top', offset: 0 } });
		expect(resolveSupportHeight(impossible, view(design({ risers: [impossible] })))).toBe(0);
	});

	it('offers a span only from a surface that has the deck above it', () => {
		const from = (mount: Support['mount'], extra: Support[] = []) => {
			const support = riser({ mount });
			return canSpanToDeck(support, view(design({ risers: [support, ...extra] })));
		};
		expect(from({ anchor: 'box-floor', offset: 0 })).toBe(true);
		expect(from({ anchor: 'deck-top', offset: 0 })).toBe(false);
		expect(from({ anchor: 'deck-underside', offset: 0 })).toBe(false);
		// An anchor pushed up to the deck itself has nothing left to fill.
		expect(from({ anchor: 'box-floor', offset: 40 })).toBe(false);
	});

	it('judges a stack by where its host actually sits, not by the kind of anchor', () => {
		const inside = riser({ id: 'inside', h: 10 });
		const onDeck = riser({ id: 'on-deck', h: 10, mount: { anchor: 'deck-top', offset: 0 } });
		const stackedOn = (hostId: string) =>
			riser({ id: 'stacked', mount: { anchor: 'support-top', supportId: hostId, offset: 0 } });
		expect(
			canSpanToDeck(
				stackedOn('inside'),
				view(design({ risers: [inside, onDeck, stackedOn('inside')] }))
			)
		).toBe(true);
		// Standing on a step that is on top of the deck leaves no gap above.
		expect(
			canSpanToDeck(
				stackedOn('on-deck'),
				view(design({ risers: [inside, onDeck, stackedOn('on-deck')] }))
			)
		).toBe(false);
	});
});

describe('resolveSupportHeights', () => {
	it('writes the derived height back into the document', () => {
		const spanning = riser({ heightMode: 'span', h: 1 });
		const resolved = resolveSupportHeights(design({ risers: [spanning] }));
		expect(resolved.risers[0]?.h).toBe(40);
	});

	it('returns the same design when nothing spans, so history stays cheap', () => {
		const base = design({ risers: [riser()] });
		expect(resolveSupportHeights(base)).toBe(base);
	});

	it('resolves a stack in one pass, whatever order it is stored in', () => {
		const lower = riser({ id: 'lower', heightMode: 'span', h: 0 });
		const upper = riser({
			id: 'upper',
			heightMode: 'span',
			h: 0,
			mount: { anchor: 'support-top', supportId: 'lower', offset: 0 }
		});
		// Child stored before its parent.
		const resolved = resolveSupportHeights(design({ risers: [upper, lower] }));
		expect(resolved.risers.find((r) => r.id === 'lower')?.h).toBe(40);
		// The lower riser already fills the cavity, so nothing is left to span.
		expect(resolved.risers.find((r) => r.id === 'upper')?.h).toBe(0);
	});

	it('does not mutate the design it is given', () => {
		const base = design({ risers: [riser({ heightMode: 'span', h: 1 })] });
		const snapshot = JSON.stringify(base);
		resolveSupportHeights(base);
		expect(JSON.stringify(base)).toBe(snapshot);
	});
});

describe('what is inside the box', () => {
	it('counts floor and deck-underside mounts as inside', () => {
		const floor = riser();
		const hanging = riser({ mount: { anchor: 'deck-underside', offset: 0 } });
		expect(sitsInsideBox(floor, [floor])).toBe(true);
		expect(sitsInsideBox(hanging, [hanging])).toBe(true);
	});

	it('counts a step on the deck as outside', () => {
		const step = riser({ mount: { anchor: 'deck-top', offset: 0 } });
		expect(sitsInsideBox(step, [step])).toBe(false);
	});

	it('follows a stack to the base it stands on', () => {
		const onDeck = riser({ id: 'base', mount: { anchor: 'deck-top', offset: 0 } });
		const stacked = riser({
			id: 'stacked',
			mount: { anchor: 'support-top', supportId: 'base', offset: 0 }
		});
		expect(sitsInsideBox(stacked, [onDeck, stacked])).toBe(false);
	});
});

describe('dropping a support', () => {
	const lower = riser({ id: 'lower', w: 120, d: 100, h: 20, assemblyX: 40, assemblyY: 30 });

	it('stacks on the support it lands on top of', () => {
		const dragged = riser({ id: 'top', w: 40, d: 30 });
		const base = design({ risers: [lower, dragged] });
		// Centre of the dragged part lands inside the lower riser's footprint.
		const drop = resolveDrop(dragged, 80, 60, view(base));
		expect(drop.mount).toEqual({ anchor: 'support-top', supportId: 'lower', offset: 0 });
		// Position becomes relative to the host it landed on.
		expect(drop.assemblyX).toBe(40);
		expect(drop.assemblyY).toBe(30);
	});

	it('keeps its base anchor when it lands on nothing', () => {
		const dragged = riser({ id: 'top', w: 40, d: 30 });
		const drop = resolveDrop(dragged, 5, 5, view(design({ risers: [lower, dragged] })));
		expect(drop.mount).toEqual({ anchor: 'box-floor', offset: 0 });
		expect(drop.assemblyX).toBe(5);
	});

	it('falls back to the base its stack stood on when dragged clear', () => {
		const onDeck = riser({ id: 'host', mount: { anchor: 'deck-top', offset: 0 } });
		const stacked = riser({
			id: 'stacked',
			w: 20,
			d: 20,
			mount: { anchor: 'support-top', supportId: 'host', offset: 0 }
		});
		const base = design({ risers: [onDeck, stacked] });
		// Dragged well clear of the host it was standing on.
		const drop = resolveDrop(stacked, 300, 300, view(base));
		expect(drop.mount).toEqual({ anchor: 'deck-top', offset: 0 });
	});

	it('clamps the placement to the surface it landed on', () => {
		const dragged = riser({ id: 'top', w: 40, d: 30 });
		const base = design({ risers: [lower, dragged] });
		// Still centred over the lower riser, but overhanging its far corner:
		// the host spans x 40..160 and y 30..130.
		const drop = resolveDrop(dragged, 135, 115, view(base));
		expect(drop.mount).toEqual({ anchor: 'support-top', supportId: 'lower', offset: 0 });
		expect(drop.assemblyX).toBe(lower.w - dragged.w);
		expect(drop.assemblyY).toBe(lower.d - dragged.d);
	});

	it('never stacks a tray, which is a hole rather than a surface', () => {
		const tray = riser({
			id: 'tray',
			kind: 'tray',
			mount: { anchor: 'deck-underside', offset: 0 }
		});
		const base = design({ risers: [lower, tray] });
		const drop = resolveDrop(tray, 80, 60, view(base));
		expect(drop.mount).toEqual({ anchor: 'deck-underside', offset: 0 });
	});

	it('refuses a stack that would make a cycle', () => {
		const parent = riser({ id: 'parent' });
		const child = riser({
			id: 'child',
			mount: { anchor: 'support-top', supportId: 'parent', offset: 0 }
		});
		const supports = [parent, child];
		expect(canStackOn(parent, child, supports)).toBe(false);
		expect(canStackOn(child, parent, supports)).toBe(true);
		// Nothing may stand on itself.
		expect(canStackOn(parent, parent, supports)).toBe(false);
	});

	it('drops onto the highest surface when stacks overlap', () => {
		const tall = riser({ id: 'tall', w: 120, d: 100, h: 25, assemblyX: 40, assemblyY: 30 });
		const dragged = riser({ id: 'top', w: 20, d: 20 });
		const host = supportUnderPoint(
			dragged,
			80,
			60,
			view(design({ risers: [lower, tall, dragged] }))
		);
		expect(host?.id).toBe('tall');
	});

	it('turns a span into a fixed height when it lands where it cannot span', () => {
		const spanning = riser({ id: 'step', w: 20, d: 20, heightMode: 'span', h: 40 });
		const onDeck = riser({
			id: 'host',
			w: 120,
			d: 100,
			assemblyX: 40,
			assemblyY: 30,
			mount: { anchor: 'deck-top', offset: 0 }
		});
		const base = design({ risers: [onDeck, spanning] });
		// Dropped onto a step standing on the deck: nothing above it to reach, so
		// the derived height becomes the height it was already showing.
		const drop = resolveDrop(spanning, 90, 70, view(base));
		expect(drop.mount).toEqual({ anchor: 'support-top', supportId: 'host', offset: 0 });
		expect(drop.heightMode).toBe('fixed');
	});

	it('keeps a span when it lands on a support inside the box', () => {
		const spanning = riser({ id: 'step', w: 20, d: 20, heightMode: 'span', h: 40 });
		const inside = riser({ id: 'host', w: 120, d: 100, h: 10, assemblyX: 40, assemblyY: 30 });
		const base = design({ risers: [inside, spanning] });
		expect(resolveDrop(spanning, 90, 70, view(base)).heightMode).toBe('span');
	});

	it('reports the base a stack ultimately stands on', () => {
		const floor = riser({ id: 'a' });
		const middle = riser({ id: 'b', mount: { anchor: 'support-top', supportId: 'a', offset: 0 } });
		const top = riser({ id: 'c', mount: { anchor: 'support-top', supportId: 'b', offset: 0 } });
		expect(baseAnchorOf(top, [floor, middle, top])).toBe('box-floor');
	});

	it('does not loop forever on a mount cycle when finding the base', () => {
		const a = riser({ id: 'a', mount: { anchor: 'support-top', supportId: 'b', offset: 0 } });
		const b = riser({ id: 'b', mount: { anchor: 'support-top', supportId: 'a', offset: 0 } });
		expect(baseAnchorOf(a, [a, b])).toBe('box-floor');
	});
});

describe('vertical validation', () => {
	const withRisers = (...risers: Support[]) =>
		validate(
			design({
				risers,
				sheets: [{ id: 'deck', name: 'Deck', machineProfileId: DEFAULT_MACHINE_PROFILE_ID }]
			})
		);

	it('accepts a spanning riser, which meets the deck by construction', () => {
		const spanning = riser({ heightMode: 'span', h: 40, flatX: 500, flatY: 500 });
		expect(withRisers(spanning)).not.toContain(
			'Riser 1: spanning height leaves no room below the top deck'
		);
	});

	it('rejects a spanning height with no room left under the deck', () => {
		const squeezed = riser({
			heightMode: 'span',
			h: 0,
			flatX: 500,
			flatY: 500,
			mount: { anchor: 'box-floor', offset: 40 }
		});
		expect(withRisers(squeezed)).toContain(
			'Riser 1: spanning height leaves no room below the top deck'
		);
	});

	it('rejects a span measured from a surface with no deck above it', () => {
		const wrongWay = riser({
			heightMode: 'span',
			flatX: 500,
			flatY: 500,
			mount: { anchor: 'deck-top', offset: 0 }
		});
		expect(withRisers(wrongWay)).toContain(
			'Riser 1: spanning height leaves no room below the top deck'
		);
	});

	it('rejects a fixed height taller than the space under the deck', () => {
		const tooTall = riser({ h: 60, flatX: 500, flatY: 500 });
		expect(withRisers(tooTall)).toContain(
			'Riser 1: stands taller than the space under the top deck'
		);
	});

	it('allows assembly slop rather than flagging a fraction of a millimetre', () => {
		const barely = riser({ h: 40.3, flatX: 500, flatY: 500 });
		expect(withRisers(barely)).not.toContain(
			'Riser 1: stands taller than the space under the top deck'
		);
	});

	it('does not measure a step on the deck against the deck', () => {
		const step = riser({
			h: 60,
			flatX: 500,
			flatY: 500,
			mount: { anchor: 'deck-top', offset: 0 }
		});
		expect(withRisers(step)).not.toContain(
			'Riser 1: stands taller than the space under the top deck'
		);
	});

	it('reports a stack that together overshoots the deck', () => {
		const lower = riser({ id: 'lower', name: 'Lower', h: 30, flatX: 500, flatY: 500 });
		const upper = riser({
			id: 'upper',
			name: 'Upper',
			h: 30,
			flatX: 600,
			flatY: 600,
			mount: { anchor: 'support-top', supportId: 'lower', offset: 0 }
		});
		expect(withRisers(lower, upper)).toContain(
			'Upper: stands taller than the space under the top deck'
		);
	});
});

describe('machine profiles across a packaging job', () => {
	const twoSheets = (): DesignState => ({
		...design(),
		machineProfiles: [
			createDefaultMachineProfile('knife', 'Drag knife'),
			{ ...createDefaultMachineProfile('router', 'Router'), fabricationMode: 'router' }
		],
		sheets: [
			{ id: 'deck', name: 'Deck', machineProfileId: 'knife' },
			{ id: 'parts', name: 'Parts 1', machineProfileId: 'knife' }
		],
		risers: [riser({ id: 'r1', sheetId: 'parts', flatX: 300, flatY: 300 })]
	});

	it('accepts a job whose sheets share a fabrication mode', () => {
		expect(validate(twoSheets())).not.toContain(
			'Sheets of one insert must all be cut with the same fabrication mode'
		);
	});

	it('rejects a deck creased on a knife and a net released on a router', () => {
		// The two halves would not assemble, and neither sheet reveals it alone.
		const mixed = twoSheets();
		expect(
			validate({
				...mixed,
				sheets: mixed.sheets.map((sheet) =>
					sheet.id === 'parts' ? { ...sheet, machineProfileId: 'router' } : sheet
				)
			})
		).toContain('Sheets of one insert must all be cut with the same fabrication mode');
	});

	it('ignores an empty sheet, which carries no parts to disagree about', () => {
		const mixed = twoSheets();
		expect(
			validate({
				...mixed,
				sheets: [...mixed.sheets, { id: 'spare', name: 'Spare', machineProfileId: 'router' }]
			})
		).not.toContain('Sheets of one insert must all be cut with the same fabrication mode');
	});

	it('cuts each sheet on its own machine, so geometry follows the profile', () => {
		const routed = withMachine(design({ risers: [] }), { fabricationMode: 'router' });
		// A router never folds, so it emits no score paths.
		expect(allGeometry(routed).paths.some((path) => path.type === 'score')).toBe(false);
		expect(allGeometry(design({ risers: [] })).paths.some((path) => path.type === 'score')).toBe(
			true
		);
	});
});
