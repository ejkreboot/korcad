import { createDefaultMachineProfile, createDefaultStock } from './defaults.js';
import type { WorkspaceId } from './workspace.js';
import type { DesignState, MachineProfile, Sheet, StockSettings } from './types.js';

type Record_ = Record<string, unknown>;

export const isRecord = (value: unknown): value is Record_ =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const finite = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

/**
 * Reads one workspace's data out of a saved document.
 *
 * Handed the raw value stored under `workspaces[id]` — `undefined` when the
 * document has none — and the document read so far, it returns the document
 * with that workspace's data in place. It may also repair sheets, because only
 * the workspace knows which of its sheets must exist.
 */
export type WorkspaceReader = {
	readonly id: WorkspaceId;
	normalize(raw: unknown, document: DesignState): DesignState;
};

/** What `normalizeDocument` needs to know about the registered workspaces. */
export type DocumentReaders = {
	readonly workspaces: readonly WorkspaceReader[];
	/** The workspace a sheet is drawn in when its saved tag is missing or unknown. */
	readonly defaultWorkspace: WorkspaceId;
	/** The sheet a document with no sheets at all is given. */
	defaultSheet(machineProfileId: string): Sheet;
};

/**
 * Reads the machine profiles, defaulting any unreadable field. A document
 * always has at least one profile, and ids are unique.
 */
function machineProfiles(value: unknown): MachineProfile[] {
	const base = createDefaultMachineProfile();
	const seen = new Set<string>();
	const parsed = (Array.isArray(value) ? value : []).flatMap((entry, index): MachineProfile[] => {
		if (!isRecord(entry)) return [];
		const id = typeof entry.id === 'string' && entry.id ? entry.id : `profile-${index + 1}`;
		if (seen.has(id)) return [];
		seen.add(id);
		const number = (key: keyof MachineProfile, fallback: number) => {
			const value = entry[key];
			return finite(value) ? value : fallback;
		};
		return [
			{
				id,
				name: typeof entry.name === 'string' && entry.name ? entry.name : id,
				fabricationMode: entry.fabricationMode === 'router' ? 'router' : base.fabricationMode,
				safeZ: number('safeZ', base.safeZ),
				cutDepth: number('cutDepth', base.cutDepth),
				scoreDepth: number('scoreDepth', base.scoreDepth),
				scoreTool: entry.scoreTool === 'crease' ? 'crease' : base.scoreTool,
				cutFeed: number('cutFeed', base.cutFeed),
				scoreFeed: number('scoreFeed', base.scoreFeed),
				plungeFeed: number('plungeFeed', base.plungeFeed),
				bladeOffset: number('bladeOffset', base.bladeOffset),
				overcut: number('overcut', base.overcut),
				cornerStep: number('cornerStep', base.cornerStep),
				bitWidth: number('bitWidth', base.bitWidth),
				spindleSpeed: number('spindleSpeed', base.spindleSpeed)
			}
		];
	});
	return parsed.length ? parsed : [base];
}

function enumerated<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

function stock(value: unknown): StockSettings {
	const saved = isRecord(value) ? value : {};
	const defaults = createDefaultStock();
	const number = (key: keyof StockSettings, fallback: number): number => {
		const entry = saved[key];
		return finite(entry) ? entry : fallback;
	};
	return {
		units: enumerated(saved.units, ['in', 'mm'] as const, defaults.units),
		material: number('material', defaults.material),
		boardFinish: enumerated(
			saved.boardFinish,
			['kraft', 'white', 'printed'] as const,
			defaults.boardFinish
		),
		grainDirection: enumerated(
			saved.grainDirection,
			['x', 'y', 'unknown'] as const,
			defaults.grainDirection
		),
		minimumWeb: number('minimumWeb', defaults.minimumWeb),
		tabWidth: number('tabWidth', defaults.tabWidth),
		tabCount: number('tabCount', defaults.tabCount),
		tabHeight: number('tabHeight', defaults.tabHeight)
	};
}

/**
 * Reads the sheet list. A sheet that names a profile the document does not
 * have is pointed at the first profile rather than dropped: losing a sheet
 * would lose the parts cut from it. The same goes for a workspace tag this
 * build does not know.
 */
function sheets(value: unknown, profiles: readonly MachineProfile[], readers: DocumentReaders) {
	const fallbackProfile = profiles[0]!.id;
	const known = readers.workspaces.map((reader) => reader.id);
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry): Sheet[] =>
		isRecord(entry) && typeof entry.id === 'string'
			? [
					{
						id: entry.id,
						name: typeof entry.name === 'string' ? entry.name : entry.id,
						workspace: enumerated(entry.workspace, known, readers.defaultWorkspace),
						machineProfileId:
							typeof entry.machineProfileId === 'string' &&
							profiles.some((profile) => profile.id === entry.machineProfileId)
								? entry.machineProfileId
								: fallbackProfile
					}
				]
			: []
	);
}

/**
 * Whether untrusted JSON is shaped like a design document: it has workspaces
 * or at least one sheet. An empty sheet list alone describes nothing.
 */
function isDocument(raw: unknown): raw is Record_ {
	return (
		isRecord(raw) &&
		((Array.isArray(raw.sheets) && raw.sheets.length > 0) || isRecord(raw.workspaces))
	);
}

/**
 * Narrows untrusted saved JSON into a `DesignState`. Throws rather than
 * silently repairing a file that is not a design at all.
 *
 * The generic fields are read here and each workspace's data by its own
 * reader. Call `normalizeState` in `features/document.ts`, which supplies the
 * registered readers.
 */
export function normalizeDocument(raw: unknown, readers: DocumentReaders): DesignState {
	if (!isDocument(raw)) {
		throw new Error('This file does not contain a valid Voisee design');
	}
	const profiles = machineProfiles(raw.machineProfiles);
	const savedWorkspaces = isRecord(raw.workspaces) ? raw.workspaces : {};

	let document: DesignState = {
		stock: stock(raw.stock),
		toolpathOrder: enumerated(raw.toolpathOrder, ['optimized', 'design'] as const, 'optimized'),
		machineProfiles: profiles,
		sheets: sheets(raw.sheets, profiles, readers),
		activeSheetId: typeof raw.activeSheetId === 'string' ? raw.activeSheetId : '',
		workspaces: {}
	};

	const read = new Set<WorkspaceId>();
	const readWorkspaces = () => {
		for (const reader of readers.workspaces) {
			if (read.has(reader.id)) continue;
			const stored = savedWorkspaces[reader.id];
			const used = document.sheets.some((sheet) => sheet.workspace === reader.id);
			if (stored === undefined && !used) continue;
			document = reader.normalize(stored, document);
			read.add(reader.id);
		}
	};
	readWorkspaces();
	if (!document.sheets.length) {
		document = { ...document, sheets: [readers.defaultSheet(profiles[0]!.id)] };
		readWorkspaces();
	}
	if (!document.sheets.some((sheet) => sheet.id === document.activeSheetId)) {
		document = { ...document, activeSheetId: document.sheets[0]!.id };
	}
	return document;
}
