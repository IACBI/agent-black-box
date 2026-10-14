#!/usr/bin/env node
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Command } from "commander";
import { analyzeChangedFiles, type WatcherlessAnalysisResult } from "./analyze/analyzer.js";
import { compareAnalysisWithBaseline } from "./analyze/baseline.js";
import { evaluateAnalysisPolicy, parseAnalysisPolicyProfile } from "./analyze/policy.js";
import { parseAnalyzeFormat, renderAnalysis } from "./analyze/render.js";
import { createAnalysisContentBudget } from "./analyze/limits.js";
import {
  collectBaselineAnalysisInputFiles,
  collectStagedAnalysisInputFiles,
  resolveBaselineCommit,
} from "./analyze/staged.js";
import { collectAnalysisInputFiles, summarizeAnalysisCoverage } from "./analyze/worktree.js";
import { recordAndRunCommand } from "./commands/commandRecorder.js";
import {
  createDefaultConfig,
  type ConfigLoadOptions,
  formatConfigProblems,
  loadConfig,
  loadConfigWithMeta,
  migrateConfigFile,
} from "./config/config.js";
import { renderDoctorReport, runDoctor } from "./doctor/doctor.js";
import { parseExportFormat, parseRiskSeverity, renderSessionExport, writeSessionExport } from "./export/exporter.js";
import { collectGitSnapshot, requireRepositoryRoot, getRepositoryRoot } from "./git/git.js";
import { createGit } from "./git/executable.js";
import {
  buildPreCommitHookScript,
  getPreCommitHookStatus,
  installPreCommitHook,
  renderHookInstallResult,
  renderHookStatus,
  renderHookUninstallResult,
  uninstallPreCommitHook,
  type HookInstallOptions,
} from "./hooks/preCommitHook.js";
import { generateSessionComparisonMarkdown } from "./reports/comparison.js";
import { filterRiskFindings, generateRisksMarkdown, generateSummaryMarkdown } from "./reports/markdown.js";
import { generatePullRequestComment } from "./reports/prComment.js";
import { renderSessionCatalog, toPublicSessionCatalog } from "./reports/sessionCatalog.js";
import {
  applyVerifiedRollbackPlan,
  confirmRollback,
  createRollbackPlan,
  renderRollbackPlan,
  verifyRollbackSafetyState,
} from "./rollback/rollback.js";
import {
  createSession,
  inspectSessionRecoveryState,
  readActiveSession,
  recoverActiveSession,
  writeStopRequest,
} from "./session/sessionManager.js";
import {
  listSessionCatalog,
  readCatalogSessionReport,
  resolveSession,
  resolveSessionEntry,
  verifyCatalogSessionReportFile,
  type SessionCatalogOptions,
  type SessionCatalogState,
} from "./session/sessionCatalog.js";
import { buildSessionComparison } from "./session/sessionComparison.js";
import { browseSessionCatalog } from "./session/sessionBrowser.js";
import {
  applySessionRetention,
  archiveSessionRetention,
  inspectSessionArchives,
  planSessionRetention,
  renderSessionArchivePlan,
  renderSessionArchiveInspection,
  renderSessionRetentionPlan,
  resolveArchiveDestination,
  retentionDateForDays,
} from "./session/sessionRetention.js";
import { filterSessionCatalog } from "./session/sessionSearch.js";
import {
  getSessionVerificationLimits,
  renderSessionVerification,
  verifySessions,
  type SessionVerificationOptions,
} from "./session/sessionVerification.js";
import { loadEvidenceKeyFile, signSessionEvidence } from "./session/evidenceSigning.js";
import { inspectSessionCaptureHealth, renderSessionCaptureHealth } from "./session/captureHealth.js";
import { runWatcher } from "./watcher/watcher.js";
import { pathExists } from "./utils/files.js";
import { meetsSeverity } from "./utils/severity.js";
import { escapeTerminalControls, formatTerminalValue } from "./utils/terminal.js";
import { sleep } from "./utils/timing.js";
import { compileSecretRules } from "./risks/secretRules.js";
import type { AgentBlackBoxConfig, ConfigLoadResult, SessionReport } from "./types.js";

const CAPTURE_HEALTH_STATES = ["active", "recoverable", "already-complete"];

const program = new Command();

program
  .name("abb")
  .description("Record and explain observable repository changes during AI coding sessions.")
  .version("0.8.4")
  .option(
    "--allow-external-session-dir",
    "allow a trusted local sessionDir outside the repository; network and UNC paths remain blocked"
  );

