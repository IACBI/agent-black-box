import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { analyzeChangedFiles } from "../src/analyze/analyzer.js";
import {
  compileSecretRules,
  matchCustomSecretPatterns,
  matchCustomSecretPatternsInLines,
} from "../src/risks/secretRules.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSessionReport, generateTimelineMarkdown } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import { listSessionCatalog, readCatalogSessionReport } from "../src/session/sessionCatalog.js";
import { digestNdjsonRecords, isCapturedFileEvent } from "../src/session/ndjson.js";
import { getEventsPath, readFileEventsWithDiagnostics } from "../src/session/sessionManager.js";
import { getSessionVerificationLimits, verifySessions } from "../src/session/sessionVerification.js";
import { digestRecords, INLINE_REPORT_BYTES, readCanonicalReportCore } from "../src/session/reportStorage.js";

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

  const digestStarted = performance.now();
  const digest = await digestNdjsonRecords(getEventsPath(temporaryDirectory), isCapturedFileEvent, "file event");
  const digestDuration = performance.now() - digestStarted;
  const expectedDigest = createHash("sha256").update(JSON.stringify(result.records)).digest("hex");
  if (digest.recordCount !== EVENT_COUNT || digest.discardedLines !== 0 || digest.digest !== expectedDigest) {
    throw new Error("Streaming verification did not preserve the canonical record digest.");
  }
  if (digestDuration > MAX_DURATION_MS) {
    throw new Error(`Streaming verification budget exceeded: ${Math.round(digestDuration)}ms > ${MAX_DURATION_MS}ms.`);
  }
  console.log(
    JSON.stringify({
      scenario: "digest-ndjson-events",
      records: EVENT_COUNT,
      durationMs: Math.round(digestDuration),
      maxDurationMs: MAX_DURATION_MS,
    })
  );

  const canonicalPath = path.join(temporaryDirectory, "canonical-large.json");
  const canonicalEvent = {
    timestamp: "2026-01-01T00:00:00.000Z",
    eventType: "change",
    path: `src/${"x".repeat(30_000)}.ts`,
  };
  const canonicalEvents = Array.from({ length: 1200 }, () => canonicalEvent);
  const expectedCanonicalEventsDigest = digestRecords(canonicalEvents);
  let canonicalBytes: number;
  let expectedCanonicalDigest: string;
  {
    const text = JSON.stringify({ note: "canonical evidence", events: canonicalEvents, commands: [] }, null, 2);
    canonicalBytes = Buffer.byteLength(text);
    expectedCanonicalDigest = createHash("sha256").update(text).digest("hex");
    await writeFile(canonicalPath, text);
  }
  if (canonicalBytes <= INLINE_REPORT_BYTES) {
    throw new Error("Canonical streaming benchmark must exceed the inline report size limit.");
  }
  const canonicalInputBudget = 4 * 1024 * 1024;
  const canonicalStarted = performance.now();
  const canonical = await readCanonicalReportCore(canonicalPath, canonicalInputBudget);
  const canonicalDuration = performance.now() - canonicalStarted;
  if (
    canonical.bytes !== canonicalBytes ||
    canonical.digest !== expectedCanonicalDigest ||
    canonical.eventCount !== canonicalEvents.length ||
    canonical.eventsDigest !== expectedCanonicalEventsDigest ||
    JSON.stringify(canonical.core) !== JSON.stringify({ note: "canonical evidence", events: [], commands: [] })
  ) {
    throw new Error("Streaming canonical verification lost report evidence or exceeded its encoded-input quota.");
  }
  if (canonicalDuration > 30_000) {
    throw new Error(`Canonical streaming budget exceeded: ${Math.round(canonicalDuration)}ms > 30000ms.`);
  }
  console.log(
    JSON.stringify({
      scenario: "canonical-report-verification",
      reportMb: Math.round((canonicalBytes / 1024 / 1024) * 10) / 10,
      records: canonical.eventCount,
      maxMaterializedInputBytes: canonicalInputBudget,
      durationMs: Math.round(canonicalDuration),
      maxDurationMs: 30_000,
    })
  );

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

  const verificationOptions = { memoryBudgetMb: 8, concurrency: 16 };
  const limits = getSessionVerificationLimits(verificationOptions);
  const verificationStarted = performance.now();
  const budgetedCatalog = await listSessionCatalog(temporaryDirectory, catalogConfig, limits);
  const verified = await verifySessions(budgetedCatalog, verificationOptions);
  const verificationDuration = performance.now() - verificationStarted;
  if (
    verified.verified !== 1 ||
    verified.failed !== 0 ||
    budgetedCatalog[0]?.startedAt !== sessionStartedAt ||
    budgetedCatalog[0]?.commandCount !== 0 ||
    budgetedCatalog[0]?.state !== "complete"
  ) {
    throw new Error("Budgeted streaming verification or catalog metadata did not preserve the complete session.");
  }
  if (verificationDuration > 30_000) {
    throw new Error(`Budgeted verification exceeded its time budget: ${Math.round(verificationDuration)}ms > 30000ms.`);
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
  const customLines = Array.from({ length: 25_000 }, (_, index) =>
    index % 1000 === 0 ? "id corp_abcdef012345" : "ordinary"
  );
  const customRules = compileSecretRules({ secretPatterns: [{ name: "Internal", pattern: "corp_[a-z0-9]{12}" }] });
  // Warm the shared evaluator so both measurements exclude worker startup.
  matchCustomSecretPatterns(customRules, "ordinary");
  const singleLineStarted = performance.now();
  const singleLineMatches = customLines.map((line) => matchCustomSecretPatterns(customRules, line));
  const singleLineDuration = performance.now() - singleLineStarted;
  const batchStarted = performance.now();
  const batchMatches = matchCustomSecretPatternsInLines(customRules, customLines);
  const batchDuration = performance.now() - batchStarted;
  if (JSON.stringify(batchMatches) !== JSON.stringify(singleLineMatches)) {
    throw new Error("Batched custom patterns changed per-line matches or their order.");
  }
  const customAnalysisStarted = performance.now();
  const customAnalysis = analyzeChangedFiles(
    [{ path: "src/generated.txt", status: "modified", content: customLines.join("\n") }],
    { secretRules: customRules }
  );
  const customAnalysisDuration = performance.now() - customAnalysisStarted;
  if (
    customAnalysis.findings.length !== 25 ||
    customAnalysis.findings.some((finding) => finding.kind !== "possible-secret")
  ) {
    throw new Error("Custom-pattern repository analysis lost findings or reported unexpected limits.");
  }
  if (batchDuration > MAX_DURATION_MS || customAnalysisDuration > MAX_DURATION_MS) {
    throw new Error("Custom-pattern batching performance budget exceeded.");
  }
  console.log(
    JSON.stringify({
      scenario: "custom-pattern-many-lines",
      lines: customLines.length,
      findings: customAnalysis.findings.length,
      singleLineMatchingDurationMs: Math.round(singleLineDuration),
      batchedMatchingDurationMs: Math.round(batchDuration),
      analysisDurationMs: Math.round(customAnalysisDuration),
      maxDurationMs: MAX_DURATION_MS,
    })
  );

  // Every tenth path carries Markdown and terminal-control characters so escaping stays on the measured path.
  const timelineEvents = result.records.map((event, index) =>
    index % 10 === 0 ? { ...event, path: `docs/odd|name_[${index}]\`*\u001b[31m.md` } : event
  );
  const timelineReport = buildSessionReport(
    { id: "session-timeline", repoRoot: temporaryDirectory, sessionDir, startedAt: sessionStartedAt },
    "2026-01-01T00:01:00.000Z",
    "benchmark",
    timelineEvents,
    [],
    { repoRoot: temporaryDirectory, statusText: "", diffSummaryText: "", changedFiles: [] },
    [],
    []
  );
  const timelineStarted = performance.now();
  const timelineMarkdown = generateTimelineMarkdown(timelineReport);
  const timelineDuration = performance.now() - timelineStarted;
  if (timelineMarkdown.split("\n- ").length - 1 < timelineEvents.length * 2) {
    throw new Error("Timeline Markdown omitted file events.");
  }
  if (timelineMarkdown.includes("\u001b")) {
    throw new Error("Timeline Markdown leaked a terminal control character.");
  }
  if (timelineDuration > 30_000) {
    throw new Error(`Timeline Markdown budget exceeded: ${Math.round(timelineDuration)}ms > 30000ms.`);
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
          {
            scenario: "timeline-markdown",
            events: timelineEvents.length,
            outputMb: Math.round((timelineMarkdown.length / 1024 / 1024) * 10) / 10,
            durationMs: Math.round(timelineDuration),
          },
          {
            scenario: "budgeted-session-verification",
            events: reportEvents.length,
            memoryBudgetMb: verificationOptions.memoryBudgetMb,
            workers: limits.concurrency,
            durationMs: Math.round(verificationDuration),
          },
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
