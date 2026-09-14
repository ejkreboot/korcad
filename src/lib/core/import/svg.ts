import type { Point } from '$lib/core/geometry/primitives.js';
import { MM_PER_IN } from '$lib/core/constants.js';

/**
 * Reads the outlines out of an SVG file: every path and basic shape, with its
 * transforms applied and its curves flattened to lines, in millimetres with Y
 * up. Fill, stroke, and fill rule are ignored. A cut follows a path's geometry,
 * whether the drawing showed it as a filled shape or a hairline.
 *
 * This is deliberately DOM-free, so it runs in core and in unit tests: a small
 * XML reader covers what SVG files carry (elements, attributes, comments,
 * CDATA, processing instructions, a doctype), and nothing SVG-specific is
 * inferred from CSS stylesheets.
 */

export type SvgOutlines = {
	/** Closed outlines, each a vertex list without a repeated closing vertex. */
	readonly closed: readonly (readonly Point[])[];
	/** Paths that do not return to their start, which cannot bound a part or a hole. */
	readonly openCount: number;
	/** Names of elements that were skipped because they cannot be read as outlines. */
	readonly unsupported: readonly string[];
};

export type SvgReadOptions = {
	/**
	 * Largest distance, in mm, a flattened curve may stray from the true curve.
	 * An open path whose ends are this close is treated as closed.
	 */
	readonly tolerance: number;
};

type XmlElement = {
	readonly name: string;
	readonly attributes: Readonly<Record<string, string>>;
	readonly children: readonly XmlElement[];
};

/** A 2D affine transform `[a, b, c, d, e, f]`: x' = ax + cy + e, y' = bx + dy + f. */
type Matrix = readonly [number, number, number, number, number, number];

type Segment =
	| { readonly kind: 'line'; readonly to: Point }
	| { readonly kind: 'cubic'; readonly c1: Point; readonly c2: Point; readonly to: Point };

type Subpath = { readonly start: Point; readonly segments: readonly Segment[]; closed: boolean };

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Millimetres per unit, for absolute lengths on the root element. A bare number is a CSS pixel. */
const MM_PER_UNIT: Readonly<Record<string, number>> = {
	'': MM_PER_IN / 96,
	px: MM_PER_IN / 96,
	pt: MM_PER_IN / 72,
	pc: MM_PER_IN / 6,
	in: MM_PER_IN,
	mm: 1,
	cm: 10,
	q: 0.25
};

/** Elements that draw something KorCad cannot cut from, named in the import notice. */
const UNSUPPORTED = new Set(['text', 'image', 'foreignObject', 'svg']);

/** Elements whose children are never drawn in place. */
const NOT_RENDERED = new Set([
	'defs',
	'symbol',
	'clipPath',
	'mask',
	'pattern',
	'marker',
	'linearGradient',
	'radialGradient',
	'filter',
	'style',
	'script',
	'title',
	'desc',
	'metadata'
]);

