<script lang="ts">
	import { onMount } from 'svelte';
	import type * as ThreeModule from 'three';
	import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
	import { buildAssembly } from '$lib/features/packaging/assembly.js';
	import {
		applyDeckOpacity,
		buildScene,
		createPaperTexture,
		disposeGroup,
		type BuiltScene
	} from '$lib/viewer/assembly-scene.js';
	import { resolveDrop, supportUnderPoint } from '$lib/features/packaging/anchoring.js';
	import { packagingView } from '$lib/features/packaging/view.js';
	import { supportAssemblyOrigin } from '$lib/features/packaging/mounting.js';
	import type { EditorState } from '$lib/editor/state.svelte.js';
	import { packagingActions } from '$lib/features/packaging/actions.js';
	import type { ToolState } from '$lib/editor/tools.svelte.js';
	import type { Point } from '$lib/core/geometry/primitives.js';
	import type { Support } from '$lib/features/packaging/types.js';
	import { display } from '$lib/core/units.js';

	let { editor, tools }: { editor: EditorState; tools: ToolState } = $props();

	/**
	 * How solid the deck is drawn. Anything below 1 lets the operator see the
	 * supports that sit inside the box.
	 */
	const DECK_OPACITIES = [
		{ value: 1, label: 'Solid' },
		{ value: 0.58, label: 'Translucent' },
		{ value: 0.22, label: 'Ghosted' },
		{ value: 0, label: 'Hidden' }
	] as const;
	const actions = $derived(packagingActions(editor));

	/**
	 * The assembled description of the current design. Everything geometric is
	 * decided here, in framework-free code; this component only owns the
	 * renderer's lifecycle and the pointer gestures.
	 */
	const assembly = $derived(buildAssembly(editor.design, actions.selectedSupportId));
	/**
	 * Dropping resolves anchors and heights, which depend on the machine, and
	 * lands on the snap grid when snap is on.
	 */
	const view = $derived({ ...packagingView(editor.design), snapEnabled: tools.snapEnabled });

	type Runtime = {
		readonly THREE: typeof ThreeModule;
		readonly renderer: ThreeModule.WebGLRenderer;
		readonly scene: ThreeModule.Scene;
		readonly camera: ThreeModule.PerspectiveCamera;
		readonly controls: OrbitControls;
		readonly paperTexture: ThreeModule.Texture;
		readonly raycaster: ThreeModule.Raycaster;
		readonly dragPlane: ThreeModule.Plane;
	};

	let host = $state<HTMLDivElement>();
	let canvas = $state<HTMLCanvasElement>();
	let ready = $state(false);
	let failed = $state('');
	/** Imperative renderer state, deliberately outside the reactive graph. */
	let runtime: Runtime | null = null;
	let built: BuiltScene | null = null;
	let needsFit = true;
	let drag = $state<{
		pointerId: number;
		supportId: string;
		group: ThreeModule.Object3D;
		/** Pointer offset within the part, so it does not jump to the cursor. */
		grab: Point;
		/** Live global assembly position, resolved into a mount on drop. */
		global: Point;
		/** The support it would stack on if dropped now, for the readout. */
		hostName: string | null;
	} | null>(null);

	const selected = $derived(
		actions.view.supports.find((support) => support.id === actions.selectedSupportId) ?? null
	);
	const units = $derived(editor.design.stock.units);
	const readout = $derived.by(() => {
		if (!selected) return 'Drag a support to position it';
		const origin = supportAssemblyOrigin(selected, actions.view.supports);
		const places = units === 'in' ? 3 : 1;
		const position = `X ${display(origin.x, units).toFixed(places)} · Y ${display(
			origin.y,
			units
		).toFixed(places)} ${units}`;
		// Dropping picks a surface, so say which one before the button comes up.
		if (drag?.supportId === selected.id && drag.hostName) {
			return `${selected.name} · ${position} · drop to stack on ${drag.hostName}`;
		}
		return `${selected.name} · ${position} · ${anchorLabel(selected)}`;
	});

	/** Plain-language name for the surface a support is built from. */
	function anchorLabel(item: Support): string {
		const { mount } = item;
		switch (mount.anchor) {
			case 'box-floor':
				return 'on the box floor';
			case 'deck-top':
				return 'on the top deck';
			case 'deck-underside':
				return 'under the top deck';
			case 'support-top': {
				const host = actions.view.supports.find((candidate) => candidate.id === mount.supportId);
				return host ? `on ${host.name}` : 'on a missing support';
			}
		}
	}

	function render(): void {
		if (!runtime) return;
		runtime.renderer.render(runtime.scene, runtime.camera);
	}

	function resize(): void {
		if (!runtime || !canvas) return;
		// Measured from the canvas itself rather than its wrapper: the wrapper may
		// carry padding, and a drawing buffer sized to the padding box would be
		// stretched across a smaller canvas.
		const width = Math.max(1, canvas.clientWidth);
		const height = Math.max(1, canvas.clientHeight);
		runtime.renderer.setSize(width, height, false);
		runtime.camera.aspect = width / height;
		runtime.camera.updateProjectionMatrix();
		render();
	}

	/**
	 * Frames the whole deck from over the lower-left corner, which is the 2D
	 * editor's origin, so the two views agree on which corner is which.
	 *
	 * The distance is solved from the model's bounding sphere against the
	 * narrower of the two fields of view, so the deck stays fully framed on a
	 * wide desktop pane and a tall phone alike.
	 */
	function fitCamera(): void {
		if (!runtime) return;
		const { camera, controls } = runtime;
		const width = Math.max(assembly.deckW, 1);
		const depth = Math.max(assembly.deckH, 1);
		const height = Math.max(assembly.deckSurfaceZ, 1);
		const radius = Math.hypot(width, depth, height) / 2;

		const targetZ = assembly.deckSurfaceZ * 0.28;
		controls.target.set(width / 2, depth / 2, targetZ);

		const verticalFov = (camera.fov * Math.PI) / 180;
		const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * Math.max(camera.aspect, 0.1));
		// A 6% margin keeps the board off the edge of the pane.
		const distance = (radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2)) * 1.06;

		// A three-quarter view: low and to the near-left, looking back and down.
		const direction = new runtime.THREE.Vector3(-0.92, -1.05, 0.9).normalize();
		camera.position.copy(controls.target).addScaledVector(direction, distance);
		camera.near = Math.max(0.5, distance / 1000);
		camera.far = distance * 8;
		camera.updateProjectionMatrix();
		controls.update();
		needsFit = false;
		render();
	}

	/** Replaces the whole scene group. Cheap enough that edits need no diffing. */
	function rebuild(): void {
		if (!runtime) return;
		disposeGroup(built?.root ?? null);
		built = buildScene(assembly, runtime.paperTexture);
		runtime.scene.add(built.root);
		applyDeckOpacity(built.deckObjects, tools.deckOpacity);
		resize();
		if (needsFit) fitCamera();
		render();
	}

	/** Pointer position on the horizontal plane just above the deck surface. */
	function planePoint(event: PointerEvent): Point | null {
		if (!runtime || !canvas) return null;
		const rect = canvas.getBoundingClientRect();
		const ndc = new runtime.THREE.Vector2(
			((event.clientX - rect.left) / rect.width) * 2 - 1,
			-((event.clientY - rect.top) / rect.height) * 2 + 1
		);
		runtime.raycaster.setFromCamera(ndc, runtime.camera);
		const hit = new runtime.THREE.Vector3();
		if (!runtime.raycaster.ray.intersectPlane(runtime.dragPlane, hit)) return null;
		return { x: hit.x, y: hit.y };
	}

	function supportIdAt(event: PointerEvent): {
		supportId: string;
		group: ThreeModule.Object3D;
	} | null {
		if (!runtime || !built || !canvas) return null;
		const rect = canvas.getBoundingClientRect();
		runtime.raycaster.setFromCamera(
			new runtime.THREE.Vector2(
				((event.clientX - rect.left) / rect.width) * 2 - 1,
				-((event.clientY - rect.top) / rect.height) * 2 + 1
			),
			runtime.camera
		);
		const hit = runtime.raycaster.intersectObjects([...built.supportTargets], true)[0];
		if (!hit) return null;
		// The support id lives on the group, so walk up from the mesh that was hit.
		let current: ThreeModule.Object3D | null = hit.object;
		while (current && !current.userData.supportId) current = current.parent;
		const supportId = current?.userData.supportId;
		return typeof supportId === 'string' && current ? { supportId, group: current } : null;
	}

	function beginDrag(event: PointerEvent): void {
		if (!runtime || !canvas || event.button !== 0) return;
		const target = supportIdAt(event);
		if (!target) return;
		const support = actions.view.supports.find((item) => item.id === target.supportId);
		if (!support) return;
		event.preventDefault();
		// Orbiting and dragging share the left button, so the grab must win.
		event.stopImmediatePropagation();
		runtime.dragPlane.constant = -(assembly.deckSurfaceZ + 1);
		const start = planePoint(event);
		if (!start) return;
		actions.selectSupport(support.id);
		editor.setActiveSheet(support.sheetId);
		const origin = supportAssemblyOrigin(support, actions.view.supports);
		drag = {
			pointerId: event.pointerId,
			supportId: support.id,
			group: target.group,
			grab: { x: start.x - origin.x, y: start.y - origin.y },
			global: origin,
			hostName: null
		};
		runtime.controls.enabled = false;
		canvas.setPointerCapture(event.pointerId);
	}

	function moveDrag(event: PointerEvent): void {
		if (!drag || event.pointerId !== drag.pointerId) return;
		const support = actions.view.supports.find((item) => item.id === drag?.supportId);
		const current = planePoint(event);
		if (!support || !current) return;

		const global = { x: current.x - drag.grab.x, y: current.y - drag.grab.y };
		drag.global = global;
		// The mount itself is only decided on release, so the part does not
		// re-parent and change height under the pointer mid-gesture.
		const host = supportUnderPoint(
			support,
			global.x + support.w / 2,
			global.y + support.d / 2,
			view
		);
		drag.hostName = host?.name ?? null;

		const placed = resolveDrop(support, global.x, global.y, view);
		actions.previewSupport(support.id, {
			assemblyX: placed.assemblyX,
			assemblyY: placed.assemblyY
		});
		// The scene is not rebuilt mid-gesture; the group is moved instead, which
		// keeps a drag at one translation per frame rather than a full rebuild.
		const moved = actions.view.supports.find((item) => item.id === drag?.supportId);
		if (moved) {
			const next = supportAssemblyOrigin(moved, actions.view.supports);
			drag.group.position.x = next.x;
			drag.group.position.y = next.y;
		}
		render();
	}

	function endDrag(event: PointerEvent): void {
		if (!drag || event.pointerId !== drag.pointerId) return;
		const support = actions.view.supports.find((item) => item.id === drag?.supportId);
		if (support) {
			// The drop chooses a surface, never a bare Z: `resolveDrop` turns the
			// landing position into a mount, and the height follows from it.
			actions.previewSupport(support.id, resolveDrop(support, drag.global.x, drag.global.y, view));
		}
		drag = null;
		if (runtime) runtime.controls.enabled = true;
		// One gesture becomes one undo step, then the scene catches up.
		editor.commit();
		rebuild();
	}

	onMount(() => {
		let disposed = false;
		let observer: ResizeObserver | null = null;

		// Three.js is loaded on demand and only in the browser: it must never run
		// during server-side rendering, and the 2D editor should not pay for it.
		(async () => {
			try {
				const [THREE, controlsModule] = await Promise.all([
					import('three'),
					import('three/addons/controls/OrbitControls.js')
				]);
				if (disposed || !canvas || !host) return;

				const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
				renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
				renderer.outputColorSpace = THREE.SRGBColorSpace;
				renderer.toneMapping = THREE.ACESFilmicToneMapping;
				renderer.toneMappingExposure = 1.08;
				renderer.shadowMap.enabled = true;
				// PCF does Vogel-disk soft sampling as of three 0.186, which
				// replaced the removed PCFSoftShadowMap; softness is set per light
				// through `shadow.radius` below.
				renderer.shadowMap.type = THREE.PCFShadowMap;
				renderer.setClearColor(0xe7ebee, 1);

				const scene = new THREE.Scene();
				scene.fog = new THREE.Fog(0xe7ebee, 1500, 3500);
				// Z is up, to match the machine and the 2D editor.
				const camera = new THREE.PerspectiveCamera(31, 1, 0.5, 5000);
				camera.up.set(0, 0, 1);

				const controls = new controlsModule.OrbitControls(camera, canvas);
				controls.enableDamping = false;
				controls.screenSpacePanning = true;
				// Stop just short of the horizon so the model never turns edge-on.
				controls.minPolarAngle = 0.18;
				controls.maxPolarAngle = Math.PI / 2.04;
				controls.addEventListener('change', () => renderer.render(scene, camera));

				scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa5ad, 2.15));
				const key = new THREE.DirectionalLight(0xffffff, 4.2);
				key.position.set(-360, -420, 700);
				key.castShadow = true;
				key.shadow.mapSize.set(2048, 2048);
				key.shadow.camera.near = 50;
				key.shadow.camera.far = 1600;
				key.shadow.camera.left = -650;
				key.shadow.camera.right = 650;
				key.shadow.camera.top = 650;
				key.shadow.camera.bottom = -650;
				key.shadow.bias = -0.00025;
				// Board casts a soft contact shadow rather than a hard CAD edge.
				key.shadow.radius = 3;
				scene.add(key);
				const fill = new THREE.DirectionalLight(0xdde5ea, 1.35);
				fill.position.set(500, 280, 340);
				scene.add(fill);

				runtime = {
					THREE,
					renderer,
					scene,
					camera,
					controls,
					paperTexture: createPaperTexture(),
					raycaster: new THREE.Raycaster(),
					dragPlane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
				};

				canvas.addEventListener('pointerdown', beginDrag, true);
				canvas.addEventListener('pointermove', moveDrag);
				canvas.addEventListener('pointerup', endDrag);
				canvas.addEventListener('pointercancel', endDrag);

				observer = new ResizeObserver(() => resize());
				observer.observe(host);

				ready = true;
				rebuild();
			} catch (reason) {
				failed = 'The 3D viewer could not load.';
				console.error(reason);
			}
		})();

		return () => {
			disposed = true;
			observer?.disconnect();
			canvas?.removeEventListener('pointerdown', beginDrag, true);
			canvas?.removeEventListener('pointermove', moveDrag);
			canvas?.removeEventListener('pointerup', endDrag);
			canvas?.removeEventListener('pointercancel', endDrag);
			disposeGroup(built?.root ?? null);
			built = null;
			if (runtime) {
				runtime.controls.dispose();
				runtime.paperTexture.dispose();
				runtime.renderer.dispose();
				runtime = null;
			}
			ready = false;
		};
	});

	// Rebuild whenever the design changes, except mid-drag: `endDrag` rebuilds
	// once the gesture is finished, so a drag does not rebuild per pointer move.
	$effect(() => {
		const next = assembly;
		if (!ready || drag) return;
		void next;
		rebuild();
	});

	$effect(() => {
		const opacity = tools.deckOpacity;
		if (!ready || !built) return;
		applyDeckOpacity(built.deckObjects, opacity);
		render();
	});
