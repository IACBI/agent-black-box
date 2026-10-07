import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  AgentBlackBoxConfig,
  ChangedFile,
  CommandEvent,
  FileEvent,
  RiskFinding,
  SecretFinding,
  SessionMetadata,
  SessionReport,
} from "../types.js";
import { summarizeRisks } from "../risks/riskDetector.js";
import { pathExists, readJsonFileLimited } from "../utils/files.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { buildChangeEvidence, selectSessionRelevantChanges } from "./changeEvidence.js";
import { digestNdjsonRecords, isCapturedCommandEvent, isCapturedFileEvent, readNdjsonRecords } from "./ndjson.js";
import {
  assertMaterializationBudget,
  digestRecords,
  digestRegularFile,
  INLINE_REPORT_BYTES,
  isReportReplay,
  MAX_REPORT_BYTES,
  MaterializationBudgetError,
  REPORT_REPLAY_FILE,
  type ReportReplay,
  validateMaterializationLimit,
} from "./reportStorage.js";

export const SESSION_METADATA_FILE = "session-metadata.json";
const SESSION_REPORT_FILE = "session.json";
const SESSION_START_FILE = "session-start.json";
const SESSION_DIRECTORY_PATTERN = /^session-[A-Za-z0-9._-]+$/;
const CATALOG_BATCH_SIZE = 32;
const CATALOG_REPORT_CONCURRENCY = 1;
const MAX_SESSION_METADATA_BYTES = 1024 * 1024;

export type SessionCatalogState = "complete" | "incomplete" | "corrupt";

export interface SessionCatalogEntry {
  id: string;
  sessionDir: string;
  state: SessionCatalogState;
  startedAt?: string;
  endedAt?: string;
  finalizedBy?: string;
  finalWorktreeChangeCount?: number;
  sessionRelevantChangeCount?: number;
  commandCount?: number;
  riskScore?: number;
  maxRiskSeverity?: SessionMetadata["maxRiskSeverity"];
  possibleSecretCount?: number;
  startHead?: string;
  endHead?: string;
  branch?: string;
  warning?: string;
  /** A working-data policy deferred report parsing, so catalog timestamps and counts are unavailable. */
  metadataUnavailable?: boolean;
}

export interface SessionCatalogOptions {
  maxMaterializedBytes?: number;
}

interface PendingCatalogReport {
  id: string;
  sessionDir: string;
  needsReport: true;
  metadataPolicyWarning?: string;
}

export function buildSessionMetadata(report: SessionReport): SessionMetadata {
  return {
    metadataVersion: 1,
    id: report.id,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    finalizedBy: report.finalizedBy,
    finalWorktreeChangeCount: report.git.changedFiles.length,
    sessionRelevantChangeCount: selectSessionRelevantChanges(report.git, report.changeEvidence).length,
    commandCount: report.commands.length,
    riskScore: report.riskSummary.score,
    maxRiskSeverity: report.riskSummary.maxSeverity,
    possibleSecretCount: report.possibleSecrets.length,
    ...(report.baseline?.git.head ? { startHead: report.baseline.git.head } : {}),
    ...(report.git.head ? { endHead: report.git.head } : {}),
    ...(report.git.branch ? { branch: report.git.branch } : {}),
  };
}

