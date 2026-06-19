#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { recordAndRunCommand } from "./commands/commandRecorder.js";
import {
  createDefaultConfig,
  formatConfigProblems,
  loadConfig,
  loadConfigWithMeta,
  migrateConfigFile
} from "./config/config.js";
import { renderDoctorReport, runDoctor } from "./doctor/doctor.js";
import { parseExportFormat, parseRiskSeverity, renderSessionExport, writeSessionExport } from "./export/exporter.js";
import { requireRepositoryRoot, getRepositoryRoot } from "./git/git.js";
import { filterRiskFindings, generateRisksMarkdown } from "./reports/markdown.js";
import { applyRollbackPlan, confirmRollback, createRollbackPlan, renderRollbackPlan } from "./rollback/rollback.js";
import {
  finalizeSession,
  getLatestSessionDir,
  isProcessRunning,
  readActiveSession,
  writeStopRequest
} from "./session/sessionManager.js";
import { runWatcher } from "./watcher/watcher.js";
import { pathExists } from "./utils/files.js";
import type { SessionReport } from "./types.js";

const program = new Command();

program
  .name("abb")
  .description("Record and explain observable repository changes during AI coding sessions.")
  .version("0.5.3");

program
  .command("init")
  .description("Create .agentblackbox.json in the current Git repository or directory.")
  .action(async () => {
    const root = (await getRepositoryRoot(process.cwd())) ?? process.cwd();
    const configPath = await createDefaultConfig(root);
    console.log(`Created ${path.relative(process.cwd(), configPath) || configPath}`);
  });

const configCommand = program.command("config").description("Validate or migrate Agent Black Box config.");

configCommand
  .command("validate")
  .description("Validate .agentblackbox.json and report schema/version issues.")
  .action(async () => {
    const root = (await getRepositoryRoot(process.cwd())) ?? process.cwd();
    const result = await loadConfigWithMeta(root);
    console.log(renderConfigLoadResult(result));
    process.exitCode = result.errors.length === 0 ? 0 : 1;
  });

configCommand
  .command("migrate")
  .description("Rewrite .agentblackbox.json using the current schema version.")
  .action(async () => {
    const root = (await getRepositoryRoot(process.cwd())) ?? process.cwd();
    const result = await migrateConfigFile(root);
    console.log(renderConfigLoadResult(result));
    console.log(`Migrated ${path.relative(process.cwd(), result.configPath) || result.configPath}`);
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
  .command("doctor")
  .description("Check local prerequisites, repository state, config, and session health.")
  .action(async () => {
    const report = await runDoctor(process.cwd());
    console.log(renderDoctorReport(report));
    process.exitCode = report.ok ? 0 : 1;
  });

program
  .command("run")
  .description("Run a command during an active session and record redacted command metadata.")
  .option("--cwd <path>", "run command from a repository-relative directory")
  .option("--label <label>", "attach a short label to the recorded command")
  .option("--group <group>", "group related recorded commands in reports")
  .option("--phase <phase>", "mark a command phase such as setup, test, build, or release")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .argument("<command...>", "command and arguments to run")
  .action(async (commandParts: string[], options: { cwd?: string; label?: string; group?: string; phase?: string }) => {
    const exitCode = await recordAndRunCommand(commandParts, process.cwd(), options);
    process.exitCode = exitCode;
  });

program
  .command("report")
  .description("Print the latest structured session JSON report.")
  .action(async () => {
    await printLatestReportFile("session.json");
  });

program
  .command("summary")
  .description("Print the latest human-readable session summary.")
  .action(async () => {
    await printLatestReportFile("summary.md");
  });

program
  .command("commands")
  .description("Print commands recorded in the latest session.")
  .action(async () => {
    await printLatestReportFile("commands.md");
  });

program
  .command("timeline")
  .description("Show a chronological timeline of file changes and recorded commands.")
  .action(async () => {
    await printLatestReportFile("timeline.md");
  });

program
  .command("risks")
  .description("Show risky changes detected in the latest session.")
  .option("--min-severity <severity>", "only include risks at or above low, medium, or high")
  .option("--category <category>", "only include risks from a specific category")
  .option("--json", "print filtered risk findings as JSON")
  .action(async (options: { minSeverity?: string; category?: string; json?: boolean }) => {
    if (!hasRiskOptions(options)) {
      await printLatestReportFile("risks.md");
      return;
    }

    const repoRoot = await requireRepositoryRoot(process.cwd());
    const report = await readLatestSessionReport(repoRoot);
    const riskFilter = {
      minSeverity: parseRiskSeverity(options.minSeverity),
      ...(options.category ? { category: options.category } : {})
    };

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            riskSummary: report.riskSummary,
            risks: filterRiskFindings(report.risks, riskFilter),
            possibleSecrets: report.possibleSecrets
          },
          null,
          2
        )
      );
      return;
    }

    console.log(generateRisksMarkdown(report, riskFilter));
  });

