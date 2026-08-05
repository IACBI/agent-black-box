#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  analyzeChangedFiles,
  type AnalysisFinding,
  type AnalysisInputFile,
  type WatcherlessAnalysisResult,
} from "./analyze/analyzer.js";
import { recordAndRunCommand } from "./commands/commandRecorder.js";
import {
  createDefaultConfig,
  formatConfigProblems,
  loadConfig,
  loadConfigWithMeta,
  migrateConfigFile,
} from "./config/config.js";
import { renderDoctorReport, runDoctor } from "./doctor/doctor.js";
import { parseExportFormat, parseRiskSeverity, renderSessionExport, writeSessionExport } from "./export/exporter.js";
import { collectGitSnapshot, requireRepositoryRoot, getRepositoryRoot } from "./git/git.js";
import { generateSessionComparisonMarkdown } from "./reports/comparison.js";
import { filterRiskFindings, generateRisksMarkdown, generateSummaryMarkdown } from "./reports/markdown.js";
import { renderSessionCatalog, toPublicSessionCatalog } from "./reports/sessionCatalog.js";
import { applyRollbackPlan, confirmRollback, createRollbackPlan, renderRollbackPlan } from "./rollback/rollback.js";
import {
  inspectSessionRecoveryState,
  isProcessRunning,
  readActiveSession,
  recoverActiveSession,
  writeStopRequest,
} from "./session/sessionManager.js";
import {
  listSessionCatalog,
  readCatalogSessionReport,
  resolveSession,
  resolveSessionEntry,
} from "./session/sessionCatalog.js";
import { buildSessionComparison } from "./session/sessionComparison.js";
import { runWatcher } from "./watcher/watcher.js";
import { pathExists } from "./utils/files.js";
import { inspectTextFile } from "./utils/fileInspection.js";
import { mapWithConcurrency } from "./utils/concurrency.js";
import { resolveRepoPath } from "./utils/paths.js";
import type { SessionReport } from "./types.js";

const program = new Command();

program
  .name("abb")
  .description("Record and explain observable repository changes during AI coding sessions.")
  .version("0.7.0");

program
  .command("init")
  .description("Create .agentblackbox.json in the current Git repository or directory.")
  .action(async () => {
    const root = (await getRepositoryRoot(process.cwd())) ?? process.cwd();
    const configPath = await createDefaultConfig(root);
    console.log(`Created ${await displayPathFromCurrentDirectory(configPath)}`);
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
    console.log(`Migrated ${await displayPathFromCurrentDirectory(result.configPath)}`);
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

    const recovery = await recoverActiveSession(repoRoot, config);
    if (recovery.report) {
      console.log(`Recovered session. Reports written to ${recovery.report.sessionDir}`);
    } else {
      console.log("Completed session state cleanup.");
    }
  });

program
  .command("recover")
  .description("Safely finalize a stale session or clean its completed state files.")
  .action(async () => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadConfig(repoRoot);
    const recovery = await recoverActiveSession(repoRoot, config);

    if (recovery.state === "no-active-session") {
      console.log("No session recovery is needed.");
    } else if (recovery.report) {
      console.log(`Recovered session. Reports written to ${recovery.report.sessionDir}`);
    } else {
      console.log("Completed session state cleanup.");
    }
  });

program
  .command("status")
  .description("Show active session status.")
  .action(async () => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadConfig(repoRoot);
    const recovery = await inspectSessionRecoveryState(repoRoot, config);
    if (!recovery.active) {
      console.log(`State: ${recovery.status}`);
      console.log(recovery.message);
      return;
    }

    console.log(`Session: ${recovery.active.id}`);
    console.log(`State: ${recovery.status}`);
    console.log(`Started: ${recovery.active.startedAt}`);
    console.log(`Reports directory: ${recovery.active.sessionDir}`);
    console.log(recovery.message);
  });

program
  .command("doctor")
  .description("Check local prerequisites, repository state, config, and session health.")
  .option("--repair", "recover a stale session only when ownership is safely verified")
  .action(async (options: { repair?: boolean }) => {
    if (options.repair) {
      const repoRoot = await requireRepositoryRoot(process.cwd());
      const config = await loadConfig(repoRoot);
      const recovery = await recoverActiveSession(repoRoot, config);
      console.log(
        recovery.report
          ? `Recovered session. Reports written to ${recovery.report.sessionDir}`
          : recovery.state === "no-active-session"
            ? "No session recovery is needed."
            : "Completed session state cleanup."
      );
    }
    const report = await runDoctor(process.cwd());
    console.log(renderDoctorReport(report));
    process.exitCode = report.ok ? 0 : 1;
  });

