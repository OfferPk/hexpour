import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isLevelComplete,
  loadPersist,
  markLevelComplete,
  savePersist,
  unlockLevel,
} from '../src/game/persist';

const storage = new Map<string, string>();

function stubStorage(): void {
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
}

describe('level completion persistence', () => {
  beforeEach(() => {
    storage.clear();
    stubStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('persists Level 40 complete without opening a Level 41 slot', () => {
    savePersist({ unlocked: 40 });

    expect(isLevelComplete(40)).toBe(false);
    markLevelComplete(40);

    expect(isLevelComplete(40)).toBe(true);
    expect(loadPersist().unlocked).toBe(40);
    expect(unlockLevel(41).unlocked).toBe(40);
    expect(storage.get('hexpour:completed-levels')).toBe('[40]');
  });

  it('keeps completion IDs unique, ordered, and inside the 1–40 range', () => {
    markLevelComplete(40);
    markLevelComplete(40);
    markLevelComplete(0);
    markLevelComplete(41);

    expect(isLevelComplete(40)).toBe(true);
    expect(isLevelComplete(0)).toBe(false);
    expect(isLevelComplete(41)).toBe(false);
    expect(storage.get('hexpour:completed-levels')).toBe('[40]');
  });

  it('ignores malformed completion data and recovers when a valid win is recorded', () => {
    storage.set('hexpour:completed-levels', '{bad');
    expect(isLevelComplete(40)).toBe(false);

    markLevelComplete(40);

    expect(isLevelComplete(40)).toBe(true);
    expect(storage.get('hexpour:completed-levels')).toBe('[40]');
  });
});
