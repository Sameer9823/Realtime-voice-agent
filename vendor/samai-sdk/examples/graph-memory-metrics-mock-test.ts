import { createMetricsCollector } from "../src/index.js";

function main() {
  const m = createMetricsCollector();

  m.recordSweep(true, 100);
  m.recordSweep(true, 200);
  m.recordSweep(false, 50);

  m.recordSelfCorrection({ curatorRan: true, duplicateNodeGroups: [1, 2], genericRelationshipCounts: [1] });
  m.recordSelfCorrection({ curatorRan: false, duplicateNodeGroups: [], genericRelationshipCounts: [] });

  m.recordDecay({ scored: 10, pruned: 2 });
  m.recordDecay({ scored: 5, pruned: 1 });

  m.recordFeedQuery(30);
  m.recordFeedQuery(70);

  const snap = m.getSnapshot();
  console.log(snap);

  if (snap.sweeps.total !== 3) throw new Error("sweep total wrong");
  if (snap.sweeps.succeeded !== 2) throw new Error("sweep succeeded wrong");
  if (snap.sweeps.failed !== 1) throw new Error("sweep failed wrong");
  if (Math.abs(snap.sweeps.avgDurationMs - (100 + 200 + 50) / 3) > 0.001) throw new Error("sweep avg duration wrong");

  if (snap.selfCorrection.runs !== 2) throw new Error("correction runs wrong");
  if (snap.selfCorrection.curatorRuns !== 1) throw new Error("curator runs wrong");
  if (snap.selfCorrection.duplicatesFound !== 2) throw new Error("duplicates found wrong");
  if (snap.selfCorrection.genericRelsFound !== 1) throw new Error("generic rels found wrong");

  if (snap.decay.runs !== 2) throw new Error("decay runs wrong");
  if (snap.decay.factsScored !== 15) throw new Error("facts scored wrong");
  if (snap.decay.factsPruned !== 3) throw new Error("facts pruned wrong");

  if (snap.feed.queries !== 2) throw new Error("feed queries wrong");
  if (Math.abs(snap.feed.avgDurationMs - 50) > 0.001) throw new Error("feed avg duration wrong");

  const json = JSON.parse(m.toJSON());
  if (json.sweeps.total !== 3) throw new Error("toJSON output doesn't match snapshot");

  console.log("\nPASS: metrics collector aggregates every recorded event correctly.");
}

main();
