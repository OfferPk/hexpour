/** Color token short ids — max 6 in late levels. */
export type ColorId = 'R' | 'G' | 'B' | 'Y' | 'P' | 'O';

export const COLORS: readonly ColorId[] = ['R', 'G', 'B', 'Y', 'P', 'O'] as const;

export const COLOR_HEX: Record<ColorId, string> = {
  R: '#e74c5e',
  G: '#3dba7a',
  B: '#4a9fe8',
  Y: '#f0c848',
  P: '#b07ce8',
  O: '#f0a04a',
};

/** Axial hex coordinate (flat-top orientation for pixel math). */
export interface Axial {
  q: number;
  r: number;
}

export interface CellDef {
  q: number;
  r: number;
  /** Bottom → top. Empty array = empty playable cell. */
  stack?: ColorId[];
  /** Hole / blocked — never holds tokens. */
  blocked?: boolean;
}

export interface LevelDef {
  id: number;
  capacity: number;
  cells: CellDef[];
}

export interface CellState {
  q: number;
  r: number;
  blocked: boolean;
  /** Bottom → top. Top is last element (pourable). */
  stack: ColorId[];
}

export interface BoardState {
  capacity: number;
  cells: Map<string, CellState>;
}

export function cellKey(q: number, r: number): string {
  return `${q},${r}`;
}

export function parseKey(key: string): Axial {
  const [q, r] = key.split(',').map(Number);
  return { q, r };
}
