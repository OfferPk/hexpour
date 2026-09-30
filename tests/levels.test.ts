import { describe, expect, it } from 'vitest';
import {
  cloneBoard,
  isWon,
  listLegalPours,
  loadBoard,
  tryPour,
} from '../src/game/engine';
import { COLORS, type BoardState, type ColorId } from '../src/game/types';
import { LEVELS, LEVEL_COUNT, getLevel } from '../src/levels/index';
import { cellAccessibleLabel } from '../src/ui/cellLabel';
import { formatPourCount } from '../src/ui/pourCount';
import { auditMinimumPours } from './support/levelSolver';

function minimumWinningPours(start: BoardState): number | null {
  const queue: { board: BoardState; moves: number }[] = [{ board: start, moves: 0 }];
  const seen = new Set([boardKey(start)]);

  for (let head = 0; head < queue.length; head++) {
    const { board, moves } = queue[head]!;
    if (isWon(board)) return moves;

    for (const pour of listLegalPours(board)) {
      const next = cloneBoard(board);
      if (!tryPour(next, pour.from, pour.to).ok) continue;
      const key = boardKey(next);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ board: next, moves: moves + 1 });
    }
  }
  return null;
}

function hasOnePourWin(board: BoardState): boolean {
  return listLegalPours(board).some(({ from, to }) => {
    const candidate = cloneBoard(board);
    return tryPour(candidate, from, to).ok && isWon(candidate);
  });
}

function boardKey(board: BoardState): string {
  return `${board.capacity}|${Array.from(board.cells.values())
    .map((cell) => (cell.blocked ? '#' : cell.stack.join('')))
    .join('/')}`;
}

function colorCounts(board: BoardState): Record<ColorId, number> {
  const counts: Record<ColorId, number> = { R: 0, G: 0, B: 0, Y: 0, P: 0, O: 0 };
  for (const cell of board.cells.values()) {
    for (const color of cell.stack) counts[color]++;
  }
  return counts;
}

