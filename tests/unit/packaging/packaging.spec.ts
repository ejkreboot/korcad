import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MACHINE_PROFILE_ID,
	createDefaultDesign,
	createPocket,
	supportDefaults
} from '$lib/core/design/defaults.js';
import type { DesignState, Support } from '$lib/core/design/types.js';
import { pathOperation } from '$lib/core/cam/gcode.js';
import { machiningStage, plannedToolpaths } from '$lib/core/cam/routing.js';
import { allGeometry, trayOpeningPath } from '$lib/features/packaging/model.js';
import {
	annotateFoldPaths,
	assemblyFoldDirection,
	assemblyFoldSign
} from '$lib/features/packaging/folds.js';
import { exteriorPaths, perimeterExtents } from '$lib/features/packaging/perimeter.js';
import { riserPaths, trayPaths, trayPullWidthAtMouth } from '$lib/features/packaging/supports.js';
import { validate } from '$lib/features/packaging/validation.js';
import { view, withMachine } from '../../support/designs.js';
import { annotateCamIntent } from '$lib/features/packaging/cam-intent.js';

const tray = (overrides: Partial<Support> = {}): Support => ({
	...supportDefaults(),
	kind: 'tray',
	id: 'tray',
	name: 'Tablet tray',
	w: 120,
	d: 80,
	h: 25,
	overlap: 6,
	taper: 8,
	flange: 12,
	openSide: 'none',
	sheetId: 'parts',
	flatX: 100,
	flatY: 100,
	assemblyX: 40,
	assemblyY: 50,
	mount: { anchor: 'deck-underside', offset: 0 },
	netVersion: 3,
	...overrides
});

const withTray = (overrides: Partial<Support> = {}): DesignState => ({
	...createDefaultDesign(),
	sheets: [
		{ id: 'deck', name: 'Deck', machineProfileId: DEFAULT_MACHINE_PROFILE_ID },
		{ id: 'parts', name: 'Parts 1', machineProfileId: DEFAULT_MACHINE_PROFILE_ID }
	],
	risers: [tray(overrides)]
});

describe('folds', () => {
	const design = createDefaultDesign();

	it('defaults perimeter folds down and honors a saved override', () => {
		expect(assemblyFoldSign('sheet:deck', 'perimeter-deck-fold', design)).toBe(-1);
		const flipped = {
			...design,
			foldDirections: { 'sheet:deck:perimeter-deck-fold': 'up' as const }
		};
		expect(assemblyFoldSign('sheet:deck', 'perimeter-deck-fold', flipped)).toBe(1);
	});

	it('defaults a tray wall fold up, because the wall rises out of the sheet', () => {
		expect(assemblyFoldDirection('riser:tray', 'tray-wall-fold', design)).toBe('up');
	});
});

describe('recessed tray', () => {
	const design = withTray();

	it('creates one linked deck opening and a four-walled tapered net', () => {
		const deck = allGeometry(design);
		expect(deck.paths.filter((path) => path.role === 'tray-opening')).toHaveLength(1);

		const parts = allGeometry({ ...design, activeSheetId: 'parts' });
		expect(parts.paths.filter((path) => path.role === 'tray-wall-fold')).toHaveLength(4);
		expect(parts.paths.filter((path) => path.role === 'tray-flange-fold')).toHaveLength(4);
		expect(
			parts.paths
				.filter((path) => path.role === 'tray-wall-fold')
				.every((path) => path.foldDirection === 'up')
		).toBe(true);
		expect(validate(design)).toEqual([]);
	});

	it('links the deck opening, wall recess and split flange for a finger pull', () => {
		const pulled = withTray({
			pulls: { top: false, right: false, bottom: true, left: false },
			pullDiameter: 38.1,
			pullDepth: 15
		});
		const support = pulled.risers[0]!;
		expect(trayPullWidthAtMouth(support)).toBeGreaterThan(0);

		const opening = trayOpeningPath(support, pulled);
		expect(opening.points.length).toBeGreaterThan(4);
		expect(Math.min(...opening.points.map((p) => p.y))).toBeLessThan(
			pulled.deckY + support.assemblyY
		);

		const flat = annotateFoldPaths(trayPaths(support, view(pulled)), {
			...pulled,
			activeSheetId: 'parts'
		});
		expect(flat.filter((path) => path.role === 'tray-finger-pull-bottom')).toHaveLength(1);
		// The pull splits one flange fold in two, so four folds become five.
		expect(flat.filter((path) => path.role === 'tray-flange-fold')).toHaveLength(5);
		expect(validate(pulled)).toEqual([]);
	});
});

