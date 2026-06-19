import type {
  AgentBlackBoxConfig,
  CommandEvent,
  ChangedFile,
  FileChangeEvidence,
  FileEvent,
  GitSnapshot,
  RiskFinding,
  SecretFinding,
  SessionBaseline,
  SessionReport
} from "../types.js";
import { summarizeRisks } from "../risks/riskDetector.js";
import { buildChangeEvidence, indexFileChangeEvidence, selectSessionRelevantChanges } from "../session/changeEvidence.js";
import { escapeMarkdownTableCell, escapeMarkdownText, markdownInlineCode, markdownTableCode } from "../utils/markdown.js";
import { shellQuotePath } from "../utils/paths.js";

const COMMAND_CAPTURE_NOTE =
  "Only commands run through `abb run -- <command>` are recorded. Shell history, terminal output, prompts, and agent reasoning are not captured.";

export function buildSessionReport(
  active: {
    id: string;
    repoRoot: string;
    sessionDir: string;
    startedAt: string;
  },
  endedAt: string,
  finalizedBy: string,
  events: FileEvent[],
  commands: CommandEvent[],
  git: GitSnapshot,
  risks: RiskFinding[],
  possibleSecrets: SecretFinding[],
  integrity: SessionReport["integrity"] = {
    warnings: [],
    discardedFileEventLines: 0,
    discardedCommandEventLines: 0
  },
  baseline: SessionBaseline | null = null,
  committedChanges: ChangedFile[] = []
): SessionReport {
  const changeEvidence = buildChangeEvidence(baseline, events, git, committedChanges);

  return {
    id: active.id,
    repoRoot: active.repoRoot,
    sessionDir: active.sessionDir,
    startedAt: active.startedAt,
    endedAt,
    finalizedBy,
    commandCapture: {
      implemented: true,
      mode: "wrapper-only",
      note: COMMAND_CAPTURE_NOTE
    },
    events,
    commands,
    baseline,
    changeEvidence,
    git,
    risks,
    riskSummary: summarizeRisks(risks, possibleSecrets),
    possibleSecrets,
    integrity
  };
}

export interface RiskReportFilter {
  minSeverity?: RiskFinding["severity"];
  category?: string;
}

export function generateTimelineMarkdown(report: SessionReport): string {
  const evidenceByPath = indexFileChangeEvidence(report.changeEvidence);
  const changedFiles = report.git.changedFiles
    .map((file) => `- ${file.status}: ${markdownInlineCode(file.path)} (${formatEvidenceLabel(evidenceByPath.get(file.path))})`)
    .join("\n");
  const committedChanges = (report.changeEvidence?.committedChanges ?? [])
    .map((file) => `- ${file.status}: ${markdownInlineCode(file.path)}`)
    .join("\n");
  const fileEvents = report.events
    .map((event) => `- ${event.timestamp} - ${event.eventType} - ${markdownInlineCode(event.path)}`)
    .join("\n");
  const commandEvents = report.commands
    .map((command) => formatCommandEvent(command))
    .join("\n");
  const timeline = [
    ...report.events.map((event) => ({
      timestamp: event.timestamp,
      line: `- ${event.timestamp} - file ${event.eventType} - ${markdownInlineCode(event.path)}`
    })),
    ...report.commands.map((command) => ({
      timestamp: command.startedAt,
      line: formatCommandEvent(command)
    }))
  ]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((entry) => entry.line)
    .join("\n");

  return `# Agent Black Box Timeline

## Session metadata

- Session ID: ${markdownInlineCode(report.id)}
- Repository: ${markdownInlineCode(report.repoRoot)}
- Started: ${report.startedAt}
- Ended: ${report.endedAt}

${formatChangeEvidenceSummary(report)}

## Command history

${COMMAND_CAPTURE_NOTE}

${commandEvents || "No wrapped commands were recorded. Use `abb run -- <command>` during an active session to record command metadata."}

## File events

${fileEvents || "No live file events were recorded."}

## Chronological timeline

${timeline || "No timeline events were recorded."}

## Files changed between start and end HEAD

${committedChanges || "No start-to-end HEAD changes were detected."}

## Files added, modified, or deleted

${changedFiles || "No changed files were detected by Git."}
`;
}

