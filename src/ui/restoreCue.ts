export function createReloadRestoreCueGate(
  navigationType: PerformanceNavigationTiming['type'] | null | undefined,
): (restored: boolean) => boolean {
  let pending = navigationType === 'reload';

  return (restored) => {
    if (!pending || !restored) return false;
    pending = false;
    return true;
  };
}
