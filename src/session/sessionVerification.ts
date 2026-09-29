import { lstat } from "node:fs/promises";
import path from "node:path";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { verifyCatalogSessionReportFile, type SessionCatalogEntry } from "./sessionCatalog.js";

const DERIVED_REPORT_FILES = ["summary.md", "commands.md", "timeline.md", "diff-summary.md", "risks.md", "rollback.md"];
const VERIFICATION_CONCURRENCY = 4;

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
export async function verifySessions(entries: readonly SessionCatalogEntry[]): Promise<SessionVerificationSummary> {
  const sessions = await mapWithConcurrency(entries, VERIFICATION_CONCURRENCY, verifySession);
  return {
    verified: sessions.filter((session) => session.status === "verified").length,
    failed: sessions.filter((session) => session.status === "failed").length,
    skipped: sessions.filter((session) => session.status === "skipped").length,
    sessions,
  };
}

async function verifySession(entry: SessionCatalogEntry): Promise<SessionVerificationResult> {
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
    await verifyCatalogSessionReportFile(entry);
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
    const detail = session.message ? ` — ${session.message}` : "";
    lines.push(`${session.status.padEnd(8)} ${session.id}${detail}`);
    if (session.missingReports) {
      lines.push(`         missing reports: ${session.missingReports.join(", ")}`);
    }
  }
  lines.push("", `Verified: ${summary.verified}, failed: ${summary.failed}, skipped: ${summary.skipped}.`);
  return `${lines.join("\n")}\n`;
}