program
  .command("init")
  .description("Create .agentblackbox.json in the current Git repository or directory.")
  .action(async () => {
    const root = (await getRepositoryRoot(process.cwd())) ?? process.cwd();
    const configPath = await createDefaultConfig(root);
    console.log(`Created ${formatTerminalValue(await displayPathFromCurrentDirectory(configPath))}`);
  });

const configCommand = program.command("config").description("Validate or migrate Agent Black Box config.");

configCommand
  .command("validate")
  .description("Validate .agentblackbox.json and report schema/version issues.")
  .action(async () => {
    const root = (await getRepositoryRoot(process.cwd())) ?? process.cwd();
    const result = await loadConfigWithMeta(root, getConfigLoadOptions());
    console.log(renderConfigLoadResult(result));
    process.exitCode = result.errors.length === 0 ? 0 : 1;
  });

configCommand
  .command("migrate")
  .description("Rewrite .agentblackbox.json using the current schema version.")
  .action(async () => {
    const root = (await getRepositoryRoot(process.cwd())) ?? process.cwd();
    const result = await migrateConfigFile(root, getConfigLoadOptions());
    console.log(renderConfigLoadResult(result));
    console.log(`Migrated ${formatTerminalValue(await displayPathFromCurrentDirectory(result.configPath))}`);
  });

program
  .command("start")
  .description("Start a foreground recording session in the current repository.")
  .action(async () => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadRuntimeConfig(repoRoot);
    const session = await createSession(repoRoot, config);
    await runWatcher(session, config);
  });

program
  .command("stop")
  .description("Stop the active session and generate reports.")
  .action(async () => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadRuntimeConfig(repoRoot);
    const state = await inspectSessionRecoveryState(repoRoot, config);
    if (state.status === "no-active-session") {
      console.log("No active Agent Black Box session was found.");
      return;
    }
    if (state.status === "corrupt" || state.status === "inconsistent" || !state.active) {
      throw new Error(state.message);
    }
    const active = state.active;
    if (state.status === "active") {
      await writeStopRequest(repoRoot, config, active.id);
      const completed = await waitForSessionToFinalize(repoRoot, config, active.sessionDir);
      if (completed) {
        console.log(`Session stopped. Reports written to ${formatTerminalValue(active.sessionDir)}`);
      } else {
        console.log("Stop requested. The foreground watcher has not finalized yet.");
      }
      return;
    }

    const recovery = await recoverActiveSession(repoRoot, config);
    if (recovery.report) {
      console.log(`Recovered session. Reports written to ${formatTerminalValue(recovery.report.sessionDir)}`);
    } else {
      console.log("Completed session state cleanup.");
    }
  });

program
  .command("recover")
  .description("Safely finalize a stale session or clean its completed state files.")
  .option("--command-wait-timeout-ms <milliseconds>", "stop recovery if recorded commands remain live beyond this wait")
  .option("--max-record-bytes <bytes>", "limit retained event and command record bytes during recovery (up to 256 MiB)")
  .action(async (options: { commandWaitTimeoutMs?: string; maxRecordBytes?: string }) => {
    const recoveryOptions = {
      commandWaitTimeoutMs: parseSessionListLimit(options.commandWaitTimeoutMs, "--command-wait-timeout-ms"),
      maxRecordBytes: parseSessionListLimit(options.maxRecordBytes, "--max-record-bytes"),
    };
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadRuntimeConfig(repoRoot);
    const recovery = await recoverActiveSession(repoRoot, config, recoveryOptions);

    if (recovery.state === "no-active-session") {
      console.log("No session recovery is needed.");
    } else if (recovery.report) {
      console.log(`Recovered session. Reports written to ${formatTerminalValue(recovery.report.sessionDir)}`);
    } else {
      console.log("Completed session state cleanup.");
    }
  });

program
  .command("status")
  .description("Show active session status.")
  .option("--capture-health", "inspect persisted capture-loss and command-completion markers")
  .option("--json", "print structured session status and capture health")
  .action(async (options: { captureHealth?: boolean; json?: boolean }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadRuntimeConfig(repoRoot);
    const recovery = await inspectSessionRecoveryState(repoRoot, config);
    const captureHealth =
      (options.captureHealth || options.json) && recovery.active && CAPTURE_HEALTH_STATES.includes(recovery.status)
        ? await inspectSessionCaptureHealth(recovery.active)
        : null;
    if (options.json) {
      console.log(
        escapeTerminalControls(
          JSON.stringify(
            {
              state: recovery.status,
              message: recovery.message,
              session: recovery.active
                ? {
                    id: recovery.active.id,
                    startedAt: recovery.active.startedAt,
                    sessionDir: recovery.active.sessionDir,
                  }
                : null,
              captureHealth,
            },
            null,
            2
          )
        )
      );
      return;
    }
    if (!recovery.active) {
      console.log(`State: ${recovery.status}`);
      console.log(formatTerminalValue(recovery.message));
      return;
    }

    console.log(`Session: ${recovery.active.id}`);
    console.log(`State: ${recovery.status}`);
    console.log(`Started: ${recovery.active.startedAt}`);
    console.log(`Reports directory: ${formatTerminalValue(recovery.active.sessionDir)}`);
    console.log(formatTerminalValue(recovery.message));
    if (options.captureHealth) {
      console.log(
        captureHealth
          ? renderSessionCaptureHealth(captureHealth)
          : "Capture health: unavailable for this session state."
      );
    }
  });

