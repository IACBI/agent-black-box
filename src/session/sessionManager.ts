import { randomUUID } from "node:crypto";
import { appendFile, open, realpath, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type {
  ActiveSession,
  AgentBlackBoxConfig,
  CommandEvent,
  FileEvent,
  GitSnapshot,
  SessionBaseline,
  SessionReport,
  StopRequest,
} from "../types.js";
import { collectGitChangesBetween, collectGitSnapshot } from "../git/git.js";
import { detectRisks } from "../risks/riskDetector.js";
import { detectPossibleSecrets } from "../risks/secretDetector.js";
import { buildSessionReport } from "../reports/markdown.js";
import { writeReports } from "../reports/reportWriter.js";
import { ensureDir, pathExists, readJsonFileLimited, removeFileIfExists, writeJsonFile } from "../utils/files.js";
import { buildChangeEvidence, selectSessionRelevantChanges } from "./changeEvidence.js";
import { listSessionCatalog, resolveSessionEntry } from "./sessionCatalog.js";

const ACTIVE_SESSION_FILE = "active-session.json";
const STOP_REQUEST_FILE = "stop-request.json";
const SESSION_LOCK_FILE = "session.lock";
const EVENTS_FILE = "events.ndjson";
const COMMANDS_FILE = "commands.ndjson";
const SESSION_START_FILE = "session-start.json";
const GIT_BASELINE_FILE = "git-start.json";
const MAX_NDJSON_LINE_BYTES = 1024 * 1024;
const MAX_NDJSON_RECORDS = 1_000_000;
const MAX_INTEGRITY_WARNINGS = 100;
const MAX_PATH_LENGTH = 32_768;
const MAX_COMMAND_LENGTH = 32_768;
const MAX_METADATA_LENGTH = 80;
const MAX_STATE_FILE_BYTES = 1024 * 1024;

export interface SessionLock {
  sessionId: string;
  pid: number;
  createdAt: string;
  sessionDir: string;
  ownerToken?: string;
}

export type SessionRecoveryStatus =
  "no-active-session" | "active" | "recoverable" | "already-complete" | "corrupt" | "inconsistent";

export interface SessionRecoveryState {
  status: SessionRecoveryStatus;
  message: string;
  active: ActiveSession | null;
}

interface StateReadResult<T> {
  value: T | null;
  corrupted: boolean;
  error?: string;
}

interface NdjsonReadResult<T> {
  records: T[];
  discardedLines: number;
  warnings: string[];
}

export function getSessionRoot(repoRoot: string, config: AgentBlackBoxConfig): string {
  return path.isAbsolute(config.sessionDir) ? config.sessionDir : path.join(repoRoot, config.sessionDir);
}

export function getStateDir(repoRoot: string, config: AgentBlackBoxConfig): string {
  return path.dirname(getSessionRoot(repoRoot, config));
}

export function getActiveSessionPath(repoRoot: string, config: AgentBlackBoxConfig): string {
  return path.join(getStateDir(repoRoot, config), ACTIVE_SESSION_FILE);
}

export function getStopRequestPath(repoRoot: string, config: AgentBlackBoxConfig): string {
  return path.join(getStateDir(repoRoot, config), STOP_REQUEST_FILE);
}

export function getSessionLockPath(repoRoot: string, config: AgentBlackBoxConfig): string {
  return path.join(getStateDir(repoRoot, config), SESSION_LOCK_FILE);
}

export function getEventsPath(sessionDir: string): string {
  return path.join(sessionDir, EVENTS_FILE);
}

export function getCommandsPath(sessionDir: string): string {
  return path.join(sessionDir, COMMANDS_FILE);
}

export function getGitBaselinePath(sessionDir: string): string {
  return path.join(sessionDir, GIT_BASELINE_FILE);
}

export async function createSession(repoRoot: string, config: AgentBlackBoxConfig): Promise<ActiveSession> {
  const startedAt = new Date().toISOString();
  const id = createSessionId(startedAt);
  const sessionDir = path.join(getSessionRoot(repoRoot, config), id);
  const session: ActiveSession = {
    id,
    repoRoot,
    sessionDir,
    startedAt,
    pid: process.pid,
    ownerToken: randomUUID(),
  };
  const baseline: SessionBaseline = {
    capturedAt: new Date().toISOString(),
    git: await collectGitSnapshot(repoRoot, config.exclude),
  };

  await ensureDir(getStateDir(repoRoot, config));
  const recoveryState = await inspectSessionRecoveryState(repoRoot, config);
  if (recoveryState.status !== "no-active-session") {
    throw new Error(`${recoveryState.message} Run \`abb recover\` before starting another session.`);
  }

  await acquireSessionLock(repoRoot, config, {
    sessionId: session.id,
    pid: session.pid,
    createdAt: session.startedAt,
    sessionDir: session.sessionDir,
    ownerToken: session.ownerToken,
  });

  try {
    const existingState = await readStateFile<ActiveSession>(getActiveSessionPath(repoRoot, config), isActiveSession);
    if (existingState.corrupted) {
      await releaseSessionLock(repoRoot, config, session);
      throw new Error("Active session state is corrupted. Run `abb doctor` before starting another session.");
    } else if (existingState.value) {
      await releaseSessionLock(repoRoot, config, session);
      throw new Error(
        `A session already exists: ${existingState.value.id}. Run \`abb recover\` before starting another session.`
      );
    }

    await ensureDir(sessionDir);
    await writeFile(getEventsPath(sessionDir), "", "utf8");
    await writeFile(getCommandsPath(sessionDir), "", "utf8");
    await writeJsonFile(getGitBaselinePath(sessionDir), baseline);
    await writeJsonFile(path.join(sessionDir, SESSION_START_FILE), session);
    await writeJsonFile(getActiveSessionPath(repoRoot, config), session);
    await removeFileIfExists(getStopRequestPath(repoRoot, config));

    return session;
  } catch (error) {
    await releaseSessionLock(repoRoot, config, session);
    throw error;
  }
}

export async function readActiveSession(repoRoot: string, config: AgentBlackBoxConfig): Promise<ActiveSession | null> {
  return (await readActiveSessionState(repoRoot, config)).value;
}

export async function readActiveSessionState(
  repoRoot: string,
  config: AgentBlackBoxConfig
): Promise<StateReadResult<ActiveSession>> {
  return readStateFile(getActiveSessionPath(repoRoot, config), isActiveSession);
}

export async function readSessionLock(repoRoot: string, config: AgentBlackBoxConfig): Promise<SessionLock | null> {
  return (await readSessionLockState(repoRoot, config)).value;
}

export async function readSessionLockState(
  repoRoot: string,
  config: AgentBlackBoxConfig
): Promise<StateReadResult<SessionLock>> {
  return readStateFile<SessionLock>(getSessionLockPath(repoRoot, config), isSessionLock);
}

export async function inspectSessionRecoveryState(
  repoRoot: string,
  config: AgentBlackBoxConfig
): Promise<SessionRecoveryState> {
  const activeState = await readActiveSessionState(repoRoot, config);
  const lockState = await readSessionLockState(repoRoot, config);

  if (activeState.corrupted || lockState.corrupted) {
    return {
      status: "corrupt",
      message: "Session state or lock is unreadable; no automatic recovery was attempted.",
      active: null,
    };
  }

  if (!activeState.value) {
    return lockState.value
      ? {
          status: "inconsistent",
          message: `Session lock ${lockState.value.sessionId} exists without an active session state.`,
          active: null,
        }
      : { status: "no-active-session", message: "No active session.", active: null };
  }

  const active = activeState.value;
  if (!(await isSessionLocationTrusted(active, repoRoot, config))) {
    return {
      status: "inconsistent",
      message: `Active session ${active.id} does not belong to this repository or configured session directory.`,
      active,
    };
  }
  if (!lockState.value) {
    return {
      status: "inconsistent",
      message: `Active session ${active.id} has no lock ownership proof.`,
      active,
    };
  }
  if (!lockMatchesActive(lockState.value, active)) {
    return {
      status: "inconsistent",
      message: `Active session ${active.id} and the session lock do not have the same owner.`,
      active,
    };
  }

  if (isProcessRunning(active.pid)) {
    return { status: "active", message: `Session ${active.id} is active.`, active };
  }

  if (await pathExists(path.join(active.sessionDir, "session-metadata.json"))) {
    return {
      status: "already-complete",
      message: `Session ${active.id} has completed reports but stale state files.`,
      active,
    };
  }

  return {
    status: "recoverable",
    message: `Session ${active.id} is stale and can be finalized from the current Git state.`,
    active,
  };
}

export async function recoverActiveSession(
  repoRoot: string,
  config: AgentBlackBoxConfig
): Promise<{ state: SessionRecoveryStatus; report?: SessionReport }> {
  const recovery = await inspectSessionRecoveryState(repoRoot, config);

  if (recovery.status === "no-active-session") {
    return { state: recovery.status };
  }
  if (recovery.status === "active" || recovery.status === "corrupt" || recovery.status === "inconsistent") {
    throw new Error(recovery.message);
  }

  const active = recovery.active;
  if (!active) {
    throw new Error("Recovery state did not include an active session.");
  }
  if (recovery.status === "already-complete") {
    await clearSessionState(active, config);
    return { state: recovery.status };
  }

  return { state: recovery.status, report: await finalizeSession(active, config, "recovery") };
}

export async function writeStopRequest(
  repoRoot: string,
  config: AgentBlackBoxConfig,
  sessionId: string
): Promise<StopRequest> {
  const request = {
    sessionId,
    requestedAt: new Date().toISOString(),
  };
  await writeJsonFile(getStopRequestPath(repoRoot, config), request);
  return request;
}

export async function readStopRequest(repoRoot: string, config: AgentBlackBoxConfig): Promise<StopRequest | null> {
  const requestPath = getStopRequestPath(repoRoot, config);
  if (!(await pathExists(requestPath))) {
    return null;
  }

  return (await readStateFile<StopRequest>(requestPath, isStopRequest)).value;
}

export async function appendFileEvent(session: ActiveSession, event: FileEvent): Promise<void> {
  await appendFile(getEventsPath(session.sessionDir), `${JSON.stringify(event)}\n`, "utf8");
}

export async function appendCommandEvent(session: ActiveSession, event: CommandEvent): Promise<void> {
  await appendFile(getCommandsPath(session.sessionDir), `${JSON.stringify(event)}\n`, "utf8");
}

export async function readFileEvents(sessionDir: string): Promise<FileEvent[]> {
  return (await readFileEventsWithDiagnostics(sessionDir)).records;
}

export async function readCommandEvents(sessionDir: string): Promise<CommandEvent[]> {
  return (await readCommandEventsWithDiagnostics(sessionDir)).records;
}

export async function readSessionBaseline(sessionDir: string): Promise<SessionBaseline | null> {
  return (await readStateFile<SessionBaseline>(getGitBaselinePath(sessionDir), isSessionBaseline)).value;
}

export async function readFileEventsWithDiagnostics(sessionDir: string): Promise<NdjsonReadResult<FileEvent>> {
  return readNdjsonRecords(getEventsPath(sessionDir), isFileEvent, "file event");
}

export async function readCommandEventsWithDiagnostics(sessionDir: string): Promise<NdjsonReadResult<CommandEvent>> {
  return readNdjsonRecords(getCommandsPath(sessionDir), isCommandEvent, "command event");
}

export async function finalizeSession(
  active: ActiveSession,
  config: AgentBlackBoxConfig,
  finalizedBy: string
): Promise<SessionReport> {
  const endedAt = new Date().toISOString();
  const fileEvents = await readFileEventsWithDiagnostics(active.sessionDir);
  const commandEvents = await readCommandEventsWithDiagnostics(active.sessionDir);
  const baselineState = await readStateFile<SessionBaseline>(getGitBaselinePath(active.sessionDir), isSessionBaseline);
  const git = await collectGitSnapshot(active.repoRoot, config.exclude);
  const committedChanges = baselineState.value
    ? await collectGitChangesBetween(active.repoRoot, baselineState.value.git.head, git.head, config.exclude)
    : [];
  const changeEvidence = buildChangeEvidence(baselineState.value, fileEvents.records, git, committedChanges);
  const sessionRelevantChanges = selectSessionRelevantChanges(git, changeEvidence);
  const risks = detectRisks(sessionRelevantChanges, config);
  const possibleSecrets = await detectPossibleSecrets(active.repoRoot, sessionRelevantChanges, config);
  const baselineWarnings = baselineState.value
    ? []
    : [
        baselineState.corrupted
          ? `Git start baseline was unreadable: ${baselineState.error ?? "unexpected shape"}. Change attribution is limited.`
          : "Git start baseline was missing. Change attribution is limited.",
      ];
  const report = buildSessionReport(
    active,
    endedAt,
    finalizedBy,
    fileEvents.records,
    commandEvents.records,
    git,
    risks,
    possibleSecrets,
    {
      warnings: [...fileEvents.warnings, ...commandEvents.warnings, ...baselineWarnings],
      discardedFileEventLines: fileEvents.discardedLines,
      discardedCommandEventLines: commandEvents.discardedLines,
    },
    baselineState.value,
    committedChanges
  );

  await writeReports(report);
  await removeFileIfExists(getActiveSessionPath(active.repoRoot, config));
  await removeFileIfExists(getStopRequestPath(active.repoRoot, config));
  await releaseSessionLock(active.repoRoot, config, active);

  return report;
}

export async function getLatestSessionDir(repoRoot: string, config: AgentBlackBoxConfig): Promise<string | null> {
  const entries = await listSessionCatalog(repoRoot, config);
  if (!entries.some((entry) => entry.state === "complete")) {
    return null;
  }
  return resolveSessionEntry(entries, "latest").sessionDir;
}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createSessionId(startedAt: string): string {
  const safeTimestamp = startedAt.replace(/[:.]/g, "-");
  return `session-${safeTimestamp}`;
}

async function acquireSessionLock(repoRoot: string, config: AgentBlackBoxConfig, lock: SessionLock): Promise<void> {
  const lockPath = getSessionLockPath(repoRoot, config);

  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return;
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
  }

  const existing = await readStateFile<SessionLock>(lockPath, isSessionLock);
  if (existing.value && isProcessRunning(existing.value.pid)) {
    throw new Error(`A session lock is already active for ${existing.value.sessionId}.`);
  }

  throw new Error("A stale or unreadable session lock exists. Run `abb recover` or inspect it with `abb doctor`.");
}

