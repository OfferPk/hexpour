const KEY = 'hexpour_v1';

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

function readRaw(): PersistData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<PersistData>;
    return {
      unlocked: typeof parsed.unlocked === 'number' ? parsed.unlocked : 1,
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
  const next = { ...readRaw(), ...patch };
  writeRaw(next);
  return next;
}

export function unlockLevel(levelId: number): PersistData {
  const cur = readRaw();
  if (levelId > cur.unlocked) {
    return savePersist({ unlocked: levelId });
  }
  return cur;
}

export function getSettings(): PersistData {
  return readRaw();
}

export function setSettings(patch: Partial<PersistData>): PersistData {
  return savePersist(patch);
}
