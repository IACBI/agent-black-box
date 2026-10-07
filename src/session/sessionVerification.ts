import { lstat } from "node:fs/promises";
import path from "node:path";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { formatTerminalValue } from "../utils/terminal.js";
import { verifyCatalogSessionReportFile, type SessionCatalogEntry } from "./sessionCatalog.js";
import { NDJSON_STREAM_WORKING_BYTES } from "./ndjson.js";
import { FILE_DIGEST_STREAM_BYTES } from "./reportStorage.js";

const DERIVED_REPORT_FILES = ["summary.md", "commands.md", "timeline.md", "diff-summary.md", "risks.md", "rollback.md"];
const VERIFICATION_CONCURRENCY = 4;
const MIN_WORKER_BUDGET_BYTES = 8 * 1024 * 1024;
/** Two NDJSON streams and the report digest stream; JSON input bytes receive the remaining quota. */
export const VERIFICATION_STREAM_WORKING_BYTES = 2 * NDJSON_STREAM_WORKING_BYTES + 2 * FILE_DIGEST_STREAM_BYTES;

export interface SessionVerificationOptions {
  memoryBudgetMb?: number;
  concurrency?: number;
}

export interface SessionVerificationLimits {
  concurrency: number;
  maxMaterializedBytes?: number;
  streamWorkingBytes: number;
}

/** Deterministic quotas for encoded inputs and stream buffers, independent of the session count. */
export function getSessionVerificationLimits(options: SessionVerificationOptions = {}): SessionVerificationLimits {
  const requestedConcurrency = options.concurrency === undefined ? VERIFICATION_CONCURRENCY : options.concurrency;
  if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 16) {
    throw new Error("Verification concurrency must be an integer between 1 and 16.");
  }
  if (
    options.memoryBudgetMb !== undefined &&
    (!Number.isSafeInteger(options.memoryBudgetMb) || options.memoryBudgetMb < 8 || options.memoryBudgetMb > 4096)
  ) {
    throw new Error("Verification memoryBudgetMb must be an integer between 8 and 4096.");
  }
  const budgetBytes = options.memoryBudgetMb === undefined ? undefined : options.memoryBudgetMb * 1024 * 1024;
  const concurrency = Math.min(
    requestedConcurrency,
    budgetBytes === undefined ? requestedConcurrency : Math.floor(budgetBytes / MIN_WORKER_BUDGET_BYTES)
  );
  return {
    concurrency,
    streamWorkingBytes: VERIFICATION_STREAM_WORKING_BYTES,
    ...(budgetBytes === undefined
      ? {}
      : {
          maxMaterializedBytes: Math.floor(
            (Math.floor(budgetBytes / concurrency) - VERIFICATION_STREAM_WORKING_BYTES) / 2
          ),
        }),
  };
}

export type SessionVerificationStatus = "verified" | "failed" | "skipped";

export interface SessionVerificationResult {
  id: string;
  status: SessionVerificationStatus;
  message?: string;
  /** Derived Markdown reports that are absent; older sessions may not have every file. */
  missingReports?: string[];
}

export interface SessionVerificationSummary {
  verified: number;
  failed: number;
  skipped: number;
  sessions: SessionVerificationResult[];
}

/**
 * Read-only integrity check of stored sessions. Complete sessions must have a `session.json` that
 * passes the same structural and digest validation used before pruning; incomplete sessions have
 * no finalized report and are skipped; corrupt catalog entries fail.
 */
export async function verifySessions(
  entries: readonly SessionCatalogEntry[],
  options: SessionVerificationOptions = {}
): Promise<SessionVerificationSummary> {
  const { concurrency, maxMaterializedBytes } = getSessionVerificationLimits(options);
  const sessions = await mapWithConcurrency(entries, concurrency, (entry) =>
    verifySession(entry, maxMaterializedBytes)
  );
  return {
    verified: sessions.filter((session) => session.status === "verified").length,
    failed: sessions.filter((session) => session.status === "failed").length,
    skipped: sessions.filter((session) => session.status === "skipped").length,
    sessions,
  };
}

async function verifySession(
  entry: SessionCatalogEntry,
  maxMaterializedBytes?: number
): Promise<SessionVerificationResult> {
  if (entry.state === "incomplete") {
    return {
      id: entry.id,
      status: "skipped",
      message: "No finalized report; run `abb recover` if it was interrupted.",
    };
  }
  if (entry.state === "corrupt") {
    return { id: entry.id, status: "failed", message: entry.warning ?? "Session metadata is corrupt." };
  }

  try {
    await verifyCatalogSessionReportFile(entry, { verifyEventLogs: true, maxMaterializedBytes });
  } catch (error) {
    return { id: entry.id, status: "failed", message: (error as Error).message };
  }

  const missingReports = await findMissingReports(entry.sessionDir);
  return { id: entry.id, status: "verified", ...(missingReports.length > 0 ? { missingReports } : {}) };
}

async function findMissingReports(sessionDir: string): Promise<string[]> {
  const present = await Promise.all(
    DERIVED_REPORT_FILES.map(async (fileName) => {
      try {
        return (await lstat(path.join(sessionDir, fileName))).isFile();
      } catch {
        return false;
      }
    })
  );
  return DERIVED_REPORT_FILES.filter((_, index) => !present[index]);
}

export function renderSessionVerification(summary: SessionVerificationSummary): string {
  if (summary.sessions.length === 0) {
    return "No Agent Black Box sessions were found.\n";
  }

  const lines = ["Agent Black Box Session Verification", ""];
  for (const session of summary.sessions) {
    const detail = session.message ? ` — ${formatTerminalValue(session.message)}` : "";
    lines.push(`${session.status.padEnd(8)} ${formatTerminalValue(session.id)}${detail}`);
    if (session.missingReports) {
      lines.push(`         missing reports: ${session.missingReports.map(formatTerminalValue).join(", ")}`);
    }
  }
  lines.push("", `Verified: ${summary.verified}, failed: ${summary.failed}, skipped: ${summary.skipped}.`);
  return `${lines.join("\n")}\n`;
}
