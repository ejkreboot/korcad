import * as THREE from 'three';
import type {
	Assembly,
	AssemblyGroup,
	AssemblyMaterial,
	AssemblyPart,
	BoxPart,
	DeckPart,
	FootprintPart,
	PanelPart,
	WallPart
} from '$lib/core/assembly/model.js';

/**
 * The rendering layer: the only place in the app that knows about Three.js.
 * It consumes the plain assembly description produced by the packaging feature
 * and returns meshes. It reads nothing from the design document and mutates no
 * application state, so the same description always yields the same scene.
 */

/** Anything thinner than this disappears at typical zoom, so parts are floored to it. */
const MIN_EXTENT = 0.5;
/** Edges are drawn where faces meet at more than this angle, in degrees. */
const EDGE_THRESHOLD = 28;
const PLACEMENT_GREEN = 0x267151;

const BOARD: Record<AssemblyMaterial, { color: number; roughness: number }> = {
	deck: { color: 0xd8dad8, roughness: 0.94 },
	wall: { color: 0xc7cac7, roughness: 0.96 },
	pocket: { color: 0xb9bcba, roughness: 0.97 },
	support: { color: 0xd0d3d0, roughness: 0.9 }
};
const SELECTED_SUPPORT = { color: 0xbfc4c0, roughness: 0.86 };
/** Kraft board reads as one brown regardless of which part it was cut from. */
const KRAFT = 0xb99b70;

/**
 * A deterministic grey-noise tile used as a bump map, so board faces catch the
 * light like paper instead of looking like moulded plastic. Seeded rather than
 * random, so the render is reproducible.
 */
export function createPaperTexture(): THREE.CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 128;
	const context = canvas.getContext('2d');
	if (context) {
		const pixels = context.createImageData(128, 128);
		let seed = 19;
		for (let i = 0; i < pixels.data.length; i += 4) {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			const value = 180 + (seed % 65);
			pixels.data.set([value, value, value, 255], i);
		}
		context.putImageData(pixels, 0, 0);
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
	texture.repeat.set(3, 3);
	return texture;
}

/**
 * Builds board materials for one assembly. Each call returns fresh materials so
 * that a rebuild can dispose the previous set without touching live meshes.
 */
function createMaterials(
	finish: Assembly['finish'],
	paperTexture: THREE.Texture
): (material: AssemblyMaterial, selected: boolean) => THREE.MeshStandardMaterial {
	const cache = new Map<string, THREE.MeshStandardMaterial>();
	return (material, selected) => {
		const key = `${material}:${selected}`;
		const existing = cache.get(key);
		if (existing) return existing;
		const spec = material === 'support' && selected ? SELECTED_SUPPORT : BOARD[material];
		const created = new THREE.MeshStandardMaterial({
			color: finish === 'kraft' ? KRAFT : spec.color,
			bumpMap: paperTexture,
			bumpScale: 0.12,
			roughness: spec.roughness,
			metalness: 0,
			// Folded board is modelled as thin shells, so back faces must show.
			side: THREE.DoubleSide
		});
		cache.set(key, created);
		return created;
	};
}

function addEdges(mesh: THREE.Mesh, color = 0x596168, opacity = 0.32): THREE.LineSegments {
	const edges = new THREE.LineSegments(
		new THREE.EdgesGeometry(mesh.geometry, EDGE_THRESHOLD),
		new THREE.LineBasicMaterial({ color, transparent: true, opacity })
	);
	mesh.add(edges);
	return edges;
}

function boxGeometry(part: BoxPart): THREE.BufferGeometry {
	return new THREE.BoxGeometry(
		Math.max(part.w, MIN_EXTENT),
		Math.max(part.d, MIN_EXTENT),
		Math.max(part.h, MIN_EXTENT)
	);
}

/**
 * Thickens a flat polygon along its own normal, producing both faces and the
 * rim between them. Returns null for a degenerate panel, which is how a
 * zero-length flange is skipped.
 */
