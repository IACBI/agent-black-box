import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitExecutable } from "../src/git/executable.js";
import {
  HOOK_MARKER,
  buildPreCommitHookScript,
  getPreCommitHookStatus,
  installPreCommitHook,
  renderHookInstallResult,
  renderHookStatus,
  renderHookUninstallResult,
  uninstallPreCommitHook,
  type HookInstallOptions,
} from "../src/hooks/preCommitHook.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";

function runGit(cwd: string, args: string[]): string {
  return execFileSync(gitExecutable(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function configureIdentity(repo: string): void {
  runGit(repo, ["config", "user.name", "Hook Tester"]);
  runGit(repo, ["config", "user.email", "hook-tester@example.invalid"]);
  runGit(repo, ["config", "commit.gpgsign", "false"]);
}

function commitFile(repo: string, name: string): void {
  writeFileSync(path.join(repo, name), `${name}\n`);
  runGit(repo, ["add", name]);
  runGit(repo, ["commit", "-m", `add ${name}`]);
}

function gitConfigPath(value: string): string {
  return value.replace(/\\/g, "/");
}

const canCreateSymlinks = ((): boolean => {
  const probeDirectory = path.join(os.tmpdir(), `abb-symlink-probe-${process.pid}`);
  try {
    mkdirSync(probeDirectory, { recursive: true });
    writeFileSync(path.join(probeDirectory, "target"), "x");
    symlinkSync(path.join(probeDirectory, "target"), path.join(probeDirectory, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probeDirectory, { recursive: true, force: true });
  }
})();

describe("managed pre-commit hook", () => {
  let repo: string;
  const extraDirs: string[] = [];

  beforeEach(async () => {
    repo = await createTempDir("abb-hook-");
    initGitRepo(repo);
    configureIdentity(repo);
  });

  afterEach(async () => {
    await removeTempDir(repo);
    for (const dir of extraDirs.splice(0)) {
      await removeTempDir(dir);
    }
  });

  async function extraTempDir(prefix: string): Promise<string> {
    const dir = await createTempDir(prefix);
    extraDirs.push(dir);
    return dir;
  }

  function defaultHookPath(): string {
    return path.join(realpathSync.native(repo), ".git", "hooks", "pre-commit");
  }

  it("builds a POSIX sh script with markers, the policy and LF endings only", () => {
    const script = buildPreCommitHookScript("new-secrets");
    const lines = script.split("\n");
    expect(lines[0]).toBe("#!/bin/sh");
    expect(lines[1]).toBe(HOOK_MARKER);
    expect(lines[2]).toBe("# agent-black-box policy: new-secrets");
    expect(script).not.toContain("\r");
    expect(script).toContain("command -v abb");
    expect(script).toContain("exec abb analyze --staged --baseline HEAD --policy new-secrets");
    expect(script).toContain("exec abb analyze --staged --fail-on high");
    expect(script.endsWith("\n")).toBe(true);
  });

  it("keeps default scripts unchanged and persists only explicit hook opt-ins", () => {
    const defaultScript = buildPreCommitHookScript("new-secrets");
    expect(buildPreCommitHookScript("new-secrets", { allowExternalSessionDir: false, firstCommit: "high" })).toBe(
      defaultScript
    );
    expect(defaultScript).not.toContain("--allow-external-session-dir");
    expect(defaultScript).not.toContain("--initial");

    const optedIn = buildPreCommitHookScript("team-review", { allowExternalSessionDir: true, firstCommit: "policy" });
    expect(optedIn.split("\n").slice(0, 5)).toEqual([
      "#!/bin/sh",
      HOOK_MARKER,
      "# agent-black-box policy: team-review",
      "# agent-black-box allow-external-session-dir: true",
      "# agent-black-box first-commit: policy",
    ]);
    expect(optedIn).toContain(
      "exec abb --allow-external-session-dir analyze --staged --baseline HEAD --policy team-review"
    );
    expect(optedIn).toContain("exec abb --allow-external-session-dir analyze --staged --initial --policy team-review");
  });

  it("reports persisted opt-ins, preserves them on identical install, and removes them on default reinstall", async () => {
    const options = { allowExternalSessionDir: true, firstCommit: "policy" as const };
    const installed = await installPreCommitHook(repo, options);
    expect(installed).toEqual({ action: "installed", hookPath: defaultHookPath(), policy: "new-secrets", ...options });
    const status = await getPreCommitHookStatus(repo);
    expect(status).toEqual({ state: "managed", hookPath: installed.hookPath, policy: "new-secrets", ...options });
    expect(renderHookInstallResult(installed)).toContain("External session storage: explicitly allowed");
    expect(renderHookStatus(status)).toContain("First commit: selected policy.");
    await expect(installPreCommitHook(repo, options)).resolves.toMatchObject({ action: "unchanged", ...options });

    await expect(installPreCommitHook(repo)).resolves.toEqual({
      action: "updated",
      hookPath: installed.hookPath,
      policy: "new-secrets",
    });
    await expect(readFile(installed.hookPath, "utf8")).resolves.toBe(buildPreCommitHookScript("new-secrets"));
    await expect(getPreCommitHookStatus(repo)).resolves.toEqual({
      state: "managed",
      hookPath: installed.hookPath,
      policy: "new-secrets",
    });
  });

  it.each([{ allowExternalSessionDir: "true" }, { firstCommit: "policy; touch pwned" }])(
    "rejects invalid opt-in options %j before writing a hook",
    async (options) => {
      await expect(installPreCommitHook(repo, options as unknown as HookInstallOptions)).rejects.toThrow(
        /must be a boolean|must be high or policy/
      );
      expect(existsSync(defaultHookPath())).toBe(false);
    }
  );

  it.each([
    "# agent-black-box allow-external-session-dir: false",
    "# agent-black-box first-commit: unknown",
    "# agent-black-box first-commit: policy\n# agent-black-box first-commit: policy",
  ])("reports invalid or duplicate option metadata as outdated: %s", async (metadata) => {
    const installed = await installPreCommitHook(repo);
    const lines = buildPreCommitHookScript("new-secrets").split("\n");
    lines.splice(3, 0, metadata);
    await writeFile(installed.hookPath, lines.join("\n"));
    await expect(getPreCommitHookStatus(repo)).resolves.toEqual({
      state: "managed-outdated",
      hookPath: installed.hookPath,
      policy: "new-secrets",
    });
  });

  it("installs into a fresh repository", async () => {
    const result = await installPreCommitHook(repo);

    expect(result).toEqual({ action: "installed", hookPath: defaultHookPath(), policy: "new-secrets" });
    const content = await readFile(result.hookPath, "utf8");
    expect(content).toBe(buildPreCommitHookScript("new-secrets"));
    expect(content).toContain(HOOK_MARKER);
    if (!isWindows) {
      expect((await lstat(result.hookPath)).mode & 0o777).toBe(0o755);
    }
    await expect(getPreCommitHookStatus(repo)).resolves.toEqual({
      state: "managed",
      hookPath: result.hookPath,
      policy: "new-secrets",
    });
  });

  it("is idempotent and reports unchanged on a second install", async () => {
    await installPreCommitHook(repo);
    const second = await installPreCommitHook(repo);
    expect(second.action).toBe("unchanged");
    await expect(readFile(second.hookPath, "utf8")).resolves.toBe(buildPreCommitHookScript("new-secrets"));
  });

  // Root can execute a file with another user's execute bit, so 0601 is not a missing permission for root.
  const nonExecutableModes = process.getuid?.() === 0 ? [0o600] : [0o600, 0o601];
  it.skipIf(isWindows).each(nonExecutableModes)(
    "reports missing execute permissions (%i) and repairs them on reinstall",
    async (mode) => {
      const installed = await installPreCommitHook(repo);
      chmodSync(installed.hookPath, mode);

      const status = await getPreCommitHookStatus(repo);
      expect(status).toEqual({ state: "managed-outdated", hookPath: installed.hookPath, policy: "new-secrets" });
      expect(renderHookStatus(status)).toContain("content or permissions need updating");
      await expect(readFile(installed.hookPath, "utf8")).resolves.toBe(buildPreCommitHookScript("new-secrets"));

      await expect(installPreCommitHook(repo)).resolves.toMatchObject({ action: "unchanged" });
      expect((await lstat(installed.hookPath)).mode & 0o777).toBe(0o755);
      await expect(getPreCommitHookStatus(repo)).resolves.toMatchObject({ state: "managed" });
    }
  );

  it("updates the hook when the policy changes and status reflects it", async () => {
    await installPreCommitHook(repo);
    const updated = await installPreCommitHook(repo, { policy: "complete-review" });

    expect(updated.action).toBe("updated");
    expect(updated.policy).toBe("complete-review");
    await expect(readFile(updated.hookPath, "utf8")).resolves.toBe(buildPreCommitHookScript("complete-review"));
    await expect(getPreCommitHookStatus(repo)).resolves.toMatchObject({ state: "managed", policy: "complete-review" });
  });

  it("reports managed-outdated when the marker is present but the content differs", async () => {
    const { hookPath } = await installPreCommitHook(repo, { policy: "ci-review" });
    await writeFile(hookPath, `${buildPreCommitHookScript("ci-review")}# locally edited\n`);

    await expect(getPreCommitHookStatus(repo)).resolves.toEqual({
      state: "managed-outdated",
      hookPath,
      policy: "ci-review",
    });
    await expect(installPreCommitHook(repo, { policy: "ci-review" })).resolves.toMatchObject({ action: "updated" });
    await expect(getPreCommitHookStatus(repo)).resolves.toMatchObject({ state: "managed" });
  });

  it("rejects unsafe policy names before writing anything", async () => {
    for (const policy of ["x; rm -rf /", "$(id)", "`id`", "A", "-x", "a b", "a\nb", "", "a".repeat(65)]) {
      await expect(installPreCommitHook(repo, { policy })).rejects.toThrow(/Invalid policy name/);
      expect(() => buildPreCommitHookScript(policy)).toThrow(/Invalid policy name/);
    }
    expect(existsSync(defaultHookPath())).toBe(false);
    const hooksDirectory = path.join(repo, ".git", "hooks");
    const entries = existsSync(hooksDirectory) ? await readdir(hooksDirectory) : [];
    expect(entries.filter((entry) => entry === "pre-commit" || entry.endsWith(".pre-abb"))).toEqual([]);
  });

  it("refuses a foreign hook, then force backs it up and uninstall restores it byte for byte", async () => {
    const hooksDirectory = path.join(repo, ".git", "hooks");
    await mkdir(hooksDirectory, { recursive: true });
    const hookPath = path.join(hooksDirectory, "pre-commit");
    const original = Buffer.from("#!/bin/sh\r\necho custom é\r\nexit 0\r\n", "utf8");
    await writeFile(hookPath, original);

    await expect(installPreCommitHook(repo)).rejects.toThrow(/did not create/);
    expect(await readFile(hookPath)).toEqual(original);
    await expect(getPreCommitHookStatus(repo)).resolves.toMatchObject({ state: "foreign" });
    await expect(uninstallPreCommitHook(repo)).resolves.toMatchObject({ action: "foreign" });
    expect(await readFile(hookPath)).toEqual(original);

    const forced = await installPreCommitHook(repo, { force: true });
    expect(forced.action).toBe("installed");
    expect(forced.backupPath).toBe(`${defaultHookPath()}.pre-abb`);
    expect(await readFile(`${hookPath}.pre-abb`)).toEqual(original);
    await expect(readFile(hookPath, "utf8")).resolves.toBe(buildPreCommitHookScript("new-secrets"));

    const removed = await uninstallPreCommitHook(repo);
    expect(removed).toMatchObject({ action: "removed", restoredFrom: `${defaultHookPath()}.pre-abb` });
    expect(await readFile(hookPath)).toEqual(original);
    expect(existsSync(`${hookPath}.pre-abb`)).toBe(false);
  });

  it("refuses a forced install when the backup file already exists", async () => {
    const hooksDirectory = path.join(repo, ".git", "hooks");
    await mkdir(hooksDirectory, { recursive: true });
    await writeFile(path.join(hooksDirectory, "pre-commit"), "#!/bin/sh\nexit 0\n");
    await writeFile(path.join(hooksDirectory, "pre-commit.pre-abb"), "older backup\n");

    await expect(installPreCommitHook(repo, { force: true })).rejects.toThrow(/already exists/);
    await expect(readFile(path.join(hooksDirectory, "pre-commit"), "utf8")).resolves.toBe("#!/bin/sh\nexit 0\n");
    await expect(readFile(path.join(hooksDirectory, "pre-commit.pre-abb"), "utf8")).resolves.toBe("older backup\n");
  });

  it("removes a managed hook without a backup and reports absent when nothing is installed", async () => {
    await expect(uninstallPreCommitHook(repo)).resolves.toMatchObject({ action: "absent" });
    await expect(getPreCommitHookStatus(repo)).resolves.toMatchObject({ state: "absent" });

    await installPreCommitHook(repo);
    const removed = await uninstallPreCommitHook(repo);
    expect(removed.action).toBe("removed");
    expect(removed.restoredFrom).toBeUndefined();
    expect(existsSync(removed.hookPath)).toBe(false);
  });

  it("honours a core.hooksPath inside the repository", async () => {
    runGit(repo, ["config", "core.hooksPath", ".githooks"]);

    const result = await installPreCommitHook(repo);

    expect(result.hookPath).toBe(path.join(realpathSync.native(repo), ".githooks", "pre-commit"));
    expect(existsSync(result.hookPath)).toBe(true);
    expect(existsSync(defaultHookPath())).toBe(false);
    await expect(getPreCommitHookStatus(repo)).resolves.toMatchObject({ state: "managed" });
  });

  it("refuses a core.hooksPath outside the repository and writes nothing", async () => {
    const outside = await extraTempDir("abb-hook-outside-");
    runGit(repo, ["config", "core.hooksPath", gitConfigPath(outside)]);

    await expect(installPreCommitHook(repo)).rejects.toThrow(/outside this repository/);
    await expect(uninstallPreCommitHook(repo)).rejects.toThrow(/outside this repository/);
    await expect(getPreCommitHookStatus(repo)).rejects.toThrow(/outside this repository/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("installs into the common hooks directory from a linked worktree", async () => {
    commitFile(repo, "seed.txt");
    const worktreeParent = await extraTempDir("abb-hook-worktree-");
    const worktree = path.join(worktreeParent, "linked");
    runGit(repo, ["worktree", "add", "-b", "linked-branch", gitConfigPath(worktree)]);

    const result = await installPreCommitHook(worktree);

    expect(result.hookPath).toBe(defaultHookPath());
    expect(existsSync(defaultHookPath())).toBe(true);
    await expect(getPreCommitHookStatus(repo)).resolves.toMatchObject({ state: "managed" });
    await expect(uninstallPreCommitHook(worktree)).resolves.toMatchObject({ action: "removed" });
    expect(existsSync(defaultHookPath())).toBe(false);
  });

  it.skipIf(!canCreateSymlinks)("never writes through a symlinked pre-commit", async () => {
    const targetDirectory = await extraTempDir("abb-hook-target-");
    const target = path.join(targetDirectory, "real-hook");
    await writeFile(target, "#!/bin/sh\nexit 0\n");
    const hooksDirectory = path.join(repo, ".git", "hooks");
    await mkdir(hooksDirectory, { recursive: true });
    symlinkSync(target, path.join(hooksDirectory, "pre-commit"));

    await expect(installPreCommitHook(repo, { force: true })).rejects.toThrow(/symbolic link/);
    await expect(uninstallPreCommitHook(repo)).resolves.toMatchObject({ action: "foreign" });
    await expect(getPreCommitHookStatus(repo)).resolves.toMatchObject({ state: "foreign" });
    expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect((await lstat(path.join(hooksDirectory, "pre-commit"))).isSymbolicLink()).toBe(true);
  });

  it("renders terminal-safe summaries", async () => {
    const installed = await installPreCommitHook(repo);
    expect(renderHookInstallResult(installed)).toContain("Installed pre-commit hook");
    expect(renderHookInstallResult({ ...installed, backupPath: "a\u001b[31mb" })).not.toContain("\u001b");
    expect(renderHookStatus(await getPreCommitHookStatus(repo))).toContain("Policy: new-secrets");
    expect(renderHookUninstallResult(await uninstallPreCommitHook(repo))).toContain("Removed pre-commit hook");
    expect(renderHookUninstallResult(await uninstallPreCommitHook(repo))).toContain("No pre-commit hook installed");
  });

  describe("executed by git", () => {
    let binDirectory: string;
    let logPath: string;
    let emptyGlobalConfig: string;

    beforeEach(async () => {
      const scratch = await extraTempDir("abb-hook-run-");
      binDirectory = path.join(scratch, "bin");
      await mkdir(binDirectory);
      logPath = path.join(scratch, "argv.log");
      emptyGlobalConfig = path.join(scratch, "gitconfig");
      await writeFile(emptyGlobalConfig, "");
      await writeFile(logPath, "");
      const fakeAbb = path.join(binDirectory, "abb");
      await writeFile(fakeAbb, '#!/bin/sh\necho "$*" >> "$ABB_FAKE_LOG"\nexit "${ABB_FAKE_EXIT:-0}"\n');
      chmodSync(fakeAbb, 0o755);
      await installPreCommitHook(repo);
    });

    function pathKey(): string {
      return Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    }

    function environment(searchPath: string, exitCode: string): NodeJS.ProcessEnv {
      return {
        ...process.env,
        [pathKey()]: searchPath,
        GIT_CONFIG_GLOBAL: emptyGlobalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        ABB_FAKE_LOG: gitConfigPath(logPath),
        ABB_FAKE_EXIT: exitCode,
      };
    }

    function withFakeAbb(): string {
      return [binDirectory, process.env[pathKey()] ?? ""].join(path.delimiter);
    }

    function withoutAbb(): string {
      const hasAbb = (directory: string): boolean =>
        ["abb", "abb.cmd", "abb.exe", "abb.ps1", "abb.bat"].some((name) => existsSync(path.join(directory, name)));
      return (process.env[pathKey()] ?? "")
        .split(path.delimiter)
        .filter((directory) => directory && !hasAbb(directory))
        .join(path.delimiter);
    }

    async function commit(name: string, env: NodeJS.ProcessEnv): Promise<{ stderr: string }> {
      await writeFile(path.join(repo, name), `${name}\n`);
      runGit(repo, ["add", name]);
      const { stderr } = await execFileAsync(gitExecutable(), ["commit", "-m", `add ${name}`], { cwd: repo, env });
      return { stderr };
    }

    it("runs abb with the right arguments and blocks commits when it fails", async () => {
      await commit("first.txt", environment(withFakeAbb(), "0"));
      const headAfterFirst = runGit(repo, ["rev-parse", "HEAD"]).trim();
      await commit("second.txt", environment(withFakeAbb(), "0"));
      const headAfterSecond = runGit(repo, ["rev-parse", "HEAD"]).trim();
      expect(headAfterSecond).not.toBe(headAfterFirst);

      const calls = readFileSync(logPath, "utf8").trim().split(/\r?\n/);
      expect(calls).toEqual([
        "analyze --staged --fail-on high",
        "analyze --staged --baseline HEAD --policy new-secrets",
      ]);

      await expect(commit("third.txt", environment(withFakeAbb(), "1"))).rejects.toMatchObject({ code: 1 });
      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(headAfterSecond);
      expect(readFileSync(logPath, "utf8").trim().split(/\r?\n/)).toHaveLength(3);
    });

    it("executes persisted external storage and initial-policy options on both commit paths", async () => {
      await installPreCommitHook(repo, {
        policy: "team-review",
        allowExternalSessionDir: true,
        firstCommit: "policy",
      });
      await commit("first.txt", environment(withFakeAbb(), "0"));
      await commit("second.txt", environment(withFakeAbb(), "0"));
      const head = runGit(repo, ["rev-parse", "HEAD"]).trim();
      expect(readFileSync(logPath, "utf8").trim().split(/\r?\n/)).toEqual([
        "--allow-external-session-dir analyze --staged --initial --policy team-review",
        "--allow-external-session-dir analyze --staged --baseline HEAD --policy team-review",
      ]);
      await expect(commit("third.txt", environment(withFakeAbb(), "1"))).rejects.toMatchObject({ code: 1 });
      expect(runGit(repo, ["rev-parse", "HEAD"]).trim()).toBe(head);
    });

    it("fails open with a notice when abb is not on PATH", async () => {
      const { stderr } = await commit("first.txt", environment(withoutAbb(), "1"));

      expect(stderr).toContain("abb was not found on PATH");
      expect(runGit(repo, ["rev-parse", "--verify", "HEAD"]).trim()).toMatch(/^[0-9a-f]{40,64}$/);
      expect(readFileSync(logPath, "utf8")).toBe("");
    });
  });
});
