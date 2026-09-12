import { describe, expect, it } from 'vitest';
import { createDefaultDesign, createPocket, supportDefaults } from '$lib/core/design/defaults.js';
import type { Assembly, AssemblyPart } from '$lib/core/assembly/model.js';
import { hingedFlangeVertices } from '$lib/core/assembly/model.js';
import type { DesignState, Support } from '$lib/core/design/types.js';
import { view, withMachine } from '../../support/designs.js';
import {
	buildAssembly,
	joistAssemblyParts,
	supportFlangeDescriptors,
	trayAssemblyProfile
} from '$lib/features/packaging/assembly.js';
import {
	deckSurfaceZ,
	raisedDeckHeight,
	supportMountPlane,
	supportTopZ
} from '$lib/features/packaging/levels.js';

const riser = (overrides: Partial<Support> = {}): Support => ({
	...supportDefaults(),
	kind: 'riser',
	id: 'riser-1',
	name: 'Riser',
	w: 80,
	d: 60,
	h: 30,
	heightMode: 'fixed',
	mount: { anchor: 'deck-top', offset: 0 },
	netVersion: 3,
	...overrides
});

const design = (overrides: Partial<DesignState> = {}): DesignState => ({
	...createDefaultDesign(),
	...overrides
});

const parts = (assembly: Assembly, groupId: string): readonly AssemblyPart[] =>
	assembly.groups.find((group) => group.id === groupId)?.parts ?? [];

const boxes = (list: readonly AssemblyPart[]) => list.filter((part) => part.form === 'box');

describe('deck height', () => {
	it('stands the deck on the perimeter wall when the perimeter is folded', () => {
		const folded = design({ perimeterType: 'folded', perimeterWall: 40, material: 2 });
		expect(raisedDeckHeight(view(folded))).toBe(40);
		expect(deckSurfaceZ(view(folded))).toBe(42);
	});

	it('stands the deck on the joist height when the perimeter is a joist', () => {
		expect(raisedDeckHeight(view(design({ perimeterType: 'joist', joistHeight: 22 })))).toBe(22);
	});

	it('uses a nominal height for plain and routed work, which has no perimeter', () => {
		expect(raisedDeckHeight(view(design({ perimeterType: 'plain' })))).toBe(8);
		expect(
			raisedDeckHeight(
				view(withMachine(design({ perimeterType: 'folded' }), { fabricationMode: 'router' }))
			)
		).toBe(8);
	});
});

describe('mount planes', () => {
	const base = design({ perimeterType: 'folded', perimeterWall: 40, material: 2 });

	it('mounts a deck-top support on the deck surface', () => {
		expect(supportMountPlane(riser(), view(base))).toBe(42);
	});

	it('mounts a deck-underside support on the deck underside, offset downward', () => {
		const hanging = riser({ mount: { anchor: 'deck-underside', offset: 5 } });
		expect(supportMountPlane(hanging, view(base))).toBe(40 - 5);
	});

	it('mounts a box-floor support at its own offset', () => {
		const floor = riser({ mount: { anchor: 'box-floor', offset: 3 } });
		expect(supportMountPlane(floor, view(base))).toBe(3);
	});

	it('stacks a support on top of its parent', () => {
		const parent = riser({ id: 'parent', h: 20 });
		const child = riser({
			id: 'child',
			mount: { anchor: 'support-top', supportId: 'parent', offset: 1 }
		});
		const stacked = { ...base, risers: [parent, child] };
		expect(supportTopZ(parent, view(stacked))).toBe(62);
		expect(supportMountPlane(child, view(stacked))).toBe(63);
	});

	it('does not recurse forever on a mount cycle in a saved file', () => {
		const a = riser({ id: 'a', mount: { anchor: 'support-top', supportId: 'b', offset: 0 } });
		const b = riser({ id: 'b', mount: { anchor: 'support-top', supportId: 'a', offset: 0 } });
		expect(Number.isFinite(supportMountPlane(a, view({ ...base, risers: [a, b] })))).toBe(true);
	});

	it('reads a tray mount plane as its mouth, not its floor', () => {
		const tray = riser({ kind: 'tray', h: 25 });
		const withTray = { ...base, risers: [tray] };
		expect(supportTopZ(tray, view(withTray))).toBe(supportMountPlane(tray, view(withTray)));
	});
});

describe('tray profile', () => {
	const tray = riser({
		kind: 'tray',
		h: 25,
		overlap: 6,
		taper: 8,
		mount: { anchor: 'deck-underside', offset: 0 }
	});
	const base = design({
		perimeterType: 'folded',
		perimeterWall: 40,
		material: 2,
		risers: [tray]
	});

	it('widens the mouth by the overlap and draws the floor in by the taper', () => {
		const profile = trayAssemblyProfile(tray, view(base));
		expect(profile.mouth).toEqual({ left: -6, right: 86, bottom: -6, top: 66 });
		expect(profile.bottom).toEqual({ left: 2, right: 78, bottom: 2, top: 58 });
	});

	it('hangs the floor below the mouth by the tray height', () => {
		const profile = trayAssemblyProfile(tray, view(base));
		// A tray mounted under the deck drops its floor away from the mouth.
		expect(profile.topZ - profile.bottomZ).toBe(25);
	});
});

