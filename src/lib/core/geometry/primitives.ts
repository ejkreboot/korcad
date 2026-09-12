export type Point = { readonly x: number; readonly y: number };

export const point = (x: number, y: number): Point => ({ x, y });

export function unit(a: Point, b: Point): Point {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = Math.hypot(dx, dy) || 1;
	return point(dx / length, dy / length);
}

/** Wraps an angle into (-PI, PI]. */
export function normalizeAngle(angle: number): number {
	let result = angle;
	while (result <= -Math.PI) result += Math.PI * 2;
	while (result > Math.PI) result -= Math.PI * 2;
	return result;
}

export function distance(a: Point, b: Point): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

export function arcPoints(
	cx: number,
	cy: number,
	radius: number,
	start: number,
	end: number,
	steps = 12
): readonly Point[] {
	return Array.from({ length: steps + 1 }, (_, index) => {
		const angle = start + ((end - start) * index) / steps;
		return point(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
	});
}
