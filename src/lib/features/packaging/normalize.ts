import { DEFAULT_MACHINE_PROFILE_ID } from '$lib/core/design/defaults.js';
import { finite, isRecord } from '$lib/core/design/normalize.js';
import type { DesignState, FoldDirection, SideFlags } from '$lib/core/design/types.js';
import { createDefaultPackaging, pocketDefaults, supportDefaults } from './defaults.js';
import type { PackagingData, Pocket, PocketPurpose, Support, SupportMount } from './types.js';

/**
 * Reads the packaging workspace out of a migrated document.
 *
 * The pre-v6 shapes recognised here — a support's `{ target, face }` mount, a
 * bare `assemblyZ`, pre-v2 riser nets — are tolerant reads of fields inside an
 * old document rather than steps of the migration pipeline. They are tested,
 * and turning them into synthetic versions would be churn.
 */

const POCKET_PURPOSES: readonly PocketPurpose[] = [
	'product',
	'rounded',
	'ellipse',
	'slot',
	'cable',
	'registration',
	'imported'
];

function sideFlags(value: unknown, fallback: SideFlags): SideFlags {
	if (!isRecord(value)) return fallback;
	return {
		top: typeof value.top === 'boolean' ? value.top : fallback.top,
		right: typeof value.right === 'boolean' ? value.right : fallback.right,
		bottom: typeof value.bottom === 'boolean' ? value.bottom : fallback.bottom,
		left: typeof value.left === 'boolean' ? value.left : fallback.left
	};
}

function foldDirections(value: unknown): Record<string, FoldDirection> {
	if (!isRecord(value)) return {};
	const result: Record<string, FoldDirection> = {};
	for (const [key, direction] of Object.entries(value)) {
		if (direction === 'up' || direction === 'down') result[key] = direction;
	}
	return result;
}

/**
 * Reads the sheet list. A sheet that names a profile the document does not
 * have is pointed at the first profile rather than dropped: losing a sheet
 * would lose the parts cut from it.
 */
function profile(value: unknown): Pocket['profile'] {
	if (!Array.isArray(value)) return null;
	const points = value.flatMap((entry) =>
		isRecord(entry) && finite(entry.x) && finite(entry.y) ? [{ x: entry.x, y: entry.y }] : []
	);
	return points.length ? points : null;
}

function labelOffset(value: unknown): { labelOffset?: { x: number; y: number } } {
	return isRecord(value) && finite(value.x) && finite(value.y)
		? { labelOffset: { x: value.x, y: value.y } }
		: {};
}

function normalizePocket(value: unknown, index: number): Pocket {
	const source = isRecord(value) ? value : {};
	const base = pocketDefaults();
	const shape =
		source.shape === 'rounded' ||
		source.shape === 'ellipse' ||
		source.shape === 'profile' ||
		source.shape === 'rectangle'
			? source.shape
			: base.shape;
	return {
		id: typeof source.id === 'string' ? source.id : `pocket-${index + 1}`,
		name: typeof source.name === 'string' ? source.name : `Cutout ${index + 1}`,
		purpose: POCKET_PURPOSES.includes(source.purpose as PocketPurpose)
			? (source.purpose as PocketPurpose)
			: base.purpose,
		shape,
		x: finite(source.x) ? source.x : 0,
		y: finite(source.y) ? source.y : 0,
		w: finite(source.w) ? source.w : 0,
		h: finite(source.h) ? source.h : 0,
		wallDepth: finite(source.wallDepth) ? source.wallDepth : 25.4,
		flange: finite(source.flange) ? source.flange : 10,
		flangeEnabled: source.flangeEnabled === true,
		relief: finite(source.relief) ? source.relief : 3.5,
		pullDiameter: finite(source.pullDiameter) ? source.pullDiameter : base.pullDiameter,
		pullDepth: finite(source.pullDepth) ? source.pullDepth : base.pullDepth,
		pulls: sideFlags(source.pulls, base.pulls),
		sides: sideFlags(source.sides, { top: false, right: false, bottom: false, left: false }),
		cornerRadius: finite(source.cornerRadius) ? source.cornerRadius : base.cornerRadius,
		profile: profile(source.profile),
		...labelOffset(source.labelOffset)
	};
}

