import {
	MATERIAL_FILE_KEY,
	PROBE_SETTINGS_KEY,
	STORAGE_KEY,
	SURFACE_FILE_KEY,
	SURFACE_MAP_KEY
} from '$lib/core/constants.js';
import { serializeMaterialPreset, type MaterialPreset } from '$lib/core/design/material.js';
import {
	parseProbeSettings,
	serializeProbeSettings,
	type ProbeSettings
} from '$lib/core/grbl/probing.js';
import {
	parseSurfaceFile,
	parseSurfaceMap,
	serializeSurfaceFile,
	serializeSurfaceMap,
	type SurfaceGrid,
	type SurfaceMap
} from '$lib/core/cam/surface.js';
import { serializeDesign } from '$lib/core/export/design-file.js';
import { parseDesign, readMaterialFile } from '$lib/features/document.js';
import type { DesignState } from '$lib/core/design/types.js';
import { reconcileDocument } from '$lib/features/workspaces.js';
import type { LinkedFile } from './text-files.js';

/**
 * Local drafts only. Durable sharing is an explicit file export, so a lost or
 * cleared browser profile never loses a design the user meant to keep.
 *
 * A draft is written exactly like a design file, envelope and version
 * included, so the two can never drift apart. A draft this build cannot read
 * is ignored and the editor starts fresh.
 */
export function loadDraft(): DesignState | null {
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (!stored) return null;
		return readDesignFile(stored);
	} catch {
		return null;
	}
}

export function saveDraft(design: DesignState): void {
	try {
		localStorage.setItem(STORAGE_KEY, serializeDesign(design));
	} catch {
		// A full or blocked storage quota must not interrupt editing.
	}
}

/** The table's surface map, kept in this browser apart from any design. */
export function loadSurfaceMap(): SurfaceMap | null {
	try {
		const stored = localStorage.getItem(SURFACE_MAP_KEY);
		return stored ? parseSurfaceMap(stored) : null;
	} catch {
		return null;
	}
}

export function saveSurfaceMap(map: SurfaceMap): void {
	try {
		localStorage.setItem(SURFACE_MAP_KEY, serializeSurfaceMap(map));
	} catch {
		// A full or blocked storage quota must not interrupt editing.
	}
}

/**
 * Which file the material or the table's surface came from, and what it held,
 * so that a reload still names it and still knows what is unsaved. Its
 * contents are written as the file itself is, and read back the same way.
 * Only the browser's pickers can write a file again in place, and what they
 * hand back cannot be stored here, so the next save asks where.
 */
function loadLinkedFile<T>(key: string, read: (text: string) => T): LinkedFile<T> | null {
	try {
		const stored = localStorage.getItem(key);
		if (!stored) return null;
		const value: unknown = JSON.parse(stored);
		if (typeof value !== 'object' || value === null) return null;
		const record: Record<string, unknown> = { ...value };
		const { name, text } = record;
		if (typeof name !== 'string' || typeof text !== 'string') return null;
		return { name, handle: null, saved: read(text) };
	} catch {
		return null;
	}
}

function saveLinkedFile<T>(key: string, file: LinkedFile<T> | null, write: (saved: T) => string) {
	try {
		if (file)
			localStorage.setItem(key, JSON.stringify({ name: file.name, text: write(file.saved) }));
		else localStorage.removeItem(key);
	} catch {
		// A full or blocked storage quota must not interrupt editing.
	}
}

export const loadMaterialFile = () => loadLinkedFile(MATERIAL_FILE_KEY, readMaterialFile);
export const saveMaterialFile = (file: LinkedFile<MaterialPreset> | null) =>
	saveLinkedFile(MATERIAL_FILE_KEY, file, (saved) => serializeMaterialPreset(saved, ''));
export const loadSurfaceFile = () => loadLinkedFile(SURFACE_FILE_KEY, parseSurfaceFile);
export const saveSurfaceFile = (file: LinkedFile<SurfaceGrid> | null) =>
	saveLinkedFile(SURFACE_FILE_KEY, file, (saved) => serializeSurfaceFile(saved, ''));

export function loadProbeSettings(): ProbeSettings | null {
	try {
		const stored = localStorage.getItem(PROBE_SETTINGS_KEY);
		return stored ? parseProbeSettings(stored) : null;
	} catch {
		return null;
	}
}

export function saveProbeSettings(settings: ProbeSettings): void {
	try {
		localStorage.setItem(PROBE_SETTINGS_KEY, serializeProbeSettings(settings));
	} catch {
		// A full or blocked storage quota must not interrupt editing.
	}
}

/**
 * Derived values, such as a spanning support height, are recomputed on the way
 * in rather than trusted: the file may have been hand-edited. `core` stays
 * feature-free, so every workspace's reconciliation is applied here.
 */
export function readDesignFile(text: string): DesignState {
	return reconcileDocument(parseDesign(text));
}

export function designFileText(design: DesignState): string {
	return serializeDesign(design);
}

export function slugify(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '') || 'design'
	);
}

/** Browser-only: hands the user a file. Never called from core. */
export function download(name: string, contents: string, type: string): void {
	const url = URL.createObjectURL(new Blob([contents], { type }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = name;
	anchor.click();
	URL.revokeObjectURL(url);
}