export async function listSessionCatalog(
  repoRoot: string,
  config: AgentBlackBoxConfig,
  options: SessionCatalogOptions = {}
): Promise<SessionCatalogEntry[]> {
  validateMaterializationLimit(options.maxMaterializedBytes);
  const sessionRoot = path.isAbsolute(config.sessionDir) ? config.sessionDir : path.join(repoRoot, config.sessionDir);
  if (!(await pathExists(sessionRoot))) {
    return [];
  }

  const directories = (await readdir(sessionRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && SESSION_DIRECTORY_PATTERN.test(entry.name))
    .map((entry) => ({ id: entry.name, sessionDir: path.join(sessionRoot, entry.name) }));
  const entries: SessionCatalogEntry[] = [];
  const pendingReports: PendingCatalogReport[] = [];

  const batchSize =
    options.maxMaterializedBytes === undefined
      ? CATALOG_BATCH_SIZE
      : Math.min(
          CATALOG_BATCH_SIZE,
          Math.max(1, Math.floor(options.maxMaterializedBytes / MAX_SESSION_METADATA_BYTES))
        );
  for (let offset = 0; offset < directories.length; offset += batchSize) {
    const inspected = await Promise.all(
      directories
        .slice(offset, offset + batchSize)
        .map((directory) => inspectSessionDirectory(directory, options.maxMaterializedBytes))
    );
    for (const result of inspected) {
      if ("needsReport" in result) {
        pendingReports.push(result);
      } else {
        entries.push(result);
      }
    }
  }
  // Legacy reports can each require up to 256 MiB before parsing; do not read them in metadata-sized batches.
  entries.push(
    ...(await mapWithConcurrency(pendingReports, CATALOG_REPORT_CONCURRENCY, (directory) =>
      inspectSessionReport(directory, options.maxMaterializedBytes)
    ))
  );

  return entries.sort(compareCatalogEntries);
}

export function resolveSessionEntry(entries: SessionCatalogEntry[], selector: string | undefined): SessionCatalogEntry {
  if (entries.length === 0) {
    throw new Error("No Agent Black Box sessions were found.");
  }

  const normalizedSelector = selector?.trim() || "latest";
  if (normalizedSelector === "latest") {
    if (entries.some((entry) => entry.state === "complete" && entry.metadataUnavailable)) {
      throw new Error(
        "Latest session cannot be determined because catalog metadata is unavailable under the working-data policy. Increase --memory-budget-mb or select an explicit session ID."
      );
    }
    const latest = entries.find((entry) => entry.state === "complete");
    if (!latest) {
      throw new Error("No completed Agent Black Box sessions were found.");
    }
    return latest;
  }

  if (!SESSION_DIRECTORY_PATTERN.test(normalizedSelector)) {
    throw new Error("Session selector must be `latest`, a session ID, or a unique session ID prefix.");
  }

  const exact = entries.find((entry) => entry.id === normalizedSelector);
  const matches = exact ? [exact] : entries.filter((entry) => entry.id.startsWith(normalizedSelector));
  if (matches.length === 0) {
    throw new Error(`Session not found: ${normalizedSelector}`);
  }
  if (matches.length > 1) {
    throw new Error(`Session selector is ambiguous: ${normalizedSelector}`);
  }

  const selected = matches[0];
  if (selected.state === "incomplete") {
    throw new Error(`Session ${selected.id} is incomplete and has no finalized report.`);
  }
  if (selected.state === "corrupt") {
    throw new Error(`Session ${selected.id} is corrupt${selected.warning ? `: ${selected.warning}` : "."}`);
  }
  return selected;
}

export async function resolveSession(
  repoRoot: string,
  config: AgentBlackBoxConfig,
  selector?: string
): Promise<SessionCatalogEntry> {
  return resolveSessionEntry(await listSessionCatalog(repoRoot, config), selector);
}

export async function readCatalogSessionReport(entry: SessionCatalogEntry): Promise<SessionReport> {
  return readCatalogSessionReportWithinLimit(entry);
}

async function readCatalogSessionReportWithinLimit(
  entry: SessionCatalogEntry,
  maxMaterializedBytes?: number
): Promise<SessionReport> {
  if (entry.state !== "complete") {
    throw new Error(`Session ${entry.id} is not complete.`);
  }

  const result = await readStoredReportUnknown(entry.sessionDir, entry.id, { maxMaterializedBytes });
  const report = parseSessionReport(result.value);
  if (!report || report.id !== entry.id) {
    throw new Error(
      `Session ${entry.id} contains an invalid session.json report${result.error ? `: ${result.error}` : "."}`
    );
  }
  return report;
}

/** Large replay checks default to report digests and log sizes; opt in to canonical record verification. */
export async function verifyCatalogSessionReportFile(
  entry: SessionCatalogEntry,
  options: { verifyEventLogs?: boolean; maxMaterializedBytes?: number } = {}
): Promise<void> {
  validateMaterializationLimit(options.maxMaterializedBytes);
  if (entry.state !== "complete") {
    throw new Error(`Session ${entry.id} is not complete.`);
  }
  const reportPath = path.join(entry.sessionDir, SESSION_REPORT_FILE);
  const reportFile = await lstat(reportPath);
  if (!reportFile.isFile() || reportFile.size > MAX_REPORT_BYTES) {
    throw new Error(`Session ${entry.id} contains an unsupported session.json report.`);
  }
  if (reportFile.size <= INLINE_REPORT_BYTES || !(await pathExists(path.join(entry.sessionDir, REPORT_REPLAY_FILE)))) {
    assertMaterializationBudget(reportPath, reportFile.size, options.maxMaterializedBytes);
    await readCatalogSessionReportWithinLimit(entry, options.maxMaterializedBytes);
    return;
  }
  const { replay, core } = await readLargeReplayCore(
    entry.sessionDir,
    entry.id,
    reportFile.size,
    options.maxMaterializedBytes
  );
  if (options.verifyEventLogs) {
    await verifyReplayEventLogs(entry.sessionDir, replay, core);
  }
}

async function inspectSessionDirectory(
  directory: { id: string; sessionDir: string },
  maxMaterializedBytes?: number
): Promise<SessionCatalogEntry | PendingCatalogReport> {
  const metadataPath = path.join(directory.sessionDir, SESSION_METADATA_FILE);
  const reportPath = path.join(directory.sessionDir, SESSION_REPORT_FILE);
  const startPath = path.join(directory.sessionDir, SESSION_START_FILE);
  let metadataPolicyWarning: string | undefined;

  if (await pathExists(metadataPath)) {
    let metadataResult;
    try {
      metadataResult = await readJsonUnknown(metadataPath, undefined, maxMaterializedBytes);
    } catch (error) {
      if (!(error instanceof MaterializationBudgetError)) {
        throw error;
      }
      metadataPolicyWarning = error.message;
      metadataResult = { error: error.message };
    }
    if (metadataResult.value && isSessionMetadata(metadataResult.value) && metadataResult.value.id === directory.id) {
      if (await pathExists(reportPath)) {
        let reportFile;
        try {
          reportFile = await lstat(reportPath);
        } catch (error) {
          return corruptEntry(directory, (error as Error).message);
        }
        if (!reportFile.isFile() || reportFile.size > MAX_REPORT_BYTES) {
          return corruptEntry(directory, "session.json is not a supported regular report file");
        }
        const legacyLargeReport =
          reportFile.size > INLINE_REPORT_BYTES &&
          !(await pathExists(path.join(directory.sessionDir, REPORT_REPLAY_FILE)));
        return {
          ...metadataToCatalogEntry(directory.sessionDir, metadataResult.value),
          ...(legacyLargeReport
            ? { warning: "Large report has no replay metadata; opening it requires more memory." }
            : {}),
        };
      }
      return corruptEntry(directory, "session-metadata.json exists but session.json is missing");
    }
  }

  if (await pathExists(reportPath)) {
    return { ...directory, needsReport: true, ...(metadataPolicyWarning ? { metadataPolicyWarning } : {}) };
  }

  if (await pathExists(startPath)) {
    let startResult;
    try {
      startResult = await readJsonUnknown(startPath, undefined, maxMaterializedBytes);
    } catch (error) {
      if (!(error instanceof MaterializationBudgetError)) {
        throw error;
      }
      return { ...directory, state: "incomplete", metadataUnavailable: true, warning: error.message };
    }
    if (startResult.value && isSessionStart(startResult.value) && startResult.value.id === directory.id) {
      return {
        id: directory.id,
        sessionDir: directory.sessionDir,
        state: "incomplete",
        startedAt: startResult.value.startedAt,
      };
    }
    return corruptEntry(directory, startResult.error ?? "session-start.json has an unexpected shape");
  }

  return corruptEntry(directory, "No session metadata, report, or start record was found");
}

async function inspectSessionReport(
  directory: PendingCatalogReport,
  maxMaterializedBytes?: number
): Promise<SessionCatalogEntry> {
  let reportResult;
  try {
    reportResult = await readStoredReportUnknown(directory.sessionDir, directory.id, {
      maxMaterializedBytes,
      metadataOnly: maxMaterializedBytes !== undefined,
    });
  } catch (error) {
    if (!(error instanceof MaterializationBudgetError)) {
      throw error;
    }
    return {
      id: directory.id,
      sessionDir: directory.sessionDir,
      state: "complete",
      metadataUnavailable: true,
      warning: error.message,
    };
  }
  const report = parseSessionReport(reportResult.value);
  if (report && report.id === directory.id) {
    return {
      ...metadataToCatalogEntry(directory.sessionDir, buildSessionMetadata(report)),
      ...(reportResult.commandCount === undefined ? {} : { commandCount: reportResult.commandCount }),
      ...(directory.metadataPolicyWarning
        ? { warning: `Catalog metadata was derived from session.json because ${directory.metadataPolicyWarning}` }
        : (await pathExists(path.join(directory.sessionDir, SESSION_METADATA_FILE)))
          ? { warning: "Invalid metadata; derived from session.json." }
          : {}),
    };
  }
  return corruptEntry(directory, reportResult.error ?? "session.json has an unexpected shape");
}

function metadataToCatalogEntry(sessionDir: string, metadata: SessionMetadata): SessionCatalogEntry {
  return {
    id: metadata.id,
    sessionDir,
    state: "complete",
    startedAt: metadata.startedAt,
    endedAt: metadata.endedAt,
    finalizedBy: metadata.finalizedBy,
    finalWorktreeChangeCount: metadata.finalWorktreeChangeCount,
    sessionRelevantChangeCount: metadata.sessionRelevantChangeCount,
    commandCount: metadata.commandCount,
    riskScore: metadata.riskScore,
    maxRiskSeverity: metadata.maxRiskSeverity,
    possibleSecretCount: metadata.possibleSecretCount,
    ...(metadata.startHead ? { startHead: metadata.startHead } : {}),
    ...(metadata.endHead ? { endHead: metadata.endHead } : {}),
    ...(metadata.branch ? { branch: metadata.branch } : {}),
  };
}

function corruptEntry(directory: { id: string; sessionDir: string }, warning: string): SessionCatalogEntry {
  return {
    id: directory.id,
    sessionDir: directory.sessionDir,
    state: "corrupt",
    warning: sanitizeSingleLine(warning),
  };
}

function compareCatalogEntries(left: SessionCatalogEntry, right: SessionCatalogEntry): number {
  const leftTime = left.startedAt ? Date.parse(left.startedAt) : 0;
  const rightTime = right.startedAt ? Date.parse(right.startedAt) : 0;
  return rightTime - leftTime || right.id.localeCompare(left.id);
}

async function readJsonUnknown(
  filePath: string,
  limitBytes?: number,
  maxMaterializedBytes?: number
): Promise<{ value?: unknown; error?: string }> {
  try {
    const maxBytes =
      limitBytes ??
      (path.basename(filePath) === SESSION_REPORT_FILE ? INLINE_REPORT_BYTES : MAX_SESSION_METADATA_BYTES);
    if (maxMaterializedBytes !== undefined) {
      const file = await lstat(filePath);
      if (file.isFile() && file.size <= maxBytes) {
        assertMaterializationBudget(filePath, file.size, maxMaterializedBytes);
      }
    }
    return {
      value: await readJsonFileLimited<unknown>(filePath, Math.min(maxBytes, maxMaterializedBytes ?? maxBytes)),
    };
  } catch (error) {
    if (error instanceof MaterializationBudgetError) {
      throw error;
    }
    return { error: sanitizeSingleLine((error as Error).message) };
  }
}

async function readStoredReportUnknown(
  sessionDir: string,
  id: string,
  options: { maxMaterializedBytes?: number; metadataOnly?: boolean } = {}
): Promise<{ value?: unknown; error?: string; commandCount?: number }> {
  const reportPath = path.join(sessionDir, SESSION_REPORT_FILE);
  try {
    const reportFile = await lstat(reportPath);
    if (!reportFile.isFile()) {
      throw new Error("session.json is not a regular file.");
    }
    if (reportFile.size <= INLINE_REPORT_BYTES) {
      assertMaterializationBudget(reportPath, reportFile.size, options.maxMaterializedBytes);
      return readJsonUnknown(
        reportPath,
        Math.min(INLINE_REPORT_BYTES, options.maxMaterializedBytes ?? INLINE_REPORT_BYTES)
      );
    }
    if (reportFile.size > MAX_REPORT_BYTES) {
      throw new Error(`session.json exceeds the ${MAX_REPORT_BYTES / 1024 / 1024} MiB size limit.`);
    }

    const replayPath = path.join(sessionDir, REPORT_REPLAY_FILE);
    if (!(await pathExists(replayPath))) {
      assertMaterializationBudget(reportPath, reportFile.size, options.maxMaterializedBytes);
      return readJsonUnknown(reportPath, Math.min(MAX_REPORT_BYTES, options.maxMaterializedBytes ?? MAX_REPORT_BYTES));
    }
    const { replay, core } = await readLargeReplayCore(sessionDir, id, reportFile.size, options.maxMaterializedBytes);
    if (options.metadataOnly) {
      await verifyReplayEventLogs(sessionDir, replay, core);
      return { value: core, commandCount: replay.commandCount };
    }
    const eventPath = path.join(sessionDir, "events.ndjson");
    const commandPath = path.join(sessionDir, "commands.ndjson");
    const [events, commands] = await Promise.all([
      readNdjsonRecords(eventPath, isCapturedFileEvent, "file event"),
      readNdjsonRecords(commandPath, isCapturedCommandEvent, "command event"),
    ]);
    if (
      events.records.length !== replay.eventCount ||
      commands.records.length !== replay.commandCount ||
      digestRecords(events.records) !== replay.eventsDigest ||
      digestRecords(commands.records) !== replay.commandsDigest ||
      events.discardedLines !== core.integrity.discardedFileEventLines ||
      commands.discardedLines !== core.integrity.discardedCommandEventLines
    ) {
      throw new Error("Large report event logs no longer match the finalized report.");
    }
    return { value: { ...replay.report, events: events.records, commands: commands.records } };
  } catch (error) {
    if (error instanceof MaterializationBudgetError) {
      throw error;
    }
    return { error: sanitizeSingleLine((error as Error).message) };
  }
}

async function verifyReplayEventLogs(sessionDir: string, replay: ReportReplay, core: SessionReport): Promise<void> {
  const [events, commands] = await Promise.all([
    digestNdjsonRecords(path.join(sessionDir, "events.ndjson"), isCapturedFileEvent, "file event"),
    digestNdjsonRecords(path.join(sessionDir, "commands.ndjson"), isCapturedCommandEvent, "command event"),
  ]);
  if (
    events.recordCount !== replay.eventCount ||
    commands.recordCount !== replay.commandCount ||
    events.digest !== replay.eventsDigest ||
    commands.digest !== replay.commandsDigest ||
    events.discardedLines !== core.integrity.discardedFileEventLines ||
    commands.discardedLines !== core.integrity.discardedCommandEventLines
  ) {
    throw new Error("Large report event logs no longer match the finalized report.");
  }
}

async function readLargeReplayCore(
  sessionDir: string,
  id: string,
  reportBytes: number,
  maxMaterializedBytes?: number
): Promise<{ replay: ReportReplay; core: SessionReport }> {
  const replayPath = path.join(sessionDir, REPORT_REPLAY_FILE);
  const replayFile = await lstat(replayPath);
  assertMaterializationBudget(replayPath, replayFile.size, maxMaterializedBytes);
  const value = await readJsonFileLimited<unknown>(
    replayPath,
    Math.min(INLINE_REPORT_BYTES, maxMaterializedBytes ?? INLINE_REPORT_BYTES)
  );
  if (!isReportReplay(value) || value.id !== id || value.reportBytes !== reportBytes) {
    throw new Error("Large report replay metadata is missing or invalid.");
  }
  const core = parseSessionReport(value.report);
  if (!core || core.id !== id || core.events.length > 0 || core.commands.length > 0) {
    throw new Error("Large report replay metadata has an invalid report body.");
  }

  const storedReport = await digestRegularFile(path.join(sessionDir, SESSION_REPORT_FILE));
  if (storedReport.bytes !== value.reportBytes || storedReport.digest !== value.reportDigest) {
    throw new Error("session.json changed after finalization.");
  }

  const [eventLog, commandLog] = await Promise.all([
    lstat(path.join(sessionDir, "events.ndjson")),
    lstat(path.join(sessionDir, "commands.ndjson")),
  ]);
  if (
    !eventLog.isFile() ||
    !commandLog.isFile() ||
    eventLog.size !== value.eventLogBytes ||
    commandLog.size !== value.commandLogBytes
  ) {
    throw new Error("Large report event logs changed after finalization.");
  }
  return { replay: value, core };
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.metadataVersion === 1 &&
    typeof value.id === "string" &&
    isIsoDate(value.startedAt) &&
    isIsoDate(value.endedAt) &&
    typeof value.finalizedBy === "string" &&
    isNonNegativeInteger(value.finalWorktreeChangeCount) &&
    isNonNegativeInteger(value.sessionRelevantChangeCount) &&
    isNonNegativeInteger(value.commandCount) &&
    typeof value.riskScore === "number" &&
    value.riskScore >= 0 &&
    value.riskScore <= 100 &&
    typeof value.maxRiskSeverity === "string" &&
    ["none", "low", "medium", "high"].includes(value.maxRiskSeverity) &&
    isNonNegativeInteger(value.possibleSecretCount) &&
    (typeof value.startHead === "string" || value.startHead === undefined) &&
    (typeof value.endHead === "string" || value.endHead === undefined) &&
    (typeof value.branch === "string" || value.branch === undefined)
  );
}

