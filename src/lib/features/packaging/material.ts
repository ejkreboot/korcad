import { presetChoice, presetNumber } from '$lib/core/design/material.js';
import type { WorkspaceMaterial } from '../workspaces.js';
import type { FoldCompensation, PackagingData } from './types.js';
import { withPackaging } from './view.js';

/**
 * How a board's folds are allowed for depends on the board, its thickness
 * and how it creases, so the fold allowance travels with a material preset.
 */
type FoldAllowance = Pick<
	PackagingData,
	'foldCompensation' | 'foldRadiusFactor' | 'foldKFactor' | 'foldDeduction'
>;

const FOLD_COMPENSATIONS: readonly FoldCompensation[] = ['none', 'computed', 'manual'];

function foldAllowance(value: unknown): FoldAllowance {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Material preset: the packaging settings must be an object.');
	}
	const values: Readonly<Record<string, unknown>> = { ...value };
	return {
		foldCompensation: presetChoice(values, 'foldCompensation', FOLD_COMPENSATIONS),
		foldRadiusFactor: presetNumber(values, 'foldRadiusFactor'),
		foldKFactor: presetNumber(values, 'foldKFactor'),
		foldDeduction: presetNumber(values, 'foldDeduction')
	};
}

export const PACKAGING_MATERIAL: WorkspaceMaterial = {
	read(design) {
		const data = design.workspaces.packaging;
		return data ? foldAllowance(data) : null;
	},
	parse: foldAllowance,
	apply(design, values) {
		const allowance = foldAllowance(values);
		return withPackaging(design, (data) => ({ ...data, ...allowance }));
	}
};
