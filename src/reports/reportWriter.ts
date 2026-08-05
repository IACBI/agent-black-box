import path from "node:path";
import type { SessionReport } from "../types.js";
import { ensureDir, removeFileIfExists, writeJsonFile, writeTextFileAtomic } from "../utils/files.js";
import { buildSessionMetadata, SESSION_METADATA_FILE } from "../session/sessionCatalog.js";
import {
  generateCommandsMarkdown,
  generateDiffSummaryMarkdown,
  generateRisksMarkdown,
  generateRollbackMarkdown,
  generateSummaryMarkdown,
  generateTimelineMarkdown,
} from "./markdown.js";

export async function writeReports(report: SessionReport): Promise<void> {
  await ensureDir(report.sessionDir);
  await removeFileIfExists(path.join(report.sessionDir, SESSION_METADATA_FILE));
  await Promise.all([
    writeJsonFile(path.join(report.sessionDir, "session.json"), report),
    writeTextFileAtomic(path.join(report.sessionDir, "summary.md"), generateSummaryMarkdown(report)),
    writeTextFileAtomic(path.join(report.sessionDir, "commands.md"), generateCommandsMarkdown(report)),
    writeTextFileAtomic(path.join(report.sessionDir, "timeline.md"), generateTimelineMarkdown(report)),
    writeTextFileAtomic(path.join(report.sessionDir, "diff-summary.md"), generateDiffSummaryMarkdown(report)),
    writeTextFileAtomic(path.join(report.sessionDir, "risks.md"), generateRisksMarkdown(report)),
    writeTextFileAtomic(path.join(report.sessionDir, "rollback.md"), generateRollbackMarkdown(report)),
  ]);
  await writeJsonFile(path.join(report.sessionDir, SESSION_METADATA_FILE), buildSessionMetadata(report));
}
