/**
 * Pour engine — hex adjacency, capacity, same-color top runs, win detect.
 * NOT TubeSort: pour only to adjacent hex cells.
 */
import { areAdjacent, neighbors } from './hex';
import {
  cellKey,
  type Axial,
  type BoardState,
  type CellState,
  type ColorId,
  type LevelDef,
} from './types';

export function loadBoard(level: LevelDef): BoardState {
  const cells = new Map<string, CellState>();
  for (const c of level.cells) {
    const blocked = c.blocked === true;
    cells.set(cellKey(c.q, c.r), {
      q: c.q,
      r: c.r,
      blocked,
      stack: blocked ? [] : [...(c.stack ?? [])],
    });
  }
  return { capacity: level.capacity, cells };
}

export function cloneBoard(board: BoardState): BoardState {
  const cells = new Map<string, CellState>();
  for (const [k, c] of board.cells) {
    cells.set(k, { q: c.q, r: c.r, blocked: c.blocked, stack: [...c.stack] });
  }
  return { capacity: board.capacity, cells };
}

export function getCell(board: BoardState, q: number, r: number): CellState | undefined {
  return board.cells.get(cellKey(q, r));
}

/** Top color of stack (last element), or null if empty. */
export function topColor(cell: CellState): ColorId | null {
  if (cell.stack.length === 0) return null;
  return cell.stack[cell.stack.length - 1]!;
}

/** Length of contiguous same-color run from the top. */
export function topRunLength(cell: CellState): number {
  if (cell.stack.length === 0) return 0;
  const top = cell.stack[cell.stack.length - 1]!;
  let n = 0;
  for (let i = cell.stack.length - 1; i >= 0; i--) {
    if (cell.stack[i] === top) n++;
    else break;
  }
  return n;
}

export interface PourResult {
  ok: boolean;
  reason?: string;
  /** How many tokens moved (if ok). */
  moved?: number;
}

/**
 * Attempt pour from source → target.
 * Rules:
 * - source & target must exist, not blocked
 * - must be adjacent (6-neighbor)
 * - source must have tokens
 * - target empty OR top color matches source top
 * - capacity: move min(topRun, freeSlots)
 */
export function tryPour(
  board: BoardState,
  from: Axial,
  to: Axial,
): PourResult {
  if (from.q === to.q && from.r === to.r) {
    return { ok: false, reason: 'same-cell' };
  }
  const src = getCell(board, from.q, from.r);
  const dst = getCell(board, to.q, to.r);
  if (!src || !dst) return { ok: false, reason: 'missing-cell' };
  if (src.blocked || dst.blocked) return { ok: false, reason: 'blocked' };
  if (!areAdjacent(from, to)) return { ok: false, reason: 'not-adjacent' };
  if (src.stack.length === 0) return { ok: false, reason: 'empty-source' };

  const color = topColor(src)!;
  const run = topRunLength(src);
  const free = board.capacity - dst.stack.length;
  if (free <= 0) return { ok: false, reason: 'full' };

  const dstTop = topColor(dst);
  if (dstTop !== null && dstTop !== color) {
    return { ok: false, reason: 'color-mismatch' };
  }

  const move = Math.min(run, free);
  for (let i = 0; i < move; i++) {
    src.stack.pop();
    dst.stack.push(color);
  }
  return { ok: true, moved: move };
}

/** Win: every occupied (non-blocked, non-empty) cell is a single solid color. Empties OK. */
export function isWon(board: BoardState): boolean {
  for (const cell of board.cells.values()) {
    if (cell.blocked) continue;
    if (cell.stack.length === 0) continue;
    const c0 = cell.stack[0]!;
    for (let i = 1; i < cell.stack.length; i++) {
      if (cell.stack[i] !== c0) return false;
    }
  }
  return true;
}

/** Find all legal pours: {from, to} pairs. */
export function listLegalPours(board: BoardState): { from: Axial; to: Axial }[] {
  const result: { from: Axial; to: Axial }[] = [];
  for (const src of board.cells.values()) {
    if (src.blocked || src.stack.length === 0) continue;
    for (const n of neighbors(src.q, src.r)) {
      const dst = getCell(board, n.q, n.r);
      if (!dst || dst.blocked) continue;
      const probe = cloneBoard(board);
      const r = tryPour(probe, { q: src.q, r: src.r }, n);
      if (r.ok) result.push({ from: { q: src.q, r: src.r }, to: n });
    }
  }
  return result;
}

/** One hint: first legal pour, or null. */
export function hintPour(board: BoardState): { from: Axial; to: Axial } | null {
  const legal = listLegalPours(board);
  return legal[0] ?? null;
}
