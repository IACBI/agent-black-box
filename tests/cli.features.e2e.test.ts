import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, inject } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { appendFileEvent, appendFileEvents, createSession, finalizeSession } from "../src/session/sessionManager.js";
import type { AgentBlackBoxConfig, SessionReport } from "../src/types.js";
import { runCli } from "./cliRunner.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => removeTempDir(dir)));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await createTempDir(prefix);
  cleanup.push(dir);
  return dir;
}

async function gitRepo(prefix: string): Promise<string> {
  const repo = await tempDir(prefix);
  initGitRepo(repo);
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["config", "user.email", "test@example.test"]);
  return repo;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function writeConfig(repo: string, extra: Record<string, unknown>): Promise<AgentBlackBoxConfig> {
  const config = { ...DEFAULT_CONFIG, ...extra } as AgentBlackBoxConfig;
  await writeFile(path.join(repo, ".agentblackbox.json"), JSON.stringify(config, null, 2));
  return config;
}

async function recordSession(
  repo: string,
  config: AgentBlackBoxConfig,
  files: Record<string, string>
): Promise<SessionReport> {
  const session = await createSession(repo, config);
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, relativePath)), { recursive: true });
    await writeFile(path.join(repo, relativePath), content);
    await appendFileEvent(session, { timestamp: new Date().toISOString(), eventType: "add", path: relativePath });
  }
  return finalizeSession(session, config, "test");
}

const secretLine = 'const apiKey = "test_credential_value_987654321";\n';
const toShellPath = (value: string): string => value.replace(/\\/g, "/");

