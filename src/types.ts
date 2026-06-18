export type FileEventType = "add" | "change" | "unlink";

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "unknown";

export type RiskSeverity = "low" | "medium" | "high";

export interface AgentBlackBoxConfig {
  sessionDir: string;
  exclude: string[];
  riskPatterns: string[];
  maxFileSizeKb: number;
}

export interface ActiveSession {
  id: string;
  repoRoot: string;
  sessionDir: string;
  startedAt: string;
  pid: number;
}

export interface StopRequest {
  sessionId: string;
  requestedAt: string;
}

export interface FileEvent {
  timestamp: string;
  eventType: FileEventType;
  path: string;
}

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  insertions?: number;
  deletions?: number;
}

export interface GitSnapshot {
  repoRoot: string;
  branch?: string;
  statusText: string;
  diffSummaryText: string;
  changedFiles: ChangedFile[];
}

export interface RiskFinding {
  path: string;
  category: string;
  severity: RiskSeverity;
  reason: string;
}

export interface SecretFinding {
  path: string;
  line: number;
  reason: string;
  redacted: string;
}

export interface SessionReport {
  id: string;
  repoRoot: string;
  sessionDir: string;
  startedAt: string;
  endedAt: string;
  finalizedBy: string;
  commandCapture: {
    implemented: false;
    note: string;
  };
  events: FileEvent[];
  git: GitSnapshot;
  risks: RiskFinding[];
  possibleSecrets: SecretFinding[];
}