describe('platform', () => {
	const platform: Support = {
		...supportDefaults(),
		kind: 'platform',
		id: 'step',
		name: 'Step',
		w: 100,
		d: 80,
		h: 25,
		flange: 12,
		seam: 15,
		sheetId: 'deck',
		flatX: 400,
		flatY: 400,
		assemblyX: 20,
		assemblyY: 20,
		mount: { anchor: 'deck-top', offset: 0 },
		netVersion: 2
	};

	it('keeps its glue flanges as down folds even when overridden', () => {
		const design: DesignState = {
			...createDefaultDesign(),
			risers: [platform],
			foldDirections: { 'riser:step:riser-bottom-flange-fold': 'up' }
		};
		const folds = annotateFoldPaths(riserPaths(platform, view(design)), design).filter(
			(path) => path.role === 'riser-bottom-flange-fold'
		);
		expect(folds).toHaveLength(4);
		expect(folds.every((path) => path.foldDirection === 'down')).toBe(true);
		expect(folds.every((path) => pathOperation(path) === 'cut')).toBe(true);
		expect(assemblyFoldDirection('riser:step', 'riser-bottom-flange-fold', design)).toBe('down');
	});
});

describe('edge joists', () => {
	const base = (): DesignState => ({
		...createDefaultDesign(),
		perimeterType: 'joist',
		joistAxis: 'vertical',
		joistHeight: 12.7,
		joistDepth: 6.35
	});

	it.each([1, 2, 3, 4])('derives %i full folds on two opposing edges', (folds) => {
		const design = { ...base(), joistFolds: folds };
		const geometry = allGeometry(design);
		const joistFolds = geometry.paths.filter((path) => path.role?.startsWith('joist-fold-'));
		expect(joistFolds).toHaveLength(folds * 2);
		expect(geometry.paths.filter((path) => path.role === 'joist-lock-slot')).toHaveLength(0);
		expect(
			joistFolds.every((path) => path.foldDirection === 'down' && pathOperation(path) === 'cut')
		).toBe(true);
		expect(validate(design)).toEqual([]);
	});

	it('adds centered locking returns and derived internal slots at five folds', () => {
		const design: DesignState = {
			...base(),
			joistAxis: 'horizontal',
			joistFolds: 5,
			joistLockWidth: 25.4,
			joistSlotClearance: 0.4
		};
		const geometry = allGeometry(design);
		expect(geometry.paths.filter((path) => path.role?.startsWith('joist-fold-'))).toHaveLength(10);
		expect(geometry.paths.filter((path) => path.role === 'joist-lock-slot')).toHaveLength(2);
		expect(geometry.paths.filter((path) => path.role === 'joist-lock-tab')).toHaveLength(4);

		// The slot must be cut before the tab that engages it releases the edge.
		const ordered = plannedToolpaths(geometry.paths, view(design)).paths;
		const slotStage = Math.max(
			...ordered
				.filter((entry) => entry.path.role === 'joist-lock-slot')
				.map((entry) => machiningStage(entry.path))
		);
		const tabStage = Math.min(
			...ordered
				.filter((entry) => entry.path.role === 'joist-lock-tab')
				.map((entry) => machiningStage(entry.path))
		);
		expect(slotStage).toBeLessThan(tabStage);
		expect(validate(design)).toEqual([]);
	});

	it('extends the flat blank only on the edge pair the joists run along', () => {
		const design = { ...base(), joistFolds: 4, joistHeight: 10, joistDepth: 5 };
		expect(perimeterExtents(view({ ...design, joistAxis: 'vertical' }))).toEqual({
			left: 30,
			right: 30,
			bottom: 0,
			top: 0
		});
		expect(perimeterExtents(view({ ...design, joistAxis: 'horizontal' }))).toEqual({
			left: 0,
			right: 0,
			bottom: 30,
			top: 30
		});
	});
});

