import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSessionReport } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import {
  appendCommandEvent,
  appendFileEvent,
  createSession,
  getActiveSessionPath,
  getSessionLockPath,
} from "../src/session/sessionManager.js";
import { pathExists } from "../src/utils/files.js";
import { runCli } from "./cliRunner.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

async function writeSession(repo: string, id: string, startedAt: string, withFinding = false): Promise<string> {
  const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
  const report = buildSessionReport(
    { id, repoRoot: repo, sessionDir, startedAt },
    new Date(Date.parse(startedAt) + 1000).toISOString(),
    "test",
    [],
    [],
    { repoRoot: repo, statusText: "", diffSummaryText: "", changedFiles: [{ path: "src/app.ts", status: "modified" }] },
    [],
    withFinding
      ? [{ path: "src/app.ts", line: 2, reason: "Possible token", redacted: "synthetic-private-excerpt" }]
      : []
  );
  await writeReports(report);
  return sessionDir;
}

describe("audit feature CLI contracts", () => {
  it.each([
    ["--command-wait-timeout-ms", "0", "positive integer"],
    ["--command-wait-timeout-ms", "1.5", "positive integer"],
    ["--command-wait-timeout-ms", "9007199254740992", "positive integer"],
    ["--max-record-bytes", "0", "positive integer"],
    ["--max-record-bytes", "1.5", "positive integer"],
    ["--max-record-bytes", "268435457", "maxRecordBytes must be an integer"],
    ["--max-records", "0", "positive integer"],
    ["--max-records", "1.5", "positive integer"],
    ["--max-records", "9007199254740992", "positive integer"],
  ])("rejects invalid recovery option %s=%s without creating session state", async (option, value, message) => {
    const repo = await createTempDir("abb-cli-recovery-options-");
    try {
      initGitRepo(repo);
      const result = await runCli(repo, ["recover", option, value]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(message);
      expect(await pathExists(path.join(repo, ".agent-black-box"))).toBe(false);
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each(["bytes", "records"])(
    "preserves recovery evidence at the %s allowance and completes an exact-boundary retry",
    async (limit) => {
      const repo = await createTempDir("abb-cli-recovery-budget-");
      try {
        initGitRepo(repo);
        const session = await createSession(repo, DEFAULT_CONFIG);
        await appendFileEvent(session, { timestamp: session.startedAt, path: "src/界.ts", eventType: "change" });
        await appendCommandEvent(session, {
          startedAt: session.startedAt,
          endedAt: session.startedAt,
          command: "echo safe",
          cwd: ".",
          durationMs: 0,
          exitCode: 0,
        });
        const activePath = getActiveSessionPath(repo, DEFAULT_CONFIG);
        const lockPath = getSessionLockPath(repo, DEFAULT_CONFIG);
        const lock = JSON.parse(await readFile(lockPath, "utf8"));
        await writeFile(activePath, JSON.stringify({ ...session, pid: 999_999 }));
        await writeFile(lockPath, JSON.stringify({ ...lock, pid: 999_999 }));
        const activeBytes = await readFile(activePath);
        const lockBytes = await readFile(lockPath);
        const eventsPath = path.join(session.sessionDir, "events.ndjson");
        const commandsPath = path.join(session.sessionDir, "commands.ndjson");
        const events = await readFile(eventsPath, "utf8");
        const commands = await readFile(commandsPath, "utf8");
        const recordBytes = Buffer.byteLength(events.trimEnd()) + Buffer.byteLength(commands.trimEnd());

        const option = limit === "bytes" ? "--max-record-bytes" : "--max-records";
        const refused = await runCli(repo, ["recover", option, String(limit === "bytes" ? recordBytes - 1 : 1)]);
        expect(refused.exitCode).toBe(1);
        expect(refused.stderr).toContain(limit === "bytes" ? "canonical record allowance" : "record count allowance");
        expect(await readFile(activePath)).toEqual(activeBytes);
        expect(await readFile(lockPath)).toEqual(lockBytes);
        expect(await readFile(eventsPath, "utf8")).toBe(events);
        expect(await readFile(commandsPath, "utf8")).toBe(commands);
        expect(await pathExists(path.join(session.sessionDir, "session.json"))).toBe(false);

        const recovered = await runCli(repo, ["recover", option, String(limit === "bytes" ? recordBytes : 2)]);
        expect(recovered.exitCode, recovered.stderr).toBe(0);
        const report = JSON.parse(await readFile(path.join(session.sessionDir, "session.json"), "utf8"));
        expect(report.events).toHaveLength(1);
        expect(report.commands).toHaveLength(1);
        expect(await pathExists(activePath)).toBe(false);
        expect(await pathExists(lockPath)).toBe(false);
      } finally {
        await removeTempDir(repo);
      }
    }
  );

  it("bounds recovery waiting without deleting a live wrapper marker or session ownership", async () => {
    const repo = await createTempDir("abb-cli-recovery-timeout-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      const activePath = getActiveSessionPath(repo, DEFAULT_CONFIG);
      const lockPath = getSessionLockPath(repo, DEFAULT_CONFIG);
      const lock = JSON.parse(await readFile(lockPath, "utf8"));
      await writeFile(activePath, JSON.stringify({ ...session, pid: 999_999 }));
      await writeFile(lockPath, JSON.stringify({ ...lock, pid: 999_999 }));
      const activeBytes = await readFile(activePath);
      const lockBytes = await readFile(lockPath);
      const marker = path.join(
        session.sessionDir,
        `command-inflight-${process.pid}-22222222-2222-4222-8222-222222222222`
      );
      await writeFile(marker, "");

      const refused = await runCli(repo, ["recover", "--command-wait-timeout-ms", "20"], { timeoutMs: 5000 });
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("Wrapped commands are still running");
      expect(await readFile(activePath)).toEqual(activeBytes);
      expect(await readFile(lockPath)).toEqual(lockBytes);
      expect(await pathExists(marker)).toBe(true);
      expect(await pathExists(path.join(session.sessionDir, "session.json"))).toBe(false);
      await rm(marker);

      const recovered = await runCli(repo, ["recover", "--command-wait-timeout-ms", "20"]);
      expect(recovered.exitCode, recovered.stderr).toBe(0);
      expect(await pathExists(path.join(session.sessionDir, "session.json"))).toBe(true);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("uses the serial repair quota consistently while selecting a legacy session with missing metadata", async () => {
    const repo = await createTempDir("abb-cli-legacy-index-repair-");
    try {
      initGitRepo(repo);
      const sessionDir = await writeSession(repo, "session-legacy-indexes", "2026-01-01T00:00:00.000Z");
      const reportPath = path.join(sessionDir, "session.json");
      const report = JSON.parse(await readFile(reportPath, "utf8"));
      report.extraEvidence = "x".repeat(2 * 1024 * 1024);
      await writeFile(reportPath, JSON.stringify(report));
      const originalBytes = await readFile(reportPath);
      await rm(path.join(sessionDir, "session-metadata.json"));

      const repaired = await runCli(repo, [
        "sessions",
        "verify",
        "latest",
        "--repair-indexes",
        "--memory-budget-mb",
        "32",
        "--json",
      ]);
      expect(repaired.exitCode, repaired.stderr).toBe(0);
      expect(JSON.parse(repaired.stdout).sessions[0].repairedIndexes).toContain("session-metadata.json");
      expect((await readFile(reportPath)).equals(originalBytes)).toBe(true);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("shares staged and baseline content budgets and fails complete-review on skipped baseline evidence", async () => {
    const repo = await createTempDir("abb-cli-analysis-budget-");
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
      const contents = 'const apiKey = "synthetic_private_credential_123456789";\n';
      await writeFile(path.join(repo, "app.ts"), contents);
      execFileSync("git", ["add", "app.ts"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
      const staged = `${contents}// changed\n`;
      await writeFile(path.join(repo, "app.ts"), staged);
      execFileSync("git", ["add", "app.ts"], { cwd: repo });

      const result = await runCli(repo, [
        "analyze",
        "--staged",
        "--baseline",
        "HEAD",
        "--policy",
        "complete-review",
        "--format",
        "json",
        "--max-total-bytes",
        String(Buffer.byteLength(staged)),
      ]);
      expect(result.exitCode, result.stderr).toBe(1);
      const analysis = JSON.parse(result.stdout);
      expect(analysis.coverage.scannedTextFiles).toBe(1);
      expect(analysis.baselineComparison.skipped).toEqual([
        expect.objectContaining({ path: "app.ts", reason: expect.stringContaining("aggregate analysis budget") }),
      ]);
      expect(analysis.policyEvaluation.failed).toBe(true);

      const zeroBudget = await runCli(repo, ["analyze", "--max-total-bytes", "0", "--format", "json"]);
      expect(zeroBudget.exitCode, zeroBudget.stderr).toBe(0);
      expect(JSON.parse(zeroBudget.stdout).coverage.scannedTextFiles).toBe(0);
      const invalid = await runCli(repo, ["analyze", "--max-total-bytes", "-1"]);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("non-negative safe integer");
    } finally {
      await removeTempDir(repo);
    }
  }, 30_000);

  it("compares possible-secret locations without exporting stored excerpts", async () => {
    const repo = await createTempDir("abb-cli-comparison-locations-");
    try {
      initGitRepo(repo);
      await writeSession(repo, "session-from", "2026-01-01T00:00:00.000Z");
      await writeSession(repo, "session-to", "2026-01-02T00:00:00.000Z", true);
      const result = await runCli(repo, ["sessions", "compare", "session-from", "session-to", "--json"]);
      expect(result.exitCode, result.stderr).toBe(0);
      const comparison = JSON.parse(result.stdout);
      expect(comparison.secrets).toMatchObject({ fromCount: 0, toCount: 1, countDelta: 1 });
      expect(comparison.secrets.onlyInTo).toEqual([{ path: "src/app.ts", line: 2, reason: "Possible token" }]);
      expect(result.stdout).not.toContain("synthetic-private-excerpt");
      expect(result.stdout).not.toContain("redacted");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("inspects partial archive resumes without mutating either copy", async () => {
    const repo = await createTempDir("abb-cli-archive-inspection-");
    try {
      initGitRepo(repo);
      const old = await writeSession(repo, "session-old", "2026-01-01T00:00:00.000Z");
      await writeSession(repo, "session-new", "2026-01-02T00:00:00.000Z");
      const destination = path.join(repo, "archive", "session-old");
      await mkdir(destination, { recursive: true });
      const copied = await readFile(path.join(old, "summary.md"));
      await writeFile(path.join(destination, "summary.md"), copied);
      const args = ["sessions", "archive", "--before", "2026-01-03", "--to", "archive", "--resume"];
      const preview = await runCli(repo, args);
      expect(preview.exitCode, preview.stderr).toBe(0);
      expect(preview.stdout).toContain("resumable");
      expect(await pathExists(path.join(destination, "session.json"))).toBe(false);
      expect(await readFile(path.join(destination, "summary.md"))).toEqual(copied);
      const refused = await runCli(repo, [...args, "--apply"]);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain("interactive terminal");
      expect(await pathExists(path.join(old, "session.json"))).toBe(true);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("repairs stale derived indexes only on request and keeps canonical report bytes intact", async () => {
    const repo = await createTempDir("abb-cli-index-repair-");
    try {
      initGitRepo(repo);
      const sessionDir = await writeSession(repo, "session-indexes", "2026-01-01T00:00:00.000Z");
      const reportPath = path.join(sessionDir, "session.json");
      const reportBytes = await readFile(reportPath);
      const metadataPath = path.join(sessionDir, "session-metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      metadata.commandCount = 99;
      await writeFile(metadataPath, JSON.stringify(metadata));
      await writeFile(
        path.join(sessionDir, "session-search.json"),
        JSON.stringify({ searchVersion: 1, id: "session-indexes", paths: [], categories: [], commands: [] })
      );

      const checked = await runCli(repo, ["sessions", "verify", "session-indexes", "--check-indexes", "--json"]);
      expect(checked.exitCode, checked.stderr).toBe(1);
      expect(JSON.parse(await readFile(metadataPath, "utf8")).commandCount).toBe(99);
      const repaired = await runCli(repo, ["sessions", "verify", "session-indexes", "--repair-indexes", "--json"]);
      expect(repaired.exitCode, repaired.stderr).toBe(0);
      expect(JSON.parse(await readFile(metadataPath, "utf8")).commandCount).toBe(0);
      expect(await readFile(reportPath)).toEqual(reportBytes);
      const searched = await runCli(repo, ["sessions", "list", "--file", "src/app.ts", "--json"]);
      expect(searched.exitCode, searched.stderr).toBe(0);
      expect(searched.stdout).toContain("session-indexes");
      const verified = await runCli(repo, ["sessions", "verify", "session-indexes", "--check-indexes", "--json"]);
      expect(verified.exitCode, verified.stderr).toBe(0);
    } finally {
      await removeTempDir(repo);
    }
  }, 30_000);
});
