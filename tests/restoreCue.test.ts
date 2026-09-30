import { describe, expect, it } from 'vitest';
import { createReloadRestoreCueGate } from '../src/ui/restoreCue';

describe('reload restoration cue gate', () => {
  it('announces restored progress once after a true page reload', () => {
    const shouldAnnounce = createReloadRestoreCueGate('reload');

    expect(shouldAnnounce(false)).toBe(false);
    expect(shouldAnnounce(true)).toBe(true);
    expect(shouldAnnounce(true)).toBe(false);
  });

  it.each(['navigate', 'back_forward', 'prerender', null, undefined] as const)(
    'does not announce restoration after %s navigation',
    (navigationType) => {
      const shouldAnnounce = createReloadRestoreCueGate(navigationType);
      expect(shouldAnnounce(true)).toBe(false);
    },
  );

  it('does not announce a fresh board even after a reload', () => {
    const shouldAnnounce = createReloadRestoreCueGate('reload');

    expect(shouldAnnounce(false)).toBe(false);
  });
});
