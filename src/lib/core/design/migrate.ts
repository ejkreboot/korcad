import { DEFAULT_MACHINE_PROFILE_ID } from './defaults.js';
import { MACHINE_SETTING_KEYS } from './machine.js';

/**
 * Version-stepped migration of untrusted saved documents.
 *
 * Each step turns a raw document of one version into the raw shape of the next.
 * Steps only move data; turning raw values into typed, defaulted, validated
 * ones is still `normalizeState`'s job, applied once at the end. That keeps
 * every step small enough to review on its own and test against the exact
 * shape it was written for — AGENTS.md requires each migration to be explicit
 * and tested.
 *
 * Documents older than version 6 are not stepped: fields inside them that
 * changed shape before this pipeline existed (a support's `{ target, face }`
 * mount, `assemblyZ`, pre-v2 riser nets) are still recognised by shape inside
 * `normalizeState`. They are this pipeline's backlog, not a gap in it.
 */

export type RawDocument = Readonly<Record<string, unknown>>;

export type MigrationStep = {
	readonly from: number;
	readonly to: number;
	readonly describe: string;
	readonly apply: (doc: RawDocument) => RawDocument;
};

/** Oldest version the pipeline steps from; anything earlier is read as this. */
export const OLDEST_STEPPED_VERSION = 6;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Version 7 moves the thirteen machine settings off the document and into a
 * named profile that each sheet references.
 *
 * Every existing sheet points at the one migrated profile, so a saved design
 * cuts exactly as it did. Values are carried across untouched, invalid ones
 * included: defaulting them is normalization's decision, made the same way it
 * was when they lived on the document.
 */
const machineProfiles: MigrationStep = {
	from: 6,
	to: 7,
	describe: 'machine settings move into a named profile referenced by each sheet',
	apply(doc) {
		const profile: Record<string, unknown> = {
			id: DEFAULT_MACHINE_PROFILE_ID,
			name: doc.fabricationMode === 'router' ? 'Router' : 'Drag knife'
		};
		const rest: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(doc)) {
			if ((MACHINE_SETTING_KEYS as readonly string[]).includes(key)) profile[key] = value;
			else rest[key] = value;
		}
		const sheets = Array.isArray(doc.sheets)
			? doc.sheets.map((sheet) =>
					isRecord(sheet) ? { ...sheet, machineProfileId: DEFAULT_MACHINE_PROFILE_ID } : sheet
				)
			: doc.sheets;
		return { ...rest, machineProfiles: [profile], ...(sheets === undefined ? {} : { sheets }) };
	}
};

/** Fields that version 8 groups under `stock`. */
const STOCK_KEYS = [
	'units',
	'material',
	'boardFinish',
	'grainDirection',
	'minimumWeb',
	'tabWidth',
	'tabCount'
] as const;

/** Fields that version 8 moves under `workspaces.packaging`. */
const PACKAGING_KEYS = [
	'deckX',
	'deckY',
	'deckW',
	'deckH',
	'perimeterType',
	'perimeterWall',
	'perimeterFlange',
	'perimeterRelief',
	'perimeterSides',
	'joistAxis',
	'joistFolds',
	'joistHeight',
	'joistDepth',
	'joistLockWidth',
	'joistSlotClearance',
	'foldCompensation',
	'foldRadiusFactor',
	'foldKFactor',
	'foldDeduction',
	'foldDirections',
	'pockets'
] as const;

/** Fields that stay at the top level of the document. */
const DOCUMENT_KEYS = ['toolpathOrder', 'machineProfiles', 'sheets', 'activeSheetId'] as const;

const pick = (doc: RawDocument, keys: readonly string[]): Record<string, unknown> =>
	Object.fromEntries(keys.filter((key) => key in doc).map((key) => [key, doc[key]]));

/**
 * Version 8 gives each workspace its own namespace.
 *
 * Until now every document was a packaging insert, so its deck, perimeter,
 * pockets, and supports sat at the top level beside settings that belong to any
 * sheet of board. They move under `workspaces.packaging`, `risers` is renamed
 * `supports` (it has always held trays and platforms too), the deck sheet stops
 * being a magic `'deck'` id and is named by `deckSheetId`, and every sheet is
 * tagged with the workspace it is drawn in.
 *
 * The field names here are the historical shape of a saved file, not an import
 * of the packaging feature: a migration describes data as it was written, and
 * must keep doing so however the feature changes.
 *
 * Selection and snap are dropped. They were only ever saved because the editor
 * used to keep them on the document, and restoring a selection from a file is
 * not something anyone asked for.
 */
const workspaceNamespace: MigrationStep = {
	from: 7,
	to: 8,
	describe: 'packaging data moves under workspaces.packaging; stock settings are grouped',
	apply(doc) {
		const packaging: Record<string, unknown> = {
			deckSheetId: 'deck',
			...pick(doc, PACKAGING_KEYS),
			...('risers' in doc ? { supports: doc.risers } : {})
		};
		const sheets = Array.isArray(doc.sheets)
			? doc.sheets.map((sheet) => (isRecord(sheet) ? { ...sheet, workspace: 'packaging' } : sheet))
			: doc.sheets;
		return {
			stock: pick(doc, STOCK_KEYS),
			...pick(doc, DOCUMENT_KEYS),
			...(sheets === undefined ? {} : { sheets }),
			workspaces: { packaging }
		};
	}
};

/** In version order. The last step's `to` is the current document version. */
export const MIGRATIONS: readonly MigrationStep[] = [machineProfiles, workspaceNamespace];

export const CURRENT_DOCUMENT_VERSION = MIGRATIONS.at(-1)!.to;

/**
 * The version a raw document's shape says it is.
 *
 * Local drafts are bare documents with no file envelope, so there is no
 * recorded version to trust, and the shape has to answer.
 */
export function detectVersion(doc: RawDocument): number {
	if (isRecord(doc.workspaces)) return 8;
	if (Array.isArray(doc.machineProfiles)) return 7;
	return OLDEST_STEPPED_VERSION;
}

/**
 * Brings a raw document up to the current version.
 *
 * The starting point is the later of the recorded version and the one the
 * shape reveals. A file can claim an old version while already carrying a newer
 * shape — hand-edited, or written by a build between releases — and running an
 * old step over newer data would overwrite it.
 */
export function migrateDocument(doc: RawDocument, recordedVersion?: number): RawDocument {
	let version = Math.max(
		OLDEST_STEPPED_VERSION,
		recordedVersion ?? OLDEST_STEPPED_VERSION,
		detectVersion(doc)
	);
	let current = doc;
	for (const step of MIGRATIONS) {
		if (step.from !== version) continue;
		current = step.apply(current);
		version = step.to;
	}
	return current;
}
