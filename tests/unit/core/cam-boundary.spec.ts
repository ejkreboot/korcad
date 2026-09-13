import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Core CAM must not know what a feature's paths mean.
 *
 * It used to classify paths by packaging role strings and owner ids, which made
 * it unusable for anything that was not a packaging insert. That knowledge now
 * travels on each path as `CamIntent`. This guard keeps it from creeping back:
 * a new `role === '…'` test or `pocketId` lookup in core CAM fails here, however
 * convenient it looks at the time.
 *
 * Printing `path.role` in a G-code comment is fine — that is display, not a
 * decision — so only comparisons and prefix tests on the role are rejected. A
 * line that genuinely compares roles only to label its output must say so with
 * a trailing `// cam-boundary: display only`, so every exception is deliberate
 * and visible in review.
 */

const DISPLAY_ONLY = '// cam-boundary: display only';

const camDir = fileURLToPath(new URL('../../../src/lib/core/cam/', import.meta.url));

const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
	[/\brole\s*[!=]==/, 'branches on a path role'],
	[/\brole\??\.(startsWith|endsWith|includes)\(/, 'pattern-matches a path role'],
	[/\b(pocketId|riserId)\b/, 'reads a packaging owner id'],
	[/\bowner\??\.(kind|id)\b/, 'branches on who drew a path'],
	[/\brouteStage\b/, 'reads the removed stage override'],
	[/\b(pockets|supports)\b/, 'reads a packaging collection'],
	[/from '\$lib\/features\//, 'imports a feature module']
];

describe('core CAM boundary', () => {
	const files = readdirSync(camDir).filter((name) => name.endsWith('.ts'));

	it('finds the CAM sources it is guarding', () => {
		expect(files).toEqual(
			expect.arrayContaining(['compensation.ts', 'gcode.ts', 'routing.ts', 'simulation.ts'])
		);
	});

	it('decides nothing from feature vocabulary', () => {
		const violations = files.flatMap((name) =>
			readFileSync(`${camDir}${name}`, 'utf8')
				.split('\n')
				.flatMap((line, index) => {
					if (line.includes(DISPLAY_ONLY)) return [];
					const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
					return FORBIDDEN.filter(([pattern]) => pattern.test(code)).map(
						([, reason]) => `${name}:${index + 1} ${reason}: ${line.trim()}`
					);
				})
		);
		expect(violations).toEqual([]);
	});
});

describe('the boundary guard itself', () => {
	it('rejects the patterns it is meant to', () => {
		const hits = (code: string) => FORBIDDEN.filter(([pattern]) => pattern.test(code)).length;
		expect(hits("if (path.role === 'exterior') return 4;")).toBeGreaterThan(0);
		expect(hits("path.role?.startsWith('perimeter-')")).toBeGreaterThan(0);
		expect(hits('const id = path.riserId;')).toBeGreaterThan(0);
		expect(hits("if (path.owner?.kind === 'support') return 2;")).toBeGreaterThan(0);
		expect(hits("import { x } from '$lib/features/packaging/model.js';")).toBeGreaterThan(0);
		// Reading the stated intent, and printing a role, are both fine.
		expect(hits('return stageIndex(path.cam.stage);')).toBe(0);
		expect(hits("`${path.role || ''}${owner}`")).toBe(0);
		expect(hits('const owner = path.owner ? ` (${path.owner.name})` : "";')).toBe(0);
	});
});

/**
 * The same rule for the whole of `core`: it may not import a feature. The
 * document names workspace data through `WorkspaceDataMap`, which features
 * augment, precisely so that this holds.
 */
describe('core import boundary', () => {
	const coreDir = fileURLToPath(new URL('../../../src/lib/core/', import.meta.url));
	const sources = (readdirSync(coreDir, { recursive: true }) as string[]).filter((name) =>
		name.endsWith('.ts')
	);

	it('finds the core sources it is guarding', () => {
		expect(sources.length).toBeGreaterThan(10);
	});

	it('imports nothing from features, the editor, components, or the viewer', () => {
		const layer = /from '\$lib\/(features|editor|components|viewer)\//;
		const violations = sources.flatMap((name) =>
			readFileSync(`${coreDir}${name}`, 'utf8')
				.split('\n')
				.flatMap((line, index) => (layer.test(line) ? [`${name}:${index + 1} ${line.trim()}`] : []))
		);
		expect(violations).toEqual([]);
	});
});
