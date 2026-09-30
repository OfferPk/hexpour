export function getLevelChangeConfirmation(
  currentLevelId: number,
  nextLevelId: number,
  pourCount: number,
): string | null {
  if (
    !Number.isInteger(currentLevelId) ||
    !Number.isInteger(nextLevelId) ||
    currentLevelId === nextLevelId ||
    !Number.isInteger(pourCount) ||
    pourCount <= 0
  ) {
    return null;
  }

  const pourWord = pourCount === 1 ? 'pour' : 'pours';
  return `You have made ${pourCount} ${pourWord} in Level ${currentLevelId}. Switching to Level ${nextLevelId} will discard this board.`;
}
