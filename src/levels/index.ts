import l1 from './level-01.json';
import l2 from './level-02.json';
import l3 from './level-03.json';
import l4 from './level-04.json';
import l5 from './level-05.json';
import l6 from './level-06.json';
import l7 from './level-07.json';
import l8 from './level-08.json';
import l9 from './level-09.json';
import l10 from './level-10.json';
import l11 from './level-11.json';
import l12 from './level-12.json';
import l13 from './level-13.json';
import l14 from './level-14.json';
import l15 from './level-15.json';
import l16 from './level-16.json';
import l17 from './level-17.json';
import l18 from './level-18.json';
import l19 from './level-19.json';
import l20 from './level-20.json';
import l21 from './level-21.json';
import l22 from './level-22.json';
import l23 from './level-23.json';
import l24 from './level-24.json';
import l25 from './level-25.json';
import l26 from './level-26.json';
import l27 from './level-27.json';
import l28 from './level-28.json';
import l29 from './level-29.json';
import l30 from './level-30.json';
import l31 from './level-31.json';
import l32 from './level-32.json';
import l33 from './level-33.json';
import l34 from './level-34.json';
import l35 from './level-35.json';
import l36 from './level-36.json';
import l37 from './level-37.json';
import l38 from './level-38.json';
import l39 from './level-39.json';
import l40 from './level-40.json';
import type { LevelDef } from '../game/types';

export const LEVELS: LevelDef[] = [l1, l2, l3, l4, l5, l6, l7, l8, l9, l10, l11, l12, l13, l14, l15, l16, l17, l18, l19, l20, l21, l22, l23, l24, l25, l26, l27, l28, l29, l30, l31, l32, l33, l34, l35, l36, l37, l38, l39, l40] as unknown as LevelDef[];

export function getLevel(id: number): LevelDef | undefined {
  return LEVELS.find((l) => l.id === id);
}

export const LEVEL_COUNT = LEVELS.length;
