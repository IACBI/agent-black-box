import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createSession, readCommandEvents } from "../src/session/sessionManager.js";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const cliPath = path.resolve(process.cwd(), "src/cli.ts");

const spawnedProcesses: ChildProcessWithoutNullStreams[] = [];

describe("CLI end-to-end", () => {
  afterEach(async () => {
    await Promise.all(spawnedProcesses.splice(0).map((child) => stopChild(child)));
  });

  it("reports staged scan coverage and ignores a different working-tree value", async () => {
    const repo = await createTempDir("abb-staged-");
    try {
      initGitRepo(repo);
      const rawValue = "test_credential_value_987654321";
      const filePath = path.join(repo, "settings.ts");
      await writeFile(filePath, `const apiKey = "${rawValue}";\n`, "utf8");
      execFileSync("git", ["add", "settings.ts"], { cwd: repo });
      await writeFile(filePath, "const apiKey = process.env.API_KEY;\n", "utf8");

      const staged = await runCli(repo, ["analyze", "--staged", "--format", "json"]);
      expect(staged.exitCode).toBe(0);
      const stagedResult = JSON.parse(staged.stdout) as {
        findings: Array<{ category: string }>;
        coverage: { source: string; scannedTextFiles: number; skipped: unknown[] };
      };
      expect(stagedResult.findings.some((finding) => finding.category === "Possible secret")).toBe(true);
      expect(stagedResult.coverage).toEqual({ source: "index", scannedTextFiles: 1, skipped: [] });
      expect(staged.stdout).not.toContain(rawValue);

      const worktree = await runCli(repo, ["analyze", "--format", "json"]);
      const worktreeResult = JSON.parse(worktree.stdout) as {
        findings: Array<{ category: string }>;
        coverage: { source: string };
      };
      expect(worktreeResult.findings.some((finding) => finding.category === "Possible secret")).toBe(false);
      expect(worktreeResult.coverage.source).toBe("worktree");

      const sarif = await runCli(repo, ["analyze", "--staged", "--format", "sarif"]);
      expect(JSON.parse(sarif.stdout).runs[0].properties.analysisCoverage.source).toBe("index");
    } finally {
      await removeTempDir(repo);
    }
  }, 25_000);

  it("compares staged findings to a fixed Git baseline without printing credential values", async () => {
    const repo = await createTempDir("abb-baseline-");
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
      const oldValue = "test_credential_old_987654321";
      const newValue = "test_credential_new_987654321";
      const filePath = path.join(repo, "settings.ts");
      await writeFile(filePath, `const apiKey = "${oldValue}";\n`, "utf8");
      execFileSync("git", ["add", "settings.ts"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
      await writeFile(filePath, `const apiKey = "${oldValue}";\nconst clientSecret = "${newValue}";\n`, "utf8");
      execFileSync("git", ["add", "settings.ts"], { cwd: repo });

      const json = await runCli(repo, ["analyze", "--staged", "--baseline", "HEAD", "--format", "json"]);
      expect(json.exitCode).toBe(0);
      const result = JSON.parse(json.stdout) as {
        findings: Array<{ kind: string; line?: number }>;
        baselineComparison: { suppressedExistingSecrets: number; commit: string };
      };
      expect(result.findings.filter((finding) => finding.kind === "possible-secret")).toMatchObject([{ line: 2 }]);
      expect(result.baselineComparison.suppressedExistingSecrets).toBe(1);
      expect(result.baselineComparison.commit).toMatch(/^[0-9a-f]{40,64}$/);
      expect(json.stdout).not.toContain(oldValue);
      expect(json.stdout).not.toContain(newValue);

      const sarif = await runCli(repo, ["analyze", "--staged", "--baseline", "HEAD", "--format", "sarif"]);
      expect(JSON.parse(sarif.stdout).runs[0].properties.analysisBaselineComparison.suppressedExistingSecrets).toBe(1);
      const policy = await runCli(repo, [
        "analyze",
        "--staged",
        "--baseline",
        "HEAD",
        "--policy",
        "new-secrets",
        "--format",
        "json",
      ]);
      expect(policy.exitCode).toBe(1);
      expect(JSON.parse(policy.stdout).policyEvaluation).toMatchObject({ profile: "new-secrets", newSecretCount: 1 });
      const policyWithoutBaseline = await runCli(repo, ["analyze", "--staged", "--policy", "new-secrets"]);
      expect(policyWithoutBaseline.stderr).toContain("--policy requires --staged and --baseline");
      const invalid = await runCli(repo, ["analyze", "--baseline", "HEAD"]);
      expect(invalid.exitCode).not.toBe(0);
      expect(invalid.stderr).toContain("--baseline requires --staged");
    } finally {
      await removeTempDir(repo);
    }
  }, 30_000);

  it("uses a Git-identified rename source for staged baseline findings", async () => {
    const repo = await createTempDir("abb-rename-baseline-");
    try {
      initGitRepo(repo);
      execFileSync("git", ["config", "user.email", "tests@example.invalid"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Agent Black Box Tests"], { cwd: repo });
      const oldValue = "test_credential_old_987654321";
      const shared = Array.from({ length: 8 }, (_, index) => `export const setting${index} = ${index};\n`).join("");
      await writeFile(path.join(repo, "old-config.ts"), `const apiKey = "${oldValue}";\n${shared}`, "utf8");
      execFileSync("git", ["add", "old-config.ts"], { cwd: repo });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: repo });
      await rename(path.join(repo, "old-config.ts"), path.join(repo, "new-config.ts"));
      execFileSync("git", ["add", "-A"], { cwd: repo });

      const result = await runCli(repo, ["analyze", "--staged", "--baseline", "HEAD", "--format", "json"]);
      expect(result.exitCode).toBe(0);
      const report = JSON.parse(result.stdout) as {
        findings: Array<{ kind: string }>;
        baselineComparison: {
          suppressedExistingSecrets: number;
          renameSources: Array<{ path: string; sourcePath: string; suppressedExistingSecrets: number }>;
        };
      };
      expect(report.findings.some((finding) => finding.kind === "possible-secret")).toBe(false);
      expect(report.baselineComparison.suppressedExistingSecrets).toBe(1);
      expect(report.baselineComparison.renameSources).toEqual([
        { path: "new-config.ts", sourcePath: "old-config.ts", suppressedExistingSecrets: 1 },
      ]);
      expect(result.stdout).not.toContain(oldValue);
      const sarif = await runCli(repo, ["analyze", "--staged", "--baseline", "HEAD", "--format", "sarif"]);
      expect(JSON.parse(sarif.stdout).runs[0].properties.analysisBaselineComparison.renameSources).toEqual(
        report.baselineComparison.renameSources
      );
    } finally {
      await removeTempDir(repo);
    }
  }, 25_000);

  it("requires an explicit global opt-in for a trusted external session directory", async () => {
    const repo = await createTempDir("abb-e2e-");
    const externalDir = await createTempDir("abb-external-");
    const sessionRoot = path.join(externalDir, "sessions");
    try {
      initGitRepo(repo);
      await writeFile(
        path.join(repo, ".agentblackbox.json"),
        JSON.stringify({
          configVersion: 1,
          sessionDir: sessionRoot,
          exclude: [],
          riskPatterns: [],
          maxFileSizeKb: 128,
        }),
        "utf8"
      );

      const rejected = await runCli(repo, ["config", "validate"]);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stdout).toContain("must stay inside the repository");

      const allowed = await runCli(repo, ["--allow-external-session-dir", "config", "validate"]);
      expect(allowed.exitCode).toBe(0);
      expect(allowed.stdout).toContain("explicitly allowed");

      const session = await createSession(repo, { ...DEFAULT_CONFIG, sessionDir: sessionRoot });
      const run = await runCli(repo, ["--allow-external-session-dir", "run", "--", process.execPath, "--version"]);
      expect(run.exitCode).toBe(0);
      await expect(readCommandEvents(session.sessionDir)).resolves.toContainEqual(
        expect.objectContaining({ exitCode: 0 })
      );
    } finally {
      await removeTempDir(repo);
      await removeTempDir(externalDir);
    }
  }, 15_000);

  it("records a full init/start/run/stop/report flow in a Git repository", async () => {
    const repo = await createTempDir("abb-e2e-");
    try {
      initGitRepo(repo);

      const init = await runCli(repo, ["init"]);
      expect(init.stdout).toContain("Created .agentblackbox.json");
      await writeFile(path.join(repo, ".env"), "APP_MODE=test\n", "utf8");

      const configValidate = await runCli(repo, ["config", "validate"]);
      expect(configValidate.exitCode).toBe(0);
      expect(configValidate.stdout).toContain("Result: valid");

      const doctor = await runCli(repo, ["doctor"]);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stdout).toContain("Result: ready");

      const watcher = spawnCli(repo, ["start"]);
      spawnedProcesses.push(watcher);
      await waitForOutput(watcher, "Agent Black Box session started");

      await writeFile(path.join(repo, "notes.md"), "# Notes\n\nhello\n", "utf8");
      await mkdir(path.join(repo, "packages", "app"), { recursive: true });
      execFileSync("git", ["add", "notes.md"], { cwd: repo });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Agent Black Box Tests",
          "-c",
          "user.email=tests@example.invalid",
          "commit",
          "-m",
          "add notes",
        ],
        { cwd: repo }
      );

      const command = await runCli(repo, [
        "run",
        "--cwd",
        "packages/app",
        "--label",
        "node-version",
        "--group",
        "validation",
        "--phase",
        "smoke",
        "--",
        "node",
        "--version",
      ]);
      expect(command.exitCode).toBe(0);
      expect(command.stdout).toContain(process.version);

      const stop = await runCli(repo, ["stop"]);
      expect(stop.stdout).toContain("Session stopped");
      await waitForExit(watcher);

      const timeline = await runCli(repo, ["timeline"]);
      expect(timeline.stdout).toContain("node --version");
      expect(timeline.stdout).toContain("[node-version]");
      expect(timeline.stdout).toContain("group `validation`");
      expect(timeline.stdout).toContain("phase `smoke`");
      expect(timeline.stdout).toContain("packages/app");
      expect(timeline.stdout).toContain("notes.md");

      const commands = await runCli(repo, ["commands"]);
      expect(commands.stdout).toContain("Recorded commands");
      expect(commands.stdout).toContain("node --version");
      expect(commands.stdout).toContain("### validation");

      const summary = await runCli(repo, ["summary"]);
      expect(summary.stdout).toContain("Agent Black Box Summary");
      expect(summary.stdout).toContain("Final worktree changed files:");

      const risks = await runCli(repo, ["risks"]);
      expect(risks.stdout).toContain("No possible secrets were detected");

      const filteredRisks = await runCli(repo, ["risks", "--min-severity", "high", "--json"]);
      expect(JSON.parse(filteredRisks.stdout)).toMatchObject({ risks: [] });

      const rollback = await runCli(repo, ["rollback"]);
      expect(rollback.stdout).toContain("does not automatically revert");

      const exportPath = path.join(repo, "abb-export.md");
      const exported = await runCli(repo, ["export", "--output", exportPath]);
      expect(exported.stdout).toContain("Export written");
      expect(await readFile(exportPath, "utf8")).toContain("Agent Black Box Summary");

      const report = await runCli(repo, ["report"]);
      const session = JSON.parse(report.stdout) as {
        id: string;
        sessionDir: string;
        baseline: { capturedAt: string } | null;
        changeEvidence: {
          baselineAvailable: boolean;
          committedChanges: Array<{ path: string; status: string }>;
          files: Array<{ path: string; atStart: boolean | null; observedDuringSession: boolean }>;
        };
        commands: Array<{ group?: string; phase?: string }>;
        git: { changedFiles: Array<{ path: string }> };
        risks: Array<{ path: string }>;
      };
      expect(session.baseline).not.toBeNull();
      expect(session.changeEvidence.baselineAvailable).toBe(true);
      expect(session.changeEvidence.files).toContainEqual(expect.objectContaining({ path: ".env", atStart: true }));
      expect(session.changeEvidence.files).toContainEqual(
        expect.objectContaining({ path: "notes.md", atStart: false, observedDuringSession: true })
      );
      expect(session.changeEvidence.committedChanges).toContainEqual({ path: "notes.md", status: "added" });
      expect(session.commands).toHaveLength(1);
      expect(session.commands[0]).toMatchObject({ group: "validation", phase: "smoke" });
      expect(session.git.changedFiles.some((file) => file.path === "notes.md")).toBe(false);
      expect(session.risks.some((risk) => risk.path === ".env")).toBe(false);

      await expect(readFile(path.join(session.sessionDir, "session-metadata.json"), "utf8")).resolves.toContain(
        `"id": "${session.id}"`
      );

      const secondWatcher = spawnCli(repo, ["start"]);
      spawnedProcesses.push(secondWatcher);
      await waitForOutput(secondWatcher, "Agent Black Box session started");
      await writeFile(path.join(repo, "second.md"), "# Second session\n", "utf8");
      const secondStop = await runCli(repo, ["stop"]);
      expect(secondStop.stdout).toContain("Session stopped");
      await waitForExit(secondWatcher);

      const sessionsList = await runCli(repo, ["sessions", "list", "--json"]);
      const catalog = JSON.parse(sessionsList.stdout) as Array<{ id: string; state: string; latest: boolean }>;
      expect(catalog).toHaveLength(2);
      expect(catalog.every((entry) => entry.state === "complete")).toBe(true);
      const latest = catalog.find((entry) => entry.latest);
      expect(latest?.id).not.toBe(session.id);

      const filteredHistory = await runCli(repo, ["sessions", "list", "--file", "notes.md", "--json"]);
      expect(JSON.parse(filteredHistory.stdout)).toMatchObject([{ id: session.id, latest: false }]);
      const commandHistory = await runCli(repo, ["sessions", "list", "--command", "node --version", "--json"]);
      expect(JSON.parse(commandHistory.stdout)).toMatchObject([{ id: session.id }]);
      const browseWithoutTerminal = await runCli(repo, ["sessions", "browse"]);
      expect(browseWithoutTerminal.exitCode).not.toBe(0);
      expect(browseWithoutTerminal.stderr).toContain("interactive terminal");
      const prunePreview = await runCli(repo, ["sessions", "prune", "--before", "2099-01-01"]);
      expect(prunePreview.stdout).toContain(session.id);
      expect(prunePreview.stdout).toContain("1 session(s) eligible");
      const pruneWithoutTerminal = await runCli(repo, ["sessions", "prune", "--before", "2099-01-01", "--apply"]);
      expect(pruneWithoutTerminal.exitCode).not.toBe(0);
      expect(pruneWithoutTerminal.stderr).toContain("interactive terminal");
      const archivePreview = await runCli(repo, [
        "sessions",
        "archive",
        "--before",
        "2099-01-01",
        "--to",
        ".agent-black-box/archive",
      ]);
      expect(archivePreview.stdout).toContain("1 session(s) eligible for archival");
      expect(archivePreview.stdout).toContain("Original sessions remain in place");
      const archiveWithoutTerminal = await runCli(repo, [
        "sessions",
        "archive",
        "--before",
        "2099-01-01",
        "--to",
        ".agent-black-box/archive",
        "--apply",
      ]);
      expect(archiveWithoutTerminal.exitCode).not.toBe(0);
      expect(archiveWithoutTerminal.stderr).toContain("interactive terminal");

      const firstPrefix = session.id.slice(0, -2);
      const selectedSummary = await runCli(repo, ["summary", "--session", firstPrefix]);
      expect(selectedSummary.stdout).toContain(`Session ID: \`${session.id}\``);
      const selectedReport = await runCli(repo, ["report", "--session", firstPrefix]);
      expect(JSON.parse(selectedReport.stdout)).toMatchObject({ id: session.id });
      const selectedCommands = await runCli(repo, ["commands", "--session", firstPrefix]);
      expect(selectedCommands.stdout).toContain("node --version");
      const selectedTimeline = await runCli(repo, ["timeline", "--session", firstPrefix]);
      expect(selectedTimeline.stdout).toContain("notes.md");
      const selectedRisks = await runCli(repo, ["risks", "--session", firstPrefix, "--json"]);
      expect(JSON.parse(selectedRisks.stdout)).toMatchObject({ riskSummary: { score: 0 }, risks: [] });
      const selectedRollback = await runCli(repo, ["rollback", "--session", firstPrefix]);
      expect(selectedRollback.stdout).toContain("Agent Black Box Rollback Hints");
      const selectedExportPath = path.join(repo, "selected-session.md");
      const selectedExport = await runCli(repo, ["export", "--session", firstPrefix, "--output", selectedExportPath]);
      expect(selectedExport.stdout).toContain("Export written");
      expect(await readFile(selectedExportPath, "utf8")).toContain(`Session ID: \`${session.id}\``);
      const selectedShow = await runCli(repo, ["sessions", "show", firstPrefix, "--json"]);
      expect(JSON.parse(selectedShow.stdout)).toMatchObject({ id: session.id });

      const comparisonResult = await runCli(repo, ["sessions", "compare", session.id, latest!.id, "--json"]);
      const comparison = JSON.parse(comparisonResult.stdout) as {
        files: { onlyInFrom: Array<{ path: string }>; onlyInTo: Array<{ path: string }> };
        commands: { fromCount: number; toCount: number };
      };
      expect(comparison.files.onlyInFrom.map((file) => file.path)).toContain("notes.md");
      expect(comparison.files.onlyInTo.map((file) => file.path)).toContain("second.md");
      expect(comparison.commands).toMatchObject({ fromCount: 1, toCount: 0 });

      const oldRollbackApply = await runCli(repo, ["rollback", "--apply", "--session", session.id]);
      expect(oldRollbackApply.exitCode).toBe(1);
      expect(oldRollbackApply.stderr).toContain("only supports the latest completed session");
    } finally {
      await removeTempDir(repo);
    }
  }, 120_000);
});

function runCli(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", tsxLoader, cliPath, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: typeof error?.code === "number" ? error.code : 0,
      });
    });
  });
}

function spawnCli(cwd: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
    cwd,
    stdio: "pipe",
  });
}

function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for output: ${expected}\n${output}`)), 15_000);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Process exited with ${code} while waiting for output: ${expected}\n${output}`));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for CLI process to exit.")), 15_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }

  child.kill("SIGTERM");
  return waitForExit(child).catch(() => undefined);
}