</script>

<!-- `canvas-wrap` is the shared editor canvas slot, so the 3D viewer occupies
     exactly the same space as the 2D canvas it replaces. -->
<div class="canvas-wrap assembly-viewer" bind:this={host}>
	<canvas bind:this={canvas} aria-label="3D packaging assembly"></canvas>

	<div class="viewer-controls">
		<label>
			Deck
			<select
				value={tools.deckOpacity}
				onchange={(event) => tools.setDeckOpacity(Number(event.currentTarget.value))}
			>
				{#each DECK_OPACITIES as option (option.value)}
					<option value={option.value}>{option.label}</option>
				{/each}
			</select>
		</label>
		<button class="button" onclick={fitCamera} disabled={!ready}>Fit view</button>
	</div>

	<p class="viewer-readout" aria-live="polite">{failed || readout}</p>

	{#if !ready && !failed}
		<p class="viewer-loading">Loading 3D viewer…</p>
	{/if}
</div>

<style>
	/* Sizing and clipping come from the shared `canvas-wrap` class. The 2D sheet
	   uses that class's padding as a framing gutter; the 3D view is full-bleed,
	   so the canvas and the overlays below share one box. */
	.assembly-viewer {
		padding: 0;
		background: var(--canvas, #e7ebee);
	}

	/* Taken out of flow deliberately. A canvas has an intrinsic size from its
	   drawing buffer, so an in-flow one would feed its own height back into the
	   grid row that `resize()` measures — a loop that shrinks the viewer. Out of
	   flow, the row sizes the canvas and never the other way round. */
	canvas {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
	}

	.viewer-controls {
		position: absolute;
		top: 0.75rem;
		right: 0.75rem;
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		/* Never wider than the pane, so a phone-width viewer still shows the model. */
		max-width: calc(100% - 1.5rem);
		gap: 0.5rem;
		align-items: center;
		padding: 0.35rem 0.5rem;
		border-radius: var(--radius, 6px);
		background: color-mix(in srgb, var(--surface, #fff) 88%, transparent);
		box-shadow: var(--shadow-raised, 0 1px 3px rgb(0 0 0 / 0.2));
		font-size: 0.8rem;
	}

	.viewer-controls label {
		display: flex;
		gap: 0.35rem;
		align-items: center;
	}

	/* The readout stays bottom-left and the controls top-right, so the two never
	   collide however narrow the pane gets. */
	.viewer-readout,
	.viewer-loading {
		position: absolute;
		left: 0.75rem;
		bottom: 0.75rem;
		max-width: calc(100% - 1.5rem);
		margin: 0;
		padding: 0.3rem 0.55rem;
		border-radius: var(--radius, 6px);
		background: color-mix(in srgb, var(--surface, #fff) 88%, transparent);
		font-size: 0.8rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.viewer-loading {
		left: 50%;
		top: 50%;
		bottom: auto;
		transform: translate(-50%, -50%);
	}

	/* The shell stacks and scrolls at this width, so the row no longer has a
	   height to give. Matches the floor the 2D sheet sets for itself. */
	@media (max-width: 860px) {
		.assembly-viewer {
			min-height: 380px;
		}
	}
</style>
