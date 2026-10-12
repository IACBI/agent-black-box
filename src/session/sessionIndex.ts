import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { CommandEvent } from "../types.js";
import { writeJsonFile } from "../utils/files.js";
import { digestNdjsonRecords, isCapturedCommandEvent } from "./ndjson.js";
import {
  digestRegularFile,
  MaterializationBudgetError,
  MAX_REPORT_BYTES,
  readJsonFileWithinBudget,
} from "./reportStorage.js";
import {
  buildSessionMetadata,
  readVerifiedCatalogSessionReportCore,
  SESSION_METADATA_FILE,
  type SessionCatalogEntry,
  type SessionCatalogOptions,
} from "./sessionCatalog.js";
import { buildSessionSearchIndex, MAX_SESSION_SEARCH_BYTES, SESSION_SEARCH_FILE } from "./sessionSearch.js";

export interface SessionIndexInspection {
  issues: string[];
  repaired: string[];
  skipped: string[];
}

/** Derived indices are disposable; canonical report bytes and capture logs are never changed here. */
export async function inspectSessionIndexes(
  entry: SessionCatalogEntry,
  options: SessionCatalogOptions & { repair?: boolean } = {}
): Promise<SessionIndexInspection> {
  const reportPath = path.join(entry.sessionDir, "session.json");
  const sourceDigest = await digestRegularFile(reportPath, MAX_REPORT_BYTES);
  const verified = await readVerifiedCatalogSessionReportCore(entry, options);
  const metadata = { ...buildSessionMetadata(verified.report), commandCount: verified.commandCount };
  const search = buildSessionSearchIndex(verified.report);
  const indexLimit = Math.min(MAX_SESSION_SEARCH_BYTES, options.maxMaterializedBytes ?? MAX_SESSION_SEARCH_BYTES);
  let searchTooLarge = false;
  if (verified.commandCount !== verified.report.commands.length) {
    const commands = new Set<string>();
    let encodedBytes = Buffer.byteLength(`${JSON.stringify(search, null, 2)}\n`);
    let exceeded = encodedBytes > indexLimit;
    // The digest scanner retains one line at a time. The guard observes only bounded unique strings.
    const scanned = await digestNdjsonRecords(
      path.join(entry.sessionDir, "commands.ndjson"),
      (value): value is CommandEvent => {
        if (!isCapturedCommandEvent(value)) {
          return false;
        }
        if (!exceeded && !commands.has(value.command)) {
          encodedBytes += Buffer.byteLength(JSON.stringify(value.command)) + (commands.size === 0 ? 8 : 6);
          if (encodedBytes > indexLimit) {
            exceeded = true;
          } else {
            commands.add(value.command);
          }
        }
        return true;
      },
      "command event"
    );
    if (exceeded) {
      if (indexLimit < MAX_SESSION_SEARCH_BYTES) {
        throw new Error(
          "Derived search index exceeds its input allowance; increase --memory-budget-mb. Canonical evidence was left unchanged."
        );
      }
      searchTooLarge = true;
    }
    if (scanned.recordCount !== verified.commandCount || scanned.digest !== verified.commandDigest) {
      throw new Error("Session commands changed while deriving its search index.");
    }
    search.commands = [...commands];
  }
  if (Buffer.byteLength(`${JSON.stringify(search, null, 2)}\n`) > indexLimit) {
    if (indexLimit < MAX_SESSION_SEARCH_BYTES) {
      throw new Error(
        "Derived search index exceeds its input allowance; increase --memory-budget-mb. Canonical evidence was left unchanged."
      );
    }
    searchTooLarge = true;
  }
  const targets = [
    { name: SESSION_SEARCH_FILE, value: search, maxBytes: MAX_SESSION_SEARCH_BYTES },
    { name: SESSION_METADATA_FILE, value: metadata, maxBytes: 1024 * 1024 },
  ].filter((target) => !searchTooLarge || target.name !== SESSION_SEARCH_FILE);
  const issues: string[] = [];
  const repaired: string[] = [];
  const skipped: string[] = [];
  if (searchTooLarge) {
    try {
      await lstat(path.join(entry.sessionDir, SESSION_SEARCH_FILE));
      throw new Error(
        "An oversized-by-design search index must be absent; preserve or remove the unexpected index manually after review."
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    skipped.push(SESSION_SEARCH_FILE);
  }
  for (const target of targets) {
    try {
      const info = await lstat(path.join(entry.sessionDir, target.name));
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("Not a regular file.");
      }
      const actual = await readJsonFileWithinBudget<unknown>(
        path.join(entry.sessionDir, target.name),
        target.maxBytes,
        options.maxMaterializedBytes
      );
      if (!sameDerivedValue(actual, target.value)) {
        issues.push(target.name);
      }
    } catch (error) {
      if (error instanceof MaterializationBudgetError) {
        throw error;
      }
      issues.push(target.name);
    }
  }
  if (!options.repair || issues.length === 0) {
    return { issues, repaired, skipped };
  }
  await assertSafeIndexDirectory(entry.sessionDir);
  for (const name of issues) {
    await assertSafeIndexTarget(path.join(entry.sessionDir, name));
  }
  // Revalidate after index inspection, before publishing derived output. Metadata is published last.
  await readVerifiedCatalogSessionReportCore(entry, options);
  const currentDigest = await digestRegularFile(reportPath, MAX_REPORT_BYTES);
  if (sourceDigest.digest !== currentDigest.digest || sourceDigest.bytes !== currentDigest.bytes) {
    throw new Error("Session report changed during index inspection; no indices were repaired.");
  }
  for (const target of targets) {
    if (issues.includes(target.name)) {
      await assertSafeIndexDirectory(entry.sessionDir);
      await assertSafeIndexTarget(path.join(entry.sessionDir, target.name));
      await writeJsonFile(path.join(entry.sessionDir, target.name), target.value);
      repaired.push(target.name);
    }
  }
  return { issues, repaired, skipped };
}

function sameDerivedValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => sameDerivedValue(actual[index], value))
    );
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) {
      return false;
    }
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    return (
      Object.keys(actualRecord).length === Object.keys(expectedRecord).length &&
      Object.entries(expectedRecord).every(
        ([key, value]) => Object.hasOwn(actualRecord, key) && sameDerivedValue(actualRecord[key], value)
      )
    );
  }
  return actual === expected;
}

async function assertSafeIndexTarget(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Index repair refused a linked or special target.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function assertSafeIndexDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  const root = path.dirname(directory);
  const rootInfo = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    (await realpath(directory)) !== path.join(await realpath(root), path.basename(directory))
  ) {
    throw new Error("Index repair refused a linked or displaced session directory.");
  }
  const stateRoot = path.dirname(root);
  for (const name of ["active-session.json", "session.lock"]) {
    try {
      await lstat(path.join(stateRoot, name));
      throw new Error("A session is active or its state needs recovery; index repair was cancelled.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}
