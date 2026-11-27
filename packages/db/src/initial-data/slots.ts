// Karaoke Slot candidates for the initial data seeding (UCR-180-007): SPEC-090 section 8.2, the standard
// algorithm of the Administrator's batch generation, applied by the seeding command under the
// KRK-GEN-001 exception. Pure functions, no database.
//
// For each window: usage_start(n) = window_start + 20 min * n, usage_end = usage_start + 15 min,
// cycle_end = usage_start + 20 min, for every n with cycle_end(n) <= window_end. The anchor is
// window_start itself (KRK-GEN-003: never rounded) and an incomplete last cycle is not made
// (KRK-GEN-002). Candidates of all windows are numbered 0.. in usage_start order (SPEC-100 section 13.5:
// generation_candidate_no), the same numbers for every Scope.

/** SPEC-100 DB-SEED-003 (4): the Slots one run may create, over every Scope. */
export const MAX_SLOTS_PER_RUN = 1000;
const MINUTE_MS = 60_000;
/** SPEC-090 section 7.2: 15 minutes of use. */
const USAGE_MS = 15 * MINUTE_MS;
/** SPEC-090 section 7.2: the 20 minute cycle (15 minutes of use + 5 of maintenance). */
const CYCLE_MS = 20 * MINUTE_MS;

export type SlotWindow = { readonly window_start: string; readonly window_end: string };
export type SlotCandidate = {
  readonly candidateNo: number;
  /** ISO 8601 UTC instants, bound as timestamptz. */
  readonly usageStart: string;
  readonly usageEnd: string;
  readonly cycleEnd: string;
};

/** The usage_start instants (ms) of one window's candidates, in order. */
export function windowCandidateStarts(startMs: number, endMs: number): number[] {
  const starts: number[] = [];
  for (let at = startMs; at + CYCLE_MS <= endMs; at += CYCLE_MS) starts.push(at);
  return starts;
}

/**
 * DB-SEED-003 (2) to (4) on windows given as epoch milliseconds: every window makes at least one
 * candidate, no two candidates of different windows overlap on [usage_start, cycle_end) (touching is
 * allowed: DB-KRK-002), and one Scope gets at most `maxPerScope` candidates. Returns the candidate
 * count of one Scope, or undefined when a rule fails.
 *
 * Nothing is expanded: a window's candidate count is computed from its length, and the bound is checked
 * as each window is read, so a window of centuries or a very long list of windows is refused at once
 * instead of building its candidates (an expansion would block the event loop, and with it the
 * transaction deadline timer, and could exhaust memory).
 */
export function countWindowCandidates(
  windows: readonly { readonly startMs: number; readonly endMs: number }[],
  maxPerScope: number,
): number | undefined {
  const occupied: [number, number][] = [];
  let total = 0;
  for (const window of windows) {
    if (!(window.startMs < window.endMs)) return undefined;
    const count = Math.floor((window.endMs - window.startMs) / CYCLE_MS);
    if (count < 1) return undefined;
    total += count;
    if (total > maxPerScope) return undefined;
    // A window's candidates are contiguous: they occupy [start, start + count * 20 min) without a gap.
    occupied.push([window.startMs, window.startMs + count * CYCLE_MS]);
  }
  occupied.sort((a, b) => a[0] - b[0]);
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const [from, to] of occupied) {
    if (from < previousEnd) return undefined;
    previousEnd = to;
  }
  return total;
}

/** The candidates of validated windows (input.ts), numbered 0.. in usage_start order. */
export function slotCandidates(windows: readonly SlotWindow[]): readonly SlotCandidate[] {
  const starts = windows
    .flatMap((window) =>
      windowCandidateStarts(Date.parse(window.window_start), Date.parse(window.window_end)),
    )
    .sort((a, b) => a - b);
  return starts.map((at, candidateNo) => ({
    candidateNo,
    usageStart: new Date(at).toISOString(),
    usageEnd: new Date(at + USAGE_MS).toISOString(),
    cycleEnd: new Date(at + CYCLE_MS).toISOString(),
  }));
}