/**
 * Reads a support mount from untrusted JSON.
 *
 * Supersedes the earlier `{ target, face }` pair, where `target` was `deck`,
 * `box-floor`, or another support's id and `face` only meant anything for the
 * deck. Those combinations map onto the named anchors one-for-one, so a saved
 * design lands at exactly the same height it did before.
 */
function normalizeMount(source: Record<string, unknown>, fallback: SupportMount): SupportMount {
	const offset = finite(source.offset) ? source.offset : fallback.offset;
	const anchor = source.anchor;
	if (anchor === 'box-floor' || anchor === 'deck-top' || anchor === 'deck-underside') {
		return { anchor, offset };
	}
	if (anchor === 'support-top') {
		return typeof source.supportId === 'string'
			? { anchor, supportId: source.supportId, offset }
			: { anchor: 'box-floor', offset };
	}

	const target = source.target;
	if (target === 'box-floor') return { anchor: 'box-floor', offset };
	if (target === 'deck') {
		return { anchor: source.face === 'underside' ? 'deck-underside' : 'deck-top', offset };
	}
	// Any other target named another support by id.
	if (typeof target === 'string' && target.length > 0) {
		return { anchor: 'support-top', supportId: target, offset };
	}
	return fallback;
}

function normalizeSupport(value: unknown, index: number, deckSheetId: string): Support {
	const source = isRecord(value) ? value : {};
	const base = supportDefaults(deckSheetId);
	const kind: Support['kind'] =
		source.kind === 'tray' ? 'tray' : source.kind === 'platform' ? 'platform' : 'riser';
	// Pre-v2 riser nets placed `flatY` at the wall fold rather than the panel
	// bottom, so legacy files must be shifted up by the riser height.
	const legacyNet = source.kind === undefined && source.netVersion !== 2;
	// Oldest files carry a bare `assemblyZ` height above the box floor.
	const defaultMount: SupportMount =
		kind === 'tray'
			? { anchor: 'deck-underside', offset: 0 }
			: { anchor: 'box-floor', offset: finite(source.assemblyZ) ? source.assemblyZ : 0 };
	const mountSource = isRecord(source.mount) ? source.mount : {};
	const flatY = finite(source.flatY) ? source.flatY : base.flatY;
	const height = finite(source.h) ? source.h : 40;

	return {
		kind,
		id: typeof source.id === 'string' ? source.id : `support-${index + 1}`,
		name: typeof source.name === 'string' ? source.name : `Support ${index + 1}`,
		sheetId: typeof source.sheetId === 'string' ? source.sheetId : base.sheetId,
		w: finite(source.w) ? source.w : 0,
		d: finite(source.d) ? source.d : 0,
		h: height,
		// Only a design saved with an explicit spanning height keeps one; every
		// older file is taken at the height it recorded, unchanged.
		heightMode: source.heightMode === 'span' ? 'span' : 'fixed',
		flange: finite(source.flange) ? source.flange : base.flange,
		seam: finite(source.seam) ? source.seam : base.seam,
		overlap: finite(source.overlap) ? source.overlap : base.overlap,
		taper: finite(source.taper) ? source.taper : base.taper,
		openSide:
			source.openSide === 'top' ||
			source.openSide === 'right' ||
			source.openSide === 'bottom' ||
			source.openSide === 'left'
				? source.openSide
				: 'none',
		bottomFlange:
			typeof source.bottomFlange === 'boolean' ? source.bottomFlange : base.bottomFlange,
		cornerClosure: source.cornerClosure === 'lock' ? 'lock' : 'glue',
		top: 'panel',
		pullDiameter: finite(source.pullDiameter) ? source.pullDiameter : base.pullDiameter,
		pullDepth: finite(source.pullDepth) ? source.pullDepth : base.pullDepth,
		pulls: sideFlags(source.pulls, base.pulls),
		flatX: finite(source.flatX) ? source.flatX : base.flatX,
		flatY: legacyNet ? flatY + height : flatY,
		assemblyX: finite(source.assemblyX) ? source.assemblyX : base.assemblyX,
		assemblyY: finite(source.assemblyY) ? source.assemblyY : base.assemblyY,
		mount: normalizeMount(mountSource, defaultMount),
		netVersion: kind === 'tray' ? 3 : 2,
		...labelOffset(source.labelOffset)
	};
}

