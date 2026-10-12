import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as markdown from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import { buildSessionMetadata, SESSION_METADATA_FILE } from "../src/session/sessionCatalog.js";
import * as files from "../src/utils/files.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

function createReport(dir: string) {
  return markdown.buildSessionReport(
    { id: "session-publication", repoRoot: dir, sessionDir: dir, startedAt: "2026-01-01T00:00:00.000Z" },
    "2026-01-01T00:01:00.000Z",
    "first-attempt",
    [],
    [],
    { repoRoot: dir, statusText: "", diffSummaryText: "", changedFiles: [] },
    [],
    []
  );
}

describe("report publication", () => {
  it("waits for pending publications after a failure and allows a coherent retry", async () => {
    const dir = await createTempDir("abb-report-writer-");
    const report = createReport(dir);
    const metadataPath = path.join(dir, SESSION_METADATA_FILE);
    const failure = Object.assign(new Error("Report publication failed."), { code: "EIO" });
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const actualWrite = files.writeTextFileAtomic;
    const writer = vi.spyOn(files, "writeTextFileAtomic").mockImplementation(async (filePath, contents, options) => {
      if (path.basename(filePath) === "commands.md") {
        throw failure;
      }
      if (path.basename(filePath) === "summary.md") {
        markWriteStarted();
        await pendingWrite;
      }
      await actualWrite(filePath, contents, options);
    });
    let settled = false;
    const writing = writeReports(report).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    try {
      await writeStarted;
      // Drain rejection microtasks while the other publication is still explicitly held.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      await expect(readFile(metadataPath)).rejects.toMatchObject({ code: "ENOENT" });

      releaseWrite();
      expect(await writing).toBe(failure);
      await expect(readFile(path.join(dir, "summary.md"), "utf8")).resolves.toContain("first-attempt");
      await expect(readFile(metadataPath)).rejects.toMatchObject({ code: "ENOENT" });

      writer.mockRestore();
      const retry = { ...report, finalizedBy: "successful-retry", endedAt: "2026-01-01T00:02:00.000Z" };
      await writeReports(retry);
      expect(JSON.parse(await readFile(path.join(dir, "session.json"), "utf8"))).toEqual(retry);
      expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual(buildSessionMetadata(retry));
      const summary = await readFile(path.join(dir, "summary.md"), "utf8");
      expect(summary).toContain("successful-retry");
      expect(summary).not.toContain("first-attempt");
      await expect(readFile(path.join(dir, "commands.md"), "utf8")).resolves.toContain("No wrapped commands");
    } finally {
      releaseWrite();
      await writing;
      writer.mockRestore();
      await removeTempDir(dir);
    }
  });

  it("preserves a completed report when rendering fails before publication", async () => {
    const dir = await createTempDir("abb-report-render-");
    const report = createReport(dir);
    let renderer: ReturnType<typeof vi.spyOn> | undefined;
    let writer: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await writeReports(report);
      const failure = new RangeError("Invalid string length.");
      renderer = vi.spyOn(markdown, "generateTimelineMarkdown").mockImplementationOnce(() => {
        throw failure;
      });
      writer = vi.spyOn(files, "writeTextFileAtomic");

      await expect(writeReports({ ...report, finalizedBy: "failed-render" })).rejects.toBe(failure);
      expect(writer).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(path.join(dir, "session.json"), "utf8"))).toEqual(report);
      expect(JSON.parse(await readFile(path.join(dir, SESSION_METADATA_FILE), "utf8"))).toEqual(
        buildSessionMetadata(report)
      );
    } finally {
      renderer?.mockRestore();
      writer?.mockRestore();
      await removeTempDir(dir);
    }
  });
});