program
  .command("rollback")
  .description("Print safe rollback suggestions based on Git diffs.")
  .option("--apply", "interactively restore eligible tracked files from the latest session")
  .option("--file <path...>", "limit interactive restore to one or more repository-relative files")
  .action(async (options: { apply?: boolean; file?: string[] }) => {
    if (!options.apply) {
      await printLatestReportFile("rollback.md");
      return;
    }

    const repoRoot = await requireRepositoryRoot(process.cwd());
    const report = await readLatestSessionReport(repoRoot);
    const plan = createRollbackPlan(report, options.file ?? []);
    console.log(renderRollbackPlan(plan));

    if (plan.restorableFiles.length === 0) {
      return;
    }

    if (!(await confirmRollback(plan))) {
      console.log("Rollback cancelled.");
      return;
    }

    await applyRollbackPlan(repoRoot, plan);
    console.log("Eligible files restored. Review `git status --short` before continuing.");
  });

program
  .command("export")
  .description("Export the latest session as bundled Markdown or structured JSON.")
  .option("--format <format>", "export format: markdown or json", "markdown")
  .option("--output <path>", "write export to a file instead of stdout")
  .option("--force", "overwrite an existing output file")
  .option("--min-severity <severity>", "filter risks in Markdown exports by low, medium, or high")
  .option("--category <category>", "filter risks in Markdown exports by category")
  .action(
    async (options: {
      format: string;
      output?: string;
      force?: boolean;
      minSeverity?: string;
      category?: string;
    }) => {
      const repoRoot = await requireRepositoryRoot(process.cwd());
      const report = await readLatestSessionReport(repoRoot);
      const content = renderSessionExport(report, {
        format: parseExportFormat(options.format),
        riskFilter: {
          minSeverity: parseRiskSeverity(options.minSeverity),
          ...(options.category ? { category: options.category } : {})
        }
      });

      if (!options.output) {
        console.log(content);
        return;
      }

      const exportPath = await writeSessionExport(options.output, content, { force: options.force });
      console.log(`Export written to ${exportPath}`);
    }
  );

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

async function readLatestSessionReport(repoRoot: string): Promise<SessionReport> {
  const config = await loadConfig(repoRoot);
  const latestSessionDir = await getLatestSessionDir(repoRoot, config);

  if (!latestSessionDir) {
    throw new Error("No Agent Black Box sessions were found.");
  }

  const reportPath = path.join(latestSessionDir, "session.json");
  if (!(await pathExists(reportPath))) {
    throw new Error("Latest session does not contain session.json.");
  }

  return JSON.parse(await readFile(reportPath, "utf8")) as SessionReport;
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

function renderConfigLoadResult(result: Awaited<ReturnType<typeof loadConfigWithMeta>>): string {
  const lines = ["Agent Black Box Config", ""];

  lines.push(`Path: ${result.configPath}`);
  lines.push(`Exists: ${result.exists ? "yes" : "no"}`);
  lines.push(`Config version: ${result.config.configVersion}`);
  lines.push(`Schema: ${result.config.$schema ?? "none"}`);
  lines.push(`Session directory: ${result.config.sessionDir}`);

  if (result.migrated) {
    lines.push("Migration: legacy config can be migrated to the current schema.");
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(formatConfigProblems("Warnings", result.warnings));
  }

  if (result.errors.length > 0) {
    lines.push("");
    lines.push(formatConfigProblems("Errors", result.errors));
    lines.push("");
    lines.push("Result: invalid");
  } else {
    lines.push("");
    lines.push("Result: valid");
  }

  return `${lines.join("\n")}\n`;
}

function hasRiskOptions(options: { minSeverity?: string; category?: string; json?: boolean }): boolean {
  return Boolean(options.minSeverity || options.category || options.json);
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