async function clearSessionState(active: ActiveSession, config: AgentBlackBoxConfig): Promise<void> {
  const current = await readActiveSession(active.repoRoot, config);
  if (!current || !activeMatches(current, active)) {
    throw new Error("Session ownership changed during recovery; state was left untouched.");
  }

  await removeFileIfExists(getActiveSessionPath(active.repoRoot, config));
  await removeFileIfExists(getStopRequestPath(active.repoRoot, config));
  await releaseSessionLock(active.repoRoot, config, active);
}

async function releaseSessionLock(repoRoot: string, config: AgentBlackBoxConfig, active: ActiveSession): Promise<void> {
  const lockState = await readSessionLockState(repoRoot, config);
  if (!lockState.value || !lockMatchesActive(lockState.value, active)) {
    return;
  }
  await removeFileIfExists(getSessionLockPath(repoRoot, config));
}

async function readStateFile<T>(filePath: string, guard: (value: unknown) => value is T): Promise<StateReadResult<T>> {
  if (!(await pathExists(filePath))) {
    return { value: null, corrupted: false };
  }

  try {
    const value = await readJsonFileLimited<unknown>(filePath, MAX_STATE_FILE_BYTES);
    if (!guard(value)) {
      return { value: null, corrupted: true, error: "State file has an unexpected shape." };
    }
    return { value, corrupted: false };
  } catch (error) {
    return { value: null, corrupted: true, error: (error as Error).message };
  }
}