program
  .command("doctor")
  .description("Check local prerequisites, repository state, config, and session health.")
  .option("--repair", "recover a stale session only when ownership is safely verified")
  .option("--json", "print structured prerequisite, config, and session checks")
  .action(async (options: { repair?: boolean; json?: boolean }) => {
    if (options.repair) {
      const repoRoot = await requireRepositoryRoot(process.cwd());
      const config = await loadRuntimeConfig(repoRoot);
      const recovery = await recoverActiveSession(repoRoot, config);
      if (!options.json) {
        console.log(
          recovery.report
            ? `Recovered session. Reports written to ${formatTerminalValue(recovery.report.sessionDir)}`
            : recovery.state === "no-active-session"
              ? "No session recovery is needed."
              : "Completed session state cleanup."
        );
      }
    }
    const report = await runDoctor(process.cwd(), getConfigLoadOptions());
    console.log(escapeTerminalControls(options.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report)));
    process.exitCode = report.ok ? 0 : 1;
  });

program
  .command("analyze")
  .description("Analyze working-tree or staged changes without starting a watcher.")
  .option("--format <format>", "output format: text, json, or sarif", "text")
  .option("--staged", "analyze staged Git blobs instead of working-tree contents")
  .option("--baseline <ref>", "with --staged, report new content findings relative to a Git commit")
  .option("--initial", "with --staged in a repository without a HEAD commit, treat all content as new")
  .option("--fail-on <severity>", "exit with code 1 at or above low, medium, or high")
  .option("--policy <profile>", "built-in or configured CI policy; requires --staged and --baseline or --initial")
  .option(
    "--max-total-bytes <bytes>",
    "limit retained analysis content across current and baseline files (UTF-8 bytes)"
  )
  .action(
    async (options: {
      format: string;
      staged?: boolean;
      baseline?: string;
      initial?: boolean;
      failOn?: string;
      policy?: string;
      maxTotalBytes?: string;
    }) => {
      if (options.baseline && !options.staged) {
        throw new Error("--baseline requires --staged.");
      }
      if (options.initial && (!options.staged || options.baseline !== undefined)) {
        throw new Error("--initial requires --staged and cannot be combined with --baseline.");
      }
      if (options.policy && (!options.staged || (!options.baseline && !options.initial))) {
        throw new Error("--policy requires --staged and --baseline.");
      }
      const repoRoot = await requireRepositoryRoot(process.cwd());
      const config = await loadRuntimeConfig(repoRoot);
      const format = parseAnalyzeFormat(options.format);
      const failOn = parseRiskSeverity(options.failOn);
      const policy = parseAnalysisPolicyProfile(options.policy, config.analysisPolicies);
      const collectionOptions =
        options.maxTotalBytes === undefined
          ? {}
          : { contentBudget: createAnalysisContentBudget(parseAnalysisByteLimit(options.maxTotalBytes)) };
      if (options.initial) {
        const status = await createGit(repoRoot).raw(["status", "--porcelain=v2", "--branch", "--untracked-files=no"]);
        if (!status.split("\n").includes("# branch.oid (initial)")) {
          throw new Error("--initial requires a repository without a HEAD commit; use --baseline HEAD instead.");
        }
      }
      const files = options.staged
        ? await collectStagedAnalysisInputFiles(repoRoot, config, collectionOptions)
        : await collectAnalysisInputFiles(
            repoRoot,
            (await collectGitSnapshot(repoRoot, config.exclude)).changedFiles,
            config.maxFileSizeKb * 1024,
            collectionOptions
          );
      const analysisOptions = { secretRules: compileSecretRules(config) };
      let result: WatcherlessAnalysisResult = {
        ...analyzeChangedFiles(files, analysisOptions),
        coverage: summarizeAnalysisCoverage(files, options.staged ? "index" : "worktree", analysisOptions),
        ...(options.initial ? { initialCommitAnalysis: true as const } : {}),
      };
      if (options.baseline) {
        const commit = await resolveBaselineCommit(repoRoot, options.baseline);
        const secretPaths = new Set(
          result.findings.filter((finding) => finding.kind === "possible-secret").map((finding) => finding.path)
        );
        const comparedFiles = files.filter((file) => secretPaths.has(file.path));
        const baselineFiles = await collectBaselineAnalysisInputFiles(
          repoRoot,
          comparedFiles,
          config,
          commit,
          collectionOptions
        );
        result = compareAnalysisWithBaseline(comparedFiles, baselineFiles, result, commit, analysisOptions);
      }

      if (policy) {
        result = {
          ...result,
          policyEvaluation: evaluateAnalysisPolicy(result, files, policy, config.analysisPolicies),
        };
      }

      console.log(renderAnalysis(result, format));
      if ((failOn && meetsSeverity(result.summary.maxSeverity, failOn)) || result.policyEvaluation?.failed) {
        process.exitCode = 1;
      }
    }
  );

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
    const exitCode = await recordAndRunCommand(commandParts, process.cwd(), { ...options, ...getConfigLoadOptions() });
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
    const riskFilter = buildRiskFilter(options);

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

    console.log(escapeTerminalControls(generateRisksMarkdown(report, riskFilter)));
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
    const config = await loadRuntimeConfig(repoRoot);
    const entries = await listSessionCatalog(repoRoot, config);
    const latest = resolveSessionEntry(entries, "latest");
    const selected = resolveSessionEntry(entries, options.session);
    if (selected.id !== latest.id) {
      throw new Error("Interactive rollback apply only supports the latest completed session.");
    }
    const report = await readCatalogSessionReport(selected);
    const plan = createRollbackPlan(report, options.file ?? []);
    if (plan.restorableFiles.length > 0) {
      await verifyRollbackSafetyState(repoRoot, selected.sessionDir, report, plan, config);
    }
    console.log(renderRollbackPlan(plan));

    if (plan.restorableFiles.length === 0) {
      return;
    }

    if (!(await confirmRollback(plan))) {
      console.log("Rollback cancelled.");
      return;
    }

    await applyVerifiedRollbackPlan(repoRoot, selected.sessionDir, report, plan, config);
    console.log("Eligible files restored. Review `git status --short` before continuing.");
  });

