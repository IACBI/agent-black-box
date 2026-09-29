import * as fs from "node:fs/promises";
import { readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseExportFormat,
  parseRiskSeverity,
  renderSessionExport,
  writeSessionExport,
} from "../src/export/exporter.js";
import { buildSessionReport } from "../src/reports/markdown.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const report = buildSessionReport(
  {
    id: "session-export",
    repoRoot: "/repo",
    sessionDir: "/repo/.agent-black-box/sessions/session-export",
    startedAt: "2026-01-01T00:00:00.000Z",
  },
  "2026-01-01T00:01:00.000Z",
  "test",
  [],
  [],
  {
    repoRoot: "/repo",
    statusText: "modified .env",
    diffSummaryText: ".env | 1 +",
    changedFiles: [{ path: ".env", status: "modified", insertions: 1, deletions: 0 }],
  },
  [{ path: ".env", category: "Environment file", severity: "high", score: 90, reason: "Environment file changed." }],
  []
);

describe("session exporter", () => {
  it("renders bundled markdown and structured JSON", () => {
    const markdown = renderSessionExport(report, { format: "markdown" });
    const json = renderSessionExport(report, { format: "json" });

    expect(markdown).toContain("Agent Black Box Summary");
    expect(markdown).toContain("Agent Black Box Rollback Hints");
    expect(JSON.parse(json)).toMatchObject({ id: "session-export" });
  });

  it("parses supported options and rejects unsupported values", () => {
    expect(parseExportFormat("json")).toBe("json");
    expect(parseRiskSeverity("medium")).toBe("medium");
    expect(() => parseExportFormat("zip")).toThrow("Export format");
    expect(() => parseRiskSeverity("critical")).toThrow("--min-severity");
  });

  it("writes exports without overwriting unless forced", async () => {
    const dir = await createTempDir();
    try {
      const outputPath = path.join(dir, "abb-export.md");

      await writeSessionExport(outputPath, "first\n");
      await expect(readFile(outputPath, "utf8")).resolves.toBe("first\n");
      await expect(writeSessionExport(outputPath, "second\n")).rejects.toThrow("Refusing to overwrite");

      await writeSessionExport(outputPath, "second\n", { force: true });
      await expect(readFile(outputPath, "utf8")).resolves.toBe("second\n");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("preserves the previous export when a forced replacement write fails", async () => {
    const dir = await createTempDir();
    try {
      const outputPath = path.join(dir, "abb-export.md");
      await writeFile(outputPath, "original\n");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const failure = new Error("Simulated export write failure.");
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        vi.spyOn(handle, "writeFile").mockRejectedValueOnce(failure);
        return handle;
      });

      await expect(writeSessionExport(outputPath, "replacement\n", { force: true })).rejects.toBe(failure);
      await expect(readFile(outputPath, "utf8")).resolves.toBe("original\n");
      expect(await readdir(dir)).toEqual(["abb-export.md"]);
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(dir);
    }
  });

  it.skipIf(process.platform === "win32")("replaces a forced output link without overwriting its target", async () => {
    const dir = await createTempDir();
    try {
      const targetPath = path.join(dir, "original.md");
      const outputPath = path.join(dir, "abb-export.md");
      await writeFile(targetPath, "original\n");
      await symlink(targetPath, outputPath);

      await expect(writeSessionExport(outputPath, "replacement\n")).rejects.toThrow("Refusing to overwrite");
      await writeSessionExport(outputPath, "replacement\n", { force: true });
      await expect(readFile(outputPath, "utf8")).resolves.toBe("replacement\n");
      await expect(readFile(targetPath, "utf8")).resolves.toBe("original\n");
    } finally {
      await removeTempDir(dir);
    }
  });
});
