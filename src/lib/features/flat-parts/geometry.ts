import {
	holdingTabCentres,
	regularPolygon,
	shapeOutline,
	splitClosedContour
} from '$lib/core/geometry/outline.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import type { DesignPath, DesignState, Geometry, HoldingTab } from '$lib/core/design/types.js';
import type { FlatPartsEntity } from './types.js';
import { flatPartsSheetView, type FlatPartsView } from './view.js';

/** The drawn outline of an entity, counter-clockwise; an imported path is stored that way. */
export function entityOutline(entity: FlatPartsEntity): Point[] {
	switch (entity.shape) {
		case 'polygon':
			return regularPolygon(entity, entity.sides);
		case 'slot':
			// A radius of zero is fully rounded: a slot's ends are half-circles.
			return shapeOutline('rounded', entity, 0);
		case 'path':
			return entity.outline.map((vertex) => ({
				x: entity.x + vertex.x * entity.w,
				y: entity.y + vertex.y * entity.h
			}));
		default:
			return shapeOutline(entity.shape, entity, entity.cornerRadius);
	}
}

const owner = (entity: FlatPartsEntity) => ({
	kind: entity.kind,
	id: entity.id,
	name: entity.name
});

/**
 * A hole goes through a part, so it is cut inside its line — the hole keeps its
 * size — and before the profile that frees the part, while the part is still
 * held by the sheet.
 */
function holePath(entity: FlatPartsEntity): DesignPath {
	return {
		points: entityOutline(entity),
		type: 'cut',
		closed: true,
		cam: { offsetSide: 'inside', stage: 'interior', chainKey: null },
		role: entity.shape === 'slot' ? 'slot' : 'hole',
		owner: owner(entity)
	};
}

/**
 * A profile frees a part, so it is cut outside its line — the part keeps its
 * size — and after every hole in it.
 *
 * Holding tabs keep the freed part from moving under the tool. A drag knife
 * leaves them as gaps: the release cut is broken into open runs chained around
 * the outline. A router leaves them as bridges: the outline stays one closed
 * contour, because compensation offsets closed outlines, and carries the tab
 * centres so CAM can rise over each after it has offset and routed the cut.
 * Either way the tabs drawn on the canvas are the same stretches of outline.
 */
function profileGeometry(entity: FlatPartsEntity, view: FlatPartsView): Geometry {
	const outline = entityOutline(entity);
	const cam = { offsetSide: 'outside', stage: 'part-release' } as const;
	const tabbed = splitClosedContour(outline, entity.tabCount, view.tabWidth);
	const tabs = tabbed.tabs.map((points): HoldingTab => ({ points }));
	const closedProfile: DesignPath = {
		points: outline,
		type: 'cut',
		closed: true,
		cam: { ...cam, chainKey: null },
		role: 'profile',
		owner: owner(entity)
	};
	if (!tabs.length) return { paths: [closedProfile], tabs: [] };
	if (view.fabricationMode === 'router') {
		const holdingTabs = holdingTabCentres(outline, entity.tabCount, view.tabWidth);
		return { paths: [{ ...closedProfile, holdingTabs }], tabs };
	}
	return {
		paths: tabbed.runs.map((points) => ({
			points,
			type: 'cut' as const,
			closed: false,
			cam: { ...cam, chainKey: `flat-parts-profile:${entity.id}` },
			role: 'profile',
			owner: owner(entity)
		})),
		tabs
	};
}

/** All flat geometry of one Flat Parts sheet: holes, then the profiles that free each part. */
export function flatPartsGeometry(design: DesignState, sheetId = design.activeSheetId): Geometry {
	const view = flatPartsSheetView(design, sheetId);
	const holes = view.entities.filter((entity) => entity.kind === 'hole').map(holePath);
	const profiles = view.entities
		.filter((entity) => entity.kind === 'profile')
		.map((entity) => profileGeometry(entity, view));
	return {
		paths: [...holes, ...profiles.flatMap((profile) => profile.paths)],
		tabs: profiles.flatMap((profile) => profile.tabs)
	};
}
