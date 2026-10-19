import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSurfaceMap } from '$lib/core/cam/surface.js';
import {
	DESIGN_FORMAT,
	DESIGN_VERSION,
	STORAGE_KEY,
	SURFACE_MAP_KEY
} from '$lib/core/constants.js';
import {
	loadDraft,
	loadMaterialFile,
	loadSurfaceFile,
	loadSurfaceMap,
	saveDraft,
	saveMaterialFile,
	saveSurfaceFile,
	saveSurfaceMap
} from '$lib/editor/persistence.js';
import { materialPreset } from '$lib/features/document.js';
import { foldedDesign } from '../../support/designs.js';

/**
 * Local drafts.
 *
 * A draft is written exactly like a design file, so it cannot drift from what
 * a design file holds. There are no legacy drafts to keep loading: one this
 * build cannot read is dropped and the editor starts fresh.
 */

beforeEach(() => {
	const store = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
		removeItem: (key: string) => store.delete(key)
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('drafts', () => {
	it('are saved as a complete design file with its version', () => {
		saveDraft(foldedDesign());
		const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
		expect(saved.format).toBe(DESIGN_FORMAT);
		expect(saved.version).toBe(DESIGN_VERSION);
		expect(saved.design).toEqual(foldedDesign());
	});

	it('round-trip unchanged', () => {
		saveDraft(foldedDesign());
		expect(loadDraft()).toEqual(foldedDesign());
	});

	it('are ignored when an earlier build saved them in another shape', () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(foldedDesign()));
		expect(loadDraft()).toBeNull();
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ format: DESIGN_FORMAT, version: DESIGN_VERSION - 1, design: foldedDesign() })
		);
		expect(loadDraft()).toBeNull();
	});

	it('come back empty rather than throwing on garbage', () => {
		localStorage.setItem(STORAGE_KEY, '{ not json');
		expect(loadDraft()).toBeNull();
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ hello: 'world' }));
		expect(loadDraft()).toBeNull();
	});
});

describe('the table surface map', () => {
	it('is kept under its own key, apart from the draft', () => {
		const map = { ...createSurfaceMap(2, 2), enabled: true, heights: [0, 0.1, -0.2, 0.3] };
		saveSurfaceMap(map);
		saveDraft(foldedDesign());
		expect(loadSurfaceMap()).toEqual(map);
		expect(localStorage.getItem(STORAGE_KEY)).not.toContain('heights');
		expect(JSON.parse(localStorage.getItem(SURFACE_MAP_KEY)!).format).toBe('korcad-surface-map');
	});

	it('is absent when nothing, or nothing readable, was saved', () => {
		expect(loadSurfaceMap()).toBeNull();
		localStorage.setItem(SURFACE_MAP_KEY, '{"format":"korcad-surface-map","version":0}');
		expect(loadSurfaceMap()).toBeNull();
	});
});

describe('linked files', () => {
	it('remember the file a material or surface came from, and what it held', () => {
		const preset = materialPreset(foldedDesign(), null);
		saveMaterialFile({ name: 'birch.korcad-material.json', handle: null, saved: preset });
		expect(loadMaterialFile()).toEqual({
			name: 'birch.korcad-material.json',
			handle: null,
			saved: preset
		});
		const grid = { columns: 2, rows: 2, inset: 10, heights: [0, 0.1, -0.2, 0.05] };
		saveSurfaceFile({ name: 'table.korcad-surface.json', handle: null, saved: grid });
		expect(loadSurfaceFile()).toEqual({
			name: 'table.korcad-surface.json',
			handle: null,
			saved: grid
		});
	});

	it('forget it once unlinked, and drop what they cannot read', () => {
		saveMaterialFile({ name: 'a.json', handle: null, saved: materialPreset(foldedDesign(), null) });
		saveMaterialFile(null);
		expect(loadMaterialFile()).toBeNull();
		localStorage.setItem('korcad-surface-file', JSON.stringify({ name: 'a.json', text: '{}' }));
		expect(loadSurfaceFile()).toBeNull();
		localStorage.setItem('korcad-material-file', 'not json');
		expect(loadMaterialFile()).toBeNull();
	});
});