program
  .command("analyze")
  .description("Analyze current working-tree changes without starting a watcher.")
  .option("--format <format>", "output format: text, json, or sarif", "text")
  .option("--fail-on <severity>", "exit with code 1 at or above low, medium, or high")
  .action(async (options: { format: string; failOn?: string }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadConfig(repoRoot);
    const format = parseAnalyzeFormat(options.format);
    const failOn = parseRiskSeverity(options.failOn);
    const snapshot = await collectGitSnapshot(repoRoot, config.exclude);
    const files = await collectAnalysisInputFiles(repoRoot, snapshot.changedFiles, config.maxFileSizeKb * 1024);
    const result = analyzeChangedFiles(files);

    console.log(renderAnalysis(result, format));
    if (failOn && meetsSeverityThreshold(result.summary.maxSeverity, failOn)) {
      process.exitCode = 1;
    }
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
  .description("Print a structured session JSON report.")
  .option("--session <id>", "select a session ID, unique prefix, or latest")
  .action(async (options: { session?: string }) => {
    await printSessionReportFile("session.json", options.session);
  });

program
  .command("summary")
  .description("Print a human-readable session summary.")
  .option("--session <id>", "select a session ID, unique prefix, or latest")
  .action(async (options: { session?: string }) => {
    await printSessionReportFile("summary.md", options.session);
  });

program
  .command("commands")
  .description("Print commands recorded in a session.")
  .option("--session <id>", "select a session ID, unique prefix, or latest")
  .action(async (options: { session?: string }) => {
    await printSessionReportFile("commands.md", options.session);
  });

program
  .command("timeline")
  .description("Show a chronological timeline of file changes and recorded commands.")
  .option("--session <id>", "select a session ID, unique prefix, or latest")
  .action(async (options: { session?: string }) => {
    await printSessionReportFile("timeline.md", options.session);
  });

program
  .command("risks")
  .description("Show risky changes detected in the latest session.")
  .option("--min-severity <severity>", "only include risks at or above low, medium, or high")
  .option("--category <category>", "only include risks from a specific category")
  .option("--json", "print filtered risk findings as JSON")
  .option("--session <id>", "select a session ID, unique prefix, or latest")
  .action(async (options: { minSeverity?: string; category?: string; json?: boolean; session?: string }) => {
    if (!hasRiskOptions(options)) {
      await printSessionReportFile("risks.md", options.session);
      return;
    }

    const repoRoot = await requireRepositoryRoot(process.cwd());
    const report = await readSelectedSessionReport(repoRoot, options.session);
    const riskFilter = {
      minSeverity: parseRiskSeverity(options.minSeverity),
      ...(options.category ? { category: options.category } : {}),
    };

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            riskSummary: report.riskSummary,
            risks: filterRiskFindings(report.risks, riskFilter),
            possibleSecrets: report.possibleSecrets,
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
  .option("--session <id>", "select a session ID, unique prefix, or latest")
  .action(async (options: { apply?: boolean; file?: string[]; session?: string }) => {
    if (!options.apply) {
      await printSessionReportFile("rollback.md", options.session);
      return;
    }

    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadConfig(repoRoot);
    const entries = await listSessionCatalog(repoRoot, config);
    const latest = resolveSessionEntry(entries, "latest");
    const selected = resolveSessionEntry(entries, options.session);
    if (selected.id !== latest.id) {
      throw new Error("Interactive rollback apply only supports the latest completed session.");
    }
    const report = await readCatalogSessionReport(selected);
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
  .option("--session <id>", "select a session ID, unique prefix, or latest")
  .action(
    async (options: {
      format: string;
      output?: string;
      force?: boolean;
      minSeverity?: string;
      category?: string;
      session?: string;
    }) => {
      const repoRoot = await requireRepositoryRoot(process.cwd());
      const report = await readSelectedSessionReport(repoRoot, options.session);
      const content = renderSessionExport(report, {
        format: parseExportFormat(options.format),
        riskFilter: {
          minSeverity: parseRiskSeverity(options.minSeverity),
          ...(options.category ? { category: options.category } : {}),
        },
      });

      if (!options.output) {
        console.log(content);
        return;
      }

      const exportPath = await writeSessionExport(options.output, content, { force: options.force });
      console.log(`Export written to ${exportPath}`);
    }
  );

const sessionsCommand = program.command("sessions").description("List, inspect, and compare recorded sessions.");

sessionsCommand
  .command("list")
  .description("List complete, incomplete, and corrupt sessions.")
  .option("--json", "print structured JSON")
  .action(async (options: { json?: boolean }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadConfig(repoRoot);
    const entries = await listSessionCatalog(repoRoot, config);
    console.log(
      options.json ? JSON.stringify(toPublicSessionCatalog(entries), null, 2) : renderSessionCatalog(entries)
    );
  });

sessionsCommand
  .command("show")
  .description("Show a session summary or normalized JSON report.")
  .argument("<session>", "session ID, unique prefix, or latest")
  .option("--json", "print the normalized session JSON report")
  .action(async (session: string, options: { json?: boolean }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const report = await readSelectedSessionReport(repoRoot, session);
    console.log(options.json ? JSON.stringify(report, null, 2) : generateSummaryMarkdown(report));
  });

sessionsCommand
  .command("compare")
  .description("Compare files, risks, commands, and HEAD revisions across two sessions.")
  .argument("<from>", "from session ID or unique prefix")
  .argument("<to>", "to session ID or unique prefix")
  .option("--json", "print structured comparison JSON")
  .action(async (from: string, to: string, options: { json?: boolean }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadConfig(repoRoot);
    const entries = await listSessionCatalog(repoRoot, config);
    const fromReport = await readCatalogSessionReport(resolveSessionEntry(entries, from));
    const toReport = await readCatalogSessionReport(resolveSessionEntry(entries, to));
    const comparison = buildSessionComparison(fromReport, toReport);
    console.log(options.json ? JSON.stringify(comparison, null, 2) : generateSessionComparisonMarkdown(comparison));
  });

async function printSessionReportFile(fileName: string, selector?: string): Promise<void> {
  const repoRoot = await requireRepositoryRoot(process.cwd());
  const config = await loadConfig(repoRoot);
  const selected = await resolveSession(repoRoot, config, selector);
  await readCatalogSessionReport(selected);
  const reportPath = path.join(selected.sessionDir, fileName);
  if (!(await pathExists(reportPath))) {
    throw new Error(`Session ${selected.id} does not contain ${fileName}.`);
  }

  console.log(await readFile(reportPath, "utf8"));
}

async function readSelectedSessionReport(repoRoot: string, selector?: string): Promise<SessionReport> {
  const config = await loadConfig(repoRoot);
  return readCatalogSessionReport(await resolveSession(repoRoot, config, selector));
}

async function waitForSessionToFinalize(
  repoRoot: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  sessionDir: string
): Promise<boolean> {
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

async function displayPathFromCurrentDirectory(targetPath: string): Promise<string> {
  const [currentDirectory, resolvedTarget] = await Promise.all([realpath(process.cwd()), realpath(targetPath)]);
  return path.relative(currentDirectory, resolvedTarget) || path.basename(resolvedTarget);
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

type AnalyzeFormat = "text" | "json" | "sarif";

function parseAnalyzeFormat(value: string): AnalyzeFormat {
  if (value === "text" || value === "json" || value === "sarif") {
    return value;
  }
  throw new Error("--format must be one of: text, json, sarif.");
}

async function collectAnalysisInputFiles(
  repoRoot: string,
  changedFiles: ReadonlyArray<SessionReport["git"]["changedFiles"][number]>,
  maxFileSizeBytes: number
): Promise<AnalysisInputFile[]> {
  const safeMaxFileSizeBytes = Math.min(maxFileSizeBytes, 256 * 1024);
  return mapWithConcurrency(changedFiles, 4, async (file) => {
    if (file.status === "deleted") {
      return file;
    }

    const absolutePath = resolveRepoPath(repoRoot, file.path);
    if (!absolutePath) {
      return file;
    }

    const inspection = await inspectTextFile(absolutePath, safeMaxFileSizeBytes, safeMaxFileSizeBytes);
    return {
      ...file,
      kind: inspection.kind,
      ...(inspection.text === undefined ? {} : { content: inspection.text }),
    };
  });
}

function renderAnalysis(result: WatcherlessAnalysisResult, format: AnalyzeFormat): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }
  if (format === "sarif") {
    return JSON.stringify(toSarif(result), null, 2);
  }

  const lines = ["Agent Black Box Analysis", "", `Findings: ${result.summary.findingCount}`];
  lines.push(`Maximum severity: ${result.summary.maxSeverity}`);
  lines.push(`Score: ${result.summary.score}`);
  if (result.findings.length > 0) {
    lines.push("");
    lines.push(...result.findings.map(renderAnalysisFinding));
  }
  return lines.join("\n");
}

function renderAnalysisFinding(finding: AnalysisFinding): string {
  const line = finding.line === undefined ? "" : `:${finding.line}`;
  return `[${finding.severity}] ${finding.path}${line} — ${finding.category}: ${finding.reason}`;
}

function toSarif(result: WatcherlessAnalysisResult): Record<string, unknown> {
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "Agent Black Box",
            informationUri: "https://github.com/IACBI/agent-black-box",
            rules: result.findings.map((finding) => ({ id: `${finding.kind}:${finding.category}` })),
          },
        },
        results: result.findings.map((finding) => ({
          ruleId: `${finding.kind}:${finding.category}`,
          level: finding.severity === "high" ? "error" : finding.severity === "medium" ? "warning" : "note",
          message: { text: finding.reason },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: finding.path },
                ...(finding.line === undefined ? {} : { region: { startLine: finding.line } }),
              },
            },
          ],
        })),
      },
    ],
  };
}

function meetsSeverityThreshold(
  actual: WatcherlessAnalysisResult["summary"]["maxSeverity"],
  threshold: string
): boolean {
  const severityOrder = { none: 0, low: 1, medium: 2, high: 3 };
  return severityOrder[actual] >= severityOrder[threshold as keyof typeof severityOrder];
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
