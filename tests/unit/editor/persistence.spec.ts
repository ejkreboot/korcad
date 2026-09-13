import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESIGN_FORMAT, DESIGN_VERSION, STORAGE_KEY } from '$lib/core/constants.js';
import { parseDesign } from '$lib/features/document.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { packagingGcode } from '$lib/features/packaging/gcode.js';
import { loadDraft, saveDraft } from '$lib/editor/persistence.js';
import { foldedDesign, view } from '../../support/designs.js';

/**
 * Local drafts.
 *
 * A draft used to be the bare document, written with `JSON.stringify` and read
 * back without a version, so it could drift from what a design file holds. It
 * is now written exactly like a design file. Drafts saved by earlier builds are
 * still in users' browsers, so those have to keep loading — and keep cutting
 * the same.
 */

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

beforeEach(() => {
	const store = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value)
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

	it('still load when an earlier build saved the bare version 6 document', () => {
		const file = readFileSync(fixture('designs/legacy/v6-folded-pocket.voisee.json'), 'utf8');
		localStorage.setItem(STORAGE_KEY, JSON.stringify(JSON.parse(file).design));

		const draft = loadDraft();
		expect(draft).not.toBeNull();
		// The same design as the file, so it cuts the same programs.
		const fromFile = parseDesign(file);
		expect(draft).toEqual(fromFile);
		const paths = allGeometry(draft!).paths;
		expect(packagingGcode(paths, view(draft!), 'cut')).toBe(
			readFileSync(fixture('expected-gcode/folded-pocket-02-cut.nc'), 'utf8')
		);
	});

	it('come back empty rather than throwing on garbage', () => {
		localStorage.setItem(STORAGE_KEY, '{ not json');
		expect(loadDraft()).toBeNull();
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ hello: 'world' }));
		expect(loadDraft()).toBeNull();
	});
});
