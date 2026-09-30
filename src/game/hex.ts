/**
 * Hex grid math — FLAT-TOP axial coordinates.
 * Documented choice: flat-top (pointy side left/right).
 * Pixel layout uses flat-top formulas; neighbor offsets are identical
 * for flat/pointy in axial space.
 */
import type { Axial } from './types';

/** Six neighbors in axial coords (flat-top / pointy-top same offsets). */
export const AXIAL_DIRS: readonly Axial[] = [
  { q: +1, r: 0 },
  { q: +1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: +1 },
  { q: 0, r: +1 },
] as const;

export function neighbors(q: number, r: number): Axial[] {
  return AXIAL_DIRS.map((d) => ({ q: q + d.q, r: r + d.r }));
}

export function areAdjacent(a: Axial, b: Axial): boolean {
  const dq = b.q - a.q;
  const dr = b.r - a.r;
  return AXIAL_DIRS.some((d) => d.q === dq && d.r === dr);
}

export type ScreenDirection = 'up' | 'down' | 'left' | 'right';

/** Choose the nearest cell lying in a screen direction from the current cell. */
export function nearestCellInDirection(
  cells: readonly Axial[],
  origin: Axial,
  direction: ScreenDirection,
): Axial | null {
  const vectors: Record<ScreenDirection, { x: number; y: number }> = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 },
  };
  const vector = vectors[direction];
  const point = axialToPixel(origin.q, origin.r, 1);
  let nearest: Axial | null = null;
  let nearestScore = Infinity;

  for (const cell of cells) {
    if (cell.q === origin.q && cell.r === origin.r) continue;
    const candidate = axialToPixel(cell.q, cell.r, 1);
    const dx = candidate.x - point.x;
    const dy = candidate.y - point.y;
    const forward = dx * vector.x + dy * vector.y;
    if (forward <= 0) continue;

    const perpendicular = dx * vector.y - dy * vector.x;
    const score = dx * dx + dy * dy + perpendicular * perpendicular;
    if (score < nearestScore - 1e-9) {
      nearest = cell;
      nearestScore = score;
    }
  }

  return nearest ? { q: nearest.q, r: nearest.r } : null;
}

/** Flat-top: pixel center of axial cell. */
export function axialToPixel(q: number, r: number, size: number): { x: number; y: number } {
  const x = size * ((3 / 2) * q);
  const y = size * ((Math.sqrt(3) / 2) * q + Math.sqrt(3) * r);
  return { x, y };
}

/** Flat-top: six corner vertices of a hex centered at (cx, cy). */
export function hexCorners(cx: number, cy: number, size: number): { x: number; y: number }[] {
  const corners: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i);
    corners.push({
      x: cx + size * Math.cos(angle),
      y: cy + size * Math.sin(angle),
    });
  }
  return corners;
}

/** Inverse: pixel → nearest axial (flat-top). */
export function pixelToAxial(x: number, y: number, size: number): Axial {
  const q = ((2 / 3) * x) / size;
  const r = ((-1 / 3) * x + (Math.sqrt(3) / 3) * y) / size;
  return axialRound(q, r);
}

function axialRound(fq: number, fr: number): Axial {
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const qDiff = Math.abs(q - fq);
  const rDiff = Math.abs(r - fr);
  const sDiff = Math.abs(s - fs);
  if (qDiff > rDiff && qDiff > sDiff) {
    q = -r - s;
  } else if (rDiff > sDiff) {
    r = -q - s;
  }
  return { q, r };
}
