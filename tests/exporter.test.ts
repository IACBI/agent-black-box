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
  return { ...actual, access: vi.fn(actual.access), link: vi.fn(actual.link), open: vi.fn(actual.open) };
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

  it("escapes Markdown presentation controls while retaining exact structured evidence", () => {
    const controls = "\u009b2J\u2028\u2029";
    const mixed = {
      ...report,
      git: { ...report.git, statusText: ` M file${controls}` },
      risks: report.risks.map((risk) => ({ ...risk, reason: `Changed${controls}` })),
    };
    const original = JSON.stringify(mixed);
    const markdown = renderSessionExport(mixed, { format: "markdown" });
    for (const control of ["\u009b", "\u2028", "\u2029"]) {
      expect(markdown).not.toContain(control);
    }
    expect(markdown).toContain("u009b2J");
    expect(JSON.parse(renderSessionExport(mixed, { format: "json" }))).toEqual(mixed);
    const sarif = JSON.parse(renderSessionExport(mixed, { format: "sarif" })) as {
      runs: Array<{ results: Array<{ message: { text: string } }> }>;
    };
    expect(sarif.runs[0]?.results[0]?.message.text).toBe(`Changed${controls}`);
    expect(JSON.stringify(mixed)).toBe(original);
  });

  it("renders a SARIF log without disturbing the markdown and JSON formats", () => {
    const sarif = renderSessionExport(report, { format: "sarif" });
    const log = JSON.parse(sarif) as { version: string; runs: Array<{ results: Array<{ ruleId: string }> }> };

    expect(sarif.endsWith("}\n")).toBe(true);
    expect(sarif).toBe(`${JSON.stringify(log, null, 2)}\n`);
    expect(log.version).toBe("2.1.0");
    expect(log.runs[0]?.results.map((result) => result.ruleId)).toEqual(["session-risk:Environment file"]);

    const json = JSON.parse(renderSessionExport(report, { format: "json" })) as Record<string, unknown>;
    expect(json).not.toHaveProperty("runs");
    expect(renderSessionExport(report, { format: "markdown" })).not.toContain('"runs"');
  });

  it("applies the risk filter to SARIF risks but never to possible secrets", () => {
    const mixed = buildSessionReport(
      { id: "session-sarif", repoRoot: "/repo", sessionDir: "/repo/s", startedAt: "2026-01-01T00:00:00.000Z" },
      "2026-01-01T00:01:00.000Z",
      "test",
      [],
      [],
      { repoRoot: "/repo", statusText: "", diffSummaryText: "", changedFiles: [] },
      [
        {
          path: ".env",
          category: "Environment file",
          severity: "high",
          score: 90,
          reason: "Environment file changed.",
        },
        {
          path: "package.json",
          category: "Package manager file",
          severity: "low",
          score: 20,
          reason: "Manifest changed.",
        },
      ],
      [{ path: "src/key.ts", line: 9, reason: "Possible token detected.", redacted: "ghp_SHOULDNEVERAPPEAR" }]
    );

    const filtered = renderSessionExport(mixed, { format: "sarif", riskFilter: { minSeverity: "high" } });
    const log = JSON.parse(filtered) as { runs: Array<{ results: Array<{ ruleId: string }> }> };

    expect(log.runs[0]?.results.map((result) => result.ruleId).sort()).toEqual([
      "possible-secret",
      "session-risk:Environment file",
    ]);
    expect(filtered).not.toContain("SHOULDNEVERAPPEAR");

    const byCategory = JSON.parse(
      renderSessionExport(mixed, { format: "sarif", riskFilter: { category: "no such category" } })
    ) as { runs: Array<{ results: Array<{ ruleId: string }> }> };
    expect(byCategory.runs[0]?.results.map((result) => result.ruleId)).toEqual(["possible-secret"]);
    expect(mixed.risks).toHaveLength(2);
  });

  it("parses supported options and rejects unsupported values", () => {
    expect(parseExportFormat("json")).toBe("json");
    expect(parseExportFormat("markdown")).toBe("markdown");
    expect(parseExportFormat("sarif")).toBe("sarif");
    expect(parseRiskSeverity("medium")).toBe("medium");
    expect(() => parseExportFormat("zip")).toThrow("`markdown`, `json` or `sarif`");
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

  it("never publishes a partial new export after an interrupted write and permits retry", async () => {
    const dir = await createTempDir();
    try {
      const outputPath = path.join(dir, "abb-export.md");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const failure = Object.assign(new Error("Simulated interrupted export write."), { code: "EIO" });
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
          await handle.write("partial");
          throw failure;
        });
        return handle;
      });
      await expect(writeSessionExport(outputPath, "complete\n")).rejects.toBe(failure);
      expect(await readdir(dir)).toEqual([]);
      await writeSessionExport(outputPath, "complete\n");
      await expect(readFile(outputPath, "utf8")).resolves.toBe("complete\n");
      expect(await readdir(dir)).toEqual(["abb-export.md"]);
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(dir);
    }
  });

  it("preserves a competing export created after the initial absence check", async () => {
    const dir = await createTempDir();
    try {
      const outputPath = path.join(dir, "abb-export.md");
      vi.mocked(fs.access).mockImplementationOnce(async () => {
        await writeFile(outputPath, "competing export\n");
        throw Object.assign(new Error("Stale absence check."), { code: "ENOENT" });
      });
      await expect(writeSessionExport(outputPath, "replacement\n")).rejects.toThrow("Refusing to overwrite");
      await expect(readFile(outputPath, "utf8")).resolves.toBe("competing export\n");
      expect(await readdir(dir)).toEqual(["abb-export.md"]);
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(dir);
    }
  });

  it("fails clearly without publishing or leaving temporary files when hard links are unsupported", async () => {
    const dir = await createTempDir();
    try {
      const outputPath = path.join(dir, "abb-export.md");
      const failure = Object.assign(new Error("Hard links are unavailable."), { code: "ENOTSUP", syscall: "link" });
      vi.mocked(fs.link).mockRejectedValueOnce(failure);
      await expect(writeSessionExport(outputPath, "complete\n")).rejects.toThrow(
        "requires hard-link support and permission"
      );
      expect(await readdir(dir)).toEqual([]);
      await writeSessionExport(outputPath, "complete\n");
      await expect(readFile(outputPath, "utf8")).resolves.toBe("complete\n");
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(dir);
    }
  });

  it("uses atomic replacement explicitly on a filesystem that rejects hard links", async () => {
    const dir = await createTempDir();
    try {
      const outputPath = path.join(dir, "abb-export.md");
      const failure = Object.assign(new Error("Hard links are unavailable."), { code: "ENOTSUP", syscall: "link" });
      vi.mocked(fs.link).mockRejectedValue(failure);
      await expect(writeSessionExport(outputPath, "complete\n")).rejects.toThrow("omit --output to use stdout");
      expect(await readdir(dir)).toEqual([]);
      await writeSessionExport(outputPath, "complete\n", { force: true });
      expect(await readFile(outputPath, "utf8")).toBe("complete\n");
      await writeSessionExport(outputPath, "replacement\n", { force: true });
      expect(await readFile(outputPath, "utf8")).toBe("replacement\n");
      expect(await readdir(dir)).toEqual(["abb-export.md"]);
    } finally {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.mocked(fs.link).mockImplementation(actual.link);
      await removeTempDir(dir);
    }
  });

  it("lets only one concurrent exporter publish a complete file", async () => {
    const dir = await createTempDir();
    try {
      const outputPath = path.join(dir, "abb-export.md");
      const contents = ["first ".repeat(10_000), "second ".repeat(10_000)];
      const results = await Promise.allSettled(contents.map((content) => writeSessionExport(outputPath, content)));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const failure = results.find((result) => result.status === "rejected");
      expect(failure?.status === "rejected" ? String(failure.reason) : "").toContain("Refusing to overwrite");
      expect(contents).toContain(await readFile(outputPath, "utf8"));
      expect(await readdir(dir)).toEqual(["abb-export.md"]);
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
