import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { packagingData } from '$lib/features/packaging/view.js';
import { serializeDesign } from '$lib/core/export/design-file.js';
import { parseDesign } from '$lib/features/document.js';
import type { DesignState } from '$lib/core/design/types.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { validate } from '$lib/features/packaging/validation.js';
import { packagingGcode } from '$lib/features/packaging/gcode.js';
import { designSvg } from '$lib/core/export/svg.js';
import { FIXTURE_DESIGNS, foldedDesign, view } from '../../support/designs.js';

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

/**
 * Golden fixtures. These files are reviewed artifacts: a diff here means the
 * manufactured result changed. Regenerate them only with UPDATE_GOLDEN=1 and
 * only after reviewing the change on purpose.
 */
function golden(name: string, actual: string): void {
	const path = fixture(name);
	if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, actual);
	}
	expect(actual).toBe(readFileSync(path, 'utf8'));
}

/**
 * Programs are emitted per sheet, so every sheet of a fixture is golden.
 *
 * Both passes are always written, including one with no motion in it: the
 * editor downloads both files unconditionally, and a crease program that is
 * only a header is itself the assertion that this design has no up-folds.
 */
function programsFor(design: DesignState, slug: string): void {
	for (const sheet of design.sheets) {
		const sheetDesign = { ...design, activeSheetId: sheet.id };
		const paths = allGeometry(sheetDesign).paths;
		if (!paths.length) continue;
		const suffix = design.sheets.length > 1 ? `-${sheet.id}` : '';
		for (const [index, operation] of (['crease', 'cut'] as const).entries()) {
			golden(
				`expected-gcode/${slug}${suffix}-0${index + 1}-${operation}.nc`,
				packagingGcode(paths, view(sheetDesign), operation)
			);
		}
	}
}

describe('golden output', () => {
	for (const [slug, build] of FIXTURE_DESIGNS) {
		describe(slug, () => {
			const design = build();

			it('has no validation diagnostics, so it is legal to export', () => {
				expect(validate(design)).toEqual([]);
			});

			it('emits stable programs', () => {
				programsFor(design, slug);
			});

			it('emits a stable design SVG', () => {
				golden(`designs/${slug}.svg`, designSvg(allGeometry(design)));
			});
		});
	}

	it('round-trips the default fixture through the design file unchanged', () => {
		const design = foldedDesign();
		const text = serializeDesign(design, '2026-01-01T00:00:00.000Z');
		golden('designs/folded-pocket.voisee.json', text);
		expect(parseDesign(text)).toEqual(design);
	});
});

/**
 * The compatibility contract, pinned to a real saved file rather than to a
 * design built in code.
 *
 * `designs/folded-pocket.voisee.json` is a serialization golden and will change
 * shape as the document format moves on. This frozen copy must not: it is a
 * version 6 file exactly as the shipped editor wrote one, and the programs it
 * produces must stay byte-identical forever. If this test fails, a real user's
 * saved design would now cut differently.
 */
describe('a saved version 6 design', () => {
	const saved = readFileSync(fixture('designs/legacy/v6-folded-pocket.voisee.json'), 'utf8');

	it('still loads', () => {
		const design = parseDesign(saved);
		expect(packagingData(design).pockets).toHaveLength(1);
		expect(validate(design)).toEqual([]);
	});

	it('still produces the same crease and cut programs', () => {
		const design = parseDesign(saved);
		const paths = allGeometry(design).paths;
		expect(packagingGcode(paths, view(design), 'crease')).toBe(
			readFileSync(fixture('expected-gcode/folded-pocket-01-crease.nc'), 'utf8')
		);
		expect(packagingGcode(paths, view(design), 'cut')).toBe(
			readFileSync(fixture('expected-gcode/folded-pocket-02-cut.nc'), 'utf8')
		);
	});
});
