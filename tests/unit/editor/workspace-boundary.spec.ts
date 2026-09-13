import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_UI } from '$lib/components/workspaces/index.js';
import { WORKSPACES } from '$lib/features/workspaces.js';

/**
 * The editor shell reaches a workspace only through the two registries —
 * `features/workspaces.ts` for behaviour and `components/workspaces/index.ts`
 * for panels, canvas layer, and 3D viewer. An import of a feature module from
 * the shell would quietly assume that workspace exists on every sheet.
 */

const src = (path: string) => fileURLToPath(new URL(`../../../src/${path}`, import.meta.url));

const SHELL = ['lib/editor/', 'lib/components/editor/', 'routes/'];

describe('the editor shell', () => {
	const files = SHELL.flatMap((dir) =>
		readdirSync(src(dir), { recursive: true, encoding: 'utf8' })
			.filter((name) => /\.(ts|svelte)$/.test(name))
			.map((name) => `${dir}${name}`)
	);

	it('finds the modules it is guarding', () => {
		expect(files).toEqual(
			expect.arrayContaining([
				'lib/editor/state.svelte.ts',
				'lib/components/editor/Canvas.svelte',
				'lib/components/editor/Inspector.svelte',
				'routes/+page.svelte'
			])
		);
	});

	it('imports no workspace feature or workspace UI directly', () => {
		const violations = files.flatMap((name) =>
			readFileSync(src(name), 'utf8')
				.split('\n')
				.flatMap((line, index) =>
					/from '\$lib\/(features|components\/workspaces)\/(?!workspaces\.js|document\.js|index\.js)/.test(
						line
					)
						? [`${name}:${index + 1} ${line.trim()}`]
						: []
				)
		);
		expect(violations).toEqual([]);
	});
});

describe('the UI registry', () => {
	it('has an entry for every workspace, with a 3D viewer exactly when it can assemble', () => {
		for (const workspace of WORKSPACES) {
			const ui = WORKSPACE_UI[workspace.id];
			expect(ui, workspace.id).toBeDefined();
			expect(ui.assembly !== undefined, workspace.id).toBe(workspace.capabilities.assembly);
		}
	});
});
