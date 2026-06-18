import type {
  AgentBlackBoxConfig,
  CommandEvent,
  FileEvent,
  GitSnapshot,
  RiskFinding,
  SecretFinding,
  SessionReport
} from "../types.js";
import { summarizeRisks } from "../risks/riskDetector.js";
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
  }
): SessionReport {
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
  const changedFiles = report.git.changedFiles.map((file) => `- ${file.status}: \`${file.path}\``).join("\n");
  const fileEvents = report.events
    .map((event) => `- ${event.timestamp} - ${event.eventType} - \`${event.path}\``)
    .join("\n");
  const commandEvents = report.commands
    .map((command) => formatCommandEvent(command))
    .join("\n");
  const timeline = [
    ...report.events.map((event) => ({
      timestamp: event.timestamp,
      line: `- ${event.timestamp} - file ${event.eventType} - \`${event.path}\``
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

- Session ID: \`${report.id}\`
- Repository: \`${report.repoRoot}\`
- Started: ${report.startedAt}
- Ended: ${report.endedAt}

## Command history

${COMMAND_CAPTURE_NOTE}

${commandEvents || "No wrapped commands were recorded. Use `abb run -- <command>` during an active session to record command metadata."}

## File events

${fileEvents || "No live file events were recorded."}

## Chronological timeline

${timeline || "No timeline events were recorded."}

## Files added, modified, or deleted

${changedFiles || "No changed files were detected by Git."}
`;
}

export function generateCommandsMarkdown(report: SessionReport): string {
  const commands = report.commands.map((command) => formatCommandEvent(command)).join("\n");

  return `# Agent Black Box Commands

${COMMAND_CAPTURE_NOTE}

## Recorded commands

${commands || "No wrapped commands were recorded."}
`;
}

export function generateSummaryMarkdown(report: SessionReport): string {
  const changedFileCount = report.git.changedFiles.length;
  const commandCount = report.commands.length;
  const highRisks = report.risks.filter((risk) => risk.severity === "high").length;
  const mediumRisks = report.risks.filter((risk) => risk.severity === "medium").length;
  const lowRisks = report.risks.filter((risk) => risk.severity === "low").length;
  const topChangedFiles = report.git.changedFiles
    .slice(0, 12)
    .map((file) => `- ${file.status}: \`${file.path}\``)
    .join("\n");
  const topRisks = report.risks
    .slice(0, 8)
    .map((risk) => `- ${risk.severity.toUpperCase()} - \`${risk.path}\` - ${risk.category}`)
    .join("\n");

  return `# Agent Black Box Summary

## Session

- Session ID: \`${report.id}\`
- Started: ${report.startedAt}
- Ended: ${report.endedAt}
- Finalized by: ${report.finalizedBy}

## At a glance

- Changed files: ${changedFileCount}
- Recorded commands: ${commandCount}
- File watcher events: ${report.events.length}
- Possible secrets: ${report.possibleSecrets.length}
- Risks: ${highRisks} high, ${mediumRisks} medium, ${lowRisks} low
- Risk score: ${report.riskSummary.score}/100 (${report.riskSummary.maxSeverity})

## Review priority

${buildReviewPriority(report)}

## Notable changed files

${topChangedFiles || "No changed files were detected by Git."}

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
  const label = command.label ? ` [${command.label}]` : "";
  const cwd = command.cwd && command.cwd !== "." ? ` cwd \`${command.cwd}\`` : "";
  return `- ${command.startedAt}${label} - command exit ${command.exitCode ?? "unknown"}${cwd} - \`${command.command}\``;
}

export function generateDiffSummaryMarkdown(report: SessionReport): string {
  const rows = report.git.changedFiles
    .map((file) => {
      const insertions = file.insertions ?? 0;
      const deletions = file.deletions ?? 0;
      return `| \`${file.path}\` | ${file.status} | ${insertions} | ${deletions} |`;
    })
    .join("\n");

  const categories = summarizeNotableCategories(report.risks);

  return `# Agent Black Box Diff Summary

## Git status

\`\`\`text
${report.git.statusText}
\`\`\`

## Git diff summary

\`\`\`text
${report.git.diffSummaryText}
\`\`\`

## Changed files

| File | Status | Added lines | Deleted lines |
| --- | --- | ---: | ---: |
${rows || "| None | clean | 0 | 0 |"}

## Notable file categories

${categories || "No notable risky file categories were detected from repository changes."}
`;
}

export function generateRisksMarkdown(report: SessionReport, filter: RiskReportFilter = {}): string {
  const risks = filterRiskFindings(report.risks, filter);
  const filterText = describeRiskFilter(filter);
  const riskyFiles = risks
    .map((risk) => `- ${risk.severity.toUpperCase()} (${risk.score}/100) - \`${risk.path}\` - ${risk.category}: ${risk.reason}`)
    .join("\n");

  const secrets = report.possibleSecrets
    .map((secret) => `- \`${secret.path}:${secret.line}\` - ${secret.reason} Value: ${secret.redacted}`)
    .join("\n");

  const dependencyChanges = risks
    .filter((risk) => ["Lockfile", "Package manager file", "Config file"].includes(risk.category))
    .map((risk) => `- \`${risk.path}\` - ${risk.category}`)
    .join("\n");

  const ciChanges = risks
    .filter((risk) => risk.category === "CI/CD file" || risk.category === "Docker file")
    .map((risk) => `- \`${risk.path}\` - ${risk.category}`)
    .join("\n");

  return `# Agent Black Box Risks

These findings are based on observable repository changes. They are possible review signals, not proof of a vulnerability.

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
  const suggestions = report.git.changedFiles
    .map((file) => {
      const quotedPath = shellQuotePath(file.path);
      if (file.status === "added") {
        return `### \`${file.path}\`

This appears to be an added or untracked file. Review it before removing it manually.

\`\`\`sh
git diff -- ${quotedPath}
\`\`\``;
      }

      return `### \`${file.path}\`

\`\`\`sh
git diff -- ${quotedPath}
git restore -- ${quotedPath}
git checkout -- ${quotedPath}
\`\`\``;
    })
    .join("\n\n");

  return `# Agent Black Box Rollback Hints

Agent Black Box does not automatically revert changes in this MVP. Review every command before running it. \`git restore\`, \`git checkout --\`, file removal, and cleanup commands can discard work.

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
  return categories.map((category) => `- ${category}`).join("\n");
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

  if (report.git.changedFiles.length > 0) {
    return "No risk signals were detected, but changed files should still be reviewed with `git diff`.";
  }

  return "No repository changes were detected.";
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
    ...report.integrity.warnings.slice(0, 8).map((warning) => `- ${warning}`)
  ].join("\n");
}
