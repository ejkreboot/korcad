import { SHEET } from '$lib/core/constants.js';
import {
	outlineBounds,
	outlineDistance,
	outlineInside,
	selfIntersects
} from '$lib/core/geometry/contour.js';
import type { DesignState } from '$lib/core/design/types.js';
import { round } from '$lib/core/units.js';
import { entityOutline } from './geometry.js';
import type { SolidEntity } from './types.js';
import { solidSheetView } from './view.js';

/** Smallest box an entity may be drawn in, in millimeters. */
export const MIN_SOLID_ENTITY = 1;

const WEB_TOLERANCE = 1e-6;

/**
 * Manufacturability of every Solid sheet, each against its own machine.
 * Messages name the entity, so the operator can find it.
 */
export function validateSolid(design: DesignState): string[] {
	return design.sheets
		.filter((sheet) => sheet.workspace === 'solid')
		.flatMap((sheet) => validateSheet(design, sheet.id));
}

function validateSheet(design: DesignState, sheetId: string): string[] {
	const view = solidSheetView(design, sheetId);
	const errors: string[] = [];
	const router = view.fabricationMode === 'router';
	const web = view.minimumWeb;
	const outlines = new Map<SolidEntity, ReturnType<typeof entityOutline>>();
	const sized = view.entities.filter((entity) => {
		if (entity.w < MIN_SOLID_ENTITY || entity.h < MIN_SOLID_ENTITY) {
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
	const outline = (entity: SolidEntity) => outlines.get(entity)!;

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
		if (!router && profile.tabCount > 0 && view.tabWidth <= 0) {
			errors.push(`${profile.name}: holding tabs need a tab width`);
		}
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

	const parents = new Map<SolidEntity, SolidEntity>();
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