export function readSvgOutlines(text: string, options: SvgReadOptions): SvgOutlines {
	const root = parseXml(text);
	if (root.name !== 'svg') throw new Error('This file is not an SVG drawing.');
	const ids = new Map<string, XmlElement>();
	indexIds(root, ids);

	const closed: Point[][] = [];
	let openCount = 0;
	const unsupported = new Set<string>();
	const tolerance = Math.max(options.tolerance, 1e-6);

	const emit = (subpaths: readonly Subpath[], matrix: Matrix) => {
		for (const subpath of subpaths) {
			const points = flattenSubpath(subpath, matrix, tolerance);
			if (!points) continue;
			if (points.closed) closed.push(points.points);
			else openCount++;
		}
	};

	const walk = (
		element: XmlElement,
		parent: Matrix,
		hidden: boolean,
		using: ReadonlySet<XmlElement>
	) => {
		const style = presentation(element);
		if (style.display === 'none') return;
		const invisible =
			style.visibility === undefined
				? hidden
				: style.visibility === 'hidden' || style.visibility === 'collapse';
		const matrix = multiply(parent, parseTransform(element.attributes.transform ?? ''));
		const name = element.name;
		if (NOT_RENDERED.has(name)) return;
		if (UNSUPPORTED.has(name)) {
			unsupported.add(name === 'svg' ? 'nested svg' : name);
			return;
		}
		if (name === 'g' || name === 'a') {
			for (const child of element.children) walk(child, matrix, invisible, using);
			return;
		}
		if (name === 'switch') {
			// A switch draws only its first child that applies; with no feature
			// tests to evaluate, that is its first element.
			const first = element.children[0];
			if (first) walk(first, matrix, invisible, using);
			return;
		}
		if (name === 'use') {
			const href = element.attributes.href ?? element.attributes['xlink:href'] ?? '';
			const target = href.startsWith('#') ? ids.get(href.slice(1)) : undefined;
			if (!target || using.has(target)) return;
			if (target.name === 'symbol') {
				unsupported.add('symbol');
				return;
			}
			const offset: Matrix = [1, 0, 0, 1, length(element, 'x'), length(element, 'y')];
			walk(target, multiply(matrix, offset), invisible, new Set([...using, target]));
			return;
		}
		const subpaths = shapeSubpaths(element);
		if (subpaths && !invisible) emit(subpaths, matrix);
	};

	const viewport = rootMatrix(root);
	for (const child of root.children) walk(child, viewport, false, new Set());
	return { closed, openCount, unsupported: [...unsupported].sort() };
}

// ---------------------------------------------------------------------------
// XML

function parseXml(text: string): XmlElement {
	type Open = { name: string; attributes: Record<string, string>; children: XmlElement[] };
	const stack: Open[] = [];
	let root: XmlElement | null = null;
	let index = 0;
	const fail = (): never => {
		throw new Error('This SVG file could not be read: it is not well-formed XML.');
	};
	const skipPast = (marker: string) => {
		const end = text.indexOf(marker, index);
		if (end < 0) fail();
		index = end + marker.length;
	};

	while (index < text.length) {
		const open = text.indexOf('<', index);
		if (open < 0) break;
		index = open;
		if (text.startsWith('<!--', index)) skipPast('-->');
		else if (text.startsWith('<![CDATA[', index)) skipPast(']]>');
		else if (text.startsWith('<?', index)) skipPast('?>');
		else if (text.startsWith('<!', index)) {
			// A doctype, possibly with an internal subset in brackets.
			let depth = 0;
			for (index += 2; index < text.length; index++) {
				const character = text[index];
				if (character === '[') depth++;
				else if (character === ']') depth--;
				else if (character === '>' && depth <= 0) break;
			}
			if (index >= text.length) fail();
			index++;
		} else if (text.startsWith('</', index)) {
			const end = text.indexOf('>', index);
			if (end < 0) fail();
			const name = localName(text.slice(index + 2, end).trim());
			const element = stack.pop();
			if (!element || element.name !== name) fail();
			index = end + 1;
			if (!stack.length) root ??= element!;
			else stack.at(-1)!.children.push(element!);
		} else {
			const tagPattern = /<([^\s/>]+)/y;
			tagPattern.lastIndex = index;
			const tag = tagPattern.exec(text);
			if (!tag) fail();
			index = tagPattern.lastIndex;
			const attributes: Record<string, string> = {};
			const attribute = /\s*([^\s=/>]+)\s*=\s*("[^"]*"|'[^']*')/y;
			for (;;) {
				attribute.lastIndex = index;
				const match = attribute.exec(text);
				if (!match) break;
				attributes[match[1]!] = decodeEntities(match[2]!.slice(1, -1));
				index = attribute.lastIndex;
			}
			const closePattern = /\s*(\/?)>/y;
			closePattern.lastIndex = index;
			const close = closePattern.exec(text);
			if (!close) fail();
			index = closePattern.lastIndex;
			const element = { name: localName(tag![1]!), attributes, children: [] };
			if (close![1]) {
				if (!stack.length) root ??= element;
				else stack.at(-1)!.children.push(element);
			} else {
				stack.push(element);
			}
		}
	}
	if (stack.length || !root) fail();
	return root!;
}

