import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
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
import { writeRollbackSafetyState } from "../rollback/rollback.js";
import { buildSessionReport } from "../reports/markdown.js";
import { writeReports } from "../reports/reportWriter.js";
import { ensureDir, pathExists, readJsonFileLimited, removeFileIfExists, writeJsonFile } from "../utils/files.js";
import { buildChangeEvidence, selectSessionRelevantChanges } from "./changeEvidence.js";
import { listSessionCatalog, resolveSessionEntry, verifyCatalogSessionReportFile } from "./sessionCatalog.js";
import { isCapturedCommandEvent, isCapturedFileEvent, readNdjsonRecords, type NdjsonReadResult } from "./ndjson.js";

const ACTIVE_SESSION_FILE = "active-session.json";
const STOP_REQUEST_FILE = "stop-request.json";
const SESSION_LOCK_FILE = "session.lock";
const EVENTS_FILE = "events.ndjson";
const COMMANDS_FILE = "commands.ndjson";
const COMMAND_CLOSING_FILE = "commands-closing";
const INFLIGHT_COMMAND_PATTERN = /^command-inflight-(\d+)-[0-9a-f-]+$/;
const CAPTURE_LOSS_MARKERS = {
  overflow: "capture-loss-overflow",
  writeFailure: "capture-loss-write-failure",
  watcherError: "capture-loss-watcher-error",
} as const;
const SESSION_START_FILE = "session-start.json";
const GIT_BASELINE_FILE = "git-start.json";
const MAX_PATH_LENGTH = 32_768;
const MAX_COMMAND_LENGTH = 32_768;
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

    await ensureDir(getSessionRoot(repoRoot, config));
    await mkdir(sessionDir, { mode: 0o700 });
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
    try {
      await verifyCatalogSessionReportFile({ id: active.id, sessionDir: active.sessionDir, state: "complete" });
    } catch {
      return {
        status: "corrupt",
        message: `Session ${active.id} has completion metadata but no valid completed report; state was left untouched.`,
        active,
      };
    }
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

export async function markCaptureLoss(session: ActiveSession, kind: keyof typeof CAPTURE_LOSS_MARKERS): Promise<void> {
  try {
    const handle = await open(path.join(session.sessionDir, CAPTURE_LOSS_MARKERS[kind]), "wx");
    await handle.close();
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
  }
}

export async function appendCommandEvent(session: ActiveSession, event: CommandEvent): Promise<void> {
  await appendFile(getCommandsPath(session.sessionDir), `${JSON.stringify(event)}\n`, "utf8");
}

export async function registerInFlightCommand(session: ActiveSession): Promise<string> {
  const closingPath = path.join(session.sessionDir, COMMAND_CLOSING_FILE);
  if (await fileExistsStrict(closingPath)) {
    throw new Error("Session is closing; no new commands can be recorded.");
  }

  const markerPath = path.join(session.sessionDir, `command-inflight-${process.pid}-${randomUUID()}`);
  const handle = await open(markerPath, "wx");
  await handle.close();

  // A finalizer may have started between the first check and marker creation.
  if (await fileExistsStrict(closingPath)) {
    await removeFileIfExists(markerPath);
    throw new Error("Session is closing; no new commands can be recorded.");
  }

  return markerPath;
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
  return readNdjsonRecords(getEventsPath(sessionDir), isCapturedFileEvent, "file event");
}

export async function readCommandEventsWithDiagnostics(sessionDir: string): Promise<NdjsonReadResult<CommandEvent>> {
  return readNdjsonRecords(getCommandsPath(sessionDir), isCapturedCommandEvent, "command event");
}

export async function finalizeSession(
  active: ActiveSession,
  config: AgentBlackBoxConfig,
  finalizedBy: string,
  captureLoss: { droppedFileEvents: number; failedFileEventWrites: number } = {
    droppedFileEvents: 0,
    failedFileEventWrites: 0,
  }
): Promise<SessionReport> {
  await markCommandsClosing(active.sessionDir);
  const commandWarnings = await waitForInFlightCommands(active.sessionDir);
  const captureLossMarkers = await Promise.all(
    Object.values(CAPTURE_LOSS_MARKERS).map((name) => fileExistsStrict(path.join(active.sessionDir, name)))
  );
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
      warnings: [
        ...fileEvents.warnings,
        ...commandEvents.warnings,
        ...baselineWarnings,
        ...commandWarnings,
        ...(captureLoss.droppedFileEvents > 0
          ? [`Dropped ${captureLoss.droppedFileEvents} file event(s) because the watcher queue was full.`]
          : []),
        ...(captureLoss.failedFileEventWrites > 0
          ? [`Failed to persist ${captureLoss.failedFileEventWrites} file event(s).`]
          : []),
        ...(captureLossMarkers[0] && captureLoss.droppedFileEvents === 0
          ? ["Watcher queue overflowed; the number of dropped file events is unknown after recovery."]
          : []),
        ...(captureLossMarkers[1] && captureLoss.failedFileEventWrites === 0
          ? ["File event writes failed; the number of lost events is unknown after recovery."]
          : []),
        ...(captureLossMarkers[2] ? ["The watcher reported an error before finalization."] : []),
      ],
      discardedFileEventLines: fileEvents.discardedLines,
      discardedCommandEventLines: commandEvents.discardedLines,
      droppedFileEvents: captureLoss.droppedFileEvents,
      failedFileEventWrites: captureLoss.failedFileEventWrites,
    },
    baselineState.value,
    committedChanges
  );

  try {
    await writeRollbackSafetyState(report);
  } catch {
    report.integrity.warnings.push("Rollback safety snapshot could not be saved; automatic restore is unavailable.");
  }
  await writeReports(report);
  await removeFileIfExists(getActiveSessionPath(active.repoRoot, config));
  await removeFileIfExists(getStopRequestPath(active.repoRoot, config));
  await releaseSessionLock(active.repoRoot, config, active);

  return report;
}

async function markCommandsClosing(sessionDir: string): Promise<void> {
  try {
    const handle = await open(path.join(sessionDir, COMMAND_CLOSING_FILE), "wx");
    await handle.close();
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error;
    }
  }
}

async function fileExistsStrict(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function waitForInFlightCommands(sessionDir: string): Promise<string[]> {
  while (true) {
    const markerNames = (await readdir(sessionDir)).filter((name) => INFLIGHT_COMMAND_PATTERN.test(name));
    const liveMarkers = markerNames.filter((name) => {
      const pid = Number(INFLIGHT_COMMAND_PATTERN.exec(name)?.[1]);
      return isProcessRunning(pid);
    });
    if (liveMarkers.length === 0) {
      return markerNames.length > 0
        ? [`${markerNames.length} wrapped command(s) ended before their completion could be recorded.`]
        : [];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
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
  } catch (error) {
    // Permission denial is not proof that the process has exited.
    return isRecord(error) && error.code === "EPERM";
  }
}

function createSessionId(startedAt: string): string {
  const safeTimestamp = startedAt.replace(/[:.]/g, "-");
  return `session-${safeTimestamp}-${randomUUID()}`;
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

function isFileExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}