describe('dependency stages', () => {
	it('cuts scores, internal slots, riser outlines, then the exterior', () => {
		const riser: Support = {
			...supportDefaults(),
			kind: 'riser',
			id: 'r',
			name: 'Riser',
			flatX: 50,
			flatY: 100,
			w: 100,
			d: 80,
			h: 30,
			seam: 12,
			flange: 10,
			bottomFlange: true,
			cornerClosure: 'lock',
			mount: { anchor: 'box-floor', offset: 0 },
			netVersion: 2
		};
		const design: DesignState = { ...createDefaultDesign(), risers: [riser] };
		const paths = annotateCamIntent(
			[...riserPaths(riser, view(design)), ...exteriorPaths(view(design)).paths],
			design
		);
		const ordered = plannedToolpaths(paths, view(design)).paths;

		expect(
			ordered.every(
				(entry, index) =>
					!index || machiningStage(ordered[index - 1]!.path) <= machiningStage(entry.path)
			)
		).toBe(true);
		expect(ordered.filter((entry) => entry.path.role === 'riser-lock-slot')).toHaveLength(4);
		expect(new Set(ordered.flatMap((entry) => entry.sourcePaths)).size).toBe(paths.length);
		expect(ordered.length).toBeLessThan(paths.length);
		expect(ordered.at(-1)?.path.role).toBe('exterior');
	});
});

describe('pockets', () => {
	it('emits a folded pocket with relief slots and one fold per wall and flange', () => {
		const design: DesignState = {
			...createDefaultDesign(),
			pockets: [
				createPocket({
					id: 'p',
					name: 'Folded pocket 1',
					x: 200,
					y: 200,
					w: 150,
					h: 120,
					flangeEnabled: true,
					sides: { top: true, right: true, bottom: true, left: true }
				})
			]
		};
		const paths = allGeometry(design).paths;
		expect(paths.filter((path) => path.role === 'central-cutout')).toHaveLength(1);
		expect(paths.filter((path) => path.role === 'top-fold')).toHaveLength(4);
		expect(paths.filter((path) => path.role === 'flange-fold')).toHaveLength(4);
		expect(paths.filter((path) => path.role === 'corner-relief')).toHaveLength(4);
		expect(validate(design)).toEqual([]);
	});

	it('emits a single through cut for a non-rectangular cutout', () => {
		const design: DesignState = {
			...createDefaultDesign(),
			pockets: [
				createPocket({ id: 'e', name: 'Lens', shape: 'ellipse', x: 200, y: 200, w: 80, h: 60 })
			]
		};
		const cutouts = allGeometry(design).paths.filter((path) => path.pocketId === 'e');
		expect(cutouts).toHaveLength(1);
		expect(cutouts[0]?.closed).toBe(true);
		expect(cutouts[0]?.role).toBe('central-cutout');
	});

	it('rejects a pocket whose walls consume the whole opening', () => {
		const design: DesignState = {
			...createDefaultDesign(),
			pockets: [
				createPocket({
					id: 'p',
					name: 'Tiny',
					x: 200,
					y: 200,
					w: 30,
					h: 30,
					sides: { top: true, right: true, bottom: true, left: true }
				})
			]
		};
		expect(validate(design)).toContain('Tiny: walls and flanges consume the entire pocket');
	});

	it('rejects overlapping pockets', () => {
		const at = (id: string, name: string, x: number) =>
			createPocket({ id, name, x, y: 200, w: 100, h: 80 });
		const design: DesignState = {
			...createDefaultDesign(),
			pockets: [at('a', 'A', 200), at('b', 'B', 250)]
		};
		expect(validate(design)).toContain('A overlaps B');
	});
});

describe('router mode', () => {
	it('cuts openings and the deck perimeter only, with no folds', () => {
		const design = withMachine(
			{
				...createDefaultDesign(),
				pockets: [createPocket({ id: 'p', name: 'Opening', x: 200, y: 200, w: 100, h: 80 })]
			},
			{ fabricationMode: 'router' }
		);
		const geometry = allGeometry(design);
		expect(geometry.paths.every((path) => path.type === 'cut')).toBe(true);
		expect(geometry.paths.filter((path) => path.role === 'router-deck-perimeter')).toHaveLength(1);
		expect(geometry.tabs).toHaveLength(0);
	});

	it('produces nothing on a non-deck sheet', () => {
		const design = withMachine(
			{ ...withTray(), activeSheetId: 'parts' },
			{
				fabricationMode: 'router'
			}
		);
		expect(allGeometry(design).paths).toEqual([]);
	});
});
