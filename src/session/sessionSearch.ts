import path from "node:path";
import type { RiskSeverity, SessionReport } from "../types.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { readJsonFileLimited } from "../utils/files.js";
import { selectSessionRelevantChanges } from "./changeEvidence.js";
import { readCatalogSessionReport, type SessionCatalogEntry, type SessionCatalogState } from "./sessionCatalog.js";

export const SESSION_SEARCH_FILE = "session-search.json";
export const MAX_SESSION_SEARCH_BYTES = 4 * 1024 * 1024;

export interface SessionSearchIndex {
  searchVersion: 1;
  id: string;
  paths: string[];
  categories: string[];
  commands: string[];
}

export interface SessionSearchFilters {
  state?: SessionCatalogState;
  since?: string;
  minSeverity?: RiskSeverity;
  file?: string;
  command?: string;
  category?: string;
  limit?: number;
}

export function buildSessionSearchIndex(report: SessionReport): SessionSearchIndex {
  return {
    searchVersion: 1,
    id: report.id,
    paths: [...new Set(selectSessionRelevantChanges(report.git, report.changeEvidence).map((file) => file.path))],
    categories: [...new Set(report.risks.map((risk) => risk.category))],
    commands: [...new Set(report.commands.map((command) => command.command))],
  };
}

export async function filterSessionCatalog(
  entries: readonly SessionCatalogEntry[],
  filters: SessionSearchFilters
): Promise<SessionCatalogEntry[]> {
  const since = filters.since ? parseSinceDate(filters.since) : undefined;
  if (filters.limit !== undefined && (!Number.isSafeInteger(filters.limit) || filters.limit < 1)) {
    throw new Error("--limit must be a positive integer.");
  }
  for (const value of [filters.file, filters.command, filters.category]) {
    if (value !== undefined && (value.trim().length === 0 || value.length > 256 || /[\r\n\0]/.test(value))) {
      throw new Error("History search terms must be 1–256 characters on one line.");
    }
  }
  const severityRank = { none: 0, low: 1, medium: 2, high: 3 } as const;
  const candidates = entries.filter(
    (entry) =>
      (filters.state === undefined || entry.state === filters.state) &&
      (since === undefined || (entry.startedAt !== undefined && Date.parse(entry.startedAt) >= since)) &&
      (filters.minSeverity === undefined ||
        (entry.state === "complete" &&
          severityRank[entry.maxRiskSeverity ?? "none"] >= severityRank[filters.minSeverity]))
  );
  if (!filters.file && !filters.command && !filters.category) {
    return filters.limit === undefined ? candidates : candidates.slice(0, filters.limit);
  }

  const filtered: SessionCatalogEntry[] = [];
  for (let offset = 0; offset < candidates.length; offset += 8) {
    const batch = candidates.slice(offset, offset + 8);
    const matches = await mapWithConcurrency(batch, 8, async (entry) => {
      if (entry.state !== "complete") {
        return false;
      }
      const index = await readSearchIndex(entry);
      return (
        matchesTerm(index.paths, filters.file) &&
        matchesTerm(index.commands, filters.command) &&
        matchesTerm(index.categories, filters.category)
      );
    });
    filtered.push(...batch.filter((_, index) => matches[index]));
    if (filters.limit !== undefined && filtered.length >= filters.limit) {
      return filtered.slice(0, filters.limit);
    }
  }
  return filtered;
}

async function readSearchIndex(entry: SessionCatalogEntry): Promise<SessionSearchIndex> {
  try {
    const value = await readJsonFileLimited<unknown>(
      path.join(entry.sessionDir, SESSION_SEARCH_FILE),
      MAX_SESSION_SEARCH_BYTES
    );
    if (isSessionSearchIndex(value) && value.id === entry.id) {
      return value;
    }
  } catch {
    // Older sessions and oversized indices are searched through their validated report.
  }
  return buildSessionSearchIndex(await readCatalogSessionReport(entry));
}

function isSessionSearchIndex(value: unknown): value is SessionSearchIndex {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const isStrings = (item: unknown): item is string[] =>
    Array.isArray(item) && item.every((part) => typeof part === "string");
  return (
    record.searchVersion === 1 &&
    typeof record.id === "string" &&
    isStrings(record.paths) &&
    isStrings(record.categories) &&
    isStrings(record.commands)
  );
}

function matchesTerm(values: readonly string[], query: string | undefined): boolean {
  if (query === undefined) {
    return true;
  }
  const normalized = query.toLowerCase();
  return values.some((value) => value.toLowerCase().includes(normalized));
}

function parseSinceDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("--since must be a date in YYYY-MM-DD format.");
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error("--since must be a valid date in YYYY-MM-DD format.");
  }
  return timestamp;
}
