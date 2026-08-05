import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getEventsPath, readFileEventsWithDiagnostics } from "../src/session/sessionManager.js";

const EVENT_COUNT = 100_000;
const MAX_DURATION_MS = 5_000;
const MAX_HEAP_DELTA_BYTES = 256 * 1024 * 1024;

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "abb-performance-"));

try {
  const lines = Array.from({ length: EVENT_COUNT }, (_, index) =>
    JSON.stringify({
      timestamp: new Date(1_700_000_000_000 + index).toISOString(),
      eventType: index % 2 === 0 ? "change" : "add",
      path: `src/generated/file-${index}.ts`,
    })
  );
  await writeFile(getEventsPath(temporaryDirectory), `${lines.join("\n")}\n`, "utf8");

  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const result = await readFileEventsWithDiagnostics(temporaryDirectory);
  const durationMs = performance.now() - startedAt;
  const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

  if (result.records.length !== EVENT_COUNT || result.discardedLines !== 0) {
    throw new Error(`Expected ${EVENT_COUNT} valid records, received ${result.records.length}.`);
  }

  console.log(
    JSON.stringify(
      {
        scenario: "read-ndjson-events",
        records: EVENT_COUNT,
        durationMs: Math.round(durationMs),
        heapDeltaMb: Math.round((heapDeltaBytes / 1024 / 1024) * 10) / 10,
        budgets: {
          maxDurationMs: MAX_DURATION_MS,
          maxHeapDeltaMb: MAX_HEAP_DELTA_BYTES / 1024 / 1024,
        },
      },
      null,
      2
    )
  );

  if (durationMs > MAX_DURATION_MS) {
    throw new Error(`NDJSON performance budget exceeded: ${Math.round(durationMs)}ms > ${MAX_DURATION_MS}ms.`);
  }
  if (heapDeltaBytes > MAX_HEAP_DELTA_BYTES) {
    throw new Error("NDJSON memory budget exceeded.");
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
