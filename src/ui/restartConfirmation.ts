export function getRestartConfirmation(levelId: number, pourCount: number): string | null {
  if (!Number.isInteger(pourCount) || pourCount <= 0) return null;
  const pourWord = pourCount === 1 ? 'pour' : 'pours';
  return `You have made ${pourCount} ${pourWord}. Restarting will discard the current board and start Level ${levelId} over.`;
}