async function readNdjsonRecords<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
  label: string
): Promise<NdjsonReadResult<T>> {
  if (!(await pathExists(filePath))) {
    return { records: [], discardedLines: 0, warnings: [] };
  }

  const records: T[] = [];
  const warnings: string[] = [];
  let discardedLines = 0;
  let lineNumber = 0;
  let warningOverflowRecorded = false;
  const input = createReadStream(filePath);
  let lineParts: Buffer[] = [];
  let lineLength = 0;
  let discardingOversizedLine = false;

  const addWarning = (warning: string): void => {
    if (warnings.length < MAX_INTEGRITY_WARNINGS) {
      warnings.push(warning);
    } else if (!warningOverflowRecorded) {
      warnings.push(`Additional malformed ${label} warnings were omitted.`);
      warningOverflowRecorded = true;
    }
  };

  const processLine = (line: Buffer, oversized: boolean): void => {
    lineNumber += 1;
    const normalized = line.length > 0 && line[line.length - 1] === 13 ? line.subarray(0, -1) : line;
    if (oversized) {
      discardedLines += 1;
      addWarning(`Discarded oversized ${label} on line ${lineNumber}.`);
      return;
    }

    if (normalized.length === 0) {
      return;
    }

    if (records.length >= MAX_NDJSON_RECORDS) {
      discardedLines += 1;
      addWarning(`Discarded ${label} beyond the ${MAX_NDJSON_RECORDS} record limit.`);
      return;
    }

    try {
      const parsed = JSON.parse(normalized.toString("utf8")) as unknown;
      if (guard(parsed)) {
        records.push(parsed);
        return;
      }
      discardedLines += 1;
      addWarning(`Discarded malformed ${label} on line ${lineNumber}.`);
    } catch {
      discardedLines += 1;
      addWarning(`Discarded unreadable ${label} on line ${lineNumber}.`);
    }
  };

  for await (const chunk of input) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const segmentEnd = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, segmentEnd);

      if (!discardingOversizedLine) {
        if (lineLength + segment.length > MAX_NDJSON_LINE_BYTES) {
          lineParts = [];
          lineLength = 0;
          discardingOversizedLine = true;
        } else if (segment.length > 0) {
          lineParts.push(segment);
          lineLength += segment.length;
        }
      }

      if (newline === -1) {
        break;
      }

      processLine(
        discardingOversizedLine ? Buffer.alloc(0) : Buffer.concat(lineParts, lineLength),
        discardingOversizedLine
      );
      lineParts = [];
      lineLength = 0;
      discardingOversizedLine = false;
      offset = newline + 1;
    }
  }

  if (discardingOversizedLine || lineLength > 0) {
    processLine(
      discardingOversizedLine ? Buffer.alloc(0) : Buffer.concat(lineParts, lineLength),
      discardingOversizedLine
    );
  }

  return { records, discardedLines, warnings };
}

