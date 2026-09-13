import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DesignPath } from '$lib/core/design/types.js';
import { machiningStage, plannedToolpaths } from '$lib/core/cam/routing.js';
import { pathsForOperation } from '$lib/core/cam/gcode.js';
import { allGeometry } from '$lib/features/packaging/model.js';
import { validate } from '$lib/features/packaging/validation.js';
import { FIXTURE_DESIGNS, view } from '../../support/designs.js';

/**
 * Characterization of the two invariants the CAM generalization must preserve:
 * which machining stage every path lands in, and how paths are partitioned and
 * ordered into route chains.
 *
 * Both were once derived inside core CAM from packaging role strings, then in
 * a packaging pass over those strings; now every constructor states its own
 * `CamIntent`. These snapshots were recorded before either move and still
 * hold, which is what made the moves provable rather than hopeful. The
 * `owner=riser` label predates `owner.kind === 'support'` and is kept so the
 * snapshot does not churn.
 *
 * A diff here means the route changed, which means the emitted program changed.
 * Investigate it; do not regenerate it to make the suite pass.
 */

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

function snapshot(name: string, actual: string): void {
	const path = fixture(name);
	if (process.env.UPDATE_GOLDEN === '1' || !existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, actual);
	}
	expect(actual).toBe(readFileSync(path, 'utf8'));
}

/** A path identified by its shape, role, owner, and the stage CAM gives it. */
const describePath = (path: DesignPath) =>
	[
		path.type,
		path.closed ? 'closed' : 'open',
		`role=${path.role ?? '-'}`,
		path.owner?.kind === 'pocket'
			? 'owner=pocket'
			: path.owner?.kind === 'support'
				? 'owner=riser'
				: 'owner=-',
		`stage=${machiningStage(path)}`
	].join(' ');

describe('CAM stage assignment', () => {
	it('records every distinct path shape and the stage it lands in', () => {
		const lines: string[] = [];
		for (const [name, build] of FIXTURE_DESIGNS) {
			const design = build();
			for (const sheet of design.sheets) {
				const paths = allGeometry({ ...design, activeSheetId: sheet.id }).paths;
				if (!paths.length) continue;
				lines.push(`# ${name} / sheet ${sheet.id}`);
				const seen = new Map<string, number>();
				for (const path of paths) {
					const key = describePath(path);
					seen.set(key, (seen.get(key) ?? 0) + 1);
				}
				for (const key of [...seen.keys()].sort()) lines.push(`  ${seen.get(key)}x ${key}`);
				lines.push('');
			}
		}
		snapshot('cam/stage-assignment.txt', lines.join('\n'));
	});

	it('keeps every fixture legal to export, so the routes are real routes', () => {
		for (const [name, build] of FIXTURE_DESIGNS) {
			expect({ name, diagnostics: validate(build()) }).toEqual({ name, diagnostics: [] });
		}
	});
});

describe('CAM route partition', () => {
	it('records the chain partition and its order for every fixture', () => {
		const lines: string[] = [];
		for (const [name, build] of FIXTURE_DESIGNS) {
			const design = build();
			for (const sheet of design.sheets) {
				for (const operation of ['crease', 'cut'] as const) {
					const all = allGeometry({ ...design, activeSheetId: sheet.id }).paths;
					const paths = pathsForOperation(all, operation);
					if (!paths.length) continue;
					const plan = plannedToolpaths(paths, view(design, sheet.id), operation);
					if (!plan.paths.length) continue;
					lines.push(`# ${name} / sheet ${sheet.id} / ${operation} (${plan.strategy})`);
					plan.paths.forEach((entry, index) => {
						// One line per route entry, in machining order. `sources` is how
						// many design paths were merged into this chain.
						const roles = [...new Set(entry.sourcePaths.map((p) => p.role ?? '-'))].sort();
						lines.push(
							`  ${String(index).padStart(2, '0')} stage=${machiningStage(entry.path)} ` +
								`sources=${entry.sourcePaths.length} roles=${roles.join(',')}`
						);
					});
					lines.push('');
				}
			}
		}
		snapshot('cam/route-partition.txt', lines.join('\n'));
	});
});
