import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const cliPath = path.resolve(process.cwd(), "src/cli.ts");

const spawnedProcesses: ChildProcessWithoutNullStreams[] = [];

describe("CLI end-to-end", () => {
  afterEach(async () => {
    await Promise.all(spawnedProcesses.splice(0).map((child) => stopChild(child)));
  });

  it("records a full init/start/run/stop/report flow in a Git repository", async () => {
    const repo = await createTempDir("abb-e2e-");
    try {
      initGitRepo(repo);

      const init = await runCli(repo, ["init"]);
      expect(init.stdout).toContain("Created .agentblackbox.json");

      const doctor = await runCli(repo, ["doctor"]);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.stdout).toContain("Result: ready");

      const watcher = spawnCli(repo, ["start"]);
      spawnedProcesses.push(watcher);
      await waitForOutput(watcher, "Agent Black Box session started");

      await writeFile(path.join(repo, "notes.md"), "# Notes\n\nhello\n", "utf8");
      await mkdir(path.join(repo, "packages", "app"), { recursive: true });

      const command = await runCli(repo, ["run", "--cwd", "packages/app", "--label", "node-version", "--", "node", "--version"]);
      expect(command.exitCode).toBe(0);
      expect(command.stdout).toContain(process.version);

      const stop = await runCli(repo, ["stop"]);
      expect(stop.stdout).toContain("Session stopped");
      await waitForExit(watcher);

      const timeline = await runCli(repo, ["timeline"]);
      expect(timeline.stdout).toContain("node --version");
      expect(timeline.stdout).toContain("[node-version]");
      expect(timeline.stdout).toContain("packages/app");
      expect(timeline.stdout).toContain("notes.md");

      const commands = await runCli(repo, ["commands"]);
      expect(commands.stdout).toContain("Recorded commands");
      expect(commands.stdout).toContain("node --version");

      const summary = await runCli(repo, ["summary"]);
      expect(summary.stdout).toContain("Agent Black Box Summary");
      expect(summary.stdout).toContain("Changed files:");

      const risks = await runCli(repo, ["risks"]);
      expect(risks.stdout).toContain("No possible secrets were detected");

      const rollback = await runCli(repo, ["rollback"]);
      expect(rollback.stdout).toContain("does not automatically revert");

      const report = await runCli(repo, ["report"]);
      const session = JSON.parse(report.stdout) as { commands: unknown[]; git: { changedFiles: Array<{ path: string }> } };
      expect(session.commands).toHaveLength(1);
      expect(session.git.changedFiles.some((file) => file.path === "notes.md")).toBe(true);
    } finally {
      await removeTempDir(repo);
    }
  }, 60_000);
});

function runCli(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ["--import", tsxLoader, cliPath, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: typeof error?.code === "number" ? error.code : 0
      });
    });
  });
}

function spawnCli(cwd: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
    cwd,
    stdio: "pipe"
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