export function parseSessionReport(value: unknown): SessionReport | null {
  if (!isRecord(value) || !isRecord(value.git)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.repoRoot !== "string" ||
    typeof value.sessionDir !== "string" ||
    !isIsoDate(value.startedAt) ||
    !isIsoDate(value.endedAt) ||
    typeof value.finalizedBy !== "string" ||
    typeof value.git.repoRoot !== "string" ||
    !isOptionalString(value.git.head) ||
    !isOptionalString(value.git.indexFingerprint) ||
    !isOptionalString(value.git.branch) ||
    typeof value.git.statusText !== "string" ||
    typeof value.git.diffSummaryText !== "string" ||
    !Array.isArray(value.git.changedFiles) ||
    !value.git.changedFiles.every(isChangedFile)
  ) {
    return null;
  }

  const events =
    value.events === undefined
      ? []
      : Array.isArray(value.events) && value.events.every(isFileEvent)
        ? value.events
        : null;
  const commands =
    value.commands === undefined
      ? []
      : Array.isArray(value.commands) && value.commands.every(isCommandEvent)
        ? value.commands
        : null;
  const risks = Array.isArray(value.risks) ? normalizeRiskFindings(value.risks) : null;
  const possibleSecrets =
    Array.isArray(value.possibleSecrets) && value.possibleSecrets.every(isSecretFinding) ? value.possibleSecrets : [];
  if (!events || !commands || !risks) {
    return null;
  }

  const git = value.git as unknown as SessionReport["git"];
  const baseline = isSessionBaseline(value.baseline) ? value.baseline : null;
  const changeEvidence = isSessionChangeEvidence(value.changeEvidence)
    ? value.changeEvidence
    : buildChangeEvidence(null, events, git);
  const riskSummary = isRiskSummary(value.riskSummary) ? value.riskSummary : summarizeRisks(risks, possibleSecrets);
  const integrity = isSessionIntegrity(value.integrity)
    ? value.integrity
    : {
        warnings: [],
        discardedFileEventLines: 0,
        discardedCommandEventLines: 0,
        droppedFileEvents: 0,
        failedFileEventWrites: 0,
      };
  const commandCapture = isCommandCapture(value.commandCapture)
    ? value.commandCapture
    : {
        implemented: commands.length > 0,
        mode: "wrapper-only" as const,
        note: "Legacy session report normalized by a newer Agent Black Box version.",
      };

  return {
    id: value.id,
    repoRoot: value.repoRoot,
    sessionDir: value.sessionDir,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    finalizedBy: value.finalizedBy,
    commandCapture,
    events,
    commands,
    baseline,
    changeEvidence,
    git,
    risks,
    riskSummary,
    possibleSecrets,
    integrity,
  };
}

