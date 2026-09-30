import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneBoard, loadBoard, tryPour } from '../src/game/engine';
import {
  clearInProgress,
  IN_PROGRESS_MAX_AGE_MS,
  loadInProgress,
  saveInProgress,
} from '../src/game/inProgress';
import { LEVELS } from '../src/levels/index';
import type { BoardState, LevelDef } from '../src/game/types';

const KEY = 'hexpour:in-progress';
const now = 1_800_000_000_000;
const level = LEVELS[1]!;
const storage = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem(key: string) {
    return storage.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  clear() {
    storage.clear();
  },
});

function progressedBoard(def: LevelDef = level): { board: BoardState; undoStack: BoardState[] } {
  const board = loadBoard(def);
  const undoStack = [cloneBoard(board)];
  const result = tryPour(board, { q: 0, r: 0 }, { q: 0, r: 1 });
  if (!result.ok) throw new Error('The Level 2 fixture move must be legal');
  return { board, undoStack };
}

describe('in-progress puzzle persistence', () => {
  beforeEach(() => storage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('stores and restores the matching board, move count, and undo history', () => {
    const progress = progressedBoard();
    expect(saveInProgress(level, progress.board, progress.undoStack, now)).toBe(true);

    const restored = loadInProgress(level, now + 10_000);
    expect(restored).not.toBeNull();
    expect(restored).toMatchObject({ levelId: level.id, moveCount: 1, savedAt: now });
    expect(restored?.board).toEqual(progress.board);
    expect(restored?.undoStack).toEqual(progress.undoStack);
  });

  it('does not restore another level’s snapshot or delete it until a new run replaces it', () => {
    const progress = progressedBoard();
    saveInProgress(level, progress.board, progress.undoStack, now);
    const stored = storage.get(KEY);

    expect(loadInProgress(LEVELS[0]!, now)).toBeNull();
    expect(storage.get(KEY)).toBe(stored);
    expect(loadInProgress(level, now)?.moveCount).toBe(1);
  });

  it('treats absent storage as a fresh run and clears explicitly', () => {
    expect(loadInProgress(level, now)).toBeNull();
    const progress = progressedBoard();
    saveInProgress(level, progress.board, progress.undoStack, now);
    clearInProgress();
    expect(storage.has(KEY)).toBe(false);
  });

  it.each([
    ['malformed JSON', '{ broken'],
    ['wrong version', JSON.stringify({ version: 99, levelId: level.id, savedAt: now, moveCount: 1 })],
    ['expired save', JSON.stringify({ version: 1, levelId: level.id, savedAt: now - IN_PROGRESS_MAX_AGE_MS - 1, moveCount: 1 })],
    ['future-dated save', JSON.stringify({ version: 1, levelId: level.id, savedAt: now + 10 * 60 * 1000, moveCount: 1 })],
  ])('falls back safely for %s data and removes it', (_label, raw) => {
    storage.set(KEY, raw);
    expect(loadInProgress(level, now)).toBeNull();
    expect(storage.has(KEY)).toBe(false);
  });

  it('rejects structurally corrupt boards and inconsistent move history', () => {
    const progress = progressedBoard();
    saveInProgress(level, progress.board, progress.undoStack, now);
    const valid = JSON.parse(storage.get(KEY)!);
    valid.board.cells[0].stack[0] = 'not-a-color';
    storage.set(KEY, JSON.stringify(valid));
    expect(loadInProgress(level, now)).toBeNull();
    expect(storage.has(KEY)).toBe(false);

    saveInProgress(level, progress.board, progress.undoStack, now);
    const wrongCount = JSON.parse(storage.get(KEY)!);
    wrongCount.moveCount = 2;
    storage.set(KEY, JSON.stringify(wrongCount));
    expect(loadInProgress(level, now)).toBeNull();
    expect(storage.has(KEY)).toBe(false);
  });

  it('keeps unlock/settings storage independent and clears a solved board instead of saving it', () => {
    const progress = progressedBoard();
    const progressData = JSON.stringify({ unlocked: 2, adsRemoved: false, mute: true });
    storage.set('hexpour_v1', progressData);
    saveInProgress(level, progress.board, progress.undoStack, now);
    expect(storage.get('hexpour_v1')).toBe(progressData);

    const solvedLevel = LEVELS[0]!;
    const solved = loadBoard(solvedLevel);
    const history = [cloneBoard(solved)];
    expect(tryPour(solved, { q: 0, r: 0 }, { q: 0, r: 1 }).ok).toBe(true);
    expect(saveInProgress(solvedLevel, solved, history, now)).toBe(false);
    expect(storage.has(KEY)).toBe(false);
    expect(storage.get('hexpour_v1')).toBe(progressData);
  });
});