program
  .command("export")
  .description("Export the latest session as bundled Markdown, structured JSON, or SARIF.")
  .option("--format <format>", "export format: markdown, json, or sarif", "markdown")
  .option("--output <path>", "write export to a file instead of stdout")
  .option("--force", "overwrite an existing output file")
  .option("--min-severity <severity>", "filter risks in Markdown and SARIF exports by low, medium, or high")
  .option("--category <category>", "filter risks in Markdown and SARIF exports by category")
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
      const format = parseExportFormat(options.format);
      const content = renderSessionExport(report, { format, riskFilter: buildRiskFilter(options) });

      if (!options.output) {
        console.log(format === "markdown" ? escapeTerminalControls(content) : content);
        return;
      }

      const exportPath = await writeSessionExport(options.output, content, { force: options.force });
      console.log(`Export written to ${formatTerminalValue(exportPath)}`);
    }
  );

program
  .command("pr-comment")
  .description("Print a compact pull request comment for a session; pipe it to `gh pr comment --body-file -`.")
  .option("--output <path>", "write the comment to a file instead of stdout")
  .option("--force", "overwrite an existing output file")
  .option("--session <id>", "select a session ID, unique prefix, or latest")
  .action(async (options: { output?: string; force?: boolean; session?: string }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const comment = generatePullRequestComment(await readSelectedSessionReport(repoRoot, options.session));
    if (!options.output) {
      process.stdout.write(escapeTerminalControls(comment));
      return;
    }
    const commentPath = await writeSessionExport(options.output, comment, { force: options.force });
    console.log(`Pull request comment written to ${formatTerminalValue(commentPath)}`);
  });

const hookCommand = program.command("hook").description("Manage the Git pre-commit hook that runs abb analyze.");

hookCommand
  .command("install")
  .description("Install a managed pre-commit hook that analyzes staged changes.")
  .option("--policy <profile>", "analysis policy the hook enforces", "new-secrets")
  .option(
    "--first-commit <mode>",
    "first commit: high severity fallback, or the selected policy (high or policy)",
    "high"
  )
  .option("--force", "back up and replace a pre-commit hook that abb did not create")
  .action(async (options: { policy: string; force?: boolean; firstCommit: string }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const firstCommit = options.firstCommit;
    if (firstCommit !== "high" && firstCommit !== "policy") {
      throw new Error("--first-commit must be high or policy.");
    }
    const hookOptions: HookInstallOptions = {
      ...options,
      firstCommit,
      allowExternalSessionDir: getConfigLoadOptions().allowExternalSessionDir === true,
    };
    buildPreCommitHookScript(options.policy, hookOptions);
    const config = await loadRuntimeConfig(repoRoot);
    parseAnalysisPolicyProfile(options.policy, config.analysisPolicies);
    console.log(renderHookInstallResult(await installPreCommitHook(repoRoot, hookOptions)));
  });

