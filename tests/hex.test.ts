import { describe, expect, it } from 'vitest';
import {
  AXIAL_DIRS,
  areAdjacent,
  nearestCellInDirection,
  neighbors,
} from '../src/game/hex';

describe('hex neighbors (flat-top axial)', () => {
  it('has 6 neighbor directions', () => {
    expect(AXIAL_DIRS).toHaveLength(6);
  });

  it('returns 6 neighbors for origin', () => {
    const n = neighbors(0, 0);
    expect(n).toHaveLength(6);
    expect(n).toEqual(
      expect.arrayContaining([
        { q: 1, r: 0 },
        { q: 1, r: -1 },
        { q: 0, r: -1 },
        { q: -1, r: 0 },
        { q: -1, r: 1 },
        { q: 0, r: 1 },
      ]),
    );
  });

  it('areAdjacent is true for neighbors, false for far cells', () => {
    expect(areAdjacent({ q: 0, r: 0 }, { q: 1, r: 0 })).toBe(true);
    expect(areAdjacent({ q: 0, r: 0 }, { q: 2, r: 0 })).toBe(false);
    expect(areAdjacent({ q: 0, r: 0 }, { q: 0, r: 0 })).toBe(false);
  });

  it('finds the nearest accessible cell in each screen direction', () => {
    const cells = [{ q: 0, r: 0 }, { q: 1, r: 0 }, { q: 0, r: 1 }];
    expect(nearestCellInDirection(cells, { q: 0, r: 0 }, 'right')).toEqual({ q: 1, r: 0 });
    expect(nearestCellInDirection(cells, { q: 0, r: 0 }, 'down')).toEqual({ q: 0, r: 1 });
    expect(nearestCellInDirection(cells, { q: 0, r: 1 }, 'up')).toEqual({ q: 0, r: 0 });
    expect(nearestCellInDirection(cells, { q: 1, r: 0 }, 'left')).toEqual({ q: 0, r: 0 });
  });

  it('returns null when no cell lies in the requested direction', () => {
    expect(nearestCellInDirection([{ q: 0, r: 0 }], { q: 0, r: 0 }, 'left')).toBeNull();
  });
});
