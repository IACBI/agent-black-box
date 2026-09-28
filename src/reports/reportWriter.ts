import { lstat } from "node:fs/promises";
import path from "node:path";
import type { SessionReport } from "../types.js";
import { ensureDir, removeFileIfExists, writeJsonFile, writeTextFileAtomic } from "../utils/files.js";
import { buildSessionMetadata, SESSION_METADATA_FILE } from "../session/sessionCatalog.js";
import { buildSessionSearchIndex, MAX_SESSION_SEARCH_BYTES, SESSION_SEARCH_FILE } from "../session/sessionSearch.js";
import {
  digestRecords,
  digestText,
  INLINE_REPORT_BYTES,
  MAX_REPORT_BYTES,
  REPORT_REPLAY_FILE,
  type ReportReplay,
} from "../session/reportStorage.js";
import {
  generateCommandsMarkdown,
  generateDiffSummaryMarkdown,
  generateRisksMarkdown,
  generateRollbackMarkdown,
  generateSummaryMarkdown,
  generateTimelineMarkdown,
} from "./markdown.js";

export async function writeReports(report: SessionReport): Promise<void> {
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const reportBytes = Buffer.byteLength(reportText);
  if (reportBytes > MAX_REPORT_BYTES) {
    throw new Error(
      `Session report exceeds the ${MAX_REPORT_BYTES / 1024 / 1024} MiB limit. Raw event logs were preserved; finalization was refused.`
    );
  }

  const replayPath = path.join(report.sessionDir, REPORT_REPLAY_FILE);
  const searchPath = path.join(report.sessionDir, SESSION_SEARCH_FILE);
  const searchText = `${JSON.stringify(buildSessionSearchIndex(report), null, 2)}\n`;
  const searchable = Buffer.byteLength(searchText) <= MAX_SESSION_SEARCH_BYTES;
  let replayText: string | undefined;
  if (reportBytes > INLINE_REPORT_BYTES) {
    const [eventLog, commandLog] = await Promise.all([
      lstat(path.join(report.sessionDir, "events.ndjson")),
      lstat(path.join(report.sessionDir, "commands.ndjson")),
    ]);
    if (!eventLog.isFile() || !commandLog.isFile()) {
      throw new Error("Large session reports require regular event and command logs.");
    }
    const replay: ReportReplay = {
      replayVersion: 1,
      id: report.id,
      reportBytes,
      reportDigest: digestText(reportText),
      eventCount: report.events.length,
      commandCount: report.commands.length,
      eventsDigest: digestRecords(report.events),
      commandsDigest: digestRecords(report.commands),
      eventLogBytes: eventLog.size,
      commandLogBytes: commandLog.size,
      report: { ...report, events: [], commands: [] },
    };
    replayText = `${JSON.stringify(replay, null, 2)}\n`;
    if (Buffer.byteLength(replayText) > INLINE_REPORT_BYTES) {
      throw new Error("Session report metadata exceeds the 32 MiB replay limit. Raw event logs were preserved.");
    }
  }

  await ensureDir(report.sessionDir);
  await removeFileIfExists(path.join(report.sessionDir, SESSION_METADATA_FILE));
  if (!replayText) {
    await removeFileIfExists(replayPath);
  }
  if (!searchable) {
    await removeFileIfExists(searchPath);
  }
  await Promise.all([
    writeTextFileAtomic(path.join(report.sessionDir, "session.json"), reportText),
    ...(replayText ? [writeTextFileAtomic(replayPath, replayText)] : []),
    ...(searchable ? [writeTextFileAtomic(searchPath, searchText)] : []),
    writeTextFileAtomic(path.join(report.sessionDir, "summary.md"), generateSummaryMarkdown(report)),
    writeTextFileAtomic(path.join(report.sessionDir, "commands.md"), generateCommandsMarkdown(report)),
    writeTextFileAtomic(path.join(report.sessionDir, "timeline.md"), generateTimelineMarkdown(report)),
    writeTextFileAtomic(path.join(report.sessionDir, "diff-summary.md"), generateDiffSummaryMarkdown(report)),
    writeTextFileAtomic(path.join(report.sessionDir, "risks.md"), generateRisksMarkdown(report)),
    writeTextFileAtomic(path.join(report.sessionDir, "rollback.md"), generateRollbackMarkdown(report)),
  ]);
  await writeJsonFile(path.join(report.sessionDir, SESSION_METADATA_FILE), buildSessionMetadata(report));
}