hookCommand
  .command("uninstall")
  .description("Remove the managed pre-commit hook and restore any hook it replaced.")
  .action(async () => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const result = await uninstallPreCommitHook(repoRoot);
    console.log(renderHookUninstallResult(result));
    process.exitCode = result.action === "foreign" ? 1 : 0;
  });

hookCommand
  .command("status")
  .description("Show whether the managed pre-commit hook is installed.")
  .action(async () => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    console.log(renderHookStatus(await getPreCommitHookStatus(repoRoot)));
  });

const sessionsCommand = program.command("sessions").description("List, inspect, and compare recorded sessions.");

addSessionFilterOptions(
  sessionsCommand
    .command("list")
    .description("List complete, incomplete, and corrupt sessions.")
    .option("--json", "print structured JSON")
)
  .option("--limit <count>", "show at most this many matching sessions")
  .option("--memory-budget-mb <mb>", "working-data byte budget in MiB (8–4096); excludes V8 object overhead")
  .action(async (options: SessionFilterOptions & { json?: boolean; limit?: string; memoryBudgetMb?: string }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadRuntimeConfig(repoRoot);
    const readOptions = getHistoryReadOptions(options.memoryBudgetMb);
    const entries = await listSessionCatalog(repoRoot, config, readOptions);
    const filtered = await filterSessionCatalog(
      entries,
      {
        ...buildSessionFilters(options),
        limit: parseSessionListLimit(options.limit),
      },
      readOptions
    );
    // Suppress renderer defaults even if filtering hides the entries with unknown timestamps.
    const latestCompleteId = entries.some((entry) => entry.state === "complete" && entry.metadataUnavailable)
      ? ""
      : entries.find((entry) => entry.state === "complete")?.id;
    console.log(
      options.json
        ? JSON.stringify(toPublicSessionCatalog(filtered, latestCompleteId), null, 2)
        : renderSessionCatalog(filtered, latestCompleteId)
    );
  });

addSessionFilterOptions(
  sessionsCommand.command("browse").description("Browse filtered session history in an interactive terminal.")
)
  .option("--page-size <count>", "sessions per page (1–50)", "10")
  .option("--memory-budget-mb <mb>", "working-data byte budget in MiB (8–4096); excludes V8 object overhead")
  .action(async (options: SessionFilterOptions & { pageSize: string; memoryBudgetMb?: string }) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Session browsing requires an interactive terminal.");
    }
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadRuntimeConfig(repoRoot);
    const readOptions = getHistoryReadOptions(options.memoryBudgetMb);
    const entries = await filterSessionCatalog(
      await listSessionCatalog(repoRoot, config, readOptions),
      buildSessionFilters(options),
      readOptions
    );
    const pageSize = parseSessionListLimit(options.pageSize, "--page-size") ?? 10;
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await browseSessionCatalog(
        entries,
        pageSize,
        { ask: (question) => prompt.question(question), write: (text) => process.stdout.write(text) },
        async (entry) => generateSummaryMarkdown(await readCatalogSessionReport(entry, readOptions))
      );
    } finally {
      prompt.close();
    }
  });

sessionsCommand
  .command("prune")
  .description("Preview deletion of older completed sessions; --apply requires interactive confirmation.")
  .option("--before <date>", "only consider sessions started before YYYY-MM-DD (UTC)")
  .option("--keep <count>", "keep at least this many newest completed sessions")
  .option("--apply", "delete eligible sessions after typed confirmation")
  .action(async (options: { before?: string; keep?: string; apply?: boolean }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadRuntimeConfig(repoRoot);
    const { before, keep } = resolveRetentionSelection(options, config);
    const plan = planSessionRetention(await listSessionCatalog(repoRoot, config), before, keep);
    console.log(escapeTerminalControls(renderSessionRetentionPlan(plan)));
    if (!options.apply || plan.sessions.length === 0) {
      return;
    }
    const confirmation = `delete ${plan.sessions.length} sessions`;
    if (
      !(await confirmTyped(
        confirmation,
        `Type "${confirmation}" to delete these sessions: `,
        "Session deletion requires an interactive terminal."
      ))
    ) {
      console.log("Session deletion cancelled.");
      return;
    }
    await applySessionRetention(repoRoot, config, plan);
    console.log(`${plan.sessions.length} completed session(s) deleted.`);
  });

