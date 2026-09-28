import { beforeEach, describe, expect, it, vi } from 'vitest';

const memStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem(k: string) {
    return memStore[k] ?? null;
  },
  setItem(k: string, v: string) {
    memStore[k] = v;
  },
  removeItem(k: string) {
    delete memStore[k];
  },
  clear() {
    for (const k of Object.keys(memStore)) delete memStore[k];
  },
});

import {
  clearAdLog,
  getAdLog,
  isAdsRemoved,
  purchaseRemoveAds,
  showInterstitial,
  showRewarded,
} from '../src/ads/stubs';

describe('ads stubs', () => {
  beforeEach(() => {
    localStorage.clear();
    clearAdLog();
  });

  it('showInterstitial logs and returns true when ads on', async () => {
    const ok = await showInterstitial('win');
    expect(ok).toBe(true);
    expect(getAdLog()).toContain('interstitial:show:win');
    expect(getAdLog()).toContain('interstitial:dismissed:win');
  });

  it('showRewarded grants', async () => {
    const ok = await showRewarded('hint');
    expect(ok).toBe(true);
    expect(getAdLog()).toContain('rewarded:earned:hint');
  });

  it('purchaseRemoveAds skips future interstitials', async () => {
    await purchaseRemoveAds();
    expect(isAdsRemoved()).toBe(true);
    clearAdLog();
    const ok = await showInterstitial('win');
    expect(ok).toBe(false);
    expect(getAdLog()).toContain('interstitial:skipped:win');
  });
});