export function generateCommandsMarkdown(report: SessionReport): string {
  const commands = formatGroupedCommands(report.commands);

  return `# Agent Black Box Commands

${COMMAND_CAPTURE_NOTE}

## Recorded commands

${commands || "No wrapped commands were recorded."}
`;
}

export function generateSummaryMarkdown(report: SessionReport): string {
  const changedFileCount = report.git.changedFiles.length;
  const commandCount = report.commands.length;
  const commandGroupCount = countCommandGroups(report.commands);
  const commandPhaseCount = countCommandPhases(report.commands);
  const highRisks = report.risks.filter((risk) => risk.severity === "high").length;
  const mediumRisks = report.risks.filter((risk) => risk.severity === "medium").length;
  const lowRisks = report.risks.filter((risk) => risk.severity === "low").length;
  const evidence = report.changeEvidence?.files ?? [];
  const preExistingCount = evidence.filter((file) => file.atStart === true).length;
  const observedPathCount = evidence.filter((file) => file.observedDuringSession).length;
  const sessionRelevantChanges = selectSessionRelevantChanges(report.git, getChangeEvidence(report));
  const sessionRelevantChangeCount = sessionRelevantChanges.length;
  const committedChangeCount = report.changeEvidence?.committedChanges.length ?? 0;
  const topChangedFiles = sessionRelevantChanges
    .slice(0, 12)
    .map((file) => `- ${file.status}: ${markdownInlineCode(file.path)}`)
    .join("\n");
  const topRisks = report.risks
    .slice(0, 8)
    .map((risk) => `- ${risk.severity.toUpperCase()} - ${markdownInlineCode(risk.path)} - ${escapeMarkdownText(risk.category)}`)
    .join("\n");

  return `# Agent Black Box Summary

## Session

- Session ID: ${markdownInlineCode(report.id)}
- Started: ${report.startedAt}
- Ended: ${report.endedAt}
- Finalized by: ${report.finalizedBy}

## At a glance

- Final worktree changed files: ${changedFileCount}
- Pre-existing changed paths: ${preExistingCount}
- Paths observed during session: ${observedPathCount}
- Start-to-end HEAD changed paths: ${committedChangeCount}
- Session-relevant repository changes: ${sessionRelevantChangeCount}
- Recorded commands: ${commandCount}
- Command groups: ${commandGroupCount}
- Command phases: ${commandPhaseCount}
- File watcher events: ${report.events.length}
- Possible secrets: ${report.possibleSecrets.length}
- Risks: ${highRisks} high, ${mediumRisks} medium, ${lowRisks} low
- Risk score: ${report.riskSummary.score}/100 (${report.riskSummary.maxSeverity})

${formatChangeEvidenceSummary(report)}

## Review priority

${buildReviewPriority(report)}

## Notable session-relevant changes

${topChangedFiles || "No session-relevant repository changes were detected."}

## Top risk signals

${topRisks || "No risky file changes were detected."}

## Recommended next checks

- Read \`risks.md\` before committing.
- Review \`git diff\` for every risky or security-sensitive file.
- Confirm possible secrets are false positives or rotate exposed values.
- Run the repository's relevant test suite.
- Use \`rollback.md\` for manual rollback hints if needed.

## Report integrity

${formatIntegrity(report)}
`;
}

function formatCommandEvent(command: CommandEvent): string {
  const label = command.label ? ` [${escapeMarkdownText(command.label)}]` : "";
  const group = command.group ? ` group ${markdownInlineCode(command.group)}` : "";
  const phase = command.phase ? ` phase ${markdownInlineCode(command.phase)}` : "";
  const cwd = command.cwd && command.cwd !== "." ? ` cwd ${markdownInlineCode(command.cwd)}` : "";
  return `- ${command.startedAt}${label} - command exit ${command.exitCode ?? "unknown"}${group}${phase}${cwd} - ${markdownInlineCode(command.command)}`;
}

