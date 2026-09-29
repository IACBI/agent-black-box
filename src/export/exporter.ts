import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { RiskSeverity, SessionReport } from "../types.js";
import { ensureDir, pathExists, writeTextFileAtomic } from "../utils/files.js";
import {
  generateCommandsMarkdown,
  generateDiffSummaryMarkdown,
  generateRisksMarkdown,
  generateRollbackMarkdown,
  generateSummaryMarkdown,
  generateTimelineMarkdown,
  type RiskReportFilter,
} from "../reports/markdown.js";

export type ExportFormat = "json" | "markdown";

export interface SessionExportOptions {
  format: ExportFormat;
  riskFilter?: RiskReportFilter;
}

export interface WriteExportOptions {
  force?: boolean;
}

export function parseExportFormat(format: string): ExportFormat {
  if (format === "json" || format === "markdown") {
    return format;
  }

  throw new Error("Export format must be either `json` or `markdown`.");
}

export function parseRiskSeverity(value: string | undefined): RiskSeverity | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  throw new Error("--min-severity must be one of: low, medium, high.");
}

export function renderSessionExport(report: SessionReport, options: SessionExportOptions): string {
  if (options.format === "json") {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  return [
    generateSummaryMarkdown(report),
    generateCommandsMarkdown(report),
    generateTimelineMarkdown(report),
    generateDiffSummaryMarkdown(report),
    generateRisksMarkdown(report, options.riskFilter),
    generateRollbackMarkdown(report),
  ]
    .map((section) => section.trimEnd())
    .join("\n\n---\n\n")
    .concat("\n");
}

export async function writeSessionExport(
  outputPath: string,
  content: string,
  options: WriteExportOptions = {}
): Promise<string> {
  const resolvedPath = path.resolve(outputPath);
  if (!options.force && (await pathExists(resolvedPath))) {
    throw new Error(`Refusing to overwrite existing export file: ${resolvedPath}. Re-run with --force to replace it.`);
  }

  await ensureDir(path.dirname(resolvedPath));
  try {
    if (options.force) {
      await writeTextFileAtomic(resolvedPath, content);
    } else {
      await writeFile(resolvedPath, content, { encoding: "utf8", flag: "wx" });
    }
  } catch (error) {
    if (!options.force && isFileExistsError(error)) {
      throw new Error(
        `Refusing to overwrite existing export file: ${resolvedPath}. Re-run with --force to replace it.`,
        { cause: error }
      );
    }

    throw error;
  }

  return resolvedPath;
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
