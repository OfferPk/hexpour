const KEY = 'hexpour_v1';

/** First-run howto flag — separate from save blob (peer: mahjongcalm:howto). */
const HOWTO_KEY = 'hexpour:howto';

/** Session A2HS tip dismiss key (used by UI). */
export const A2HS_KEY = 'hexpour:a2hs';

/** Soft upper bound for unlock clamp (matches shipped LEVEL_COUNT). */
const UNLOCKED_MAX = 40;

export interface PersistData {
  /** Highest unlocked level id (1-based). */
  unlocked: number;
  adsRemoved: boolean;
  mute: boolean;
}

const DEFAULTS: PersistData = {
  unlocked: 1,
  adsRemoved: false,
  mute: false,
};

function clampUnlocked(n: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.floor(n), 1), UNLOCKED_MAX);
}

function readRaw(): PersistData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PersistData>;
    return {
      unlocked: clampUnlocked(
        typeof parsed.unlocked === 'number' ? parsed.unlocked : 1,
      ),
      adsRemoved: parsed.adsRemoved === true,
      mute: parsed.mute === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeRaw(data: PersistData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignore quota */
  }
}

export function loadPersist(): PersistData {
  return readRaw();
}

export function savePersist(patch: Partial<PersistData>): PersistData {
  const cur = readRaw();
  const next: PersistData = {
    unlocked:
      patch.unlocked !== undefined ? clampUnlocked(patch.unlocked) : cur.unlocked,
    adsRemoved:
      patch.adsRemoved !== undefined ? patch.adsRemoved === true : cur.adsRemoved,
    mute: patch.mute !== undefined ? patch.mute === true : cur.mute,
  };
  writeRaw(next);
  return next;
}

export function unlockLevel(levelId: number): PersistData {
  const cur = readRaw();
  const id = clampUnlocked(levelId);
  if (id > cur.unlocked) {
    return savePersist({ unlocked: id });
  }
  return cur;
}

const COMPLETED_LEVELS_KEY = 'hexpour:completed-levels';

export function isLevelComplete(levelId: number): boolean {
  if (!Number.isSafeInteger(levelId) || levelId < 1 || levelId > UNLOCKED_MAX) return false;
  try {
    const raw = localStorage.getItem(COMPLETED_LEVELS_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.includes(levelId);
  } catch {
    return false;
  }
}

export function markLevelComplete(levelId: number): void {
  if (!Number.isSafeInteger(levelId) || levelId < 1 || levelId > UNLOCKED_MAX) return;
  let parsed: unknown = [];
  try {
    const raw = localStorage.getItem(COMPLETED_LEVELS_KEY);
    parsed = raw ? JSON.parse(raw) : [];
  } catch {
    parsed = [];
  }
  const completed = Array.isArray(parsed)
    ? parsed.filter((id): id is number =>
        Number.isSafeInteger(id) && id >= 1 && id <= UNLOCKED_MAX,
      )
    : [];
  if (!completed.includes(levelId)) completed.push(levelId);
  completed.sort((a, b) => a - b);
  try {
    localStorage.setItem(COMPLETED_LEVELS_KEY, JSON.stringify(completed));
  } catch {
    /* Storage may be disabled or full. */
  }
}

export function getSettings(): PersistData {
  return readRaw();
}

export function setSettings(patch: Partial<PersistData>): PersistData {
  return savePersist(patch);
}

export function isHowtoSeen(): boolean {
  try {
    return localStorage.getItem(HOWTO_KEY) === '1';
  } catch {
    return false;
  }
}

export function markHowtoSeen(): void {
  try {
    localStorage.setItem(HOWTO_KEY, '1');
  } catch {
    /* quota / private */
  }
}