/** The element name without an `svg:` prefix; other prefixes are kept, so editor metadata is ignored. */
function localName(name: string): string {
	return name.startsWith('svg:') ? name.slice(4) : name;
}

function decodeEntities(value: string): string {
	const named: Readonly<Record<string, string>> = {
		amp: '&',
		lt: '<',
		gt: '>',
		quot: '"',
		apos: "'"
	};
	return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
		if (body[0] === '#') {
			const code =
				body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
			return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
		}
		return named[body] ?? entity;
	});
}

function indexIds(element: XmlElement, ids: Map<string, XmlElement>): void {
	const id = element.attributes.id;
	if (id && !ids.has(id)) ids.set(id, element);
	for (const child of element.children) indexIds(child, ids);
}

/** `display` and `visibility`, from the inline style first, then the attribute. */
function presentation(element: XmlElement): { display?: string; visibility?: string } {
	const result: { display?: string; visibility?: string } = {};
	const { display, visibility, style } = element.attributes;
	if (display) result.display = display.trim();
	if (visibility) result.visibility = visibility.trim();
	for (const declaration of (style ?? '').split(';')) {
		const [key, value] = declaration.split(':').map((part) => part.trim());
		if (key === 'display' && value) result.display = value;
		if (key === 'visibility' && value) result.visibility = value;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Coordinates

function multiply(m: Matrix, n: Matrix): Matrix {
	return [
		m[0] * n[0] + m[2] * n[1],
		m[1] * n[0] + m[3] * n[1],
		m[0] * n[2] + m[2] * n[3],
		m[1] * n[2] + m[3] * n[3],
		m[0] * n[4] + m[2] * n[5] + m[4],
		m[1] * n[4] + m[3] * n[5] + m[5]
	];
}

function apply(m: Matrix, p: Point): Point {
	return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

function numbers(text: string): number[] {
	return (text.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
}

function parseTransform(text: string): Matrix {
	let matrix = IDENTITY;
	for (const match of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
		const args = numbers(match[2]!);
		const [a = 0, b, c, d = 0, e = 0, f = 0] = args;
		let next: Matrix = IDENTITY;
		switch (match[1]) {
			case 'matrix':
				if (args.length === 6) next = [a, b!, c!, d, e, f];
				break;
			case 'translate':
				next = [1, 0, 0, 1, a, b ?? 0];
				break;
			case 'scale':
				next = [a, 0, 0, b ?? a, 0, 0];
				break;
			case 'rotate': {
				const angle = (a * Math.PI) / 180;
				const cos = Math.cos(angle);
				const sin = Math.sin(angle);
				const [cx, cy] = [b ?? 0, c ?? 0];
				next = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
				break;
			}
			case 'skewX':
				next = [1, 0, Math.tan((a * Math.PI) / 180), 1, 0, 0];
				break;
			case 'skewY':
				next = [1, Math.tan((a * Math.PI) / 180), 0, 1, 0, 0];
				break;
		}
		matrix = multiply(matrix, next);
	}
	return matrix;
}

/** A length on the root element, in mm, or `null` when it is absent or relative. */
function absoluteLength(value: string | undefined): number | null {
	const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z]*)\s*$/.exec(
		value ?? ''
	);
	if (!match) return null;
	const unit = MM_PER_UNIT[match[2]!.toLowerCase()];
	const size = Number(match[1]) * (unit ?? NaN);
	return Number.isFinite(size) && size > 0 ? size : null;
}

/** A length inside the drawing, in user units: a CSS pixel, or an absolute unit converted to pixels. */
function length(element: XmlElement, key: string): number {
	const mm = absoluteLength(element.attributes[key]);
	return mm === null ? 0 : mm / MM_PER_UNIT['']!;
}

/**
 * User units to sheet millimetres, with Y flipped: SVG's Y points down, the
 * sheet's up. Where the root states its size in absolute units the viewBox is
 * scaled to fit it; otherwise a user unit is a CSS pixel, 1/96 in.
 * Alignment offsets are left out, since the importer places the drawing.
 */
function rootMatrix(root: XmlElement): Matrix {
	const box = numbers(root.attributes.viewBox ?? '');
	const [minX = 0, minY = 0, boxW = 0, boxH = 0] = box;
	const hasBox = box.length === 4 && boxW > 0 && boxH > 0;
	const width = absoluteLength(root.attributes.width);
	const height = absoluteLength(root.attributes.height);
	const pixel = MM_PER_UNIT['']!;
	let sx = pixel;
	let sy = pixel;
	if (hasBox && (width !== null || height !== null)) {
		const fitX = width === null ? null : width / boxW;
		const fitY = height === null ? null : height / boxH;
		const stretch = (root.attributes.preserveAspectRatio ?? '').trim().startsWith('none');
		if (stretch && fitX !== null && fitY !== null) {
			sx = fitX;
			sy = fitY;
		} else {
			const uniform = Math.min(fitX ?? Infinity, fitY ?? Infinity);
			sx = uniform;
			sy = uniform;
		}
	}
	return [sx, 0, 0, -sy, -minX * sx, minY * sy];
}

// ---------------------------------------------------------------------------
// Shapes

function shapeSubpaths(element: XmlElement): Subpath[] | null {
	const attr = (key: string) => length(element, key);
	const at = (x: number, y: number): Point => ({ x, y });
	switch (element.name) {
		case 'path':
			return parsePathData(element.attributes.d ?? '');
		case 'rect': {
			const [x, y, w, h] = [attr('x'), attr('y'), attr('width'), attr('height')];
			if (!(w > 0 && h > 0)) return [];
			const rxSet = element.attributes.rx !== undefined;
			const rySet = element.attributes.ry !== undefined;
			let rx = rxSet ? attr('rx') : rySet ? attr('ry') : 0;
			let ry = rySet ? attr('ry') : rx;
			rx = Math.min(Math.max(rx, 0), w / 2);
			ry = Math.min(Math.max(ry, 0), h / 2);
			if (!(rx > 0 && ry > 0)) {
				return [polyline([at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h)], true)];
			}
			const segments: Segment[] = [
				{ kind: 'line', to: at(x + w - rx, y) },
				...arcSegments(at(x + w - rx, y), rx, ry, 0, false, true, at(x + w, y + ry)),
				{ kind: 'line', to: at(x + w, y + h - ry) },
				...arcSegments(at(x + w, y + h - ry), rx, ry, 0, false, true, at(x + w - rx, y + h)),
				{ kind: 'line', to: at(x + rx, y + h) },
				...arcSegments(at(x + rx, y + h), rx, ry, 0, false, true, at(x, y + h - ry)),
				{ kind: 'line', to: at(x, y + ry) },
				...arcSegments(at(x, y + ry), rx, ry, 0, false, true, at(x + rx, y))
			];
			return [{ start: at(x + rx, y), segments, closed: true }];
		}
		case 'circle':
		case 'ellipse': {
			const [cx, cy] = [attr('cx'), attr('cy')];
			const circle = element.name === 'circle';
			const rx = circle ? attr('r') : attr('rx');
			const ry = circle ? rx : attr('ry');
			if (!(rx > 0 && ry > 0)) return [];
			const start = at(cx + rx, cy);
			const opposite = at(cx - rx, cy);
			const segments = [
				...arcSegments(start, rx, ry, 0, false, true, opposite),
				...arcSegments(opposite, rx, ry, 0, false, true, start)
			];
			return [{ start, segments, closed: true }];
		}
		case 'line':
			return [polyline([at(attr('x1'), attr('y1')), at(attr('x2'), attr('y2'))], false)];
		case 'polyline':
		case 'polygon': {
			const values = numbers(element.attributes.points ?? '');
			const points: Point[] = [];
			for (let index = 0; index + 1 < values.length; index += 2) {
				points.push(at(values[index]!, values[index + 1]!));
			}
			return points.length ? [polyline(points, element.name === 'polygon')] : [];
		}
		default:
			return null;
	}
}

function polyline(points: readonly Point[], closed: boolean): Subpath {
	return {
		start: points[0]!,
		segments: points.slice(1).map((to) => ({ kind: 'line' as const, to })),
		closed
	};
}

/** Path data to subpaths; reading stops at the first error, as SVG renderers do. */
function parsePathData(d: string): Subpath[] {
	const subpaths: Subpath[] = [];
	let index = 0;
	const skipSeparators = () => {
		while (index < d.length && /[\s,]/.test(d[index]!)) index++;
	};
	const readNumber = (): number | null => {
		skipSeparators();
		const match = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
		match.lastIndex = index;
		const found = match.exec(d);
		if (!found) return null;
		index = match.lastIndex;
		return Number(found[0]);
	};
	// Arc flags are single digits and may run together: `a5 5 0 01 10 10`.
	const readFlag = (): boolean | null => {
		skipSeparators();
		const character = d[index];
		if (character !== '0' && character !== '1') return null;
		index++;
		return character === '1';
	};

	let current: Point = { x: 0, y: 0 };
	let start: Point = current;
	let segments: Segment[] | null = null;
	let lastCubic: Point | null = null;
	let lastQuad: Point | null = null;
	let command = '';

	const begin = (at: Point) => {
		segments = [];
		subpaths.push({ start: at, segments, closed: false });
		start = at;
	};
	const add = (segment: Segment) => {
		if (!segments) begin(current);
		segments!.push(segment);
		current = segment.to;
	};

	parse: for (;;) {
		skipSeparators();
		if (index >= d.length) break;
		const character = d[index]!;
		if (/[MmLlHhVvCcSsQqTtAaZz]/.test(character)) {
			command = character;
			index++;
		} else if (!command || command === 'Z' || command === 'z') {
			break;
		}
		const relative = command === command.toLowerCase();
		const base = () => (relative ? current : { x: 0, y: 0 });
		const pointFrom = (x: number | null, y: number | null): Point | null =>
			x === null || y === null ? null : { x: base().x + x, y: base().y + y };
		const upper = command.toUpperCase();
		const previousCubic: Point | null = lastCubic;
		const previousQuad: Point | null = lastQuad;
		lastCubic = null;
		lastQuad = null;
		switch (upper) {
			case 'M': {
				const to = pointFrom(readNumber(), readNumber());
				if (!to) break parse;
				current = to;
				begin(to);
				// Further coordinate pairs are implicit line-tos.
				command = relative ? 'l' : 'L';
				break;
			}
			case 'Z': {
				if (segments) {
					subpaths.at(-1)!.closed = true;
					segments = null;
				}
				current = start;
				break;
			}
			case 'L': {
				const to = pointFrom(readNumber(), readNumber());
				if (!to) break parse;
				add({ kind: 'line', to });
				break;
			}
			case 'H': {
				const x = readNumber();
				if (x === null) break parse;
				add({ kind: 'line', to: { x: relative ? current.x + x : x, y: current.y } });
				break;
			}
			case 'V': {
				const y = readNumber();
				if (y === null) break parse;
				add({ kind: 'line', to: { x: current.x, y: relative ? current.y + y : y } });
				break;
			}
			case 'C': {
				const c1 = pointFrom(readNumber(), readNumber());
				const c2 = pointFrom(readNumber(), readNumber());
				const to = pointFrom(readNumber(), readNumber());
				if (!c1 || !c2 || !to) break parse;
				add({ kind: 'cubic', c1, c2, to });
				lastCubic = c2;
				break;
			}
			case 'S': {
				const c2 = pointFrom(readNumber(), readNumber());
				const to = pointFrom(readNumber(), readNumber());
				if (!c2 || !to) break parse;
				const c1 = previousCubic ? reflect(previousCubic, current) : current;
				add({ kind: 'cubic', c1, c2, to });
				lastCubic = c2;
				break;
			}
			case 'Q': {
				const control = pointFrom(readNumber(), readNumber());
				const to = pointFrom(readNumber(), readNumber());
				if (!control || !to) break parse;
				add(quadratic(current, control, to));
				lastQuad = control;
				break;
			}
			case 'T': {
				const to = pointFrom(readNumber(), readNumber());
				if (!to) break parse;
				const control: Point = previousQuad ? reflect(previousQuad, current) : current;
				add(quadratic(current, control, to));
				lastQuad = control;
				break;
			}
			case 'A': {
				const rx = readNumber();
				const ry = readNumber();
				const rotation = readNumber();
				const large = readFlag();
				const sweep = readFlag();
				const to = pointFrom(readNumber(), readNumber());
				if (
					rx === null ||
					ry === null ||
					rotation === null ||
					large === null ||
					sweep === null ||
					!to
				)
					break parse;
				const from = current;
				for (const segment of arcSegments(from, rx, ry, rotation, large, sweep, to)) add(segment);
				current = to;
				break;
			}
		}
	}
	return subpaths;
}

const reflect = (control: Point, about: Point): Point => ({
	x: 2 * about.x - control.x,
	y: 2 * about.y - control.y
});

/** A quadratic Bézier is exactly a cubic with its controls two thirds of the way to the quadratic's. */
function quadratic(from: Point, control: Point, to: Point): Segment {
	return {
		kind: 'cubic',
		c1: { x: from.x + (2 / 3) * (control.x - from.x), y: from.y + (2 / 3) * (control.y - from.y) },
		c2: { x: to.x + (2 / 3) * (control.x - to.x), y: to.y + (2 / 3) * (control.y - to.y) },
		to
	};
}

/**
 * An SVG elliptical arc as cubic Béziers of at most a quarter turn each, whose
 * error is under a millionth of the radius. Converted from endpoint to centre
 * form as in the SVG specification (implementation notes, F.6.5), with radii
 * scaled up when they are too small to reach the endpoint.
 */
function arcSegments(
	from: Point,
	rxIn: number,
	ryIn: number,
	rotation: number,
	large: boolean,
	sweep: boolean,
	to: Point
): Segment[] {
	let rx = Math.abs(rxIn);
	let ry = Math.abs(ryIn);
	if (from.x === to.x && from.y === to.y) return [];
	if (!rx || !ry) return [{ kind: 'line', to }];
	const phi = (rotation * Math.PI) / 180;
	const cos = Math.cos(phi);
	const sin = Math.sin(phi);
	const dx = (from.x - to.x) / 2;
	const dy = (from.y - to.y) / 2;
	const x1 = cos * dx + sin * dy;
	const y1 = -sin * dx + cos * dy;
	const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
	if (lambda > 1) {
		rx *= Math.sqrt(lambda);
		ry *= Math.sqrt(lambda);
	}
	const numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
	const denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1;
	const root = Math.sqrt(Math.max(0, numerator / denominator)) * (large === sweep ? -1 : 1);
	const cxp = (root * rx * y1) / ry;
	const cyp = (-root * ry * x1) / rx;
	const cx = cos * cxp - sin * cyp + (from.x + to.x) / 2;
	const cy = sin * cxp + cos * cyp + (from.y + to.y) / 2;
	const angle = (ux: number, uy: number, vx: number, vy: number) =>
		Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
	const theta = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
	let delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
	if (!sweep && delta > 0) delta -= 2 * Math.PI;
	if (sweep && delta < 0) delta += 2 * Math.PI;

	const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
	const step = delta / pieces;
	const k = (4 / 3) * Math.tan(step / 4);
	const onEllipse = (t: number, derivative: boolean): Point => {
		const ex = derivative ? -rx * Math.sin(t) : rx * Math.cos(t);
		const ey = derivative ? ry * Math.cos(t) : ry * Math.sin(t);
		return derivative
			? { x: cos * ex - sin * ey, y: sin * ex + cos * ey }
			: { x: cx + cos * ex - sin * ey, y: cy + sin * ex + cos * ey };
	};
	const segments: Segment[] = [];
	for (let piece = 0; piece < pieces; piece++) {
		const t0 = theta + piece * step;
		const t1 = t0 + step;
		const p0 = onEllipse(t0, false);
		const d0 = onEllipse(t0, true);
		const p1 = piece === pieces - 1 ? to : onEllipse(t1, false);
		const d1 = onEllipse(t1, true);
		segments.push({
			kind: 'cubic',
			c1: { x: p0.x + k * d0.x, y: p0.y + k * d0.y },
			c2: { x: p1.x - k * d1.x, y: p1.y - k * d1.y },
			to: p1
		});
	}
	return segments;
}

// ---------------------------------------------------------------------------
// Flattening

/**
 * A subpath in sheet millimetres as a vertex list. Curves are transformed
 * before they are flattened, which is exact for Béziers under an affine map,
 * so the tolerance holds in millimetres whatever the drawing's scale.
 */
function flattenSubpath(
	subpath: Subpath,
	matrix: Matrix,
	tolerance: number
): { points: Point[]; closed: boolean } | null {
	if (!subpath.segments.length) return null;
	const points: Point[] = [apply(matrix, subpath.start)];
	let current = points[0]!;
	for (const segment of subpath.segments) {
		const to = apply(matrix, segment.to);
		if (segment.kind === 'cubic') {
			flattenCubic(
				current,
				apply(matrix, segment.c1),
				apply(matrix, segment.c2),
				to,
				tolerance,
				points,
				0
			);
		}
		points.push(to);
		current = to;
	}
	const distinct = points.filter(
		(p, index) =>
			index === 0 || Math.hypot(p.x - points[index - 1]!.x, p.y - points[index - 1]!.y) > 1e-9
	);
	const first = distinct[0]!;
	const last = distinct.at(-1)!;
	const meets = distinct.length > 1 && Math.hypot(last.x - first.x, last.y - first.y) <= tolerance;
	if (meets) distinct.pop();
	const closed = (subpath.closed || meets) && distinct.length >= 3;
	return { points: distinct, closed };
}

/** Pushes the interior points of a cubic, subdividing until its controls lie within tolerance of its chord. */
function flattenCubic(
	p0: Point,
	p1: Point,
	p2: Point,
	p3: Point,
	tolerance: number,
	out: Point[],
	depth: number
): void {
	const chordX = p3.x - p0.x;
	const chordY = p3.y - p0.y;
	const lengthSquared = chordX * chordX + chordY * chordY;
	const offset = (p: Point) => {
		const t = lengthSquared
			? Math.max(0, Math.min(1, ((p.x - p0.x) * chordX + (p.y - p0.y) * chordY) / lengthSquared))
			: 0;
		return Math.hypot(p.x - (p0.x + t * chordX), p.y - (p0.y + t * chordY));
	};
	// The curve lies in the hull of its controls, so their distance from the
	// chord segment bounds the flattening error, loops and cusps included.
	if (depth >= 18 || Math.max(offset(p1), offset(p2)) <= tolerance) return;
	const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
	const a = mid(p0, p1);
	const b = mid(p1, p2);
	const c = mid(p2, p3);
	const ab = mid(a, b);
	const bc = mid(b, c);
	const centre = mid(ab, bc);
	flattenCubic(p0, a, ab, centre, tolerance, out, depth + 1);
	out.push(centre);
	flattenCubic(centre, bc, c, p3, tolerance, out, depth + 1);
}