export function generateDiffSummaryMarkdown(report: SessionReport): string {
  const evidenceByPath = indexFileChangeEvidence(report.changeEvidence);
  const rows = report.git.changedFiles
    .map((file) => {
      const insertions = file.insertions ?? 0;
      const deletions = file.deletions ?? 0;
      const kind = file.kind ?? "unknown";
      const source = file.lineStatsSource ?? "unknown";
      const note = file.statsNote ?? "";
      const evidence = evidenceByPath.get(file.path);
      return `| ${markdownTableCode(file.path)} | ${file.status} | ${formatEvidenceValue(evidence?.atStart)} | ${formatEvidenceValue(evidence?.observedDuringSession)} | ${kind} | ${formatBytes(file.sizeBytes)} | ${insertions} | ${deletions} | ${source} | ${escapeMarkdownTableCell(note)} |`;
    })
    .join("\n");

  const categories = summarizeNotableCategories(report.risks);
  const committedRows = (report.changeEvidence?.committedChanges ?? [])
    .map((file) => `| ${markdownTableCode(file.path)} | ${file.status} |`)
    .join("\n");

  return `# Agent Black Box Diff Summary

## Git status

\`\`\`text
${report.git.statusText}
\`\`\`

## Git diff summary

\`\`\`text
${report.git.diffSummaryText}
\`\`\`

${formatChangeEvidenceSummary(report)}

## Start-to-end HEAD changes

| File | Status |
| --- | --- |
${committedRows || "| None | unchanged |"}

## Changed files

| File | Status | At start | Observed | Kind | Size | Added lines | Deleted lines | Line stats | Note |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
${rows || "| None | clean | no | no | unknown | 0 B | 0 | 0 | skipped | |"}

## Notable file categories

${categories || "No notable risky file categories were detected from repository changes."}
`;
}

export function generateRisksMarkdown(report: SessionReport, filter: RiskReportFilter = {}): string {
  const risks = filterRiskFindings(report.risks, filter);
  const filterText = describeRiskFilter(filter);
  const riskyFiles = risks
    .map(
      (risk) =>
        `- ${risk.severity.toUpperCase()} (${risk.score}/100) - ${markdownInlineCode(risk.path)} - ${escapeMarkdownText(risk.category)}: ${escapeMarkdownText(risk.reason)}`
    )
    .join("\n");

  const secrets = report.possibleSecrets
    .map(
      (secret) =>
        `- ${markdownInlineCode(`${secret.path}:${secret.line}`)} - ${escapeMarkdownText(secret.reason)} Value: ${escapeMarkdownText(secret.redacted)}`
    )
    .join("\n");

  const dependencyChanges = risks
    .filter((risk) => ["Lockfile", "Package manager file", "Config file"].includes(risk.category))
    .map((risk) => `- ${markdownInlineCode(risk.path)} - ${escapeMarkdownText(risk.category)}`)
    .join("\n");

  const ciChanges = risks
    .filter((risk) => risk.category === "CI/CD file" || risk.category === "Docker file")
    .map((risk) => `- ${markdownInlineCode(risk.path)} - ${escapeMarkdownText(risk.category)}`)
    .join("\n");

  return `# Agent Black Box Risks

These findings are based on observable repository changes. They are possible review signals, not proof of a vulnerability.

${formatChangeEvidenceSummary(report)}

${filterText}

## Risk summary

- Score: ${report.riskSummary.score}/100
- Max severity: ${report.riskSummary.maxSeverity}
- High: ${report.riskSummary.severityCounts.high}
- Medium: ${report.riskSummary.severityCounts.medium}
- Low: ${report.riskSummary.severityCounts.low}
- Possible secrets: ${report.riskSummary.possibleSecretCount}

## Risky files changed

${riskyFiles || "No risky file changes were detected."}

## Possible secrets

${secrets || "No possible secrets were detected in changed files."}

## Dependency and config changes

${dependencyChanges || "No dependency or config changes were detected."}

## CI/CD and container changes

${ciChanges || "No CI/CD or container changes were detected."}

## Suggested review checklist

- Review changed environment, dependency, CI/CD, Docker, migration, auth, security, and config files carefully.
- Confirm possible secret findings are false positives or rotate exposed values if needed.
- Run the repository's relevant tests and type checks.
- Review \`git diff\` before committing or reverting changes.
`;
}

