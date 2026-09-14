import { describe, expect, it } from 'vitest';
import { generateGcode } from '$lib/core/cam/gcode.js';
import { sheetView } from '$lib/core/design/machine.js';
import { serializeDesign } from '$lib/core/export/design-file.js';
import { outlineBounds } from '$lib/core/geometry/contour.js';
import { createDefaultDesign, parseDesign } from '$lib/features/document.js';
import { cutoutPoints } from '$lib/features/packaging/geometry.js';
import {
	movePocketGroup,
	pocketGroupBox,
	removePocketGroup,
	scalePocketGroup
} from '$lib/features/packaging/actions.js';
import { importSvgOpenings } from '$lib/features/packaging/import.js';
import { packagingView } from '$lib/features/packaging/view.js';
import { PACKAGING_WORKSPACE, validateDocument } from '$lib/features/workspaces.js';
import { flatPartsDesign } from '../../support/designs.js';

const svg = (body: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="300mm" height="300mm" viewBox="0 0 300 300">${body}</svg>`;

/** An irregular 120 x 80 mm product: a rounded body with a tab, a mounting hole, drawn filled and stroked. */
const PRODUCT = svg(`
	<path d="M0 20 A20 20 0 0 1 20 0 H100 L120 30 V80 H0 Z" fill="#999" stroke="#000"/>
	<circle cx="60" cy="40" r="6"/>
`);

describe('importing an SVG as deck openings', () => {
	it('makes one opening of the outer outline, centred on the deck, and skips what is inside it', () => {
		const result = importSvgOpenings(createDefaultDesign(), 'deck', PRODUCT, 'voisee-hub.svg');
		const { pockets, deckX, deckY, deckW, deckH } = packagingView(result.design);
		expect(pockets).toHaveLength(1);
		const pocket = pockets[0]!;
		expect(pocket).toMatchObject({
			name: 'voisee-hub',
			purpose: 'imported',
			shape: 'profile',
			w: 120,
			h: 80
		});
		expect(pocket.x + pocket.w / 2).toBeCloseTo(deckX + deckW / 2, 2);
		expect(pocket.y + pocket.h / 2).toBeCloseTo(deckY + deckH / 2, 2);
		expect(result.selection).toEqual({ kind: 'pocket', id: pocket.id });
		expect(result.notice).toBe(
			'Imported 1 opening from voisee-hub.svg (120 × 80 mm), centred on the deck. Skipped 1 inner outline (they fall out with the opening).'
		);
		expect(validateDocument(result.design)).toEqual([]);

		// The cut follows the drawing, not its bounding box. SVG's Y points down, so the
		// chamfer drawn at the top right stays at the top right: that corner is open.
		const outline = cutoutPoints(pocket);
		const box = outlineBounds(outline);
		expect(box.right - box.left).toBeCloseTo(120, 2);
		expect(
			outline.some((p) => Math.abs(p.x - box.right) < 0.01 && Math.abs(p.y - box.top) < 0.01)
		).toBe(false);
		expect(
			outline.some((p) => Math.abs(p.x - box.right) < 0.01 && Math.abs(p.y - box.bottom) < 0.01)
		).toBe(true);
	});

	it('cuts the opening as an interior cut in the deck program', () => {
		const { design } = importSvgOpenings(createDefaultDesign(), 'deck', PRODUCT, 'hub.svg');
		const paths = PACKAGING_WORKSPACE.geometry(design, 'deck').paths.filter(
			(path) => path.owner?.name === 'hub'
		);
		expect(paths).toHaveLength(1);
		expect(paths[0]!.cam).toMatchObject({ stage: 'interior', offsetSide: 'inside' });
		const program = generateGcode(
			PACKAGING_WORKSPACE.geometry(design, 'deck').paths,
			sheetView(design, 'deck'),
			'cut',
			PACKAGING_WORKSPACE.gcodeOptions(design, 'deck')
		);
		expect(program).toContain('hub');
	});

	it('groups several outer outlines, named after the file', () => {
		const result = importSvgOpenings(
			createDefaultDesign(),
			'deck',
			svg('<rect width="40" height="40"/><circle cx="100" cy="20" r="20"/>'),
			'kit.svg'
		);
		const { pockets, pocketGroups } = packagingView(result.design);
		expect(pockets.map((pocket) => pocket.name)).toEqual(['kit 1', 'kit 2']);
		expect(pocketGroups).toEqual([{ id: expect.any(String), name: 'kit' }]);
		expect(pockets.every((pocket) => pocket.groupId === pocketGroups[0]!.id)).toBe(true);
		expect(result.selection).toEqual({ kind: 'pocket-group', id: pocketGroups[0]!.id });
		expect(result.notice).toBe(
			'Imported 2 openings from kit.svg (120 × 40 mm) as the group kit, centred on the deck.'
		);
		expect(validateDocument(result.design)).toEqual([]);
		// One label for the whole drawing, not one per opening.
		expect(PACKAGING_WORKSPACE.labels(result.design, 'deck').map((label) => label.name)).toEqual([
			'kit'
		]);
	});

	it('moves, scales, and deletes a group of openings as one', () => {
		const { design, selection } = importSvgOpenings(
			createDefaultDesign(),
			'deck',
			svg('<rect width="40" height="40"/><circle cx="100" cy="20" r="20"/>'),
			'kit.svg'
		);
		const id = selection!.id;
		const box = pocketGroupBox(design, id)!;
		const moved = movePocketGroup(design, id, box.x + 10, box.y - 5);
		const before = packagingView(design).pockets;
		packagingView(moved).pockets.forEach((pocket, index) => {
			expect(pocket.x).toBeCloseTo(before[index]!.x + 10, 3);
			expect(pocket.y).toBeCloseTo(before[index]!.y - 5, 3);
		});

		const halved = scalePocketGroup(design, id, 0.5);
		expect(pocketGroupBox(halved, id)).toMatchObject({ x: box.x, y: box.y, w: 60, h: 20 });
		expect(packagingView(scalePocketGroup(halved, id, 2)).pockets).toEqual(before);

		expect(PACKAGING_WORKSPACE.selectionBounds(design, selection!, 'deck')).toEqual({
			left: box.x,
			right: box.x + box.w,
			bottom: box.y,
			top: box.y + box.h
		});
		const gone = removePocketGroup(design, id);
		expect(packagingView(gone).pockets).toEqual([]);
		expect(packagingView(gone).pocketGroups).toEqual([]);
		expect(PACKAGING_WORKSPACE.selectionExists(gone, selection!)).toBe(false);
	});

	it('judges imported openings by their outlines, so a kerned pair does not overlap', () => {
		// Two slanted triangles, like "AV": their boxes overlap by 5 mm, their facing
		// sides run parallel 5 mm apart.
		const kerned = svg(
			'<polygon points="0,100 40,0 50,100"/><polygon points="45,0 100,0 55,100"/>'
		);
		const pair = importSvgOpenings(createDefaultDesign(), 'deck', kerned, 'av.svg').design;
		expect(validateDocument(pair).filter((message) => message.includes('overlaps'))).toEqual([]);

		const crossing = svg(
			'<rect width="60" height="60"/><rect x="40" y="40" width="60" height="60"/>'
		);
		const crossed = importSvgOpenings(createDefaultDesign(), 'deck', crossing, 'x.svg').design;
		expect(validateDocument(crossed)).toContain('x 1 overlaps x 2');
	});

	it('reads groups back, dropping one with no openings and a dangling reference', () => {
		const { design } = importSvgOpenings(
			createDefaultDesign(),
			'deck',
			svg('<rect width="40" height="40"/><circle cx="100" cy="20" r="20"/>'),
			'kit.svg'
		);
		expect(parseDesign(serializeDesign(design))).toEqual(design);
		const raw = JSON.parse(serializeDesign(design));
		raw.design.workspaces.packaging.pocketGroups.push({ id: 'empty', name: 'Empty' });
		raw.design.workspaces.packaging.pockets[0].groupId = 'missing';
		const read = packagingView(parseDesign(JSON.stringify(raw)));
		expect(read.pocketGroups.map((group) => group.name)).toEqual(['kit']);
		expect(read.pockets.map((pocket) => pocket.groupId === null)).toEqual([true, false]);
	});

	it('imports only onto the deck sheet', () => {
		const design = flatPartsDesign();
		expect(() => importSvgOpenings(design, 'sheet', PRODUCT, 'hub.svg')).toThrow(
			'Openings are cut from the deck; switch to the Deck sheet to import them.'
		);
	});

	it('refuses a drawing with nothing closed', () => {
		expect(() =>
			importSvgOpenings(createDefaultDesign(), 'deck', svg('<line x2="10" y2="10"/>'), 'l.svg')
		).toThrow('No closed outlines to cut in l.svg: openings need closed outlines.');
	});

	it('round-trips an imported opening through a design file', () => {
		const { design } = importSvgOpenings(createDefaultDesign(), 'deck', PRODUCT, 'hub.svg');
		expect(parseDesign(serializeDesign(design))).toEqual(design);
	});
});