sessionsCommand
  .command("archive")
  .description("Preview verified copies of older completed sessions; --apply preserves the originals.")
  .option("--before <date>", "only consider sessions started before YYYY-MM-DD (UTC)")
  .option("--keep <count>", "keep at least this many newest completed sessions")
  .option("--to <directory>", "local archive destination (or configure retention.archiveDir)")
  .option("--apply", "copy and verify eligible sessions after typed confirmation")
  .option("--resume", "inspect matching partial archives and copy only missing files with --apply")
  .action(async (options: { before?: string; keep?: string; to?: string; apply?: boolean; resume?: boolean }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadRuntimeConfig(repoRoot);
    const { before, keep } = resolveRetentionSelection(options, config);
    const archiveDir = await resolveArchiveDestination(repoRoot, options.to, config.retention?.archiveDir);
    if (!archiveDir) {
      throw new Error("--to is required unless retention.archiveDir is configured.");
    }
    const plan = planSessionRetention(await listSessionCatalog(repoRoot, config), before, keep);
    console.log(escapeTerminalControls(renderSessionArchivePlan(plan, archiveDir)));
    if (options.resume) {
      const archives = await inspectSessionArchives(repoRoot, config, plan, archiveDir);
      console.log(escapeTerminalControls(renderSessionArchiveInspection(archives).trimEnd()));
      if (archives.some((archive) => archive.status === "conflict")) {
        process.exitCode = 1;
        return;
      }
    }
    if (!options.apply || plan.sessions.length === 0) {
      return;
    }
    const confirmation = `archive ${plan.sessions.length} sessions`;
    if (
      !(await confirmTyped(
        confirmation,
        `Type "${confirmation}" to copy these sessions: `,
        "Session archiving requires an interactive terminal."
      ))
    ) {
      console.log("Session archiving cancelled.");
      return;
    }
    await archiveSessionRetention(repoRoot, config, plan, archiveDir, { resume: options.resume });
    console.log(`${plan.sessions.length} completed session(s) archived; originals remain in place.`);
  });

sessionsCommand
  .command("show")
  .description("Show a session summary or normalized JSON report.")
  .argument("<session>", "session ID, unique prefix, or latest")
  .option("--json", "print the normalized session JSON report")
  .option("--memory-budget-mb <mb>", "working-data byte budget in MiB (8–4096); excludes V8 object overhead")
  .action(async (session: string, options: { json?: boolean; memoryBudgetMb?: string }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const report = await readSelectedSessionReport(repoRoot, session, getHistoryReadOptions(options.memoryBudgetMb));
    console.log(
      options.json ? JSON.stringify(report, null, 2) : escapeTerminalControls(generateSummaryMarkdown(report))
    );
  });

sessionsCommand
  .command("compare")
  .description("Compare files, risks, possible-secret locations, commands, and HEAD revisions across two sessions.")
  .argument("<from>", "from session ID or unique prefix")
  .argument("<to>", "to session ID or unique prefix")
  .option("--json", "print structured comparison JSON")
  .option("--memory-budget-mb <mb>", "working-data byte budget in MiB (8–4096); excludes V8 object overhead")
  .action(async (from: string, to: string, options: { json?: boolean; memoryBudgetMb?: string }) => {
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadRuntimeConfig(repoRoot);
    const readOptions = getHistoryReadOptions(options.memoryBudgetMb);
    const entries = await listSessionCatalog(repoRoot, config, readOptions);
    const fromReport = await readCatalogSessionReport(resolveSessionEntry(entries, from), readOptions);
    const toReport = await readCatalogSessionReport(resolveSessionEntry(entries, to), readOptions);
    const comparison = buildSessionComparison(fromReport, toReport);
    console.log(
      options.json
        ? JSON.stringify(comparison, null, 2)
        : escapeTerminalControls(generateSessionComparisonMarkdown(comparison))
    );
  });

sessionsCommand
  .command("sign")
  .description("Seal finalized evidence using an independently managed encrypted Ed25519 key.")
  .argument("<session>", "session ID, unique prefix, or latest")
  .requiredOption("--private-key <path>", "encrypted PKCS8 PEM outside the repository and session storage")
  .option("--passphrase-env <name>", "environment variable holding the key passphrase", "ABB_SIGNING_PASSPHRASE")
  .action(async (session: string, options: { privateKey: string; passphraseEnv: string }) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.passphraseEnv)) {
      throw new Error("--passphrase-env must name an environment variable.");
    }
    const repoRoot = await requireRepositoryRoot(process.cwd());
    const config = await loadRuntimeConfig(repoRoot);
    const entry = await resolveSession(repoRoot, config, session);
    const privateKey = await loadEvidenceKeyFile(options.privateKey, repoRoot, path.dirname(entry.sessionDir), {
      privateKey: true,
      passphrase: process.env[options.passphraseEnv],
    });
    const fingerprint = await signSessionEvidence(entry, privateKey);
    console.log("Evidence sealed with key SHA-256: " + fingerprint);
  });

