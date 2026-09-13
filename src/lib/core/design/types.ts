import type { Point } from '$lib/core/geometry/primitives.js';
import type { Units } from '$lib/core/units.js';
import type { MachiningStage } from '$lib/core/cam/stages.js';
import type { WorkspaceData, WorkspaceId } from './workspace.js';

export type FabricationMode = 'knife' | 'router';
export type ScoreTool = 'knife' | 'crease';
export type FoldDirection = 'up' | 'down';
export type ToolpathOrder = 'optimized' | 'design';
export type GrainDirection = 'x' | 'y' | 'unknown';
export type BoardFinish = 'kraft' | 'white' | 'printed';
export type Side = 'top' | 'right' | 'bottom' | 'left';

export type SideFlags = { readonly [K in Side]: boolean };

export type PathType = 'cut' | 'score';

/** Which side of the drawn line the tool runs on. */
export type OffsetSide = 'outside' | 'inside' | 'on';

/**
 * Explicit manufacturing intent, stated by whoever drew the path.
 *
 * CAM reads this and nothing else about what a path *means*: no role strings,
 * no owner ids, no feature vocabulary. A workspace that draws a path has to say
 * what it is for, which is what lets a generic outer profile and a packaging
 * deck perimeter be cut on the outside of the line without CAM knowing either
 * concept.
 */
export type CamIntent = {
	readonly offsetSide: OffsetSide;
	readonly stage: MachiningStage;
	/**
	 * Paths sharing a key are machined as one continuous chain, so that for
	 * example all four perimeter folds are creased in one pass rather than being
	 * scattered by travel optimization. `null` stands alone.
	 */
	readonly chainKey: string | null;
};

/**
 * The path contract shared by geometry, CAM, and export. Points are always in
 * millimeters with the origin at the lower-left of the stock sheet.
 */
export type DesignPath = {
	readonly points: readonly Point[];
	readonly type: PathType;
	readonly closed: boolean;
	/**
	 * Manufacturing intent: which side of the line, which stage, which chain.
	 * The only thing CAM reads about what a path is for.
	 */
	readonly cam: CamIntent;
	/**
	 * Semantic role, e.g. `exterior`, `central-cutout`. Display and diagnostics
	 * only — it is printed in G-code comments, and CAM never branches on it.
	 */
	readonly role?: string;
	/** The named entity that drew this path, for the operator's G-code comment. */
	readonly owner?: { readonly kind: string; readonly id: string; readonly name: string };
	readonly foldDirection?: FoldDirection;
	/**
	 * Centres of holding tabs on a closed outline. On a router the bit rises over
	 * each, leaving a bridge `tabWidth` wide and `tabHeight` thick (see
	 * `core/cam/tabs.ts`). A drag knife cannot bridge, so a knife path leaves its
	 * tabs as gaps between open runs instead and does not carry these.
	 */
	readonly holdingTabs?: readonly Point[];
	readonly sheetId?: string;
	readonly bladeOffset?: number;
	readonly overcut?: number;
	/** Per-path overrides used by the calibration coupon. */
	readonly depth?: number;
	readonly feed?: number;
	readonly note?: string;
	readonly foldKey?: string;
	readonly foldLabel?: string;
};

/**
 * Where material is deliberately left in a release cut so the part stays
 * attached to the stock, drawn on the nominal outline: a gap in a knife cut,
 * or a bridge a router rises over. A tab is drawn and broken by hand; it is
 * not a path to machine, so it carries no operation or feed.
 */
export type HoldingTab = {
	readonly points: readonly [Point, Point];
};

export type Geometry = {
	readonly paths: readonly DesignPath[];
	readonly tabs: readonly HoldingTab[];
};

/**
 * The settings that describe how a machine turns geometry into motion: what
 * kind of tool it is, how it compensates, how deep and how fast it goes.
 * Nothing here describes a part.
 */
export type MachineSettings = {
	readonly fabricationMode: FabricationMode;
	readonly safeZ: number;
	readonly cutDepth: number;
	readonly scoreDepth: number;
	readonly scoreTool: ScoreTool;
	readonly cutFeed: number;
	readonly scoreFeed: number;
	readonly plungeFeed: number;
	readonly bladeOffset: number;
	readonly overcut: number;
	readonly cornerStep: number;
	readonly bitWidth: number;
	readonly spindleSpeed: number;
};

/**
 * A named, reusable machine setup. Sheets reference a profile by id rather
 * than restating thirteen settings each, so changing the machine is one edit
 * however many sheets run on it.
 */
export type MachineProfile = MachineSettings & {
	readonly id: string;
	readonly name: string;
};

/**
 * The stock every sheet is cut from, and how the operator measures it. Shared
 * by every workspace: a Solid plate and a packaging deck are both sheets of
 * this board.
 */
export type StockSettings = {
	readonly units: Units;
	/** Board thickness in millimeters. */
	readonly material: number;
	readonly boardFinish: BoardFinish;
	readonly grainDirection: GrainDirection;
	/** Narrowest strip of board left between two cuts before it is flagged. */
	readonly minimumWeb: number;
	/** Holding tabs left in a release cut. */
	readonly tabWidth: number;
	readonly tabCount: number;
	/** Thickness of board a router's bridge tab leaves, above the underside. */
	readonly tabHeight: number;
};

/**
 * A sheet of stock. It is cut on the machine its profile describes and drawn
 * in the vocabulary of its workspace, and programs are emitted per sheet, so
 * both are properties of the sheet.
 */
export type Sheet = {
	readonly id: string;
	readonly name: string;
	/** Which workspace's tools, entities, and rules apply to this sheet. */
	readonly workspace: WorkspaceId;
	/** References `DesignState.machineProfiles`; normalization repairs a dangling id. */
	readonly machineProfileId: string;
};

/**
 * The durable design document.
 *
 * Generic concerns live at the top level; everything a workspace invents lives
 * under `workspaces`, keyed by workspace id. Selection and snap are not here:
 * they are editor state. The active sheet is, so a reopened design shows the
 * sheet it was saved on, but it is excluded from the history signature.
 */
export type DesignState = {
	stock: StockSettings;
	toolpathOrder: ToolpathOrder;
	machineProfiles: MachineProfile[];
	sheets: Sheet[];
	activeSheetId: string;
	workspaces: WorkspaceData;
};

export type DesignFile = {
	readonly format: string;
	readonly version: number;
	readonly savedAt: string;
	readonly design: DesignState;
};

/**
 * The generic document as seen from one sheet: the stock, the machine settings
 * of the profile that sheet is cut on, and `activeSheetId` naming that sheet.
 *
 * Geometry, validation, and CAM are all answered per sheet — "the cut depth"
 * only means something once you know which machine — so they take a view
 * rather than the raw document. Build one with `sheetView` in `machine.ts`; a
 * workspace extends it with its own data.
 */
export type SheetView = StockSettings &
	MachineSettings &
	Pick<DesignState, 'toolpathOrder' | 'sheets' | 'activeSheetId'>;
