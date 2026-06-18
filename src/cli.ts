#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { createDefaultConfig, loadConfig } from "./config/config.js";
import { requireRepositoryRoot, getRepositoryRoot } from "./git/git.js";
import {
  finalizeSession,
  getLatestSessionDir,
  isProcessRunning,
  readActiveSession,
  writeStopRequest
} from "./session/sessionManager.js";
import { runWatcher } from "./watcher/watcher.js";
import { pathExists } from "./utils/files.js";

const program = new Command();

program
  .name("abb")
  .description("Record and explain observable repository changes during AI coding sessions.")
  .version("0.1.0");

program
  .command("init")
  .description("Create .agentblackbox.json in the current Git repository or directory.")
  .action(async () => {
    const root = (await getRepositoryRoot(process.cwd())) ?? process.cwd();
    const configPath = await createDefaultConfig(root);
    console.log(`Created ${path.relative(process.cwd(), configPath) || configPath}`);
  });

program
  .command("start")
  .description("Start a foreground recording session in the current repository.")
  .action(async () => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadConfig(repoRoot);
    const { createSession } = await import("./session/sessionManager.js");
    const session = await createSession(repoRoot, config);
    await runWatcher(session, config);
  });

program
  .command("stop")
  .description("Stop the active session and generate reports.")
  .action(async () => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadConfig(repoRoot);
    const active = await readActiveSession(repoRoot, config);

    if (!active) {
      console.log("No active Agent Black Box session was found.");
      return;
    }

    if (isProcessRunning(active.pid)) {
      await writeStopRequest(repoRoot, config, active.id);
      const completed = await waitForSessionToFinalize(repoRoot, config, active.sessionDir);
      if (completed) {
        console.log(`Session stopped. Reports written to ${active.sessionDir}`);
      } else {
        console.log("Stop requested. The foreground watcher has not finalized yet.");
      }
      return;
    }

    console.log(`Active session ${active.id} appears stale. Finalizing from current Git state.`);
    const report = await finalizeSession(active, config, "stale-stop");
    console.log(`Reports written to ${report.sessionDir}`);
  });

program
  .command("status")
  .description("Show active session status.")
  .action(async () => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadConfig(repoRoot);
    const active = await readActiveSession(repoRoot, config);

    if (!active) {
      console.log("No active Agent Black Box session.");
      return;
    }

    const state = isProcessRunning(active.pid) ? "active" : "stale";
    console.log(`Session: ${active.id}`);
    console.log(`State: ${state}`);
    console.log(`Started: ${active.startedAt}`);
    console.log(`Reports directory: ${active.sessionDir}`);
  });

program
  .command("report")
  .description("Print the latest session summary.")
  .action(async () => {
    await printLatestReportFile("session.json");
  });

program
  .command("timeline")
  .description("Show a chronological timeline of file changes and command placeholders.")
  .action(async () => {
    await printLatestReportFile("timeline.md");
  });

program
  .command("risks")
  .description("Show risky changes detected in the latest session.")
  .action(async () => {
    await printLatestReportFile("risks.md");
  });

program
  .command("rollback")
  .description("Print safe rollback suggestions based on Git diffs.")
  .action(async () => {
    await printLatestReportFile("rollback.md");
  });

async function printLatestReportFile(fileName: string): Promise<void> {
  const repoRoot = await requireRepositoryRoot(process.cwd());
  const config = await loadConfig(repoRoot);
  const latestSessionDir = await getLatestSessionDir(repoRoot, config);

  if (!latestSessionDir) {
    throw new Error("No Agent Black Box sessions were found.");
  }

  const reportPath = path.join(latestSessionDir, fileName);
  if (!(await pathExists(reportPath))) {
    throw new Error(`Latest session does not contain ${fileName}.`);
  }

  console.log(await readFile(reportPath, "utf8"));
}

async function waitForSessionToFinalize(repoRoot: string, config: Awaited<ReturnType<typeof loadConfig>>, sessionDir: string): Promise<boolean> {
  const sessionPath = path.join(sessionDir, "session.json");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const active = await readActiveSession(repoRoot, config);
    if (!active && (await pathExists(sessionPath))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