export function filterRiskFindings(risks: RiskFinding[], filter: RiskReportFilter = {}): RiskFinding[] {
  return risks.filter((risk) => {
    if (filter.minSeverity && severityRank(risk.severity) < severityRank(filter.minSeverity)) {
      return false;
    }

    if (filter.category && risk.category.toLowerCase() !== filter.category.toLowerCase()) {
      return false;
    }

    return true;
  });
}

export function generateRollbackMarkdown(report: SessionReport, _config?: AgentBlackBoxConfig): string {
  const evidenceByPath = indexFileChangeEvidence(report.changeEvidence);
  const suggestions = report.git.changedFiles
    .map((file) => {
      const quotedPath = shellQuotePath(file.path);
      const evidence = evidenceByPath.get(file.path);
      if (file.status === "added") {
        return `### ${markdownInlineCode(file.path)}

This appears to be an added or untracked file. Review it before removing it manually.

\`\`\`sh
git diff -- ${quotedPath}
\`\`\``;
      }

      if (evidence?.atStart !== false) {
        const reason = evidence?.atStart === true
          ? "This path already had changes when the session started. Restore commands are omitted because they could discard pre-session work."
          : "No reliable start baseline is available for this path. Restore commands are omitted.";
        return `### ${markdownInlineCode(file.path)}

${reason}

\`\`\`sh
git diff -- ${quotedPath}
\`\`\``;
      }

      return `### ${markdownInlineCode(file.path)}

\`\`\`sh
git diff -- ${quotedPath}
git restore -- ${quotedPath}
git checkout -- ${quotedPath}
\`\`\``;
    })
    .join("\n\n");

  return `# Agent Black Box Rollback Hints

Agent Black Box does not automatically revert changes in this MVP. Review every command before running it. \`git restore\`, \`git checkout --\`, file removal, and cleanup commands can discard work.

${formatChangeEvidenceSummary(report)}

## Current Git status

\`\`\`text
${report.git.statusText}
\`\`\`

## Manual review commands

\`\`\`sh
git status --short
git diff
\`\`\`

## File-level suggestions

${suggestions || "No changed files were detected."}
`;
}

function summarizeNotableCategories(risks: RiskFinding[]): string {
  const categories = [...new Set(risks.map((risk) => risk.category))];
  return categories.map((category) => `- ${escapeMarkdownText(category)}`).join("\n");
}

function formatGroupedCommands(commands: CommandEvent[]): string {
  if (commands.length === 0) {
    return "No wrapped commands were recorded.";
  }

  const groups = new Map<string, CommandEvent[]>();
  for (const command of commands) {
    const group = command.group ?? "ungrouped";
    groups.set(group, [...(groups.get(group) ?? []), command]);
  }

  return [...groups.entries()]
    .map(([group, groupCommands]) => {
      const lines = groupCommands.map((command) => formatCommandEvent(command)).join("\n");
      return `### ${escapeMarkdownText(group)}\n\n${lines}`;
    })
    .join("\n\n");
}

function countCommandGroups(commands: CommandEvent[]): number {
  return new Set(commands.filter((command) => command.group).map((command) => command.group)).size;
}

function countCommandPhases(commands: CommandEvent[]): number {
  return new Set(commands.filter((command) => command.phase).map((command) => command.phase)).size;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return "unknown";
  }

  if (value < 1024) {
    return `${value} B`;
  }

  return `${(value / 1024).toFixed(1)} KiB`;
}

