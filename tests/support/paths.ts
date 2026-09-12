import type { CamIntent, DesignPath } from '$lib/core/design/types.js';

/**
 * Intent for a path built by hand in a test.
 *
 * Defaults to the least surprising reading of its type — a score on the line,
 * machined first; a cut as a standalone interior hole — so a test only states
 * the part of the intent it is actually about. A test that depends on chaining
 * or a release stage has to say so, which is the point: CAM no longer infers
 * either from a role name.
 */
export function intent(type: DesignPath['type'], overrides: Partial<CamIntent> = {}): CamIntent {
	return {
		offsetSide: type === 'score' ? 'on' : 'inside',
		stage: type === 'score' ? 'score' : 'interior',
		chainKey: null,
		...overrides
	};
}