function isChangedFile(value: unknown): value is ChangedFile {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.status === "string" &&
    ["added", "modified", "deleted", "renamed", "unknown"].includes(value.status) &&
    isOptionalNonNegativeNumber(value.insertions) &&
    isOptionalNonNegativeNumber(value.deletions) &&
    (value.kind === undefined ||
      (typeof value.kind === "string" &&
        ["text", "binary", "large", "missing", "not-file", "unknown"].includes(value.kind))) &&
    isOptionalNonNegativeNumber(value.sizeBytes) &&
    (value.lineStatsSource === undefined ||
      (typeof value.lineStatsSource === "string" && ["git", "estimated", "skipped"].includes(value.lineStatsSource))) &&
    (typeof value.statsNote === "string" || value.statsNote === undefined)
  );
}

function isSessionBaseline(value: unknown): value is NonNullable<SessionReport["baseline"]> {
  return (
    isRecord(value) &&
    isIsoDate(value.capturedAt) &&
    isRecord(value.git) &&
    typeof value.git.repoRoot === "string" &&
    isOptionalString(value.git.head) &&
    isOptionalString(value.git.indexFingerprint) &&
    isOptionalString(value.git.branch) &&
    typeof value.git.statusText === "string" &&
    typeof value.git.diffSummaryText === "string" &&
    Array.isArray(value.git.changedFiles) &&
    value.git.changedFiles.every(isChangedFile)
  );
}

