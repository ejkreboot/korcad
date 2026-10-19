import { describe, expect, it } from 'vitest';
import { createDefaultStock } from '$lib/core/design/defaults.js';
import {
	MATERIAL_FORMAT,
	MATERIAL_VERSION,
	materialSettings,
	sameMaterialPreset,
	serializeMaterialPreset,
	unwrapMaterialFile,
	withMaterialSettings,
	type MaterialPreset
} from '$lib/core/design/material.js';

const preset = (): MaterialPreset => ({
	stock: {
		material: 6.35,
		boardFinish: 'white',
		grainDirection: 'x',
		minimumWeb: 4,
		tabWidth: 5,
		tabHeight: 1.5
	},
	workspaces: { packaging: { foldCompensation: 'manual', foldDeduction: 1.2 } }
});

describe('material presets', () => {
	it('carry the board, not the display units or the stock-wide tab count', () => {
		const stock = { ...createDefaultStock(), units: 'mm' as const, tabCount: 7 };
		const settings = materialSettings(stock);
		expect(settings).not.toHaveProperty('units');
		expect(settings).not.toHaveProperty('tabCount');
		const inches = { ...createDefaultStock(), units: 'in' as const, tabCount: 3 };
		expect(withMaterialSettings(inches, settings)).toEqual({ ...stock, units: 'in', tabCount: 3 });
	});

	it('read back what they wrote, in an envelope like a design file', () => {
		const text = serializeMaterialPreset(preset(), '2026-01-01T00:00:00.000Z');
		const file = JSON.parse(text) as Record<string, unknown>;
		expect(file.format).toBe(MATERIAL_FORMAT);
		expect(file.version).toBe(MATERIAL_VERSION);
		expect(unwrapMaterialFile(text)).toEqual(preset());
	});

	it('refuse a file of another format or version, or with malformed stock', () => {
		const good = JSON.parse(serializeMaterialPreset(preset())) as Record<string, unknown>;
		const stock = preset().stock;
		for (const [text, message] of [
			['not json', /not a KorCad material preset/],
			['[]', /not a KorCad material preset/],
			[JSON.stringify({ ...good, format: 'korcad-design' }), /not a KorCad material preset/],
			[JSON.stringify({ ...good, version: 2 }), /version 2; this build reads version 1/],
			[JSON.stringify({ ...good, stock: undefined }), /stock must be an object/],
			[
				JSON.stringify({ ...good, stock: { ...stock, material: '6' } }),
				/material must be a number/
			],
			[JSON.stringify({ ...good, stock: { ...stock, grainDirection: 'z' } }), /grainDirection/],
			[JSON.stringify({ ...good, workspaces: [] }), /workspaces must be an object/]
		] as const) {
			expect(() => unwrapMaterialFile(text)).toThrow(message);
		}
	});

	it('compare equal whatever order their keys were written in', () => {
		const { stock, workspaces } = preset();
		const reordered: MaterialPreset = {
			workspaces: { packaging: { foldDeduction: 1.2, foldCompensation: 'manual' } },
			stock: { ...stock }
		};
		expect(sameMaterialPreset(preset(), reordered)).toBe(true);
		expect(sameMaterialPreset(preset(), { stock: { ...stock, tabWidth: 5.01 }, workspaces })).toBe(
			false
		);
		expect(sameMaterialPreset(preset(), { stock, workspaces: {} })).toBe(false);
	});
});
