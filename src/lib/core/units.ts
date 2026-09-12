import { MM_PER_IN, SNAP } from './constants.js';

export type Units = 'in' | 'mm';

export function round(value: number, places = 3): number {
	return Number(value.toFixed(places));
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Millimeters are canonical; inches exist only for display. */
export function display(mm: number, units: Units): number {
	return units === 'in' ? round(mm / MM_PER_IN, 3) : round(mm, 2);
}

export function parseDisplay(value: string | number, units: Units): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed * (units === 'in' ? MM_PER_IN : 1) : 0;
}

export function snap(mm: number, snapEnabled: boolean): number {
	return snapEnabled ? round(Math.round(mm / SNAP) * SNAP) : mm;
}

export function snapWithin(mm: number, min: number, max: number, snapEnabled: boolean): number {
	return clamp(snap(mm, snapEnabled), min, max);
}
