import { describe, expect, it } from 'vitest';
import { AXIAL_DIRS, areAdjacent, neighbors } from '../src/game/hex';

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
});