describe('support flanges', () => {
	it('folds a platform flange inward so it can be glued without widening it', () => {
		const platform = riser({ kind: 'platform', flange: 10 });
		const flanges = supportFlangeDescriptors(platform, view(design({ risers: [platform] })));
		const bottom = flanges.find((flange) => flange.side === 'bottom');
		expect(bottom?.extension).toEqual({ x: 0, y: 10 });
	});

	it('folds a riser flange outward by default', () => {
		const support = riser({ flange: 10 });
		const flanges = supportFlangeDescriptors(support, view(design({ risers: [support] })));
		expect(flanges.find((flange) => flange.side === 'bottom')?.extension).toEqual({
			x: 0,
			y: -10
		});
	});

	it('describes one flange per side', () => {
		const support = riser({ flange: 10 });
		expect(
			supportFlangeDescriptors(support, view(design({ risers: [support] }))).map((f) => f.side)
		).toEqual(['bottom', 'top', 'left', 'right']);
	});
});

describe('hinged flange vertices', () => {
	it('extends from the hinge and insets the free edge by the chamfer', () => {
		const vertices = hingedFlangeVertices({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 10 }, 5, 3);
		expect(vertices).toEqual([
			{ x: 0, y: 0, z: 3 },
			{ x: 100, y: 0, z: 3 },
			{ x: 95, y: 10, z: 3 },
			{ x: 5, y: 10, z: 3 }
		]);
	});

	it('never insets past the middle of a short hinge', () => {
		const vertices = hingedFlangeVertices({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, 40, 0);
		expect(vertices[2]?.x).toBe(5);
		expect(vertices[3]?.x).toBe(5);
	});
});

describe('joist parts', () => {
	const joist = design({
		perimeterType: 'joist',
		joistAxis: 'vertical',
		joistFolds: 5,
		joistHeight: 20,
		joistDepth: 12,
		joistLockWidth: 60
	});

	it('rolls a joist edge on the two sides that carry it', () => {
		const sides = new Set(joistAssemblyParts(view(joist)).map((part) => part.side));
		expect([...sides].sort()).toEqual(['left', 'right']);
	});

	it('emits one block per fold, up to the locking return', () => {
		const left = joistAssemblyParts(view(joist)).filter((part) => part.side === 'left');
		expect(left.map((part) => part.kind)).toEqual([
			'outer-wall',
			'bottom',
			'inner-wall',
			'closing-panel',
			'locking-return'
		]);
	});

	it('stops emitting blocks at the configured fold count', () => {
		const two = joistAssemblyParts(view({ ...joist, joistFolds: 2 }));
		expect(two.filter((part) => part.side === 'left').map((part) => part.kind)).toEqual([
			'outer-wall',
			'bottom'
		]);
	});

	it('emits nothing for a routed design, which is cut rather than folded', () => {
		expect(joistAssemblyParts(view(withMachine(joist, { fabricationMode: 'router' })))).toEqual([]);
	});
});

describe('buildAssembly', () => {
	it('always emits one deck panel, extruded to the material thickness', () => {
		const assembly = buildAssembly(design({ material: 2.5 }));
		const deck = parts(assembly, 'deck').filter((part) => part.form === 'deck');
		expect(deck).toHaveLength(1);
		expect(deck[0]).toMatchObject({ thickness: 2.5, deckPart: true, material: 'deck' });
	});

	it('punches every pocket through the deck, in deck-local coordinates', () => {
		const pocket = createPocket({ id: 'p1', name: 'Pocket', x: 60, y: 70, w: 40, h: 30 });
		const assembly = buildAssembly(design({ deckX: 50, deckY: 50, pockets: [pocket] }));
		const deck = parts(assembly, 'deck').find((part) => part.form === 'deck');
		expect(deck?.form === 'deck' && deck.holes).toHaveLength(1);
		const hole = deck?.form === 'deck' ? (deck.holes[0] ?? []) : [];
		// The pocket sits 10mm inside the deck origin on both axes.
		expect(Math.min(...hole.map((p) => p.x))).toBeCloseTo(10, 6);
		expect(Math.min(...hole.map((p) => p.y))).toBeCloseTo(20, 6);
	});

	it('punches a tray opening through the deck', () => {
		const tray = riser({ kind: 'tray', assemblyX: 30, assemblyY: 20 });
		const assembly = buildAssembly(design({ risers: [tray] }));
		const deck = parts(assembly, 'deck').find((part) => part.form === 'deck');
		expect(deck?.form === 'deck' && deck.holes).toHaveLength(1);
	});

	it('folds a wall and a flange out of each enabled pocket side', () => {
		const pocket = createPocket({
			id: 'p1',
			name: 'Pocket',
			x: 60,
			y: 60,
			w: 60,
			h: 60,
			flange: 8,
			flangeEnabled: true,
			sides: { top: true, right: false, bottom: true, left: false }
		});
		const deckParts = parts(buildAssembly(design({ pockets: [pocket] })), 'deck');
		expect(
			deckParts.filter((part) => part.form === 'wall' && part.material === 'pocket')
		).toHaveLength(2);
		expect(
			deckParts.filter((part) => part.form === 'panel' && part.material === 'pocket')
		).toHaveLength(2);
	});

	it('omits pocket walls in router mode, where openings are cut not folded', () => {
		const pocket = createPocket({
			id: 'p1',
			name: 'Pocket',
			x: 60,
			y: 60,
			w: 60,
			h: 60,
			sides: { top: true, right: true, bottom: true, left: true }
		});
		const routed = buildAssembly(
			withMachine(design({ pockets: [pocket] }), { fabricationMode: 'router' })
		);
		expect(parts(routed, 'deck').filter((part) => part.form === 'wall')).toEqual([]);
	});

	it('marks every part of the deck piece as deck geometry, and no support part', () => {
		const support = riser();
		const assembly = buildAssembly(design({ perimeterType: 'folded', risers: [support] }));
		expect(parts(assembly, 'deck').every((part) => part.deckPart)).toBe(true);
		expect(parts(assembly, 'riser:riser-1').some((part) => part.deckPart)).toBe(false);
	});

	it('gives a support its own draggable group at its assembly origin', () => {
		const support = riser({ assemblyX: 40, assemblyY: 25 });
		const group = buildAssembly(design({ risers: [support] })).groups.find(
			(candidate) => candidate.supportId === 'riser-1'
		);
		expect(group?.origin).toEqual({ x: 40, y: 25 });
		expect(group?.id).toBe('riser:riser-1');
	});

	it('accumulates a stacked support origin through its parent', () => {
		const parent = riser({ id: 'parent', assemblyX: 40, assemblyY: 25 });
		const child = riser({
			id: 'child',
			assemblyX: 5,
			assemblyY: 5,
			mount: { anchor: 'support-top', supportId: 'parent', offset: 0 }
		});
		const groups = buildAssembly(design({ risers: [parent, child] })).groups;
		expect(groups.find((group) => group.supportId === 'child')?.origin).toEqual({ x: 45, y: 30 });
	});

	it('marks the selected support so the viewer can highlight it', () => {
		const support = riser();
		const assembly = buildAssembly(design({ risers: [support], selectedRiserId: 'riser-1' }));
		expect(assembly.groups.find((group) => group.supportId === 'riser-1')?.selected).toBe(true);
	});

	it('closes a riser with four walls, a top panel, and four corner tabs', () => {
		const support = riser({ bottomFlange: false });
		const group = parts(buildAssembly(design({ risers: [support] })), 'riser:riser-1');
		expect(boxes(group)).toHaveLength(5);
		expect(group.filter((part) => part.form === 'panel')).toHaveLength(4);
		expect(group.filter((part) => part.form === 'footprint')).toHaveLength(1);
	});

	it('adds a bottom flange panel per side when the riser has one', () => {
		const support = riser({ bottomFlange: true, flange: 10 });
		const group = parts(buildAssembly(design({ risers: [support] })), 'riser:riser-1');
		// Four corner tabs plus four flanges.
		expect(group.filter((part) => part.form === 'panel')).toHaveLength(8);
	});

	it('leaves the open side of a tray without a wall', () => {
		const tray = riser({ kind: 'tray', openSide: 'left', flange: 0 });
		const group = parts(buildAssembly(design({ risers: [tray] })), 'riser:riser-1');
		expect(group.filter((part) => part.form === 'wall')).toHaveLength(3);
	});

	it('splits a tray flange around a finger pull', () => {
		const tray = riser({
			kind: 'tray',
			flange: 10,
			openSide: 'none',
			pullDiameter: 30,
			overlap: 6,
			pulls: { top: false, right: false, bottom: true, left: false }
		});
		const group = parts(buildAssembly(design({ risers: [tray] })), 'riser:riser-1');
		// Three plain flanges, plus two segments either side of the pull.
		expect(group.filter((part) => part.form === 'panel')).toHaveLength(5);
	});

	it('notches the tray wall that carries a finger pull', () => {
		const tray = riser({
			kind: 'tray',
			openSide: 'none',
			pullDiameter: 30,
			overlap: 6,
			pulls: { top: false, right: false, bottom: true, left: false }
		});
		const walls = parts(buildAssembly(design({ risers: [tray] })), 'riser:riser-1').filter(
			(part) => part.form === 'wall'
		);
		expect(walls.filter((part) => part.form === 'wall' && part.notch)).toHaveLength(1);
	});

	it('reports the deck planes and finish the viewer needs', () => {
		const assembly = buildAssembly(
			design({ perimeterType: 'folded', perimeterWall: 40, material: 2, boardFinish: 'kraft' })
		);
		expect(assembly.deckZ).toBe(40);
		expect(assembly.deckSurfaceZ).toBe(42);
		expect(assembly.finish).toBe('kraft');
	});

	it('does not mutate the design it describes', () => {
		const support = riser({ assemblyX: 10 });
		const source = design({ risers: [support], pockets: [] });
		const snapshot = JSON.stringify(source);
		buildAssembly(source);
		expect(JSON.stringify(source)).toBe(snapshot);
	});
});
