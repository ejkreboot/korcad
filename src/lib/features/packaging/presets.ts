import type { PackagingView } from './view.js';
import { round } from '$lib/core/units.js';
import { supportDefaults } from './defaults.js';
import type { Pocket, PocketPurpose, Support } from './types.js';

/**
 * Semantic opening types. The preset chooses shape, purpose, and construction
 * together, so an opening carries what it is for and not just its outline.
 */
export type CutoutPreset =
	'rectangle' | 'folded' | 'rounded' | 'ellipse' | 'slot' | 'cable' | 'registration';

export type CutoutPresetInfo = {
	readonly id: CutoutPreset;
	readonly label: string;
	readonly description: string;
};

export const CUTOUT_PRESETS: readonly CutoutPresetInfo[] = [
	{ id: 'rectangle', label: 'Product opening', description: 'Rectangular through cut' },
	{ id: 'folded', label: 'Folded pocket', description: 'Four walls with optional glue flanges' },
	{ id: 'rounded', label: 'Rounded opening', description: 'Rounded rectangular through cut' },
	{ id: 'ellipse', label: 'Circle or ellipse', description: 'Draw its enclosing bounds' },
	{ id: 'slot', label: 'Material slot', description: 'Narrow functional through cut' },
	{ id: 'cable', label: 'Cable opening', description: 'Rounded pass-through for cabling' },
	{ id: 'registration', label: 'Registration hole', description: 'Square-bounded locating hole' }
];

const CUTOUT_NAMES: Readonly<Record<CutoutPreset, string>> = {
	rectangle: 'Pocket',
	folded: 'Folded pocket',
	rounded: 'Rounded opening',
	ellipse: 'Ellipse',
	slot: 'Material slot',
	cable: 'Cable opening',
	registration: 'Registration hole'
};

function presetShape(preset: CutoutPreset): Pocket['shape'] {
	if (preset === 'ellipse' || preset === 'registration') return 'ellipse';
	if (preset === 'rounded' || preset === 'slot' || preset === 'cable') return 'rounded';
	return 'rectangle';
}

function presetPurpose(preset: CutoutPreset): PocketPurpose {
	return preset === 'rectangle' || preset === 'folded' ? 'product' : preset;
}

/**
 * Builds an opening from a drawn rectangle. A registration hole is forced
 * square so it locates in both axes equally.
 */
export function createPocketFromPreset(
	preset: CutoutPreset,
	rect: { x: number; y: number; w: number; h: number },
	id: string,
	index: number
): Pocket {
	let { x, y, w, h } = rect;
	if (preset === 'registration') {
		const size = Math.min(w, h);
		x = x + (w - size) / 2;
		y = y + (h - size) / 2;
		w = size;
		h = size;
	}
	const folded = preset === 'folded';
	return {
		id,
		name: `${CUTOUT_NAMES[preset]} ${index}`,
		purpose: presetPurpose(preset),
		shape: presetShape(preset),
		cornerRadius: preset === 'rounded' ? 6.35 : Math.min(w, h) / 2,
		profile: null,
		x: round(x),
		y: round(y),
		w: round(w),
		h: round(h),
		wallDepth: 25.4,
		flange: 10,
		relief: 3.5,
		pullDiameter: 38.1,
		pullDepth: 19,
		pulls: { top: false, right: false, bottom: false, left: false },
		flangeEnabled: folded,
		sides: { top: folded, right: folded, bottom: folded, left: folded }
	};
}

/** Semantic support types. */
export type SupportPreset = 'riser-glue' | 'riser-lock' | 'platform' | 'tray';

export type SupportPresetInfo = {
	readonly id: SupportPreset;
	readonly label: string;
	readonly description: string;
};

export const SUPPORT_PRESETS: readonly SupportPresetInfo[] = [
	{ id: 'riser-glue', label: 'Glued riser box', description: 'Cross net with corner glue tabs' },
	{ id: 'riser-lock', label: 'Locking riser box', description: 'Derived corner tabs and slots' },
	{
		id: 'platform',
		label: 'Platform step',
		description: 'Closed support mounted at a chosen level'
	},
	{ id: 'tray', label: 'Recessed tray', description: 'Linked deck opening and suspended tray' }
];

export function supportKindForPreset(preset: SupportPreset): Support['kind'] {
	if (preset === 'tray') return 'tray';
	if (preset === 'platform') return 'platform';
	return 'riser';
}

/** A recessed tray is drawn on the deck; other supports are drawn on a sheet. */
export function presetDrawsOnDeck(preset: SupportPreset): boolean {
	return preset === 'tray';
}

/**
 * Builds a support from a drawn rectangle. A tray is positioned by where it
 * was drawn on the deck and then auto-placed on a cutting sheet; other
 * supports are laid out where they were drawn.
 */
export function createSupportFromPreset(
	preset: SupportPreset,
	rect: { x: number; y: number; w: number; h: number },
	id: string,
	index: number,
	context: Pick<PackagingView, 'activeSheetId' | 'deckSheetId' | 'deckX' | 'deckY'>
): Support {
	const kind = supportKindForPreset(preset);
	const tray = kind === 'tray';
	const name =
		kind === 'tray'
			? `Recessed tray ${index}`
			: kind === 'platform'
				? `Platform step ${index}`
				: `Riser ${index}`;
	return {
		...supportDefaults(context.deckSheetId),
		kind,
		id,
		name,
		w: round(rect.w),
		d: round(rect.h),
		h: tray || kind === 'platform' ? 25.4 : 40,
		/*
		 * A riser box exists to hold the deck up, so its height is the cavity it
		 * fills rather than a number the operator has to keep in step with the
		 * wall. A platform step is placed at a chosen level and a tray has its
		 * own depth, so both keep a fixed height.
		 */
		heightMode: kind === 'riser' ? 'span' : 'fixed',
		cornerClosure: preset === 'riser-lock' ? 'lock' : 'glue',
		pulls: { top: false, right: false, bottom: tray, left: false },
		pullDepth: 15,
		sheetId: tray ? context.deckSheetId : context.activeSheetId,
		flatX: tray ? 25.4 : round(rect.x),
		flatY: tray ? 25.4 : round(rect.y),
		assemblyX: tray ? round(rect.x - context.deckX) : 0,
		assemblyY: tray ? round(rect.y - context.deckY) : 0,
		mount: tray ? { anchor: 'deck-underside', offset: 0 } : { anchor: 'box-floor', offset: 0 },
		netVersion: tray ? 3 : 2
	};
}
