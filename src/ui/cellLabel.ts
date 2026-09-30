import type { CellState, ColorId } from '../game/types';

const COLOR_NAMES: Record<ColorId, string> = {
  R: 'red',
  G: 'green',
  B: 'blue',
  Y: 'yellow',
  P: 'purple',
  O: 'orange',
};

/** Describe a board cell using the same bottom-to-top order as the game rules. */
export function cellAccessibleLabel(cell: CellState, capacity: number): string {
  const location = `Hex cell q ${cell.q}, r ${cell.r}`;
  if (cell.blocked) return `${location}: blocked hole.`;
  if (cell.stack.length === 0) {
    return `${location}: empty; 0 of ${capacity} slots filled. Available as a pour target.`;
  }

  const tokens = cell.stack.map((color) => COLOR_NAMES[color] ?? color).join(', ');
  return `${location}: bottom to top ${tokens}; ${cell.stack.length} of ${capacity} slots filled.`;
}