function isActiveSession(value: unknown): value is ActiveSession {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isSessionId(value.id) &&
    isBoundedString(value.repoRoot, MAX_PATH_LENGTH) &&
    isBoundedString(value.sessionDir, MAX_PATH_LENGTH) &&
    isIsoDate(value.startedAt) &&
    isPositiveInteger(value.pid) &&
    isOptionalOwnerToken(value.ownerToken)
  );
}

function isSessionLock(value: unknown): value is SessionLock {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isSessionId(value.sessionId) &&
    isIsoDate(value.createdAt) &&
    isBoundedString(value.sessionDir, MAX_PATH_LENGTH) &&
    isPositiveInteger(value.pid) &&
    isOptionalOwnerToken(value.ownerToken)
  );
}

function isStopRequest(value: unknown): value is StopRequest {
  if (!isRecord(value)) {
    return false;
  }

  return isSessionId(value.sessionId) && isIsoDate(value.requestedAt);
}

function isFileEvent(value: unknown): value is FileEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isIsoDate(value.timestamp) &&
    isBoundedString(value.path, MAX_PATH_LENGTH) &&
    (value.eventType === "add" || value.eventType === "change" || value.eventType === "unlink")
  );
}

function isCommandEvent(value: unknown): value is CommandEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isIsoDate(value.startedAt) &&
    isIsoDate(value.endedAt) &&
    isBoundedString(value.command, MAX_COMMAND_LENGTH) &&
    isBoundedString(value.cwd, MAX_PATH_LENGTH) &&
    isOptionalBoundedString(value.label, MAX_METADATA_LENGTH) &&
    isOptionalBoundedString(value.group, MAX_METADATA_LENGTH) &&
    isOptionalBoundedString(value.phase, MAX_METADATA_LENGTH) &&
    (isInteger(value.exitCode) || value.exitCode === null) &&
    isNonNegativeFiniteNumber(value.durationMs) &&
    isOptionalBoundedString(value.error, MAX_COMMAND_LENGTH)
  );
}