function isSessionChangeEvidence(value: unknown): value is SessionReport["changeEvidence"] {
  return (
    isRecord(value) &&
    typeof value.baselineAvailable === "boolean" &&
    (value.baselineCapturedAt === undefined || isIsoDate(value.baselineCapturedAt)) &&
    (typeof value.headChanged === "boolean" || value.headChanged === null) &&
    (typeof value.indexChanged === "boolean" || value.indexChanged === null) &&
    (typeof value.branchChanged === "boolean" || value.branchChanged === null) &&
    Array.isArray(value.committedChanges) &&
    value.committedChanges.every(isChangedFile) &&
    Array.isArray(value.files) &&
    value.files.every(
      (file) =>
        isRecord(file) &&
        typeof file.path === "string" &&
        (typeof file.atStart === "boolean" || file.atStart === null) &&
        typeof file.observedDuringSession === "boolean" &&
        typeof file.atEnd === "boolean" &&
        (typeof file.gitMetadataChanged === "boolean" || file.gitMetadataChanged === null)
    )
  );
}

function isRiskSummary(value: unknown): value is SessionReport["riskSummary"] {
  return (
    isRecord(value) &&
    typeof value.score === "number" &&
    value.score >= 0 &&
    value.score <= 100 &&
    typeof value.maxSeverity === "string" &&
    ["none", "low", "medium", "high"].includes(value.maxSeverity) &&
    isNonNegativeInteger(value.possibleSecretCount) &&
    isRecord(value.severityCounts) &&
    isNonNegativeInteger(value.severityCounts.low) &&
    isNonNegativeInteger(value.severityCounts.medium) &&
    isNonNegativeInteger(value.severityCounts.high)
  );
}

