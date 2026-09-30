import { isWon, loadBoard } from './engine';
import { COLORS, type BoardState, type ColorId, type LevelDef } from './types';

const KEY = 'hexpour:in-progress';
const VERSION = 1;
export const IN_PROGRESS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_SNAPSHOT_CHARS = 512 * 1024;

export interface InProgressSnapshot {
  levelId: number;
  board: BoardState;
  /** One pre-pour board for each undoable move; also supplies the displayed pour count. */
  undoStack: BoardState[];
  moveCount: number;
  savedAt: number;
}

interface SerializedCell {
  q: number;
  r: number;
  blocked: boolean;
  stack: ColorId[];
}

interface SerializedBoard {
  capacity: number;
  cells: SerializedCell[];
}

interface SerializedSnapshot {
  version: number;
  levelId: number;
  savedAt: number;
  moveCount: number;
  board: SerializedBoard;
  undoStack: SerializedBoard[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializeBoard(board: BoardState): SerializedBoard {
  return {
    capacity: board.capacity,
    cells: Array.from(board.cells.values(), (cell) => ({
      q: cell.q,
      r: cell.r,
      blocked: cell.blocked,
      stack: [...cell.stack],
    })),
  };
}

function boardFromUnknown(value: unknown, level: LevelDef): BoardState | null {
  if (!isRecord(value) || value.capacity !== level.capacity || !Array.isArray(value.cells) ||
      value.cells.length !== level.cells.length) {
    return null;
  }

  const definitions = new Map(level.cells.map((cell) => [`${cell.q},${cell.r}`, cell]));
  const cells = new Map<string, { q: number; r: number; blocked: boolean; stack: ColorId[] }>();
  const expectedInventory = new Map<ColorId, number>();
  const actualInventory = new Map<ColorId, number>();
  for (const cell of level.cells) {
    for (const color of cell.stack ?? []) {
      expectedInventory.set(color, (expectedInventory.get(color) ?? 0) + 1);
    }
  }

  for (const candidate of value.cells) {
    if (!isRecord(candidate) || !Number.isInteger(candidate.q) || !Number.isInteger(candidate.r) ||
        typeof candidate.blocked !== 'boolean' || !Array.isArray(candidate.stack)) {
      return null;
    }
    const q = candidate.q as number;
    const r = candidate.r as number;
    const key = `${q},${r}`;
    const definition = definitions.get(key);
    if (!definition || cells.has(key) || candidate.blocked !== (definition.blocked === true)) {
      return null;
    }

    const stack: ColorId[] = [];
    if (candidate.stack.length > level.capacity || (candidate.blocked && candidate.stack.length > 0)) {
      return null;
    }
    for (const color of candidate.stack) {
      if (typeof color !== 'string' || !COLORS.includes(color as ColorId)) return null;
      stack.push(color as ColorId);
      actualInventory.set(color as ColorId, (actualInventory.get(color as ColorId) ?? 0) + 1);
    }
    cells.set(key, { q, r, blocked: candidate.blocked, stack });
  }

  if (cells.size !== definitions.size) return null;
  for (const color of COLORS) {
    if ((actualInventory.get(color) ?? 0) !== (expectedInventory.get(color) ?? 0)) return null;
  }
  return { capacity: level.capacity, cells };
}

function sameBoard(a: BoardState, b: BoardState): boolean {
  if (a.capacity !== b.capacity || a.cells.size !== b.cells.size) return false;
  for (const [key, left] of a.cells) {
    const right = b.cells.get(key);
    if (!right || left.q !== right.q || left.r !== right.r || left.blocked !== right.blocked ||
        left.stack.length !== right.stack.length || left.stack.some((color, index) => color !== right.stack[index])) {
      return false;
    }
  }
  return true;
}

function removeStoredSnapshot(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* Storage can be disabled in private or restricted contexts. */
  }
}

export function clearInProgress(): void {
  removeStoredSnapshot();
}

export function saveInProgress(
  level: LevelDef,
  board: BoardState,
  undoStack: BoardState[],
  now = Date.now(),
): boolean {
  if (undoStack.length === 0 || isWon(board)) {
    clearInProgress();
    return false;
  }

  const snapshot: SerializedSnapshot = {
    version: VERSION,
    levelId: level.id,
    savedAt: now,
    moveCount: undoStack.length,
    board: serializeBoard(board),
    undoStack: undoStack.map(serializeBoard),
  };

  try {
    const serialized = JSON.stringify(snapshot);
    if (serialized.length > MAX_SNAPSHOT_CHARS) {
      clearInProgress();
      return false;
    }
    localStorage.setItem(KEY, serialized);
    return true;
  } catch {
    /* Playing remains available if serialization or storage fails. */
    clearInProgress();
    return false;
  }
}

export function loadInProgress(level: LevelDef, now = Date.now()): InProgressSnapshot | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  if (raw.length > MAX_SNAPSHOT_CHARS) {
    clearInProgress();
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearInProgress();
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== VERSION || !Number.isSafeInteger(parsed.levelId) ||
      !Number.isSafeInteger(parsed.savedAt) || !Number.isSafeInteger(parsed.moveCount)) {
    clearInProgress();
    return null;
  }

  const savedAt = parsed.savedAt as number;
  if (savedAt < now - IN_PROGRESS_MAX_AGE_MS || savedAt > now + FUTURE_CLOCK_SKEW_MS) {
    clearInProgress();
    return null;
  }
  if (parsed.levelId !== level.id) return null;

  const moveCount = parsed.moveCount as number;
  if (moveCount < 1 || !Array.isArray(parsed.undoStack) || parsed.undoStack.length !== moveCount) {
    clearInProgress();
    return null;
  }
  const board = boardFromUnknown(parsed.board, level);
  const undoStack: BoardState[] = [];
  for (const candidate of parsed.undoStack) {
    const restored = boardFromUnknown(candidate, level);
    if (!restored) {
      clearInProgress();
      return null;
    }
    undoStack.push(restored);
  }
  if (!board || isWon(board) || !sameBoard(undoStack[0]!, loadBoard(level))) {
    clearInProgress();
    return null;
  }

  return { levelId: level.id, board, undoStack, moveCount, savedAt };
}
