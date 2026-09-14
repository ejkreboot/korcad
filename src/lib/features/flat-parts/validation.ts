import { SHEET } from '$lib/core/constants.js';
import {
	outlineBounds,
	outlineDistance,
	outlineInside,
	selfIntersects
} from '$lib/core/geometry/contour.js';
import type { DesignState } from '$lib/core/design/types.js';
import type { Point } from '$lib/core/geometry/primitives.js';
import { bridgeTabZ } from '$lib/core/cam/tabs.js';
import { round } from '$lib/core/units.js';
import { entityOutline } from './geometry.js';
import type { FlatPartsEntity } from './types.js';
import { flatPartsSheetView, type FlatPartsView } from './view.js';

/** Smallest box an entity may be drawn in, in millimeters. */
export const MIN_FLAT_PARTS_ENTITY = 1;

const WEB_TOLERANCE = 1e-6;

/**
 * Manufacturability of every Flat Parts sheet, each against its own machine.
 * Messages name the entity, so the operator can find it.
 */
export function validateFlatParts(design: DesignState): string[] {
	return design.sheets
		.filter((sheet) => sheet.workspace === 'flatParts')
		.flatMap((sheet) => validateSheet(design, sheet.id));
}

function validateSheet(design: DesignState, sheetId: string): string[] {
	const view = flatPartsSheetView(design, sheetId);
	const errors: string[] = [];
	const router = view.fabricationMode === 'router';
	const web = view.minimumWeb;
	const outlines = new Map<FlatPartsEntity, ReturnType<typeof entityOutline>>();
	const sized = view.entities.filter((entity) => {
		if (entity.w < MIN_FLAT_PARTS_ENTITY || entity.h < MIN_FLAT_PARTS_ENTITY) {
			errors.push(`${entity.name}: is too small to cut`);
			return false;
		}
		const outline = entityOutline(entity);
		outlines.set(entity, outline);
		if (selfIntersects(outline)) errors.push(`${entity.name}: outline crosses itself`);
		return true;
	});
	const profiles = sized.filter((entity) => entity.kind === 'profile');
	const holes = sized.filter((entity) => entity.kind === 'hole');
	const outline = (entity: FlatPartsEntity) => outlines.get(entity)!;

	for (const profile of profiles) {
		// A router cuts outside the line, so the bit's far edge must stay on the stock.
		const margin = router ? view.bitWidth / 2 : 0;
		const bounds = outlineBounds(outline(profile));
		if (
			bounds.left - margin < 0 ||
			bounds.bottom - margin < 0 ||
			bounds.right + margin > SHEET ||
			bounds.top + margin > SHEET
		) {
			errors.push(`${profile.name}: does not fit the sheet`);
		}
		if (profile.tabCount > 0) errors.push(...tabErrors(profile, outline(profile), view));
	}

	profiles.forEach((profile, index) => {
		for (const other of profiles.slice(index + 1)) {
			// Both release cuts run outside their lines, so on a router the strip
			// between them loses a full bit width.
			const needed = web + (router ? view.bitWidth : 0);
			const nested =
				outlineInside(outline(profile), outline(other)) ||
				outlineInside(outline(other), outline(profile));
			if (nested || outlineDistance(outline(profile), outline(other)) + WEB_TOLERANCE < needed) {
				errors.push(
					`${profile.name} and ${other.name}: leave less than the ${round(web, 2)} mm minimum web between them`
				);
			}
		}
	});

	const parents = new Map<FlatPartsEntity, FlatPartsEntity>();
	for (const hole of holes) {
		const parent = profiles.find((profile) => outlineInside(outline(hole), outline(profile)));
		if (!parent) {
			errors.push(`${hole.name}: is not inside a part`);
			continue;
		}
		parents.set(hole, parent);
		if (outlineDistance(outline(hole), outline(parent)) + WEB_TOLERANCE < web) {
			errors.push(`${hole.name}: leaves less than the minimum web to the edge of ${parent.name}`);
		}
	}

	holes.forEach((hole, index) => {
		for (const other of holes.slice(index + 1)) {
			if (!parents.has(hole) || parents.get(hole) !== parents.get(other)) continue;
			const nested =
				outlineInside(outline(hole), outline(other)) ||
				outlineInside(outline(other), outline(hole));
			if (nested || outlineDistance(outline(hole), outline(other)) + WEB_TOLERANCE < web) {
				errors.push(`${hole.name} and ${other.name}: leave less than the minimum web between them`);
			}
		}
	});

	return [...new Set(errors)];
}

/**
 * Whether a part's holding tabs can be cut. On a router a tab is a bridge the
 * bit rises over for the tab width plus a bit width, and it must sit above the
 * floor of the cut and below the top of the board, or the program would cut
 * straight through it or lift out of the work.
 */
function tabErrors(
	profile: FlatPartsEntity,
	outline: readonly Point[],
	view: FlatPartsView
): string[] {
	if (view.tabWidth <= 0) return [`${profile.name}: holding tabs need a tab width`];
	const router = view.fabricationMode === 'router';
	const errors: string[] = [];
	const perimeter = outline.reduce((sum, vertex, index) => {
		const next = outline[(index + 1) % outline.length]!;
		return sum + Math.hypot(next.x - vertex.x, next.y - vertex.y);
	}, 0);
	const span = view.tabWidth + (router ? view.bitWidth : 0);
	if (profile.tabCount * span >= perimeter) {
		errors.push(`${profile.name}: holding tabs leave no room to cut between them`);
	}
	if (router) {
		if (view.tabHeight <= 0 || view.tabHeight >= view.material) {
			errors.push(`${profile.name}: holding tabs must be thinner than the board`);
		} else if (bridgeTabZ(view) <= -view.cutDepth) {
			errors.push(`${profile.name}: the cut depth stops above the holding tabs`);
		}
	}
	return errors;
}
