import { describe, expect, it } from 'vitest';
import { getLevelChangeConfirmation } from '../src/ui/levelChangeConfirmation';

describe('level-change confirmation', () => {
  it('does not interrupt an untouched board or a return to the same level', () => {
    expect(getLevelChangeConfirmation(2, 1, 0)).toBeNull();
    expect(getLevelChangeConfirmation(2, 2, 1)).toBeNull();
  });

  it('describes the board at risk after one pour', () => {
    expect(getLevelChangeConfirmation(2, 1, 1)).toBe(
      'You have made 1 pour in Level 2. Switching to Level 1 will discard this board.',
    );
  });

  it('uses the plural pour count for a progressed board', () => {
    expect(getLevelChangeConfirmation(11, 4, 3)).toBe(
      'You have made 3 pours in Level 11. Switching to Level 4 will discard this board.',
    );
  });

  it('ignores invalid counts rather than showing a misleading warning', () => {
    expect(getLevelChangeConfirmation(2, 1, -1)).toBeNull();
    expect(getLevelChangeConfirmation(2, 1, 1.5)).toBeNull();
  });
});
