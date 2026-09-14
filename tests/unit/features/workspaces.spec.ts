import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateGcode } from '$lib/core/cam/gcode.js';
import { sheetView } from '$lib/core/design/machine.js';
import { ICON_PATHS } from '$lib/components/icons/paths.js';
import { serializeDesign } from '$lib/core/export/design-file.js';
import { createDefaultDesign, parseDesign } from '$lib/features/document.js';
import { resolveSupportHeights } from '$lib/features/packaging/levels.js';
import { buildAssembly } from '$lib/features/packaging/assembly.js';
import { validate } from '$lib/features/packaging/validation.js';
import { packagingData } from '$lib/features/packaging/view.js';
import {
	activeWorkspace,
	PACKAGING_WORKSPACE,
	presentWorkspaces,
	sheetForWorkspace,
	reconcileDocument,
	validateDocument,
	WORKSPACES
} from '$lib/features/workspaces.js';
import {
	FIXTURE_DESIGNS,
	foldedDesign,
	patchDesign,
	flatPartsDesign,
	supportDesign,
	withMachine
} from '../../support/designs.js';

/**
 * The workspace registry is how the editor, toolbar, and export reach a
 * workspace without importing it. Dispatching through it must produce exactly
 * what calling packaging directly did.
 */

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

describe('the registry', () => {
	it('has one entry per id, each consistent about its assembly preview', () => {
		expect(new Set(WORKSPACES.map((workspace) => workspace.id)).size).toBe(WORKSPACES.length);
		for (const workspace of WORKSPACES) {
			expect(workspace.capabilities.assembly, workspace.id).toBe(workspace.assembly !== undefined);
		}
	});

	it('gives every tool and preset an icon from the vendored set', () => {
		for (const workspace of WORKSPACES) {
			for (const tool of workspace.tools) {
				expect(ICON_PATHS, tool.id).toHaveProperty(tool.icon);
				expect(tool.presets.length, tool.id).toBeGreaterThan(0);
				for (const preset of tool.presets)
					expect(ICON_PATHS, preset.id).toHaveProperty(preset.icon);
			}
		}
	});

	it('looks up the active sheet’s workspace and every workspace the document uses', () => {
		const design = createDefaultDesign();
		expect(activeWorkspace(design)).toBe(PACKAGING_WORKSPACE);
		expect(presentWorkspaces(design)).toEqual([PACKAGING_WORKSPACE]);
		expect(presentWorkspaces({ ...design, workspaces: {} })).toEqual([]);
	});

	it('finds the sheet to show when switching workspace', () => {
		const design = flatPartsDesign();
		expect(sheetForWorkspace(design, 'flatParts')).toBe('sheet');
		expect(sheetForWorkspace(design, 'packaging')).toBe('deck');
		expect(sheetForWorkspace(createDefaultDesign(), 'packaging')).toBe('deck');
		expect(sheetForWorkspace(createDefaultDesign(), 'flatParts')).toBeNull();
	});

	it('creates the data a new document starts with', () => {
		expect(PACKAGING_WORKSPACE.defaults('deck')).toEqual(
			createDefaultDesign().workspaces.packaging
		);
		expect(createDefaultDesign('packaging')).toEqual(createDefaultDesign());
	});

	it('starts a new project in any workspace with one empty sheet and only its data', () => {
		for (const workspace of WORKSPACES) {
			const design = createDefaultDesign(workspace.id);
			expect(design.sheets).toHaveLength(1);
			expect(design.sheets[0]?.workspace).toBe(workspace.id);
			expect(design.activeSheetId).toBe(design.sheets[0]?.id);
			expect(Object.keys(design.workspaces)).toEqual([workspace.id]);
			expect(validateDocument(design)).toEqual([]);
			expect(parseDesign(serializeDesign(design))).toEqual(design);
		}
		const flatParts = createDefaultDesign('flatParts');
		expect(flatParts.sheets[0]?.name).toBe('Sheet 1');
		expect(flatParts.machineProfiles).toEqual([
			{ ...createDefaultDesign().machineProfiles[0], name: 'Router', fabricationMode: 'router' }
		]);
		expect(createDefaultDesign().machineProfiles[0]?.fabricationMode).toBe('knife');
		expect(flatParts.workspaces.flatParts?.sheets[flatParts.activeSheetId]).toEqual({
			entities: []
		});
	});

	it('makes the first packaging sheet a project gains its deck', () => {
		const flatParts = createDefaultDesign('flatParts');
		expect(PACKAGING_WORKSPACE.newSheetName(flatParts)).toBe('Deck');
		expect(PACKAGING_WORKSPACE.defaults('sheet-2').deckSheetId).toBe('sheet-2');
		expect(PACKAGING_WORKSPACE.newSheetName(createDefaultDesign())).toBe('Parts 1');
	});
});

