import { describe, expect, it } from 'vitest';
import { serializeMaterialPreset } from '$lib/core/design/material.js';
import {
	applyMaterialPreset,
	createDefaultDesign,
	materialPreset,
	readMaterialFile
} from '$lib/features/document.js';
import { foldedDesign } from '../../support/designs.js';

describe("a design's material preset", () => {
	it("holds packaging's fold allowance only when the design has packaging", () => {
		const packaging = materialPreset(foldedDesign(), null);
		expect(Object.keys(packaging.workspaces)).toEqual(['packaging']);
		expect(Object.keys(packaging.workspaces.packaging ?? {}).sort()).toEqual([
			'foldCompensation',
			'foldDeduction',
			'foldKFactor',
			'foldRadiusFactor'
		]);
		expect(materialPreset(createDefaultDesign('flatParts'), null).workspaces).toEqual({});
	});

	it('keeps the sections of the file it came from that the design has no use for', () => {
		const fromPackaging = materialPreset(foldedDesign(), null);
		const flat = materialPreset(createDefaultDesign('flatParts'), fromPackaging);
		expect(flat.workspaces).toEqual(fromPackaging.workspaces);
	});

	it('reads back through every workspace, and refuses a workspace this build lacks', () => {
		const preset = materialPreset(foldedDesign(), null);
		expect(readMaterialFile(serializeMaterialPreset(preset))).toEqual(preset);
		const file = JSON.parse(serializeMaterialPreset(preset)) as Record<string, unknown>;
		expect(() =>
			readMaterialFile(JSON.stringify({ ...file, workspaces: { laser: { power: 1 } } }))
		).toThrow(/no laser material settings/);
		expect(() =>
			readMaterialFile(
				JSON.stringify({ ...file, workspaces: { packaging: { foldCompensation: 'guess' } } })
			)
		).toThrow(/foldCompensation/);
	});

	it('cuts a design from the preset, leaving its units and everything else alone', () => {
		const design = foldedDesign();
		const source = materialPreset(design, null);
		const preset = {
			stock: { ...source.stock, material: 3, grainDirection: 'x' as const },
			workspaces: {
				packaging: {
					foldCompensation: 'manual',
					foldRadiusFactor: 1,
					foldKFactor: 0.4,
					foldDeduction: 2.5
				}
			}
		};
		const inches = { ...design, stock: { ...design.stock, units: 'in' as const } };
		const next = applyMaterialPreset(inches, preset);
		expect(next.stock).toEqual({ ...inches.stock, material: 3, grainDirection: 'x' });
		expect(next.workspaces.packaging).toEqual({
			...design.workspaces.packaging,
			...preset.workspaces.packaging
		});
		expect(materialPreset(next, null)).toEqual(preset);
	});

	it('gives a design without packaging no packaging data', () => {
		const flat = createDefaultDesign('flatParts');
		const next = applyMaterialPreset(flat, materialPreset(foldedDesign(), null));
		expect(next.workspaces).toEqual(flat.workspaces);
	});
});
