import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionReport } from "../types.js";
import { ensureDir, writeJsonFile } from "../utils/files.js";
import {
  generateDiffSummaryMarkdown,
  generateRisksMarkdown,
  generateRollbackMarkdown,
  generateTimelineMarkdown
} from "./markdown.js";

export async function writeReports(report: SessionReport): Promise<void> {
  await ensureDir(report.sessionDir);
  await writeJsonFile(path.join(report.sessionDir, "session.json"), report);
  await writeFile(path.join(report.sessionDir, "timeline.md"), generateTimelineMarkdown(report), "utf8");
  await writeFile(path.join(report.sessionDir, "diff-summary.md"), generateDiffSummaryMarkdown(report), "utf8");
  await writeFile(path.join(report.sessionDir, "risks.md"), generateRisksMarkdown(report), "utf8");
  await writeFile(path.join(report.sessionDir, "rollback.md"), generateRollbackMarkdown(report), "utf8");
}
