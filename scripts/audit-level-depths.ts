import { LEVELS } from '../src/levels/index';
import { auditMinimumPours, type ExactDepthResult } from '../tests/support/levelSolver';

const maxStates = Number(process.env.LEVEL_AUDIT_MAX_STATES ?? 2_000_000);
const maxMilliseconds = Number(process.env.LEVEL_AUDIT_MAX_MS ?? 60_000);
const results: ExactDepthResult[] = [];

console.log(
  `Exact level audit: at most ${maxStates.toLocaleString()} states and ${maxMilliseconds.toLocaleString()} ms per level`,
);
for (const level of LEVELS) {
  const result = auditMinimumPours(level, { maxStates, maxMilliseconds });
  results.push(result);
  if (result.status === 'solved') {
    console.log(
      `Level ${String(level.id).padStart(2, '0')}: ${result.minimumPours} pours ` +
        `(${result.visitedStates.toLocaleString()} states, ${result.expandedStates.toLocaleString()} expanded)`,
    );
  } else {
    console.log(
      `Level ${String(level.id).padStart(2, '0')}: ${result.status}` +
        (result.status === 'bounded' ? ` (${result.reason})` : '') +
        ` (${result.visitedStates.toLocaleString()} states, ${result.expandedStates.toLocaleString()} expanded)`,
    );
  }
}

const profile = results.map((result) =>
  result.status === 'solved' ? String(result.minimumPours) : '?',
);
console.log(`Depth profile 01–40: ${profile.join(', ')}`);

const incomplete = results.filter((result) => result.status !== 'solved');
if (incomplete.length > 0) {
  console.error(`Exact profile incomplete for ${incomplete.length} level(s). Increase the audit bound to continue.`);
  process.exitCode = 1;
}