function isSessionBaseline(value: unknown): value is SessionBaseline {
  return isRecord(value) && isIsoDate(value.capturedAt) && isGitSnapshot(value.git);
}

function isGitSnapshot(value: unknown): value is GitSnapshot {
  return (
    isRecord(value) &&
    isBoundedString(value.repoRoot, MAX_PATH_LENGTH) &&
    isOptionalBoundedString(value.head, 128) &&
    isOptionalBoundedString(value.indexFingerprint, 128) &&
    isOptionalBoundedString(value.branch, 1024) &&
    isBoundedString(value.statusText, MAX_COMMAND_LENGTH * 32) &&
    isBoundedString(value.diffSummaryText, MAX_COMMAND_LENGTH * 32) &&
    Array.isArray(value.changedFiles) &&
    value.changedFiles.every(
      (file) =>
        isRecord(file) &&
        isBoundedString(file.path, MAX_PATH_LENGTH) &&
        ["added", "modified", "deleted", "renamed", "unknown"].includes(String(file.status))
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && /^session-[A-Za-z0-9._-]{1,200}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isOptionalBoundedString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || isBoundedString(value, maxLength);
}

function isOptionalOwnerToken(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value));
}

function lockMatchesActive(lock: SessionLock, active: ActiveSession): boolean {
  if (lock.sessionId !== active.id || lock.pid !== active.pid || lock.sessionDir !== active.sessionDir) {
    return false;
  }
  return lock.ownerToken === active.ownerToken;
}

function activeMatches(left: ActiveSession, right: ActiveSession): boolean {
  return (
    left.id === right.id &&
    left.pid === right.pid &&
    left.sessionDir === right.sessionDir &&
    left.ownerToken === right.ownerToken
  );
}

async function isSessionLocationTrusted(
  active: ActiveSession,
  repoRoot: string,
  config: AgentBlackBoxConfig
): Promise<boolean> {
  const expectedSessionDir = path.join(getSessionRoot(repoRoot, config), active.id);
  const [trustedRepoRoot, activeRepoRoot, expectedDirectory, activeDirectory] = await Promise.all([
    tryRealpath(repoRoot),
    tryRealpath(active.repoRoot),
    tryRealpath(expectedSessionDir),
    tryRealpath(active.sessionDir),
  ]);

  return (
    trustedRepoRoot !== null &&
    trustedRepoRoot === activeRepoRoot &&
    expectedDirectory !== null &&
    expectedDirectory === activeDirectory
  );
}

async function tryRealpath(targetPath: string): Promise<string | null> {
  try {
    return await realpath(targetPath);
  } catch {
    return null;
  }
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFileExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}
