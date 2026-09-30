import { listLegalPours, loadBoard } from '../../src/game/engine';
import { neighbors } from '../../src/game/hex';
import type { LevelDef } from '../../src/game/types';

const EMPTY = '.';
const BLOCKED = '#';

export interface SolverLimits {
  /** Maximum unique states visited before this level's audit is bounded. */
  maxStates?: number;
  /** Maximum wall-clock time spent on this level before it is bounded. */
  maxMilliseconds?: number;
}

export type ExactDepthResult =
  | { status: 'solved'; minimumPours: number; visitedStates: number; expandedStates: number }
  | { status: 'unsolvable'; visitedStates: number; expandedStates: number }
  | {
      status: 'bounded';
      visitedStates: number;
      expandedStates: number;
      reason: 'state-limit' | 'time-limit';
    };

/**
 * Exact breadth-first search over fixed-width stack encodings. Each token move
 * follows the same top-run, capacity, adjacency, and top-color rules as the
 * game engine. The result is a shortest depth or an explicit bounded/exhausted
 * status; a bound is never reported as a proof of unsolvability.
 */
export function auditMinimumPours(
  level: LevelDef,
  limits: SolverLimits = {},
): ExactDepthResult {
  const maxStates = limits.maxStates ?? 250_000;
  const maxMilliseconds = limits.maxMilliseconds ?? 15_000;
  const cellCount = level.cells.length;
  const capacity = level.capacity;
  const cellIndex = new Map(level.cells.map((cell, index) => [`${cell.q},${cell.r}`, index]));
  const targets = level.cells.map((cell) => {
    if (cell.blocked) return [];
    return neighbors(cell.q, cell.r)
      .map(({ q, r }) => cellIndex.get(`${q},${r}`))
      .filter((index): index is number => index !== undefined && !level.cells[index]!.blocked);
  });

  const initial = level.cells
    .map((cell) =>
      cell.blocked ? BLOCKED.repeat(capacity) : (cell.stack ?? []).join('').padEnd(capacity, EMPTY),
    )
    .join('');

  const encodeMove = (from: number, to: number): string => {
    const source = level.cells[from]!;
    const target = level.cells[to]!;
    return `${source.q},${source.r}>${target.q},${target.r}`;
  };

  function stackLength(state: string, cell: number): number {
    const start = cell * capacity;
    let length = 0;
    while (length < capacity && state[start + length] !== EMPTY) length++;
    return length;
  }

  function isWon(state: string): boolean {
    for (let cell = 0; cell < cellCount; cell++) {
      if (level.cells[cell]!.blocked) continue;
      const length = stackLength(state, cell);
      if (length < 2) continue;
      const start = cell * capacity;
      const first = state[start];
      for (let slot = 1; slot < length; slot++) {
        if (state[start + slot] !== first) return false;
      }
    }
    return true;
  }

  function moves(state: string): { state: string; from: number; to: number }[] {
    const result: { state: string; from: number; to: number }[] = [];
    for (let from = 0; from < cellCount; from++) {
      if (level.cells[from]!.blocked) continue;
      const sourceLength = stackLength(state, from);
      if (sourceLength === 0) continue;
      const sourceStart = from * capacity;
      const color = state[sourceStart + sourceLength - 1]!;
      let topRun = 1;
      while (
        topRun < sourceLength &&
        state[sourceStart + sourceLength - topRun - 1] === color
      ) {
        topRun++;
      }

      for (const to of targets[from]!) {
        const targetLength = stackLength(state, to);
        if (targetLength >= capacity) continue;
        const targetStart = to * capacity;
        if (targetLength > 0 && state[targetStart + targetLength - 1] !== color) continue;

        const moved = Math.min(topRun, capacity - targetLength);
        const next = state.split('');
        for (let slot = 0; slot < moved; slot++) {
          next[sourceStart + sourceLength - 1 - slot] = EMPTY;
          next[targetStart + targetLength + slot] = color;
        }
        result.push({ state: next.join(''), from, to });
      }
    }
    return result;
  }

  // Guard the compact solver's initial move generator against the production
  // engine before search; both use the same axial neighbor helper and rules.
  const engineMoves = listLegalPours(loadBoard(level))
    .map(({ from, to }) => `${from.q},${from.r}>${to.q},${to.r}`)
    .sort();
  const compactMoves = moves(initial)
    .map(({ from, to }) => encodeMove(from, to))
    .sort();
  if (JSON.stringify(engineMoves) !== JSON.stringify(compactMoves)) {
    throw new Error(`Exact solver opening moves disagree with the engine for level ${level.id}`);
  }

  const queue = [initial];
  const seen = new Set(queue);
  let head = 0;
  let depth = 0;
  let layerEnd = 1;
  let expandedStates = 0;
  const started = Date.now();

  while (head < queue.length) {
    if (head === layerEnd) {
      depth++;
      layerEnd = queue.length;
    }

    const state = queue[head++]!;
    expandedStates++;
    if (isWon(state)) {
      return { status: 'solved', minimumPours: depth, visitedStates: seen.size, expandedStates };
    }

    if ((expandedStates & 0xff) === 0 && Date.now() - started >= maxMilliseconds) {
      return {
        status: 'bounded',
        visitedStates: seen.size,
        expandedStates,
        reason: 'time-limit',
      };
    }

    for (const move of moves(state)) {
      if (seen.has(move.state)) continue;
      if (seen.size >= maxStates) {
        return {
          status: 'bounded',
          visitedStates: seen.size,
          expandedStates,
          reason: 'state-limit',
        };
      }
      seen.add(move.state);
      queue.push(move.state);
    }
  }

  return { status: 'unsolvable', visitedStates: seen.size, expandedStates };
}
