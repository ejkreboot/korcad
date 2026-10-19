import { cutDepth, referencedProfiles } from './machine.js';
import type { DesignState, MachineProfile, MachineSettings } from './types.js';

type NumericSetting = {
	[K in keyof MachineSettings]: MachineSettings[K] extends number ? K : never;
}[keyof MachineSettings];

/** Settings every program moves by: a zero or negative one plunges, stalls, or travels in the work. */
const POSITIVE: readonly (readonly [NumericSetting, string])[] = [
	['safeZ', 'safe Z'],
	['cutFeed', 'cut feed'],
	['scoreFeed', 'score feed'],
	['plungeFeed', 'plunge feed'],
	['cornerStep', 'corner step']
];

const NONNEGATIVE: readonly (readonly [NumericSetting, string])[] = [
	['cutPast', 'cut past material'],
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
 * the profile, because the operator fixes it in the Tool panel rather than
 * on the drawing. Profiles no sheet uses cannot emit a program, so they are not
 * held against the design.
 */
export function validateMachineSettings(design: DesignState): string[] {
	const errors: string[] = [];
	if (!positive(design.stock.material)) errors.push('Material thickness must be positive');
	for (const profile of referencedProfiles(design)) {
		errors.push(...profileErrors(profile, design.stock.material));
	}
	return errors;
}

function profileErrors(profile: MachineProfile, material: number): string[] {
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
	} else {
		errors.push(...knifeErrors(profile, cutDepth(material, profile.cutPast), named));
	}
	return errors;
}

/**
 * A knife's passes are counted, not measured, so a fraction is a typo. Its
 * swivel only spares the board if the blade turns shallower than it then
 * cuts, so a swivel as deep as the first pass is refused rather than run.
 * A blade that trails the axis needs some swivel depth: without it the blade
 * plunges at whatever heading it was left on, unknown at the start of every
 * program, and is dragged round at full depth, and it has nowhere to lift to
 * at a sharp corner. Its lift angle is at most 90°, so an acute corner is always turned lifted,
 * never torn round at depth.
 */
function knifeErrors(
	profile: MachineProfile,
	depth: number,
	named: (label: string, rule: string) => string
): string[] {
	const errors: string[] = [];
	const passes = profile.knifePasses;
	if (!(Number.isInteger(passes) && passes >= 1)) {
		errors.push(named('passes', 'a whole number, 1 or more'));
	}
	const swivel = profile.swivelDepth;
	if (!(Number.isFinite(swivel) && swivel >= 0)) {
		errors.push(named('swivel depth', 'zero or more'));
	} else if (swivel === 0 && profile.bladeOffset > 0) {
		errors.push(named('swivel depth', 'more than zero for a blade with an offset'));
	} else if (Number.isInteger(passes) && passes >= 1 && swivel >= depth / passes) {
		errors.push(named('swivel depth', 'shallower than one pass of the cut depth'));
	}
	const angle = profile.liftAngle;
	if (!(Number.isFinite(angle) && angle > 0 && angle <= 90)) {
		errors.push(named('lift angle', 'more than 0° and at most 90°'));
	}
	const radius = profile.liftRadius;
	if (!(Number.isFinite(radius) && radius >= 0)) {
		errors.push(named('lift radius', 'zero or more'));
	}
	return errors;
}

const positive = (value: number) => Number.isFinite(value) && value > 0;
