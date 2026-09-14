import { describe, expect, it } from 'vitest';
import { generateGcode } from '$lib/core/cam/gcode.js';
import { sheetView } from '$lib/core/design/machine.js';
import { serializeDesign } from '$lib/core/export/design-file.js';
import { outlineBounds } from '$lib/core/geometry/contour.js';
import { createDefaultDesign, parseDesign } from '$lib/features/document.js';
import { cutoutPoints } from '$lib/features/packaging/geometry.js';
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

	it('numbers several outer outlines after the file', () => {
		const { design } = importSvgOpenings(
			createDefaultDesign(),
			'deck',
			svg('<rect width="40" height="40"/><circle cx="100" cy="20" r="20"/>'),
			'kit.svg'
		);
		expect(packagingView(design).pockets.map((pocket) => pocket.name)).toEqual(['kit 1', 'kit 2']);
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