describe("abb hook (installed hook runs the compiled CLI)", () => {
  async function shimDirectory(): Promise<string> {
    const bin = await tempDir("abb-shim-");
    const cli = toShellPath(path.join(inject("abbE2eDistDir"), "cli.js"));
    const script = `#!/bin/sh\nexec "${toShellPath(process.execPath)}" "${cli}" "$@"\n`;
    await writeFile(path.join(bin, "abb"), script);
    chmodSync(path.join(bin, "abb"), 0o755);
    return bin;
  }

  function commitEnvironment(bin: string): NodeJS.ProcessEnv {
    const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    return { ...process.env, [pathKey]: [bin, process.env[pathKey] ?? ""].join(path.delimiter) };
  }

  async function commit(repo: string, env: NodeJS.ProcessEnv, name: string, content: string): Promise<void> {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), content);
    git(repo, ["add", "--", name]);
    await execFileAsync("git", ["commit", "-m", `add ${name}`], { cwd: repo, env });
  }

  it("installs, reports status, blocks a new secret, honours the allowlist, and uninstalls", async () => {
    const repo = await gitRepo("abb-hook-e2e-");
    const env = commitEnvironment(await shimDirectory());

    const absent = await runCli(repo, ["hook", "status"]);
    expect(absent.exitCode).toBe(0);
    expect(absent.stdout).toContain("Pre-commit hook: not installed");

    const installed = await runCli(repo, ["hook", "install"]);
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toContain("Installed pre-commit hook");
    expect(installed.stdout).toContain("Policy: new-secrets");
    const again = await runCli(repo, ["hook", "install"]);
    expect(again.stdout).toContain("already up to date");
    const status = await runCli(repo, ["hook", "status"]);
    expect(status.stdout).toContain("installed (managed by abb)");

    await commit(repo, env, "clean.txt", "nothing to see\n");
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    await expect(commit(repo, env, "src/leak.js", secretLine)).rejects.toMatchObject({ code: 1 });
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(head);
    git(repo, ["reset", "--quiet", "--", "src/leak.js"]);

    await writeConfig(repo, {
      secretAllowlist: [{ path: "vendor/fixtures", reason: "synthetic credentials shipped with the fixtures" }],
    });
    await commit(repo, env, "vendor/fixtures/leak.js", secretLine);
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).not.toBe(head);

    const removed = await runCli(repo, ["hook", "uninstall"]);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain("Removed pre-commit hook");
    expect((await runCli(repo, ["hook", "status"])).stdout).toContain("not installed");
    await commit(repo, env, "src/leak.js", secretLine);
  }, 120_000);

  it("refuses to replace a hook it did not write, and never removes it", async () => {
    const repo = await gitRepo("abb-hook-foreign-");
    const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeFile(hookPath, "#!/bin/sh\necho custom\n");

    const refused = await runCli(repo, ["hook", "install"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("did not create");
    const uninstall = await runCli(repo, ["hook", "uninstall"]);
    expect(uninstall.exitCode).toBe(1);
    expect(uninstall.stdout).toContain("was not installed by abb");
    expect(await readFile(hookPath, "utf8")).toBe("#!/bin/sh\necho custom\n");

    const forced = await runCli(repo, ["hook", "install", "--force"]);
    expect(forced.exitCode).toBe(0);
    expect(forced.stdout).toContain("Previous hook saved to");
    expect(await readFile(`${hookPath}.pre-abb`, "utf8")).toBe("#!/bin/sh\necho custom\n");
    expect((await runCli(repo, ["hook", "uninstall"])).stdout).toContain("Restored previous hook");
    expect(await readFile(hookPath, "utf8")).toBe("#!/bin/sh\necho custom\n");
  }, 60_000);

  it("rejects a policy name that could reach the shell, without writing anything", async () => {
    const repo = await gitRepo("abb-hook-policy-");
    const result = await runCli(repo, ["hook", "install", "--policy", "x; touch pwned"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid policy name");
    expect(existsSync(path.join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
  }, 60_000);

  it.each(["absent", "managed", "foreign"] as const)(
    "preserves %s hooks when the selected policy or configuration is invalid",
    async (state) => {
      const repo = await gitRepo("abb-hook-invalid-");
      const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
      if (state === "managed") {
        expect((await runCli(repo, ["hook", "install"])).exitCode).toBe(0);
      } else if (state === "foreign") {
        await mkdir(path.dirname(hookPath), { recursive: true });
        await writeFile(hookPath, "#!/bin/sh\necho original\n");
      }
      const original = state === "absent" ? undefined : await readFile(hookPath, "utf8");
      const unknown = await runCli(repo, ["hook", "install", "--policy", "missing-profile", "--force"]);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("--policy must be one of:");
      expect(unknown.stdout).toBe("");
      if (original === undefined) {
        expect(existsSync(hookPath)).toBe(false);
      } else {
        await expect(readFile(hookPath, "utf8")).resolves.toBe(original);
      }
      expect(existsSync(`${hookPath}.pre-abb`)).toBe(false);

      await writeConfig(repo, { analysisPolicies: { team: { minSeverity: "urgent" } } });
      const invalid = await runCli(repo, ["hook", "install", "--force"]);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("Invalid Agent Black Box config");
      expect(invalid.stdout).toBe("");
      if (original === undefined) {
        expect(existsSync(hookPath)).toBe(false);
      } else {
        await expect(readFile(hookPath, "utf8")).resolves.toBe(original);
      }
      expect(existsSync(`${hookPath}.pre-abb`)).toBe(false);
    },
    60_000
  );

  it("installs a configured policy and enforces it on subsequent commits", async () => {
    const repo = await gitRepo("abb-hook-custom-policy-");
    const env = commitEnvironment(await shimDirectory());
    await writeConfig(repo, {
      analysisPolicies: {
        "team-review": { minSeverity: "medium", categories: ["CI/CD file"], failOnNewSecrets: false },
      },
    });
    const installed = await runCli(repo, ["hook", "install", "--policy", "team-review"]);
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toContain("Policy: team-review");
    await expect(commit(repo, env, "first.js", secretLine)).rejects.toMatchObject({ code: 1 });
    git(repo, ["rm", "--cached", "--quiet", "--", "first.js"]);
    await commit(repo, env, "clean.txt", "nothing to see\n");
    const head = git(repo, ["rev-parse", "HEAD"]).trim();

    await expect(commit(repo, env, ".github/workflows/build.yml", "name: Build\n")).rejects.toMatchObject({
      code: 1,
    });
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(head);
    git(repo, ["reset", "--quiet", "--", ".github/workflows/build.yml"]);
    await commit(repo, env, "docs.md", "Documentation update\n");
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).not.toBe(head);
  }, 120_000);

  it("persists external storage authorization only when explicitly requested", async () => {
    const repo = await gitRepo("abb-hook-external-config-");
    const external = await tempDir("abb-hook-external-storage-");
    await writeConfig(repo, { sessionDir: external });
    const refused = await runCli(repo, ["hook", "install"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("sessionDir must stay inside the repository");
    const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
    expect(existsSync(hookPath)).toBe(false);

    const installed = await runCli(repo, ["--allow-external-session-dir", "hook", "install"]);
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout).toContain("External session storage: explicitly allowed");
    expect(await readFile(hookPath, "utf8")).toContain("exec abb --allow-external-session-dir analyze");
    expect((await runCli(repo, ["hook", "status"])).stdout).toContain("External session storage: explicitly allowed");
    const env = commitEnvironment(await shimDirectory());
    await commit(repo, env, "clean.txt", "first commit\n");
    await commit(repo, env, "second.txt", "second commit\n");
    const head = git(repo, ["rev-parse", "HEAD"]).trim();
    await expect(commit(repo, env, "settings.ts", secretLine)).rejects.toMatchObject({ code: 1 });
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(head);
  }, 60_000);

  it("enforces the selected policy on an initial commit only with an explicit opt-in", async () => {
    const repo = await gitRepo("abb-hook-initial-policy-");
    await writeConfig(repo, {
      analysisPolicies: {
        "team-review": { minSeverity: "medium", categories: ["CI/CD file"], failOnNewSecrets: false },
      },
    });
    const invalid = await runCli(repo, ["hook", "install", "--first-commit", "unknown"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain("--first-commit must be high or policy");
    expect(existsSync(path.join(repo, ".git", "hooks", "pre-commit"))).toBe(false);
    const installed = await runCli(repo, ["hook", "install", "--policy", "team-review", "--first-commit", "policy"]);
    expect(installed.exitCode).toBe(0);
    expect((await runCli(repo, ["hook", "status"])).stdout).toContain("First commit: selected policy");
    const env = commitEnvironment(await shimDirectory());
    await expect(commit(repo, env, ".github/workflows/build.yml", "name: Build\n")).rejects.toMatchObject({ code: 1 });
    git(repo, ["rm", "--cached", "--quiet", "--", ".github/workflows/build.yml"]);
    await commit(repo, env, "clean.txt", "first commit\n");
    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toMatch(/^[a-f0-9]{40,64}$/);
  }, 60_000);

  it("analyzes initial staged content without a fake baseline and refuses established HEADs", async () => {
    const repo = await gitRepo("abb-initial-analysis-");
    await writeFile(path.join(repo, "settings.ts"), secretLine);
    git(repo, ["add", "--", "settings.ts"]);
    const result = await runCli(repo, [
      "analyze",
      "--staged",
      "--initial",
      "--policy",
      "new-secrets",
      "--format",
      "json",
    ]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({
      initialCommitAnalysis: true,
      policyEvaluation: { failed: true, newSecretCount: 1 },
    });
    expect(parsed).not.toHaveProperty("baselineComparison");
    expect(result.stdout).not.toContain("test_credential_value_987654321");
    for (const args of [
      ["--initial"],
      ["--initial", "--staged", "--baseline", "HEAD"],
      ["--initial", "--staged", "--baseline", ""],
    ]) {
      const invalid = await runCli(repo, ["analyze", ...args]);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("--initial requires --staged and cannot be combined with --baseline");
      expect(invalid.stdout).toBe("");
    }
    git(repo, ["commit", "-qm", "baseline"]);
    const established = await runCli(repo, ["analyze", "--staged", "--initial", "--policy", "new-secrets"]);
    expect(established.exitCode).toBe(1);
    expect(established.stderr).toContain("requires a repository without a HEAD commit");
    expect(established.stdout).toBe("");
  }, 60_000);
});

describe("budgeted session history", () => {
  it("preserves small reports and fails visibly on oversized report and search fallbacks", async () => {
    const repo = await gitRepo("abb-history-budget-");
    const config = await writeConfig(repo, {});
    const small = await recordSession(repo, config, { "small.txt": "small session\n" });
    const session = await createSession(repo, config);
    await appendFileEvents(
      session,
      Array.from({ length: 12_000 }, (_, index) => ({
        timestamp: session.startedAt,
        eventType: "change" as const,
        path: `src/bulk/module-${index}/settings.ts`,
      }))
    );
    const large = await finalizeSession(session, config, "test");
    const reportPath = path.join(session.sessionDir, "session.json");
    expect((await stat(reportPath)).size).toBeGreaterThan(2 * 1024 * 1024);
    const original = await readFile(reportPath, "utf8");

    const list = await runCli(repo, ["sessions", "list", "--json", "--memory-budget-mb", "8"]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).map((entry: { id: string }) => entry.id)).toEqual(
      expect.arrayContaining([small.id, large.id])
    );
    const showSmall = await runCli(repo, ["sessions", "show", small.id, "--json", "--memory-budget-mb", "8"]);
    expect(showSmall.exitCode).toBe(0);
    expect(JSON.parse(showSmall.stdout).id).toBe(small.id);
    const limited = await runCli(repo, ["sessions", "show", large.id, "--json", "--memory-budget-mb", "8"]);
    expect(limited.exitCode).toBe(1);
    expect(limited.stderr).toContain("working-data policy");
    expect(limited.stdout).toBe("");
    const allowed = await runCli(repo, ["sessions", "show", large.id, "--json", "--memory-budget-mb", "64"]);
    expect(allowed.exitCode).toBe(0);
    expect(JSON.parse(allowed.stdout).events).toHaveLength(12_000);
    const compared = await runCli(repo, [
      "sessions",
      "compare",
      small.id,
      large.id,
      "--json",
      "--memory-budget-mb",
      "8",
    ]);
    expect(compared.exitCode).toBe(1);
    expect(compared.stderr).toContain("working-data policy");
    expect(compared.stdout).toBe("");
    await rm(path.join(session.sessionDir, "session-search.json"));
    const search = await runCli(repo, [
      "sessions",
      "list",
      "--file",
      "settings.ts",
      "--json",
      "--memory-budget-mb",
      "8",
    ]);
    expect(search.exitCode).toBe(1);
    expect(search.stderr).toContain("working-data policy");
    expect(search.stdout).toBe("");
    const invalid = await runCli(repo, ["sessions", "list", "--memory-budget-mb", "7"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(await readFile(reportPath, "utf8")).toBe(original);
  }, 60_000);
});

describe("session exports for pull requests and code scanning", () => {
  it("prints a pull request comment and writes it to a file only once without --force", async () => {
    const repo = await gitRepo("abb-pr-comment-");
    const config = await writeConfig(repo, {});
    const report = await recordSession(repo, config, {
      "src/settings.ts": secretLine,
      ".github/workflows/ci.yml": "on: push\n",
    });

    const result = await runCli(repo, ["pr-comment"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n")[0]).toBe("<!-- agent-black-box:session-summary -->");
    expect(result.stdout).toContain("settings.ts");
    expect(result.stdout).toContain("ci.yml");
    expect(result.stdout).not.toContain("test_credential_value_987654321");
    // The comment shortens the trailing 36-character UUID to its first 8 characters.
    expect(result.stdout).toContain("`" + report.id.slice(0, report.id.length - 28) + "`");

    const target = path.join(repo, "comment.md");
    const written = await runCli(repo, ["pr-comment", "--output", target]);
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toContain("Pull request comment written to");
    expect(await readFile(target, "utf8")).toBe(result.stdout);
    const second = await runCli(repo, ["pr-comment", "--output", target]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("--force");
    expect((await runCli(repo, ["pr-comment", "--output", target, "--force"])).exitCode).toBe(0);
  }, 60_000);

  it("exports a SARIF log whose findings match the session and never contain the secret", async () => {
    const repo = await gitRepo("abb-sarif-export-");
    const config = await writeConfig(repo, {});
    await recordSession(repo, config, { "src/settings.ts": secretLine, ".github/workflows/ci.yml": "on: push\n" });

    const result = await runCli(repo, ["export", "--format", "sarif"]);
    expect(result.exitCode).toBe(0);
    const log = JSON.parse(result.stdout) as {
      version: string;
      runs: Array<{ results: Array<{ ruleId: string; level: string }>; properties: { sessionId: string } }>;
    };
    expect(log.version).toBe("2.1.0");
    const ruleIds = log.runs[0].results.map((entry) => entry.ruleId);
    expect(ruleIds).toContain("possible-secret");
    expect(ruleIds.some((id) => id.startsWith("session-risk:"))).toBe(true);
    expect(result.stdout).not.toContain("test_credential_value_987654321");

    const filtered = JSON.parse((await runCli(repo, ["export", "--format", "sarif", "--min-severity", "high"])).stdout);
    expect(filtered.runs[0].results.some((entry: { ruleId: string }) => entry.ruleId === "possible-secret")).toBe(true);

    const unknown = await runCli(repo, ["export", "--format", "xml"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Export format must be one of");

    const output = path.join(repo, "session.sarif");
    expect((await runCli(repo, ["export", "--format", "sarif", "--output", output])).exitCode).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8")).version).toBe("2.1.0");
  }, 60_000);
});

describe("custom secret patterns and the allowlist through the CLI", () => {
  const rules = {
    secretPatterns: [{ name: "Internal service token", pattern: "corp_[a-z0-9]{16}" }],
    secretAllowlist: [{ path: "tests/fixtures", reason: "synthetic credentials used by the tests" }],
  };

  it("analyzes with the configured patterns, hides allowlisted files, and counts what it hid", async () => {
    const repo = await gitRepo("abb-rules-cli-");
    await writeConfig(repo, rules);
    await mkdir(path.join(repo, "tests", "fixtures"), { recursive: true });
    await writeFile(path.join(repo, "src.ts"), 'export const id = "corp_0123456789abcdef";\n');
    await writeFile(path.join(repo, "tests", "fixtures", "seed.ts"), 'export const id = "corp_0123456789abcdef";\n');

    const json = await runCli(repo, ["analyze", "--format", "json"]);
    expect(json.exitCode).toBe(0);
    const result = JSON.parse(json.stdout) as {
      findings: Array<{ path: string; kind: string }>;
      secretAllowlist: { suppressedFindings: number };
    };
    expect(
      result.findings.filter((finding) => finding.kind === "possible-secret").map((finding) => finding.path)
    ).toEqual(["src.ts"]);
    expect(result.secretAllowlist).toEqual({ suppressedFindings: 1 });
    expect(json.stdout).not.toContain("corp_0123456789abcdef");

    const text = await runCli(repo, ["analyze"]);
    expect(text.stdout).toContain("Secret findings hidden by the configured allowlist: 1.");
    expect((await runCli(repo, ["analyze", "--fail-on", "high"])).exitCode).toBe(1);

    await writeFile(path.join(repo, "src.ts"), "export const id = 1;\n");
    expect((await runCli(repo, ["analyze", "--fail-on", "low"])).exitCode).toBe(0);
  }, 60_000);

  it("treats an unsafe pattern as a configuration error instead of scanning without it", async () => {
    const repo = await gitRepo("abb-rules-invalid-");
    await writeConfig(repo, { secretPatterns: [{ name: "Bad", pattern: "(a+)+b" }] });

    const analyze = await runCli(repo, ["analyze"]);
    expect(analyze.exitCode).toBe(1);
    expect(analyze.stderr).toContain("nest quantifiers");
    const validate = await runCli(repo, ["config", "validate"]);
    expect(validate.exitCode).toBe(1);
    expect(validate.stdout).toContain("Result: invalid");
  }, 60_000);
});

describe("archive destination from repository configuration", () => {
  it("refuses a configured destination outside the repository but accepts an explicit --to", async () => {
    const repo = await gitRepo("abb-archive-config-");
    const external = await tempDir("abb-archive-external-");
    await writeConfig(repo, { retention: { archiveDir: external } });

    const refused = await runCli(repo, ["sessions", "archive", "--before", "2099-01-01"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("retention.archiveDir must stay inside the repository");

    const explicit = await runCli(repo, ["sessions", "archive", "--before", "2099-01-01", "--to", external]);
    expect(explicit.exitCode).toBe(0);
    expect(explicit.stdout).toContain("0 session(s) eligible for archival");
  }, 60_000);

  it("accepts a configured destination inside the repository", async () => {
    const repo = await gitRepo("abb-archive-inside-");
    await writeConfig(repo, { retention: { archiveDir: ".agent-black-box/archive" } });

    const preview = await runCli(repo, ["sessions", "archive", "--before", "2099-01-01"]);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("Archive destination: .agent-black-box/archive");
  }, 60_000);
});

describe("version", () => {
  it("reports the version declared in package.json", async () => {
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { version: string };
    const cwd = await tempDir("abb-version-");
    const result = await runCli(cwd, ["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  }, 60_000);
  it("offers structured config, hook status and file output for analysis", async () => {
    const repo = await gitRepo("abb-json-e2e-");

    const config = await runCli(repo, ["config", "validate", "--json"]);
    expect(config.exitCode).toBe(0);
    expect(JSON.parse(config.stdout)).toMatchObject({ exists: false, valid: true, errors: [] });

    await writeFile(path.join(repo, ".agentblackbox.json"), "{ not json");
    const malformed = await runCli(repo, ["config", "validate", "--json"]);
    expect(malformed.exitCode).toBe(1);
    expect(JSON.parse(malformed.stdout)).toMatchObject({ valid: false, errors: [expect.stringContaining("parse")] });
    await rm(path.join(repo, ".agentblackbox.json"));

    const hook = await runCli(repo, ["hook", "status", "--json"]);
    expect(hook.exitCode).toBe(0);
    expect(JSON.parse(hook.stdout)).toMatchObject({ state: "absent" });

    await writeFile(path.join(repo, "note.txt"), "plain text\n");
    const output = path.join(repo, "out", "analysis.json");
    await mkdir(path.dirname(output));
    const written = await runCli(repo, ["analyze", "--format", "json", "--output", output]);
    expect(written.exitCode).toBe(0);
    expect(written.stdout).toContain("Analysis written to");
    expect(JSON.parse(await readFile(output, "utf8"))).toHaveProperty("summary");

    const refused = await runCli(repo, ["analyze", "--format", "json", "--output", output]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("Refusing to overwrite");
    const forced = await runCli(repo, ["analyze", "--format", "json", "--output", output, "--force"]);
    expect(forced.exitCode).toBe(0);
  }, 60_000);
});
