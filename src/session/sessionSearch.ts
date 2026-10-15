import path from "node:path";
import type { RiskSeverity, SessionReport } from "../types.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { meetsSeverity } from "../utils/severity.js";
import { selectSessionRelevantChanges } from "./changeEvidence.js";
import { readCatalogSessionReport, type SessionCatalogEntry, type SessionCatalogState } from "./sessionCatalog.js";
import { readJsonFileWithinBudget, validateMaterializationLimit } from "./reportStorage.js";

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
  filters: SessionSearchFilters,
  options: { maxMaterializedBytes?: number } = {}
): Promise<SessionCatalogEntry[]> {
  validateMaterializationLimit(options.maxMaterializedBytes);
  const since = filters.since ? parseSinceDate(filters.since) : undefined;
  if (filters.limit !== undefined && (!Number.isSafeInteger(filters.limit) || filters.limit < 1)) {
    throw new Error("--limit must be a positive integer.");
  }
  for (const value of [filters.file, filters.command, filters.category]) {
    if (value !== undefined && (value.trim().length === 0 || value.length > 256 || /[\r\n\0]/.test(value))) {
      throw new Error("History search terms must be 1–256 characters on one line.");
    }
  }
  const stateCandidates = entries.filter((entry) => filters.state === undefined || entry.state === filters.state);
  if (
    stateCandidates.some(
      (entry) =>
        entry.metadataUnavailable &&
        (since !== undefined ||
          filters.limit !== undefined ||
          (filters.minSeverity !== undefined && entry.state === "complete"))
    )
  ) {
    throw new Error(
      "History date, severity, and limit filters require catalog metadata unavailable under the working-data policy. Increase --memory-budget-mb or list sessions without these filters."
    );
  }
  const candidates = stateCandidates.filter(
    (entry) =>
      (since === undefined || (entry.startedAt !== undefined && Date.parse(entry.startedAt) >= since)) &&
      (filters.minSeverity === undefined ||
        (entry.state === "complete" && meetsSeverity(entry.maxRiskSeverity ?? "none", filters.minSeverity)))
  );
  if (!filters.file && !filters.command && !filters.category) {
    return filters.limit === undefined ? candidates : candidates.slice(0, filters.limit);
  }

  const filtered: SessionCatalogEntry[] = [];
  // A fallback can consume the entire report allowance; budgeted searches keep one read active.
  const concurrency = options.maxMaterializedBytes === undefined ? 8 : 1;
  const fallbackReads = createSerialQueue();
  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    const batch = candidates.slice(offset, offset + concurrency);
    const matches = await mapWithConcurrency(batch, concurrency, async (entry) => {
      if (entry.state !== "complete") {
        return false;
      }
      const index = await readSearchIndex(entry, options.maxMaterializedBytes, fallbackReads);
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

/** Runs tasks one at a time, in submission order, regardless of earlier failures. */
function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

async function readSearchIndex(
  entry: SessionCatalogEntry,
  maxMaterializedBytes: number | undefined,
  serializeFallback: <T>(task: () => Promise<T>) => Promise<T>
): Promise<SessionSearchIndex> {
  try {
    const value = await readJsonFileWithinBudget<unknown>(
      path.join(entry.sessionDir, SESSION_SEARCH_FILE),
      MAX_SESSION_SEARCH_BYTES,
      maxMaterializedBytes
    );
    if (isSessionSearchIndex(value) && value.id === entry.id) {
      return value;
    }
  } catch {
    // Older sessions and oversized indices are searched through their report under the same quota.
  }
  // Fallback parsing materializes a whole report, so only one may be resident even when index reads run in parallel.
  return buildSessionSearchIndex(
    await serializeFallback(() => readCatalogSessionReport(entry, { maxMaterializedBytes }))
  );
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
