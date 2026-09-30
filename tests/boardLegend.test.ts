import { describe, expect, it } from 'vitest';
import { BOARD_CUE_LEGEND } from '../src/ui/boardLegend';

describe('board cue legend', () => {
  it('names the source, legal destination, blocked neighbor, and blocked-cell marks without color language', () => {
    expect(BOARD_CUE_LEGEND.map(({ label, description }) => `${label} — ${description}`)).toEqual([
      'Selected source — double outline',
      'Legal destination — dashed outline + check',
      'Blocked neighbor — X mark',
      'Blocked cell — diagonal hatch',
    ]);
    expect(new Set(BOARD_CUE_LEGEND.map(({ markerClass }) => markerClass)).size).toBe(4);
  });
});