describe('full 40-level pack', () => {
  it('keeps all levels indexed, structurally valid, and playable', () => {
    expect(LEVEL_COUNT).toBe(40);
    expect(LEVELS).toHaveLength(40);
    expect(LEVELS.map((level) => level.id)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );

    for (const [index, level] of LEVELS.entries()) {
      expect(getLevel(index + 1)).toBe(level);
      expect([3, 4]).toContain(level.capacity);
      expect(level.capacity).toBe(index < 12 ? 3 : 4);
      expect(level.cells.length).toBeGreaterThan(0);

      const coordinates = new Set<string>();
      for (const cell of level.cells) {
        expect(Number.isInteger(cell.q)).toBe(true);
        expect(Number.isInteger(cell.r)).toBe(true);
        const key = `${cell.q},${cell.r}`;
        expect(coordinates.has(key), `Level ${level.id} repeats ${key}`).toBe(false);
        coordinates.add(key);

        const stack = cell.stack ?? [];
        if (cell.blocked) {
          expect(stack, `Level ${level.id} blocked cell ${key} holds tokens`).toHaveLength(0);
          continue;
        }
        expect(stack.length, `Level ${level.id} cell ${key} exceeds capacity`).toBeLessThanOrEqual(
          level.capacity,
        );
        for (const color of stack) {
          expect(COLORS, `Level ${level.id} cell ${key} has invalid color ${color}`).toContain(color);
        }
      }

      const board = loadBoard(level);
      expect(board.cells.size).toBe(level.cells.length);
      expect(isWon(board), `Level ${level.id} starts already solved`).toBe(false);
      const before = colorCounts(board);
      const legalPours = listLegalPours(board);
      expect(legalPours.length, `Level ${level.id} has no legal opening pour`).toBeGreaterThan(0);

      for (const pour of legalPours) {
        const next = cloneBoard(board);
        expect(tryPour(next, pour.from, pour.to).ok).toBe(true);
        expect(colorCounts(next), `Level ${level.id} pour changes the color inventory`).toEqual(before);
      }
    }
  });

  it('proves the exact shortest solution depth for all 40 levels within the audit bound', () => {
    const expectedDepths = [
      1, 2, 3, 4, 5, 6, 7, 6, 2, 9, 3, 8, 4, 5, 4, 3, 6, 4, 4, 4,
      6, 2, 2, 2, 3, 4, 2, 2, 3, 4, 2, 2, 2, 3, 2, 2, 3, 6, 2, 2,
    ];
    const audits = LEVELS.map((level) =>
      auditMinimumPours(level, { maxStates: 2_000_000, maxMilliseconds: 60_000 }),
    );
    const incomplete = audits.flatMap((audit, index) =>
      audit.status === 'solved' ? [] : [LEVELS[index]!.id],
    );

    expect(incomplete, 'levels not proven solvable within the explicit bounds').toEqual([]);
    expect(
      audits.map((audit) => (audit.status === 'solved' ? audit.minimumPours : null)),
    ).toEqual(expectedDepths);
  }, 120_000);

  it('keeps the tutorial progression and preserves the deeper Level 10 and 12 puzzles', () => {
    const shortestSolutions = Array.from({ length: 12 }, (_, index) => {
      const level = getLevel(index + 1);
      if (!level) throw new Error(`Missing level ${index + 1}`);
      return minimumWinningPours(loadBoard(level));
    });
    expect(shortestSolutions).toEqual([1, 2, 3, 4, 5, 6, 7, 6, 2, 9, 3, 8]);
  });

  it('keeps the late-game retunes at their exact engine-based shortest depths', () => {
    const retunedLevels = [9, 22, 23, 24, 29, 32, 34, 35, 37, 39];
    const shortestSolutions = retunedLevels.map((id) => {
      const level = getLevel(id);
      if (!level) throw new Error(`Missing level ${id}`);
      return minimumWinningPours(loadBoard(level));
    });
    expect(shortestSolutions).toEqual([2, 2, 2, 2, 3, 2, 3, 2, 3, 2]);
  });

  it('preserves each retuned level color inventory', () => {
    const expected: Record<number, Partial<Record<ColorId, number>>> = {
      9: { R: 3, G: 3, B: 3 },
      22: { R: 16, G: 12, B: 12, Y: 12 },
      23: { R: 16, G: 12, B: 12, Y: 12 },
      24: { R: 16, G: 12, B: 12, Y: 12 },
      29: { R: 16, G: 12, B: 12, Y: 12 },
      32: { R: 16, G: 16, B: 12, Y: 12 },
      34: { R: 12, G: 12, B: 12, Y: 12, P: 8 },
      35: { R: 12, G: 12, B: 12, Y: 12, P: 8 },
      37: { R: 12, G: 8, B: 8, Y: 8, P: 8, O: 8 },
      39: { R: 12, G: 8, B: 8, Y: 8, P: 8, O: 8 },
    };

    for (const [id, totals] of Object.entries(expected)) {
      const level = getLevel(Number(id));
      if (!level) throw new Error(`Missing level ${id}`);
      const presentTotals = Object.fromEntries(
        Object.entries(colorCounts(loadBoard(level))).filter(([, count]) => count > 0),
      );
      expect(presentTotals, `Level ${id} color totals`).toEqual(totals);
    }
  });

  it('keeps Level 1 as the only one-pour win in the pack', () => {
    const onePourWins = LEVELS.filter((level) => hasOnePourWin(loadBoard(level))).map(
      (level) => level.id,
    );
    expect(onePourWins).toEqual([1]);
  });
});

describe('accessible cell labels', () => {
  it('announces stack colors in bottom-to-top order and identifies the top color', () => {
    expect(
      cellAccessibleLabel({ q: -1, r: 2, blocked: false, stack: ['G', 'R', 'R'] }),
    ).toBe('Hex cell q -1, r 2: tokens bottom to top green, red, red. Top color red moves first.');
  });

  it('identifies empty destinations and blocked holes', () => {
    expect(cellAccessibleLabel({ q: 0, r: 1, blocked: false, stack: [] })).toContain(
      'empty. Available as a pour target.',
    );
    expect(cellAccessibleLabel({ q: 2, r: -1, blocked: true, stack: [] })).toContain(
      'blocked hole.',
    );
  });
});

describe('pour-count copy', () => {
  it('uses the singular for one pour and plural for zero or multiple pours', () => {
    expect(formatPourCount(0)).toBe('0 pours');
    expect(formatPourCount(1)).toBe('1 pour');
    expect(formatPourCount(2)).toBe('2 pours');
  });
});