sessionsCommand
  .command("verify")
  .description("Check stored session integrity; optionally verify or repair derived indexes.")
  .argument("[session]", "session ID, unique prefix, or latest; all sessions when omitted")
  .option("--json", "print structured JSON")
  .option("--memory-budget-mb <mb>", "working-data byte budget in MiB (8–4096); excludes V8 object overhead")
  .option("--concurrency <count>", "maximum parallel verifications (1–16, default 4); reduced by the memory budget")
  .option("--trusted-key <path>", "require signatures from this independently trusted external Ed25519 public PEM")
  .option("--check-indexes", "compare derived metadata and search indexes with verified evidence")
  .option("--repair-indexes", "regenerate derived indexes from verified evidence without changing reports or logs")
  .action(
    async (
      session: string | undefined,
      options: {
        json?: boolean;
        memoryBudgetMb?: string;
        concurrency?: string;
        checkIndexes?: boolean;
        repairIndexes?: boolean;
        trustedKey?: string;
      }
    ) => {
      const verificationOptions: SessionVerificationOptions = {
        memoryBudgetMb: parseSessionListLimit(options.memoryBudgetMb, "--memory-budget-mb"),
        concurrency: parseSessionListLimit(options.concurrency, "--concurrency"),
        checkIndexes: options.checkIndexes,
        repairIndexes: options.repairIndexes,
      };
      const limits = getSessionVerificationLimits(verificationOptions);
      const repoRoot = await requireRepositoryRoot(process.cwd());
      const config = await loadRuntimeConfig(repoRoot);
      const entries = await listSessionCatalog(repoRoot, config, { maxMaterializedBytes: limits.maxMaterializedBytes });
      const selected = session === undefined ? entries : [resolveSessionEntry(entries, session)];
      if (options.trustedKey) {
        const sessionRoot = path.resolve(repoRoot, config.sessionDir);
        verificationOptions.trustedKey = await loadEvidenceKeyFile(options.trustedKey, repoRoot, sessionRoot);
      }
      const summary = await verifySessions(selected, verificationOptions);
      console.log(
        options.json
          ? JSON.stringify(summary, null, 2)
          : escapeTerminalControls(renderSessionVerification(summary).trimEnd())
      );
      if (
        summary.failed > 0 ||
        summary.sessions.some(
          (result) => result.indexError || result.indexIssues?.some((file) => !result.repairedIndexes?.includes(file))
        )
      ) {
        process.exitCode = 1;
      }
    }
  );

async function printSessionReportFile(fileName: string, selector?: string): Promise<void> {
  const repoRoot = await requireRepositoryRoot(process.cwd());
  const config = await loadRuntimeConfig(repoRoot);
  const selected = await resolveSession(repoRoot, config, selector);
  await verifyCatalogSessionReportFile(selected);
  const reportPath = path.join(selected.sessionDir, fileName);
  if (!(await pathExists(reportPath))) {
    throw new Error(`Session ${selected.id} does not contain ${fileName}.`);
  }

  const details = await lstat(reportPath);
  if (!details.isFile()) {
    throw new Error(`${fileName} is not a regular file.`);
  }
  const handle = await open(reportPath, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== details.dev ||
      opened.ino !== details.ino ||
      opened.size !== details.size ||
      opened.mtimeMs !== details.mtimeMs
    ) {
      throw new Error(`${fileName} changed before it could be opened.`);
    }
    const source = handle.createReadStream({ autoClose: false });
    if (fileName === "session.json") {
      await pipeline(source, process.stdout, { end: false });
    } else {
      source.setEncoding("utf8");
      const terminalSafe = new Transform({
        decodeStrings: false,
        transform(chunk: string, _encoding, callback) {
          callback(null, escapeTerminalControls(chunk));
        },
      });
      await pipeline(source, terminalSafe, process.stdout, { end: false });
    }
  } finally {
    await handle.close();
  }
  process.stdout.write("\n");
}

async function readSelectedSessionReport(
  repoRoot: string,
  selector?: string,
  options: SessionCatalogOptions = {}
): Promise<SessionReport> {
  const config = await loadRuntimeConfig(repoRoot);
  return readCatalogSessionReport(await resolveSession(repoRoot, config, selector, options), options);
}

