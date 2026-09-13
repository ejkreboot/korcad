import { regularPolygon, shapeOutline, splitClosedContour } from '$lib/core/geometry/outline.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import type { DesignPath, DesignState, Geometry, HoldingTab } from '$lib/core/design/types.js';
import type { SolidEntity } from './types.js';
import { solidSheetView, type SolidView } from './view.js';

/** The drawn outline of an entity, counter-clockwise. */
export function entityOutline(entity: SolidEntity): Point[] {
	switch (entity.shape) {
		case 'polygon':
			return regularPolygon(entity, entity.sides);
		case 'slot':
			// A radius of zero is fully rounded: a slot's ends are half-circles.
			return shapeOutline('rounded', entity, 0);
		default:
			return shapeOutline(entity.shape, entity, entity.cornerRadius);
	}
}

const owner = (entity: SolidEntity) => ({ kind: entity.kind, id: entity.id, name: entity.name });

/**
 * A hole goes through a part, so it is cut inside its line — the hole keeps its
 * size — and before the profile that frees the part, while the part is still
 * held by the sheet.
 */
function holePath(entity: SolidEntity): DesignPath {
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
 * On a drag knife, holding tabs break the release cut into open runs chained
 * around the outline. A router cuts the whole compensated contour: core
 * compensation offsets closed outlines only, and an open run has no inside or
 * outside for it to offset toward, so tabs are not offered there.
 */
function profileGeometry(entity: SolidEntity, view: SolidView): Geometry {
	const outline = entityOutline(entity);
	const cam = { offsetSide: 'outside', stage: 'part-release' } as const;
	const tabbed =
		view.fabricationMode === 'knife'
			? splitClosedContour(outline, entity.tabCount, view.tabWidth)
			: null;
	if (!tabbed?.tabs.length) {
		return {
			paths: [
				{
					points: outline,
					type: 'cut',
					closed: true,
					cam: { ...cam, chainKey: null },
					role: 'profile',
					owner: owner(entity)
				}
			],
			tabs: []
		};
	}
	return {
		paths: tabbed.runs.map((points) => ({
			points,
			type: 'cut' as const,
			closed: false,
			cam: { ...cam, chainKey: `solid-profile:${entity.id}` },
			role: 'profile',
			owner: owner(entity)
		})),
		tabs: tabbed.tabs.map((points): HoldingTab => ({ points }))
	};
}

/** All flat geometry of one Solid sheet: holes, then the profiles that free each part. */
export function solidGeometry(design: DesignState, sheetId = design.activeSheetId): Geometry {
	const view = solidSheetView(design, sheetId);
	const holes = view.entities.filter((entity) => entity.kind === 'hole').map(holePath);
	const profiles = view.entities
		.filter((entity) => entity.kind === 'profile')
		.map((entity) => profileGeometry(entity, view));
	return {
		paths: [...holes, ...profiles.flatMap((profile) => profile.paths)],
		tabs: profiles.flatMap((profile) => profile.tabs)
	};
}
