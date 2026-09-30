import { describe, expect, it } from 'vitest';
import {
  cloneBoard,
  isWon,
  listLegalPours,
  loadBoard,
  tryPour,
} from '../src/game/engine';
import type { LevelDef } from '../src/game/types';

const fixture: LevelDef = {
  id: 99,
  capacity: 3,
  cells: [
    { q: 0, r: 0, stack: ['R', 'G', 'R'] },
    { q: 1, r: 0, stack: ['G'] },
    { q: 0, r: 1, stack: [] },
    { q: 2, r: 0, blocked: true },
  ],
};

describe('pour engine', () => {
  it('allows legal pour onto empty adjacent', () => {
    const board = loadBoard(fixture);
    const r = tryPour(board, { q: 0, r: 0 }, { q: 0, r: 1 });
    expect(r.ok).toBe(true);
    expect(r.moved).toBe(1); // top run of R is length 1
    expect(board.cells.get('0,1')!.stack).toEqual(['R']);
    expect(board.cells.get('0,0')!.stack).toEqual(['R', 'G']);
  });

  it('allows pour onto matching top color', () => {
    const board = loadBoard({
      id: 98,
      capacity: 3,
      cells: [
        { q: 0, r: 0, stack: ['R', 'R'] },
        { q: 1, r: 0, stack: ['R'] },
      ],
    });
    const r = tryPour(board, { q: 0, r: 0 }, { q: 1, r: 0 });
    expect(r.ok).toBe(true);
    expect(r.moved).toBe(2);
    expect(board.cells.get('1,0')!.stack).toEqual(['R', 'R', 'R']);
    expect(board.cells.get('0,0')!.stack).toEqual([]);
  });

  it('rejects non-adjacent pour', () => {
    const b = loadBoard(fixture);
    const r = tryPour(b, { q: 0, r: 0 }, { q: 2, r: -1 });
    // 2,-1 may not exist — missing-cell or not-adjacent
    expect(r.ok).toBe(false);
  });

  it('rejects pour to non-adjacent existing empty via far cell', () => {
    const board = loadBoard({
      id: 97,
      capacity: 3,
      cells: [
        { q: 0, r: 0, stack: ['R'] },
        { q: 2, r: 0, stack: [] },
      ],
    });
    const r = tryPour(board, { q: 0, r: 0 }, { q: 2, r: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-adjacent');
  });

  it('rejects color mismatch', () => {
    const board = loadBoard(fixture);
    const r = tryPour(board, { q: 0, r: 0 }, { q: 1, r: 0 });
    // top of source is R, target top is G
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('color-mismatch');
  });

  it('rejects pour onto blocked', () => {
    const board = loadBoard(fixture);
    // make adjacent blocked reachable: add neighbor that is blocked
    // (2,0) is blocked but not adjacent to (0,0). Use (1,-1) blocked.
    const b2 = loadBoard({
      id: 96,
      capacity: 3,
      cells: [
        { q: 0, r: 0, stack: ['R'] },
        { q: 1, r: 0, blocked: true },
      ],
    });
    const r = tryPour(b2, { q: 0, r: 0 }, { q: 1, r: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('blocked');
  });

  it('respects capacity', () => {
    const board = loadBoard({
      id: 95,
      capacity: 3,
      cells: [
        { q: 0, r: 0, stack: ['R', 'R', 'R'] },
        { q: 1, r: 0, stack: ['R', 'R', 'R'] },
      ],
    });
    const r = tryPour(board, { q: 0, r: 0 }, { q: 1, r: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('full');
  });

  it('cloneBoard is deep', () => {
    const board = loadBoard(fixture);
    const c = cloneBoard(board);
    c.cells.get('0,0')!.stack.pop();
    expect(board.cells.get('0,0')!.stack).toHaveLength(3);
  });
});

describe('win detect', () => {
  it('wins when all occupied stacks are uniform', () => {
    const board = loadBoard({
      id: 1,
      capacity: 3,
      cells: [
        { q: 0, r: 0, stack: ['R', 'R'] },
        { q: 1, r: 0, stack: ['G', 'G', 'G'] },
        { q: 0, r: 1, stack: [] },
        { q: -1, r: 0, blocked: true },
      ],
    });
    expect(isWon(board)).toBe(true);
  });

  it('not won when a stack is mixed', () => {
    const board = loadBoard(fixture);
    expect(isWon(board)).toBe(false);
  });
});

describe('fixture level 1', () => {
  it('has a one-pour solution that actually wins', async () => {
    const { default: level1 } = await import('../src/levels/level-01.json');
    const board = loadBoard(level1 as LevelDef);
    expect(board.capacity).toBe(3);
    const legal = listLegalPours(board);
    expect(legal.length).toBeGreaterThan(0);
    const winning = legal.filter(({ from, to }) => {
      const candidate = cloneBoard(board);
      return tryPour(candidate, from, to).ok && isWon(candidate);
    });
    expect(winning).toHaveLength(1);
    expect(tryPour(board, winning[0]!.from, winning[0]!.to).ok).toBe(true);
    expect(isWon(board)).toBe(true);
  });
});
