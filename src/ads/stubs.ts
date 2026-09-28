/**
 * Ad / IAP placeholder hooks — no real SDK in MVP.
 * Same factory stub API as ArrowPath / MahjongCalm.
 */
import { getSettings, setSettings } from '../game/persist';

const log: string[] = [];

export type InterstitialPresenter = (reason: string) => Promise<void>;
export type RewardedPresenter = (reason: string) => Promise<boolean>;

let interstitialPresenter: InterstitialPresenter | null = null;
let rewardedPresenter: RewardedPresenter | null = null;

export function setInterstitialPresenter(fn: InterstitialPresenter | null): void {
  interstitialPresenter = fn;
}

export function setRewardedPresenter(fn: RewardedPresenter | null): void {
  rewardedPresenter = fn;
}

export function getAdLog(): readonly string[] {
  return log;
}

export function clearAdLog(): void {
  log.length = 0;
}

export function isAdsRemoved(): boolean {
  return getSettings().adsRemoved === true;
}

export async function showInterstitial(reason: string = 'generic'): Promise<boolean> {
  if (isAdsRemoved()) {
    log.push(`interstitial:skipped:${reason}`);
    return false;
  }
  log.push(`interstitial:show:${reason}`);
  if (interstitialPresenter) {
    await interstitialPresenter(reason);
  } else {
    await Promise.resolve();
  }
  log.push(`interstitial:dismissed:${reason}`);
  return true;
}

export async function showRewarded(reason: string = 'hint'): Promise<boolean> {
  if (isAdsRemoved()) {
    log.push(`rewarded:auto-grant:${reason}`);
    return true;
  }
  log.push(`rewarded:show:${reason}`);
  let earned = true;
  if (rewardedPresenter) {
    earned = await rewardedPresenter(reason);
  } else {
    await Promise.resolve();
  }
  if (earned) log.push(`rewarded:earned:${reason}`);
  else log.push(`rewarded:cancel:${reason}`);
  return earned;
}

export async function purchaseRemoveAds(): Promise<boolean> {
  log.push('iap:remove-ads:stub');
  setSettings({ adsRemoved: true });
  await Promise.resolve();
  return true;
}
