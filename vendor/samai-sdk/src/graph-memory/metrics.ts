/**
 * A dependency-free metrics collector. Pass the same instance into
 * enableGraphMemory(), startSelfCorrectionLoop(), applyRecencyDecay(), and
 * createFeedEngine() (all accept an optional `metrics` option) to get one
 * aggregated snapshot across every part of the system — sweep success rate,
 * how often self-correction actually finds problems, decay/prune volume,
 * feed query latency.
 *
 * Deliberately not wired to any specific dashboard/APM — call getSnapshot()
 * or toJSON() on whatever interval your own metrics pipeline expects.
 */

export interface MetricsSnapshot {
  sweeps: { total: number; succeeded: number; failed: number; avgDurationMs: number };
  selfCorrection: { runs: number; curatorRuns: number; duplicatesFound: number; genericRelsFound: number };
  decay: { runs: number; factsScored: number; factsPruned: number };
  feed: { queries: number; avgDurationMs: number };
}

export interface MetricsCollector {
  recordSweep(success: boolean, durationMs: number): void;
  recordSelfCorrection(report: { curatorRan: boolean; duplicateNodeGroups: unknown[]; genericRelationshipCounts: unknown[] }): void;
  recordDecay(report: { scored: number; pruned: number }): void;
  recordFeedQuery(durationMs: number): void;
  getSnapshot(): MetricsSnapshot;
  toJSON(): string;
}

export function createMetricsCollector(): MetricsCollector {
  let sweepsTotal = 0, sweepsSucceeded = 0, sweepsFailed = 0, sweepDurationSum = 0;
  let correctionRuns = 0, curatorRuns = 0, duplicatesFound = 0, genericRelsFound = 0;
  let decayRuns = 0, factsScored = 0, factsPruned = 0;
  let feedQueries = 0, feedDurationSum = 0;

  const collector: MetricsCollector = {
    recordSweep(success, durationMs) {
      sweepsTotal += 1;
      if (success) sweepsSucceeded += 1; else sweepsFailed += 1;
      sweepDurationSum += durationMs;
    },
    recordSelfCorrection(report) {
      correctionRuns += 1;
      if (report.curatorRan) curatorRuns += 1;
      duplicatesFound += report.duplicateNodeGroups.length;
      genericRelsFound += report.genericRelationshipCounts.length;
    },
    recordDecay(report) {
      decayRuns += 1;
      factsScored += report.scored;
      factsPruned += report.pruned;
    },
    recordFeedQuery(durationMs) {
      feedQueries += 1;
      feedDurationSum += durationMs;
    },
    getSnapshot() {
      return {
        sweeps: {
          total: sweepsTotal,
          succeeded: sweepsSucceeded,
          failed: sweepsFailed,
          avgDurationMs: sweepsTotal ? sweepDurationSum / sweepsTotal : 0,
        },
        selfCorrection: { runs: correctionRuns, curatorRuns, duplicatesFound, genericRelsFound },
        decay: { runs: decayRuns, factsScored, factsPruned },
        feed: { queries: feedQueries, avgDurationMs: feedQueries ? feedDurationSum / feedQueries : 0 },
      };
    },
    toJSON() {
      return JSON.stringify(collector.getSnapshot(), null, 2);
    },
  };

  return collector;
}