function panelGeometry(part: PanelPart): THREE.BufferGeometry | null {
	if (part.vertices.length < 3) return null;
	const vectors = part.vertices.map((vertex) => new THREE.Vector3(vertex.x, vertex.y, vertex.z));
	const [first, second, third] = vectors as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
	const normal = new THREE.Vector3()
		.crossVectors(
			new THREE.Vector3().subVectors(second, first),
			new THREE.Vector3().subVectors(third, first)
		)
		.normalize();
	if (!Number.isFinite(normal.x)) return null;
	const offset = normal.multiplyScalar(Math.max(part.thickness, 0.35) / 2);
	const positions: number[] = [];
	for (const direction of [-1, 1]) {
		for (const vertex of vectors) {
			const shifted = vertex.clone().add(offset.clone().multiplyScalar(direction));
			positions.push(shifted.x, shifted.y, shifted.z);
		}
	}
	const count = vectors.length;
	const indices: number[] = [];
	// Fan-triangulate both faces, then stitch the rim, so a flange is solid.
	for (let i = 1; i < count - 1; i++) {
		indices.push(0, i + 1, i, count, count + i, count + i + 1);
	}
	for (let i = 0; i < count; i++) {
		const next = (i + 1) % count;
		indices.push(i, next, count + next, i, count + next, count + i);
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	geometry.setIndex(indices);
	geometry.computeVertexNormals();
	return geometry;
}

/**
 * A wall standing between a top edge and a shorter or offset bottom edge. The
 * profile is built in the wall's own plane — distance along the top edge
 * against Z — so a tapered tray wall and a notched finger pull are the same
 * construction.
 */
function wallGeometry(part: WallPart): THREE.BufferGeometry | null {
	const dx = part.topB.x - part.topA.x;
	const dy = part.topB.y - part.topA.y;
	const topLength = Math.hypot(dx, dy);
	if (topLength <= 0) return null;
	const tangent = { x: dx / topLength, y: dy / topLength };
	const along = (p: { x: number; y: number }) =>
		(p.x - part.topA.x) * tangent.x + (p.y - part.topA.y) * tangent.y;

	const profile: THREE.Vector2[] = [new THREE.Vector2(0, part.topZ)];
	const { notch } = part;
	if (notch && notch.diameter > 0 && notch.depth > 0) {
		const radiusX = Math.min(notch.diameter / 2, topLength * 0.42);
		const center = topLength / 2;
		// The pull is cut into the wall, so it runs from the mouth toward the floor.
		const wallDirection = Math.sign(part.bottomZ - part.topZ) || -1;
		const notchDepth = Math.min(notch.depth, Math.abs(part.topZ - part.bottomZ));
		const radiusZ = Math.min(radiusX, notchDepth);
		const arcCenterZ = part.topZ + wallDirection * (notchDepth - radiusZ);
		profile.push(new THREE.Vector2(center - radiusX, part.topZ));
		if (arcCenterZ !== part.topZ) profile.push(new THREE.Vector2(center - radiusX, arcCenterZ));
		for (let i = 1; i < 12; i++) {
			const angle = Math.PI - (Math.PI * i) / 12;
			profile.push(
				new THREE.Vector2(
					center + Math.cos(angle) * radiusX,
					arcCenterZ + wallDirection * Math.sin(angle) * radiusZ
				)
			);
		}
		if (arcCenterZ !== part.topZ) profile.push(new THREE.Vector2(center + radiusX, arcCenterZ));
		profile.push(new THREE.Vector2(center + radiusX, part.topZ));
	}
	profile.push(
		new THREE.Vector2(topLength, part.topZ),
		new THREE.Vector2(along(part.bottomB), part.bottomZ),
		new THREE.Vector2(along(part.bottomA), part.bottomZ)
	);

	const faceTriangles = THREE.ShapeUtils.triangulateShape(profile, []);
	const vertices: number[] = [];
	for (const offset of [0, part.thickness]) {
		for (const vertex of profile) {
			vertices.push(
				part.topA.x + tangent.x * vertex.x + part.inward.x * offset,
				part.topA.y + tangent.y * vertex.x + part.inward.y * offset,
				vertex.y
			);
		}
	}
	const count = profile.length;
	const indices: number[] = [];
	for (const triangle of faceTriangles) {
		const [a, b, c] = triangle;
		if (a === undefined || b === undefined || c === undefined) continue;
		indices.push(a, b, c, count + c, count + b, count + a);
	}
	for (let i = 0; i < count; i++) {
		const next = (i + 1) % count;
		indices.push(i, next, count + next, i, count + next, count + i);
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
	geometry.setIndex(indices);
	geometry.computeVertexNormals();
	return geometry;
}

function deckGeometry(part: DeckPart): THREE.BufferGeometry | null {
	const [start, ...rest] = part.outline;
	if (!start) return null;
	const shape = new THREE.Shape();
	shape.moveTo(start.x, start.y);
	for (const p of rest) shape.lineTo(p.x, p.y);
	shape.closePath();
	for (const hole of part.holes) {
		const [holeStart, ...holeRest] = hole;
		if (!holeStart) continue;
		const path = new THREE.Path();
		path.moveTo(holeStart.x, holeStart.y);
		for (const p of holeRest) path.lineTo(p.x, p.y);
		path.closePath();
		shape.holes.push(path);
	}
	return new THREE.ExtrudeGeometry(shape, {
		depth: Math.max(MIN_EXTENT, part.thickness),
		bevelEnabled: false,
		curveSegments: 1
	});
}

function footprintMesh(part: FootprintPart, selected: boolean): THREE.Mesh {
	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry(Math.max(part.w, MIN_EXTENT), Math.max(part.d, MIN_EXTENT)),
		new THREE.MeshBasicMaterial({
			color: PLACEMENT_GREEN,
			transparent: true,
			opacity: selected ? 0.3 : 0.13,
			side: THREE.DoubleSide,
			// The pad is an overlay, so it must not occlude the parts under it.
			depthWrite: false
		})
	);
	mesh.position.set(part.x + part.w / 2, part.y + part.d / 2, part.z);
	mesh.renderOrder = 5;
	return mesh;
}

export type BuiltScene = {
	/** Root of everything built for this assembly; add it to the scene. */
	readonly root: THREE.Group;
	/** Meshes and edges of the deck piece, which the opacity control fades. */
	readonly deckObjects: readonly THREE.Object3D[];
	/** Groups that can be picked and dragged, tagged with their support id. */
	readonly supportTargets: readonly THREE.Object3D[];
};

/** Builds the meshes for one part into `parent`, returning what it created. */
function addPart(
	parent: THREE.Object3D,
	part: AssemblyPart,
	selected: boolean,
	board: ReturnType<typeof createMaterials>
): THREE.Object3D[] {
	if (part.form === 'footprint') {
		const mesh = footprintMesh(part, selected);
		parent.add(mesh);
		return [mesh];
	}

	const geometry =
		part.form === 'box'
			? boxGeometry(part)
			: part.form === 'panel'
				? panelGeometry(part)
				: part.form === 'wall'
					? wallGeometry(part)
					: deckGeometry(part);
	if (!geometry) return [];

	const mesh = new THREE.Mesh(geometry, board(part.material, selected));
	// A box is described by its corner, but BoxGeometry is centred.
	if (part.form === 'box') {
		mesh.position.set(part.x + part.w / 2, part.y + part.d / 2, part.z + part.h / 2);
	} else if (part.form === 'deck') {
		mesh.position.z = part.z;
	}
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	parent.add(mesh);
	const edges = part.form === 'deck' ? addEdges(mesh, 0x666d72, 0.38) : addEdges(mesh);
	return [mesh, edges];
}

function addGroup(
	root: THREE.Group,
	group: AssemblyGroup,
	board: ReturnType<typeof createMaterials>,
	deckObjects: THREE.Object3D[]
): THREE.Group {
	const container = new THREE.Group();
	container.position.set(group.origin.x, group.origin.y, 0);
	if (group.supportId) container.userData.supportId = group.supportId;
	for (const part of group.parts) {
		const created = addPart(container, part, group.selected, board);
		if (part.deckPart) deckObjects.push(...created);
	}
	root.add(container);
	return container;
}

/**
 * Turns an assembly description into meshes, plus a shadow-catching ground
 * plane so the model reads as sitting on a surface rather than floating.
 */
export function buildScene(assembly: Assembly, paperTexture: THREE.Texture): BuiltScene {
	const root = new THREE.Group();
	const board = createMaterials(assembly.finish, paperTexture);
	const deckObjects: THREE.Object3D[] = [];
	const supportTargets: THREE.Object3D[] = [];

	for (const group of assembly.groups) {
		const container = addGroup(root, group, board, deckObjects);
		if (group.supportId) supportTargets.push(container);
	}

	const ground = new THREE.Mesh(
		new THREE.PlaneGeometry(
			Math.max(assembly.deckW * 1.7, MIN_EXTENT),
			Math.max(assembly.deckH * 1.7, MIN_EXTENT)
		),
		new THREE.ShadowMaterial({ color: 0x3d3a34, opacity: 0.14 })
	);
	ground.position.set(assembly.deckW / 2, assembly.deckH / 2, -1.5);
	ground.receiveShadow = true;
	root.add(ground);

	return { root, deckObjects, supportTargets };
}

/** Releases every geometry and material under `group` and detaches it. */
export function disposeGroup(group: THREE.Object3D | null): void {
	if (!group) return;
	group.traverse((object) => {
		const mesh = object as Partial<THREE.Mesh>;
		mesh.geometry?.dispose();
		const material = mesh.material;
		if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
		else material?.dispose();
	});
	group.removeFromParent();
}

/**
 * Applies the deck-transparency setting to the deck piece only, so the
 * supports inside stay solid. Depth writing is dropped once the deck is
 * noticeably transparent, otherwise it hides what it is meant to reveal.
 */
export function applyDeckOpacity(deckObjects: readonly THREE.Object3D[], opacity: number): void {
	for (const object of deckObjects) {
		object.visible = opacity > 0;
		const material = (object as Partial<THREE.Mesh>).material;
		if (!material || Array.isArray(material)) continue;
		material.transparent = opacity < 1;
		material.opacity = opacity;
		material.depthWrite = opacity > 0.82;
		material.needsUpdate = true;
	}
}