/**
 * Reads packaging data and makes sure its deck has a sheet to be cut from.
 *
 * A document that lost its deck sheet — hand-edited, or saved before sheets
 * existed — gets one back at the front of the list rather than losing the deck
 * blank, which is the design itself.
 */
export function normalizePackaging(raw: unknown, document: DesignState): DesignState {
	const saved = isRecord(raw) ? raw : {};
	const defaults = createDefaultPackaging();
	const number = (key: keyof PackagingData, fallback: number): number => {
		const value = saved[key];
		return finite(value) ? value : fallback;
	};
	const enumerated = <T extends string>(
		key: keyof PackagingData,
		allowed: readonly T[],
		fallback: T
	): T => {
		const value = saved[key];
		return typeof value === 'string' && (allowed as readonly string[]).includes(value)
			? (value as T)
			: fallback;
	};
	const deckSheetId =
		typeof saved.deckSheetId === 'string' && saved.deckSheetId
			? saved.deckSheetId
			: defaults.deckSheetId;

	const packaging: PackagingData = {
		deckSheetId,
		deckX: number('deckX', defaults.deckX),
		deckY: number('deckY', defaults.deckY),
		deckW: number('deckW', defaults.deckW),
		deckH: number('deckH', defaults.deckH),
		perimeterType: enumerated(
			'perimeterType',
			['plain', 'folded', 'joist'] as const,
			defaults.perimeterType
		),
		perimeterWall: number('perimeterWall', defaults.perimeterWall),
		perimeterFlange: number('perimeterFlange', defaults.perimeterFlange),
		perimeterRelief: number('perimeterRelief', defaults.perimeterRelief),
		perimeterSides: sideFlags(saved.perimeterSides, defaults.perimeterSides),
		joistAxis: enumerated('joistAxis', ['vertical', 'horizontal'] as const, defaults.joistAxis),
		joistFolds: number('joistFolds', defaults.joistFolds),
		joistHeight: number('joistHeight', defaults.joistHeight),
		joistDepth: number('joistDepth', defaults.joistDepth),
		joistLockWidth: number('joistLockWidth', defaults.joistLockWidth),
		joistSlotClearance: number('joistSlotClearance', defaults.joistSlotClearance),
		foldCompensation: enumerated(
			'foldCompensation',
			['none', 'computed', 'manual'] as const,
			'none'
		),
		foldRadiusFactor: number('foldRadiusFactor', defaults.foldRadiusFactor),
		foldKFactor: number('foldKFactor', defaults.foldKFactor),
		foldDeduction: number('foldDeduction', defaults.foldDeduction),
		foldDirections: foldDirections(saved.foldDirections),
		pockets: Array.isArray(saved.pockets) ? saved.pockets.map(normalizePocket) : [],
		supports: Array.isArray(saved.supports)
			? saved.supports.map((support, index) => normalizeSupport(support, index, deckSheetId))
			: []
	};

	const sheets = document.sheets.some((sheet) => sheet.id === deckSheetId)
		? document.sheets
		: [
				{
					id: deckSheetId,
					name: 'Deck',
					workspace: 'packaging' as const,
					machineProfileId: document.machineProfiles[0]?.id ?? DEFAULT_MACHINE_PROFILE_ID
				},
				...document.sheets
			];
	return { ...document, sheets, workspaces: { ...document.workspaces, packaging } };
}
