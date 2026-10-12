import path from "node:path";
import type { RiskSeverity, SessionReport } from "../types.js";
import { pathExists, writeTextFileAtomic } from "../utils/files.js";
import {
  generateCommandsMarkdown,
  generateDiffSummaryMarkdown,
  generateRisksMarkdown,
  generateRollbackMarkdown,
  generateSummaryMarkdown,
  generateTimelineMarkdown,
  filterRiskFindings,
  type RiskReportFilter,
} from "../reports/markdown.js";
import { toSessionSarif } from "../reports/sessionSarif.js";

export type ExportFormat = "json" | "markdown" | "sarif";

export interface SessionExportOptions {
  format: ExportFormat;
  riskFilter?: RiskReportFilter;
}

export interface WriteExportOptions {
  force?: boolean;
}

export function parseExportFormat(format: string): ExportFormat {
  if (format === "json" || format === "markdown" || format === "sarif") {
    return format;
  }

  throw new Error("Export format must be one of `markdown`, `json` or `sarif`.");
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

  if (options.format === "sarif") {
    // The risk filter narrows risk findings only; possible secrets are always reported.
    const filtered = { ...report, risks: filterRiskFindings(report.risks, options.riskFilter) };
    return `${JSON.stringify(toSessionSarif(filtered), null, 2)}\n`;
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

  try {
    await writeTextFileAtomic(resolvedPath, content, { overwrite: options.force === true });
  } catch (error) {
    if (!options.force && isFileExistsError(error)) {
      throw new Error(
        `Refusing to overwrite existing export file: ${resolvedPath}. Re-run with --force to replace it.`,
        { cause: error }
      );
    }

    if (!options.force && isHardLinkPublicationError(error)) {
      throw new Error(
        `Atomic export publication requires hard-link support and permission on the destination filesystem: ${resolvedPath}. ` +
          "Choose a supported destination, omit --output to use stdout, or use --force for atomic replacement only if replacing any existing destination is intended.",
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

function isHardLinkPublicationError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "syscall" in error &&
    error.syscall === "link" &&
    ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EXDEV"].includes(String(error.code))
  );
}
