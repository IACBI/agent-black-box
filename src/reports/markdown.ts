import type {
  AgentBlackBoxConfig,
  CommandEvent,
  FileEvent,
  GitSnapshot,
  RiskFinding,
  SecretFinding,
  SessionReport
} from "../types.js";
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
  possibleSecrets: SecretFinding[]
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
    possibleSecrets
  };
}

export function generateTimelineMarkdown(report: SessionReport): string {
  const changedFiles = report.git.changedFiles.map((file) => `- ${file.status}: \`${file.path}\``).join("\n");
  const fileEvents = report.events
    .map((event) => `- ${event.timestamp} - ${event.eventType} - \`${event.path}\``)
    .join("\n");
  const commandEvents = report.commands
    .map((command) => `- ${command.startedAt} - command exit ${command.exitCode ?? "unknown"} - \`${command.command}\``)
    .join("\n");
  const timeline = [
    ...report.events.map((event) => ({
      timestamp: event.timestamp,
      line: `- ${event.timestamp} - file ${event.eventType} - \`${event.path}\``
    })),
    ...report.commands.map((command) => ({
      timestamp: command.startedAt,
      line: `- ${command.startedAt} - command exit ${command.exitCode ?? "unknown"} - \`${command.command}\``
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

export function generateRisksMarkdown(report: SessionReport): string {
  const riskyFiles = report.risks
    .map((risk) => `- ${risk.severity.toUpperCase()} - \`${risk.path}\` - ${risk.category}: ${risk.reason}`)
    .join("\n");

  const secrets = report.possibleSecrets
    .map((secret) => `- \`${secret.path}:${secret.line}\` - ${secret.reason} Value: ${secret.redacted}`)
    .join("\n");

  const dependencyChanges = report.risks
    .filter((risk) => ["Lockfile", "Package manager file", "Config file"].includes(risk.category))
    .map((risk) => `- \`${risk.path}\` - ${risk.category}`)
    .join("\n");

  const ciChanges = report.risks
    .filter((risk) => risk.category === "CI/CD file" || risk.category === "Docker file")
    .map((risk) => `- \`${risk.path}\` - ${risk.category}`)
    .join("\n");

  return `# Agent Black Box Risks

These findings are based on observable repository changes. They are possible review signals, not proof of a vulnerability.

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