describe('document-wide dispatch', () => {
	it('reconciles spanning heights exactly as packaging does', () => {
		const base = supportDesign();
		const spanning = patchDesign(base, {
			supports: packagingData(base).supports.map((support) =>
				support.kind === 'riser' ? { ...support, heightMode: 'span' as const, h: 1 } : support
			)
		});
		expect(reconcileDocument(spanning)).toEqual(resolveSupportHeights(spanning));
		expect(reconcileDocument(spanning)).not.toEqual(spanning);
	});

	it('validates every workspace present', () => {
		const broken = patchDesign(foldedDesign(), { deckW: 5000 });
		expect(validateDocument(broken)).toEqual(validate(broken));
		expect(validateDocument(broken).length).toBeGreaterThan(0);
		expect(validateDocument({ ...broken, workspaces: {} })).toEqual([]);
	});
});

describe('packaging through the registry', () => {
	it('exports the golden programs for every fixture sheet', () => {
		for (const [slug, build] of FIXTURE_DESIGNS) {
			const design = build();
			for (const sheet of design.sheets) {
				const sheetDesign = { ...design, activeSheetId: sheet.id };
				const workspace = activeWorkspace(sheetDesign);
				const paths = workspace.geometry(sheetDesign).paths;
				if (!paths.length) continue;
				const suffix = design.sheets.length > 1 ? `-${sheet.id}` : '';
				const options = workspace.gcodeOptions(sheetDesign, sheet.id);
				for (const [index, operation] of (['crease', 'cut'] as const).entries()) {
					expect(
						generateGcode(paths, sheetView(sheetDesign), operation, options),
						`${slug}${suffix} ${operation}`
					).toBe(
						readFileSync(
							fixture(`expected-gcode/${slug}${suffix}-0${index + 1}-${operation}.nc`),
							'utf8'
						)
					);
				}
			}
		}
	});

	it('builds the assembly with the selected support highlighted', () => {
		const design = supportDesign();
		expect(PACKAGING_WORKSPACE.assembly?.(design, { kind: 'support', id: 'tray-1' })).toEqual(
			buildAssembly(design, 'tray-1')
		);
		expect(PACKAGING_WORKSPACE.assembly?.(design, { kind: 'pocket', id: 'x' })).toEqual(
			buildAssembly(design, null)
		);
	});

	it('labels openings on the deck and supports on the sheet they are cut from', () => {
		const design = supportDesign();
		const pocket = packagingData(design).pockets[0]!;
		expect(PACKAGING_WORKSPACE.labels(design, 'deck')).toEqual([
			{ name: pocket.name, x: pocket.x + 5, y: pocket.y + pocket.h - 9 }
		]);
		expect(PACKAGING_WORKSPACE.labels(design, 'parts').map((label) => label.name)).toEqual([
			'Tablet tray',
			'Riser 1'
		]);
	});

	it('only reports a selection that still exists', () => {
		const design = supportDesign();
		const pocketId = packagingData(design).pockets[0]!.id;
		expect(PACKAGING_WORKSPACE.selectionExists(design, { kind: 'pocket', id: pocketId })).toBe(
			true
		);
		expect(PACKAGING_WORKSPACE.selectionExists(design, { kind: 'support', id: 'riser-1' })).toBe(
			true
		);
		expect(PACKAGING_WORKSPACE.selectionExists(design, { kind: 'support', id: pocketId })).toBe(
			false
		);
		expect(PACKAGING_WORKSPACE.selectionExists(design, { kind: 'hole', id: 'riser-1' })).toBe(
			false
		);
	});

	it('frames a support only on the sheet its net is cut from', () => {
		const design = supportDesign();
		const selection = { kind: 'support', id: 'riser-1' };
		expect(PACKAGING_WORKSPACE.selectionBounds(design, selection, 'parts')).not.toBeNull();
		expect(PACKAGING_WORKSPACE.selectionBounds(design, selection, 'deck')).toBeNull();
		const pocket = packagingData(design).pockets[0]!;
		expect(
			PACKAGING_WORKSPACE.selectionBounds(design, { kind: 'pocket', id: pocket.id }, 'deck')
		).toEqual({
			left: pocket.x,
			right: pocket.x + pocket.w,
			bottom: pocket.y,
			top: pocket.y + pocket.h
		});
	});

	it('protects the deck sheet and releases the supports cut from a parts sheet', () => {
		const design = supportDesign();
		expect(PACKAGING_WORKSPACE.protectsSheet(design, 'deck')).toBe(true);
		expect(PACKAGING_WORKSPACE.protectsSheet(design, 'parts')).toBe(false);
		expect(packagingData(PACKAGING_WORKSPACE.releaseSheet(design, 'parts')).supports).toEqual([]);
	});

	it('withholds the support tool from a router, whose board does not fold', () => {
		const support = PACKAGING_WORKSPACE.tools.find((tool) => tool.id === 'support')!;
		const cutout = PACKAGING_WORKSPACE.tools.find((tool) => tool.id === 'cutout')!;
		const router = sheetView(withMachine(foldedDesign(), { fabricationMode: 'router' }));
		const knife = sheetView(foldedDesign());
		expect(support.unavailable(router)).toMatch(/drag knife/);
		expect(support.unavailable(knife)).toBeNull();
		expect(cutout.unavailable(router)).toBeNull();
	});
});
