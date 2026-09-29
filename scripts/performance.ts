import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { analyzeChangedFiles } from "../src/analyze/analyzer.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSessionReport } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import { listSessionCatalog, readCatalogSessionReport } from "../src/session/sessionCatalog.js";
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

  const reportEvents = result.records.slice(0, 5_000);
  const sessionDir = path.join(temporaryDirectory, "sessions", "session-performance");
  const sessionStartedAt = "2026-01-01T00:00:00.000Z";
  const report = buildSessionReport(
    { id: "session-performance", repoRoot: temporaryDirectory, sessionDir, startedAt: sessionStartedAt },
    "2026-01-01T00:01:00.000Z",
    "benchmark",
    reportEvents,
    [],
    { repoRoot: temporaryDirectory, statusText: "", diffSummaryText: "", changedFiles: [] },
    [],
    []
  );
  const catalogConfig = { ...DEFAULT_CONFIG, sessionDir: "sessions" };
  const writeStarted = performance.now();
  await writeReports(report);
  const writeDuration = performance.now() - writeStarted;
  if (writeDuration > 30_000) {
    throw new Error(`Report writing budget exceeded: ${Math.round(writeDuration)}ms > 30000ms.`);
  }
  const normalCatalog = await listSessionCatalog(temporaryDirectory, catalogConfig);
  if (normalCatalog.length !== 1 || normalCatalog[0]?.state !== "complete") {
    throw new Error("Metadata-backed catalog lookup failed.");
  }

  await rm(path.join(sessionDir, "session-metadata.json"));
  const fallbackStarted = performance.now();
  const fallbackCatalog = await listSessionCatalog(temporaryDirectory, catalogConfig);
  const reopened = fallbackCatalog[0] && (await readCatalogSessionReport(fallbackCatalog[0]));
  const fallbackDuration = performance.now() - fallbackStarted;
  if (fallbackCatalog.length !== 1 || reopened?.events.length !== reportEvents.length) {
    throw new Error("Legacy catalog fallback failed to recover all report events.");
  }
  if (fallbackDuration > 30_000) {
    throw new Error(`Catalog fallback budget exceeded: ${Math.round(fallbackDuration)}ms > 30000ms.`);
  }

  const analysisFiles = Array.from({ length: 5_000 }, (_, index) => ({
    path: `src/module-${index}/index.ts`,
    status: "modified" as const,
    content: "export const value = 1;\n",
  }));
  const analysisStarted = performance.now();
  const analysis = analyzeChangedFiles(analysisFiles);
  const analysisDuration = performance.now() - analysisStarted;
  if (analysis.findings.length !== 0) {
    throw new Error("Synthetic repository analysis produced unexpected findings.");
  }
  if (analysisDuration > 30_000) {
    throw new Error(`Large-repository analysis budget exceeded: ${Math.round(analysisDuration)}ms > 30000ms.`);
  }
  const adversarialCharacters = 256 * 1024;
  const adversarialStarted = performance.now();
  const adversarial = analyzeChangedFiles([
    { path: "src/padded.ts", status: "modified", content: " ".repeat(adversarialCharacters - 1) + "!" },
    { path: "src/identifier.ts", status: "modified", content: "a".repeat(adversarialCharacters - 1) + "!" },
  ]);
  const adversarialDuration = performance.now() - adversarialStarted;
  if (adversarial.findings.length !== 0) {
    throw new Error("Adversarial content analysis produced unexpected findings.");
  }
  if (adversarialDuration > MAX_DURATION_MS) {
    throw new Error(
      `Adversarial analysis budget exceeded: ${Math.round(adversarialDuration)}ms > ${MAX_DURATION_MS}ms.`
    );
  }
  console.log(
    JSON.stringify(
      {
        scenario: "analyze-adversarial-content",
        charactersPerFile: adversarialCharacters,
        files: 2,
        durationMs: Math.round(adversarialDuration),
        maxDurationMs: MAX_DURATION_MS,
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify(
      {
        scenarios: [
          { scenario: "write-report", events: reportEvents.length, durationMs: Math.round(writeDuration) },
          {
            scenario: "legacy-catalog-fallback",
            events: reopened.events.length,
            durationMs: Math.round(fallbackDuration),
          },
          { scenario: "analyze-changed-files", files: analysisFiles.length, durationMs: Math.round(analysisDuration) },
        ],
        maxDurationMsPerScenario: 30_000,
      },
      null,
      2
    )
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
