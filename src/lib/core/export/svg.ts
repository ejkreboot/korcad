import { SHEET } from '$lib/core/constants.js';
import { round } from '$lib/core/units.js';
import type { DesignPath, Geometry } from '$lib/core/design/types.js';

export type SvgLabel = { readonly name: string; readonly x: number; readonly y: number };

export function xmlEscape(value: string): string {
	return String(value).replace(
		/[&<>"']/g,
		(character) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!
	);
}

function pathMarkup(path: DesignPath): string {
	// SVG's Y axis points down; CAM coordinates point up, so flip about the sheet.
	const points = path.points.map((pt) => `${round(pt.x)},${round(SHEET - pt.y)}`).join(' ');
	const tag = path.closed ? 'polygon' : 'polyline';
	const score = path.type === 'score';
	const stroke = score ? (path.foldDirection === 'up' ? '#84527d' : '#2474a6') : '#d44a36';
	const dash = score
		? path.foldDirection === 'up'
			? ' stroke-dasharray="1 2"'
			: ' stroke-dasharray="3 2"'
		: '';
	return `<${tag} points="${points}" fill="none" stroke="${stroke}" stroke-width="0.5"${dash}/>`;
}

/**
 * A design drawing of the active sheet, in stock coordinates. This is the
 * drawn design, not the compensated toolpath: it is for review and for
 * handing to another program, not for driving a machine.
 */
export function designSvg(geometry: Geometry, labels: readonly SvgLabel[] = []): string {
	const labelMarkup = labels
		.map(
			(label) =>
				`<text x="${round(label.x)}" y="${round(SHEET - label.y)}" text-anchor="start" font-family="sans-serif" font-size="5" fill="#18212b">${xmlEscape(label.name)}</text>`
		)
		.join('\n');
	return (
		`<?xml version="1.0" encoding="UTF-8"?>\n` +
		`<svg xmlns="http://www.w3.org/2000/svg" width="609.6mm" height="609.6mm" viewBox="0 0 ${SHEET} ${SHEET}">\n` +
		`<!-- Voisee insert: red=through cut, blue dashed=down fold, purple dotted=up fold. Origin is lower left in CAM coordinates. -->\n` +
		`<rect width="${SHEET}" height="${SHEET}" fill="white"/>\n` +
		`${geometry.paths.map(pathMarkup).join('\n')}\n` +
		`${labelMarkup}\n` +
		`</svg>\n`
	);
}
