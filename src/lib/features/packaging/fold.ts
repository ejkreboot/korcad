import { MIN_FLAT_PANEL } from '$lib/core/constants.js';
import { clamp, round } from '$lib/core/units.js';
import type { PackagingView } from './view.js';

export type FoldSettings = Pick<
	PackagingView,
	| 'fabricationMode'
	| 'foldCompensation'
	| 'foldDeduction'
	| 'foldRadiusFactor'
	| 'foldKFactor'
	| 'material'
>;

/**
 * Material removed from a panel's flat width so that the folded part lands on
 * its nominal outside dimension. Router work is cut, not folded, so it never
 * gets a deduction.
 *
 * The computed form is the standard bend-deduction identity
 * `BD = 2 * OSSB - BA`, with the outside setback measured at the bend radius
 * `r = foldRadiusFactor * t` and the bend allowance taken at the neutral axis
 * `r + K * t`.
 */
export function bendDeduction(settings: FoldSettings, angle = Math.PI / 2): number {
	if (settings.fabricationMode !== 'knife') return 0;
	if (settings.foldCompensation === 'manual') return Math.max(0, settings.foldDeduction || 0);
	if (settings.foldCompensation !== 'computed') return 0;
	const thickness = Math.max(0, settings.material);
	if (thickness <= 0) return 0;
	const radius = Math.max(0, settings.foldRadiusFactor ?? 1) * thickness;
	const kFactor = clamp(settings.foldKFactor ?? 0.5, 0, 1);
	return Math.max(
		0,
		2 * (radius + thickness) * Math.tan(angle / 2) - angle * (radius + kFactor * thickness)
	);
}

/** Flat width of a nominal panel after bend deduction, never below the minimum. */
export function flatPanel(nominal: number, settings: FoldSettings): number {
	if (!(nominal > 0)) return nominal;
	return Math.max(MIN_FLAT_PANEL, nominal - bendDeduction(settings));
}

/** True when bend deduction would drive a panel below the folding minimum. */
export function panelClamped(nominal: number, settings: FoldSettings): boolean {
	return nominal > 0 && nominal - bendDeduction(settings) < MIN_FLAT_PANEL;
}

/**
 * Human-readable fold allowance, recorded in the G-code header through
 * `packagingGcode`, since core CAM does not know what a fold is.
 */
export function foldAllowanceLabel(settings: FoldSettings): string {
	if (settings.foldCompensation === 'none') return 'none (panels cut to drawn size)';
	if (settings.foldCompensation === 'manual') {
		return `measured, ${round(bendDeduction(settings), 3)} mm deducted per fold`;
	}
	return (
		`computed, r=${round(settings.foldRadiusFactor ?? 1, 2)}xt K=${round(settings.foldKFactor ?? 0.5, 2)}, ` +
		`${round(bendDeduction(settings), 3)} mm deducted per fold`
	);
}
