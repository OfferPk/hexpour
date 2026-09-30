export function formatPourCount(count: number): string {
  return `${count} ${count === 1 ? 'pour' : 'pours'}`;
}
