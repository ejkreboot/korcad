import { referencedProfiles } from './machine.js';
import type { DesignState, MachineProfile, MachineSettings } from './types.js';

type NumericSetting = {
	[K in keyof MachineSettings]: MachineSettings[K] extends number ? K : never;
}[keyof MachineSettings];

/** Settings every program moves by: a zero or negative one plunges, stalls, or travels in the work. */
const POSITIVE: readonly (readonly [NumericSetting, string])[] = [
	['safeZ', 'safe Z'],
	['cutDepth', 'cut depth'],
	['cutFeed', 'cut feed'],
	['scoreFeed', 'score feed'],
	['plungeFeed', 'plunge feed'],
	['cornerStep', 'corner step']
];

const NONNEGATIVE: readonly (readonly [NumericSetting, string])[] = [
	['scoreDepth', 'score depth'],
	['bladeOffset', 'blade offset'],
	['overcut', 'overcut']
];

/** Settings only a router reads; a knife profile may leave them at anything. */
const ROUTER_POSITIVE: readonly (readonly [NumericSetting, string])[] = [
	['bitWidth', 'bit diameter'],
	['spindleSpeed', 'spindle speed'],
	['passDepth', 'depth per pass']
];

/**
 * Machine settings that make any program unsafe, whichever workspace drew the
 * sheet. Every profile a sheet is cut on is checked, and each message names
 * the profile, because the operator fixes it in the Machine panel rather than
 * on the drawing. Profiles no sheet uses cannot emit a program, so they are not
 * held against the design.
 */
export function validateMachineSettings(design: DesignState): string[] {
	const errors: string[] = [];
	if (!positive(design.stock.material)) errors.push('Material thickness must be positive');
	for (const profile of referencedProfiles(design)) errors.push(...profileErrors(profile));
	return errors;
}

function profileErrors(profile: MachineProfile): string[] {
	const errors: string[] = [];
	const named = (label: string, rule: string) => `${profile.name}: ${label} must be ${rule}`;
	for (const [key, label] of POSITIVE) {
		if (!positive(profile[key])) errors.push(named(label, 'positive'));
	}
	for (const [key, label] of NONNEGATIVE) {
		if (!(Number.isFinite(profile[key]) && profile[key] >= 0)) {
			errors.push(named(label, 'zero or more'));
		}
	}
	if (profile.fabricationMode === 'router') {
		for (const [key, label] of ROUTER_POSITIVE) {
			if (!positive(profile[key])) errors.push(named(label, 'positive'));
		}
	}
	return errors;
}

const positive = (value: number) => Number.isFinite(value) && value > 0;
