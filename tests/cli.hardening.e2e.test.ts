import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { appendFileEvent, createSession, finalizeSession } from "../src/session/sessionManager.js";
import { pathExists } from "../src/utils/files.js";
import { runCli } from "./cliRunner.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

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
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repo });
  return repo;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Records one finished session in `repo` and returns its ID. */
async function finishedSession(repo: string, fileName: string): Promise<string> {
  const session = await createSession(repo, DEFAULT_CONFIG);
  await appendFileEvent(session, { timestamp: new Date().toISOString(), eventType: "add", path: fileName });
  const report = await finalizeSession(session, DEFAULT_CONFIG, "test");
  return report.id;
}

describe("abb stop when the watcher has not finalized", () => {
  it("keeps the pending message and exits 1 so scripts can stop a chain", async () => {
    const repo = await gitRepo("abb-stop-pending-");
    // The live test process owns this session and no watcher runs, so stop cannot finalize it.
    await createSession(repo, DEFAULT_CONFIG);

    const stopped = await runCli(repo, ["stop"], { timeoutMs: 60_000 });
    expect(stopped.exitCode).toBe(1);
    expect(stopped.stdout).toContain("Stop requested. The foreground watcher has not finalized yet.");
  }, 60_000);
});

describe("option validation names the flag", () => {
  it.each([
    [["sessions", "list", "--memory-budget-mb", "7"], "--memory-budget-mb"],
    [["sessions", "verify", "--concurrency", "17"], "--concurrency"],
    [["recover", "--max-record-bytes", "268435457"], "--max-record-bytes"],
    [["recover", "--max-rss-mb", "8589934592"], "--max-rss-mb"],
  ])(
    "rejects %j and names the flag %s",
    async (args, flag) => {
      const repo = await gitRepo("abb-option-validation-");

      const result = await runCli(repo, args);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(flag);
      expect(existsSync(path.join(repo, ".agent-black-box"))).toBe(false);
    },
    60_000
  );
});

describe("sessions prune and archive --json", () => {
  it("previews the retention plan as JSON without deleting sessions", async () => {
    const repo = await gitRepo("abb-prune-json-");
    const older = await finishedSession(repo, "first.txt");
    await sleep(20);
    const newer = await finishedSession(repo, "second.txt");

    const preview = await runCli(repo, ["sessions", "prune", "--before", "2099-01-01", "--keep", "1", "--json"]);

    expect(preview.exitCode).toBe(0);
    const plan = JSON.parse(preview.stdout) as { keep: number; sessions: Array<{ id: string }> };
    expect(plan.keep).toBe(1);
    expect(plan.sessions.map((session) => session.id)).toEqual([older]);
    expect(await pathExists(path.join(repo, DEFAULT_CONFIG.sessionDir, older, "session.json"))).toBe(true);
    expect(await pathExists(path.join(repo, DEFAULT_CONFIG.sessionDir, newer, "session.json"))).toBe(true);
  }, 60_000);

  it("previews the archive plan as JSON without creating the destination", async () => {
    const repo = await gitRepo("abb-archive-json-");
    const older = await finishedSession(repo, "first.txt");
    await sleep(20);
    await finishedSession(repo, "second.txt");

    const preview = await runCli(repo, [
      "sessions",
      "archive",
      "--before",
      "2099-01-01",
      "--keep",
      "1",
      "--to",
      "archive",
      "--json",
    ]);

    expect(preview.exitCode).toBe(0);
    const plan = JSON.parse(preview.stdout) as { archiveDir: string; sessions: Array<{ id: string }> };
    expect(plan.sessions.map((session) => session.id)).toEqual([older]);
    expect(plan.archiveDir).toContain("archive");
    expect(await pathExists(path.join(repo, "archive"))).toBe(false);
  }, 60_000);

  it("refuses --json combined with --apply for prune and deletes nothing", async () => {
    const repo = await gitRepo("abb-prune-json-apply-");
    const older = await finishedSession(repo, "first.txt");
    await sleep(20);
    await finishedSession(repo, "second.txt");

    const refused = await runCli(repo, [
      "sessions",
      "prune",
      "--before",
      "2099-01-01",
      "--keep",
      "1",
      "--json",
      "--apply",
    ]);

    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("--json cannot be combined with --apply.");
    expect(await pathExists(path.join(repo, DEFAULT_CONFIG.sessionDir, older, "session.json"))).toBe(true);
  }, 60_000);

  it.each([
    ["--apply", "--json cannot be combined with --apply."],
    ["--resume", "--json cannot be combined with --resume."],
  ])(
    "refuses archive --json with %s before copying anything",
    async (flag, message) => {
      const repo = await gitRepo("abb-archive-json-refuse-");
      await finishedSession(repo, "first.txt");
      await sleep(20);
      await finishedSession(repo, "second.txt");

      const refused = await runCli(repo, [
        "sessions",
        "archive",
        "--before",
        "2099-01-01",
        "--keep",
        "1",
        "--to",
        "archive",
        "--json",
        flag,
      ]);

      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain(message);
      expect(await pathExists(path.join(repo, "archive"))).toBe(false);
    },
    60_000
  );
});
