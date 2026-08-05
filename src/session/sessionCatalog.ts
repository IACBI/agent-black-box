import { readFile, readdir } from "node:fs/promises";
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
import { pathExists } from "../utils/files.js";
import { buildChangeEvidence, selectSessionRelevantChanges } from "./changeEvidence.js";

export const SESSION_METADATA_FILE = "session-metadata.json";
const SESSION_REPORT_FILE = "session.json";
const SESSION_START_FILE = "session-start.json";
const SESSION_DIRECTORY_PATTERN = /^session-[A-Za-z0-9._-]+$/;
const CATALOG_BATCH_SIZE = 32;

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
  config: AgentBlackBoxConfig
): Promise<SessionCatalogEntry[]> {
  const sessionRoot = path.isAbsolute(config.sessionDir) ? config.sessionDir : path.join(repoRoot, config.sessionDir);
  if (!(await pathExists(sessionRoot))) {
    return [];
  }

  const directories = (await readdir(sessionRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && SESSION_DIRECTORY_PATTERN.test(entry.name))
    .map((entry) => ({ id: entry.name, sessionDir: path.join(sessionRoot, entry.name) }));
  const entries: SessionCatalogEntry[] = [];

  for (let offset = 0; offset < directories.length; offset += CATALOG_BATCH_SIZE) {
    entries.push(
      ...(await Promise.all(directories.slice(offset, offset + CATALOG_BATCH_SIZE).map(inspectSessionDirectory)))
    );
  }

  return entries.sort(compareCatalogEntries);
}

export function resolveSessionEntry(entries: SessionCatalogEntry[], selector: string | undefined): SessionCatalogEntry {
  if (entries.length === 0) {
    throw new Error("No Agent Black Box sessions were found.");
  }

  const normalizedSelector = selector?.trim() || "latest";
  if (normalizedSelector === "latest") {
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
  if (entry.state !== "complete") {
    throw new Error(`Session ${entry.id} is not complete.`);
  }

  const result = await readJsonUnknown(path.join(entry.sessionDir, SESSION_REPORT_FILE));
  const report = parseSessionReport(result.value);
  if (!report || report.id !== entry.id) {
    throw new Error(`Session ${entry.id} contains an invalid session.json report.`);
  }
  return report;
}

async function inspectSessionDirectory(directory: { id: string; sessionDir: string }): Promise<SessionCatalogEntry> {
  const metadataPath = path.join(directory.sessionDir, SESSION_METADATA_FILE);
  const reportPath = path.join(directory.sessionDir, SESSION_REPORT_FILE);
  const startPath = path.join(directory.sessionDir, SESSION_START_FILE);

  if (await pathExists(metadataPath)) {
    const metadataResult = await readJsonUnknown(metadataPath);
    if (metadataResult.value && isSessionMetadata(metadataResult.value) && metadataResult.value.id === directory.id) {
      if (await pathExists(reportPath)) {
        return metadataToCatalogEntry(directory.sessionDir, metadataResult.value);
      }
      return corruptEntry(directory, "session-metadata.json exists but session.json is missing");
    }
  }

  if (await pathExists(reportPath)) {
    const reportResult = await readJsonUnknown(reportPath);
    const report = parseSessionReport(reportResult.value);
    if (report && report.id === directory.id) {
      return {
        ...metadataToCatalogEntry(directory.sessionDir, buildSessionMetadata(report)),
        ...((await pathExists(metadataPath)) ? { warning: "Invalid metadata; derived from session.json." } : {}),
      };
    }
    return corruptEntry(directory, reportResult.error ?? "session.json has an unexpected shape");
  }

  if (await pathExists(startPath)) {
    const startResult = await readJsonUnknown(startPath);
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

async function readJsonUnknown(filePath: string): Promise<{ value?: unknown; error?: string }> {
  try {
    return { value: JSON.parse(await readFile(filePath, "utf8")) as unknown };
  } catch (error) {
    return { error: sanitizeSingleLine((error as Error).message) };
  }
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
    ["none", "low", "medium", "high"].includes(String(value.maxRiskSeverity)) &&
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
    : { warnings: [], discardedFileEventLines: 0, discardedCommandEventLines: 0 };
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
    ["added", "modified", "deleted", "renamed", "unknown"].includes(String(value.status)) &&
    isOptionalNonNegativeNumber(value.insertions) &&
    isOptionalNonNegativeNumber(value.deletions) &&
    (value.kind === undefined ||
      ["text", "binary", "large", "missing", "not-file", "unknown"].includes(String(value.kind))) &&
    isOptionalNonNegativeNumber(value.sizeBytes) &&
    (value.lineStatsSource === undefined || ["git", "estimated", "skipped"].includes(String(value.lineStatsSource))) &&
    (typeof value.statsNote === "string" || value.statsNote === undefined)
  );
}

function isSessionBaseline(value: unknown): value is NonNullable<SessionReport["baseline"]> {
  return (
    isRecord(value) &&
    isIsoDate(value.capturedAt) &&
    isRecord(value.git) &&
    typeof value.git.repoRoot === "string" &&
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
    ["none", "low", "medium", "high"].includes(String(value.maxSeverity)) &&
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
    ["add", "change", "unlink"].includes(String(value.eventType))
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
      !["low", "medium", "high"].includes(String(value.severity)) ||
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
    isNonNegativeInteger(value.discardedCommandEventLines)
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

function sanitizeSingleLine(value: string): string {
  return value.replace(/[\r\n\0]/g, " ").slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
