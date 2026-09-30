import { describe, expect, it } from 'vitest';
import { getRestartConfirmation } from '../src/ui/restartConfirmation';

describe('restart confirmation', () => {
  it('keeps a fresh level restart immediate', () => {
    expect(getRestartConfirmation(2, 0)).toBeNull();
  });

  it('warns before discarding a board after one pour', () => {
    expect(getRestartConfirmation(2, 1)).toBe(
      'You have made 1 pour. Restarting will discard the current board and start Level 2 over.',
    );
  });

  it('uses the plural pour count for progressed boards', () => {
    expect(getRestartConfirmation(11, 3)).toBe(
      'You have made 3 pours. Restarting will discard the current board and start Level 11 over.',
    );
  });
});