function buildReviewPriority(report: SessionReport): string {
  if (report.possibleSecrets.length > 0) {
    return "Possible secret-like values were detected. Review `risks.md` first and rotate any exposed real credentials.";
  }

  if (report.risks.some((risk) => risk.severity === "high")) {
    return "High-signal risky files changed. Review authentication, security, or environment-related changes before committing.";
  }

  if (report.risks.length > 0) {
    return "Risk signals were detected. Review dependency, config, CI/CD, Docker, migration, or related changes carefully.";
  }

  if (selectSessionRelevantChanges(report.git, getChangeEvidence(report)).length > 0) {
    return "No risk signals were detected, but changed files should still be reviewed with `git diff`.";
  }

  if (report.git.changedFiles.length > 0) {
    return "No session-relevant final changes were detected. Pre-existing repository changes may still be present and should be reviewed separately.";
  }

  return "No repository changes were detected.";
}

function getChangeEvidence(report: SessionReport): SessionReport["changeEvidence"] {
  return report.changeEvidence ?? {
    baselineAvailable: false,
    headChanged: null,
    indexChanged: null,
    branchChanged: null,
    committedChanges: [],
    files: report.git.changedFiles.map((file) => ({
      path: file.path,
      atStart: null,
      observedDuringSession: false,
      atEnd: true,
      gitMetadataChanged: null
    }))
  };
}

function formatChangeEvidenceSummary(report: SessionReport): string {
  const evidence = getChangeEvidence(report);
  if (!evidence.baselineAvailable || !report.baseline) {
    return `## Change evidence

- Git start baseline: unavailable
- Attribution confidence: limited; final Git changes cannot be separated from pre-existing work.`;
  }

  return `## Change evidence

- Git start baseline: ${escapeMarkdownText(evidence.baselineCapturedAt ?? report.baseline.capturedAt)}
- Start HEAD: ${report.baseline.git.head ? markdownInlineCode(report.baseline.git.head) : "unborn repository"}
- End HEAD: ${report.git.head ? markdownInlineCode(report.git.head) : "unborn repository"}
- HEAD changed during session: ${formatEvidenceValue(evidence.headChanged)}
- Git index changed during session: ${formatEvidenceValue(evidence.indexChanged)}
- Branch changed during session: ${formatEvidenceValue(evidence.branchChanged)}
- Start-to-end HEAD changed paths: ${evidence.committedChanges.length}
- Watcher evidence indicates that a path changed during the session; it does not identify which tool or person changed it.`;
}

function formatEvidenceLabel(evidence: FileChangeEvidence | undefined): string {
  if (!evidence || evidence.atStart === null) {
    return "start state unknown";
  }
  if (evidence.atStart && evidence.observedDuringSession) {
    return "pre-existing, observed during session";
  }
  if (evidence.atStart) {
    return "pre-existing";
  }
  if (evidence.observedDuringSession) {
    return "observed during session";
  }
  return "detected at finalization";
}

function formatEvidenceValue(value: boolean | null | undefined): string {
  if (value === true) {
    return "yes";
  }
  if (value === false) {
    return "no";
  }
  return "unknown";
}

function severityRank(severity: RiskFinding["severity"]): number {
  if (severity === "high") {
    return 3;
  }

  if (severity === "medium") {
    return 2;
  }

  return 1;
}

function describeRiskFilter(filter: RiskReportFilter): string {
  const parts = [];
  if (filter.minSeverity) {
    parts.push(`minimum severity \`${filter.minSeverity}\``);
  }
  if (filter.category) {
    parts.push(`category \`${filter.category}\``);
  }

  return parts.length > 0 ? `Active filter: ${parts.join(", ")}.` : "Active filter: none.";
}

function formatIntegrity(report: SessionReport): string {
  if (
    report.integrity.warnings.length === 0 &&
    report.integrity.discardedFileEventLines === 0 &&
    report.integrity.discardedCommandEventLines === 0
  ) {
    return "No malformed session event records were detected.";
  }

  return [
    `- Discarded file event lines: ${report.integrity.discardedFileEventLines}`,
    `- Discarded command event lines: ${report.integrity.discardedCommandEventLines}`,
    ...report.integrity.warnings.slice(0, 8).map((warning) => `- ${escapeMarkdownText(warning)}`)
  ].join("\n");
}