function isFileEvent(value: unknown): value is FileEvent {
  return (
    isRecord(value) &&
    typeof value.timestamp === "string" &&
    typeof value.path === "string" &&
    typeof value.eventType === "string" &&
    ["add", "change", "unlink"].includes(value.eventType)
  );
}

function isCommandEvent(value: unknown): value is CommandEvent {
  return (
    isRecord(value) &&
    typeof value.startedAt === "string" &&
    typeof value.endedAt === "string" &&
    typeof value.command === "string" &&
    typeof value.cwd === "string" &&
    (typeof value.label === "string" || value.label === undefined) &&
    (typeof value.group === "string" || value.group === undefined) &&
    (typeof value.phase === "string" || value.phase === undefined) &&
    (Number.isInteger(value.exitCode) || value.exitCode === null) &&
    isOptionalNonNegativeNumber(value.durationMs) &&
    value.durationMs !== undefined &&
    (typeof value.error === "string" || value.error === undefined)
  );
}

function normalizeRiskFindings(values: unknown[]): RiskFinding[] | null {
  const findings: RiskFinding[] = [];
  for (const value of values) {
    if (
      !isRecord(value) ||
      typeof value.path !== "string" ||
      typeof value.category !== "string" ||
      typeof value.severity !== "string" ||
      !["low", "medium", "high"].includes(value.severity) ||
      typeof value.reason !== "string"
    ) {
      return null;
    }
    const severity = value.severity as RiskFinding["severity"];
    findings.push({
      path: value.path,
      category: value.category,
      severity,
      score:
        typeof value.score === "number" && value.score >= 0 && value.score <= 100
          ? value.score
          : severity === "high"
            ? 90
            : severity === "medium"
              ? 60
              : 30,
      reason: value.reason,
    });
  }
  return findings;
}

function isSecretFinding(value: unknown): value is SecretFinding {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    Number.isInteger(value.line) &&
    typeof value.reason === "string" &&
    typeof value.redacted === "string"
  );
}

function isSessionIntegrity(value: unknown): value is SessionReport["integrity"] {
  return (
    isRecord(value) &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string") &&
    isNonNegativeInteger(value.discardedFileEventLines) &&
    isNonNegativeInteger(value.discardedCommandEventLines) &&
    (value.droppedFileEvents === undefined || isNonNegativeInteger(value.droppedFileEvents)) &&
    (value.failedFileEventWrites === undefined || isNonNegativeInteger(value.failedFileEventWrites))
  );
}

function isCommandCapture(value: unknown): value is SessionReport["commandCapture"] {
  return (
    isRecord(value) &&
    typeof value.implemented === "boolean" &&
    value.mode === "wrapper-only" &&
    typeof value.note === "string"
  );
}

function isSessionStart(value: unknown): value is { id: string; startedAt: string } {
  return isRecord(value) && typeof value.id === "string" && isIsoDate(value.startedAt);
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isOptionalNonNegativeNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function sanitizeSingleLine(value: string): string {
  return value.replace(/[\r\n\0]/g, " ").slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