function getHistoryReadOptions(memoryBudgetMb: string | undefined): SessionCatalogOptions {
  if (memoryBudgetMb === undefined) {
    return {};
  }
  const limits = getSessionVerificationLimits({
    memoryBudgetMb: parseSessionListLimit(memoryBudgetMb, "--memory-budget-mb"),
    concurrency: 1,
  });
  return { maxMaterializedBytes: limits.maxMaterializedBytes };
}

async function waitForSessionToFinalize(
  repoRoot: string,
  config: AgentBlackBoxConfig,
  sessionDir: string
): Promise<boolean> {
  const sessionPath = path.join(sessionDir, "session.json");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const active = await readActiveSession(repoRoot, config);
    if (!active && (await pathExists(sessionPath))) {
      return true;
    }
    await sleep(250);
  }

  return false;
}

async function displayPathFromCurrentDirectory(targetPath: string): Promise<string> {
  const [currentDirectory, resolvedTarget] = await Promise.all([realpath(process.cwd()), realpath(targetPath)]);
  return path.relative(currentDirectory, resolvedTarget) || path.basename(resolvedTarget);
}

function getConfigLoadOptions(): ConfigLoadOptions {
  const options = program.opts() as { allowExternalSessionDir?: boolean };
  return { allowExternalSessionDir: options.allowExternalSessionDir === true };
}

async function loadRuntimeConfig(repoRoot: string): Promise<AgentBlackBoxConfig> {
  return loadConfig(repoRoot, getConfigLoadOptions());
}

function renderConfigLoadResult(result: ConfigLoadResult): string {
  const lines = ["Agent Black Box Config", ""];

  lines.push(`Path: ${formatTerminalValue(result.configPath)}`);
  lines.push(`Exists: ${result.exists ? "yes" : "no"}`);
  lines.push(`Config version: ${result.config.configVersion}`);
  lines.push(`Schema: ${formatTerminalValue(result.config.$schema ?? "none")}`);
  lines.push(`Session directory: ${formatTerminalValue(result.config.sessionDir)}`);

  if (result.migrated) {
    lines.push("Migration: legacy config can be migrated to the current schema.");
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(formatConfigProblems("Warnings", result.warnings.map(formatTerminalValue)));
  }

  if (result.errors.length > 0) {
    lines.push("");
    lines.push(formatConfigProblems("Errors", result.errors.map(formatTerminalValue)));
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

function parseSessionState(value: string | undefined): SessionCatalogState | undefined {
  if (value === undefined || value === "complete" || value === "incomplete" || value === "corrupt") {
    return value;
  }
  throw new Error("--state must be one of: complete, incomplete, corrupt.");
}

function parseSessionListLimit(value: string | undefined, optionName = "--limit"): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return Number(value);
}

function parseAnalysisByteLimit(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("--max-total-bytes must be a non-negative safe integer.");
  }
  return Number(value);
}

interface SessionFilterOptions {
  state?: string;
  since?: string;
  minSeverity?: string;
  file?: string;
  command?: string;
  category?: string;
}

function addSessionFilterOptions(command: Command): Command {
  return command
    .option("--state <state>", "only include complete, incomplete, or corrupt sessions")
    .option("--since <date>", "only include sessions started on or after YYYY-MM-DD (UTC)")
    .option("--min-severity <severity>", "only include sessions at or above low, medium, or high risk")
    .option("--file <text>", "find session-relevant paths containing text")
    .option("--command <text>", "find recorded redacted commands containing text")
    .option("--category <text>", "find risk categories containing text");
}

function buildSessionFilters(options: SessionFilterOptions) {
  return {
    state: parseSessionState(options.state),
    since: options.since,
    minSeverity: parseRiskSeverity(options.minSeverity),
    file: options.file,
    command: options.command,
    category: options.category,
  };
}

function buildRiskFilter(options: { minSeverity?: string; category?: string }) {
  return {
    minSeverity: parseRiskSeverity(options.minSeverity),
    ...(options.category ? { category: options.category } : {}),
  };
}

function resolveRetentionSelection(
  options: { before?: string; keep?: string },
  config: AgentBlackBoxConfig
): { before: string; keep: number } {
  const before = options.before ?? (config.retention?.days && retentionDateForDays(config.retention.days));
  if (!before) {
    throw new Error("--before is required unless retention.days is configured.");
  }
  return { before, keep: parseSessionListLimit(options.keep, "--keep") ?? config.retention?.keep ?? 1 };
}

async function confirmTyped(expected: string, question: string, notInteractiveMessage: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(notInteractiveMessage);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)) === expected;
  } finally {
    prompt.close();
  }
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(escapeTerminalControls(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
