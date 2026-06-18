import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActiveSession, AgentBlackBoxConfig, FileEvent, SessionReport, StopRequest } from "../types.js";
import { collectGitSnapshot } from "../git/git.js";
import { detectRisks } from "../risks/riskDetector.js";
import { detectPossibleSecrets } from "../risks/secretDetector.js";
import { buildSessionReport } from "../reports/markdown.js";
import { writeReports } from "../reports/reportWriter.js";
import { ensureDir, getNewestDirectory, pathExists, readJsonFile, removeFileIfExists, writeJsonFile } from "../utils/files.js";

const ACTIVE_SESSION_FILE = "active-session.json";
const STOP_REQUEST_FILE = "stop-request.json";
const EVENTS_FILE = "events.ndjson";
const SESSION_START_FILE = "session-start.json";

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

export function getEventsPath(sessionDir: string): string {
  return path.join(sessionDir, EVENTS_FILE);
}

export async function createSession(repoRoot: string, config: AgentBlackBoxConfig): Promise<ActiveSession> {
  const existing = await readActiveSession(repoRoot, config);
  if (existing && isProcessRunning(existing.pid)) {
    throw new Error(`A session is already active: ${existing.id}`);
  }

  const startedAt = new Date().toISOString();
  const id = createSessionId(startedAt);
  const sessionDir = path.join(getSessionRoot(repoRoot, config), id);
  const session: ActiveSession = {
    id,
    repoRoot,
    sessionDir,
    startedAt,
    pid: process.pid
  };

  await ensureDir(sessionDir);
  await writeFile(getEventsPath(sessionDir), "", "utf8");
  await writeJsonFile(path.join(sessionDir, SESSION_START_FILE), session);
  await writeJsonFile(getActiveSessionPath(repoRoot, config), session);
  await removeFileIfExists(getStopRequestPath(repoRoot, config));

  return session;
}

export async function readActiveSession(repoRoot: string, config: AgentBlackBoxConfig): Promise<ActiveSession | null> {
  const activePath = getActiveSessionPath(repoRoot, config);
  if (!(await pathExists(activePath))) {
    return null;
  }

  return readJsonFile<ActiveSession>(activePath);
}

export async function writeStopRequest(
  repoRoot: string,
  config: AgentBlackBoxConfig,
  sessionId: string
): Promise<StopRequest> {
  const request = {
    sessionId,
    requestedAt: new Date().toISOString()
  };
  await writeJsonFile(getStopRequestPath(repoRoot, config), request);
  return request;
}

export async function readStopRequest(repoRoot: string, config: AgentBlackBoxConfig): Promise<StopRequest | null> {
  const requestPath = getStopRequestPath(repoRoot, config);
  if (!(await pathExists(requestPath))) {
    return null;
  }

  return readJsonFile<StopRequest>(requestPath);
}

export async function appendFileEvent(session: ActiveSession, event: FileEvent): Promise<void> {
  await appendFile(getEventsPath(session.sessionDir), `${JSON.stringify(event)}\n`, "utf8");
}

export async function readFileEvents(sessionDir: string): Promise<FileEvent[]> {
  const eventsPath = getEventsPath(sessionDir);
  if (!(await pathExists(eventsPath))) {
    return [];
  }

  const raw = await readFile(eventsPath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FileEvent);
}

export async function finalizeSession(
  active: ActiveSession,
  config: AgentBlackBoxConfig,
  finalizedBy: string
): Promise<SessionReport> {
  const endedAt = new Date().toISOString();
  const events = await readFileEvents(active.sessionDir);
  const git = await collectGitSnapshot(active.repoRoot);
  const risks = detectRisks(git.changedFiles, config);
  const possibleSecrets = await detectPossibleSecrets(active.repoRoot, git.changedFiles, config);
  const report = buildSessionReport(active, endedAt, finalizedBy, events, git, risks, possibleSecrets);

  await writeReports(report);
  await removeFileIfExists(getActiveSessionPath(active.repoRoot, config));
  await removeFileIfExists(getStopRequestPath(active.repoRoot, config));

  return report;
}

export async function getLatestSessionDir(repoRoot: string, config: AgentBlackBoxConfig): Promise<string | null> {
  return getNewestDirectory(getSessionRoot(repoRoot, config));
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
