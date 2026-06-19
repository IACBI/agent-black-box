import type { ChangedFile, RiskFinding } from "../types.js";
import type { ComparedCommandCount, SessionComparison } from "../session/sessionComparison.js";
import { escapeMarkdownText, markdownInlineCode, markdownTableCode } from "../utils/markdown.js";

export function generateSessionComparisonMarkdown(comparison: SessionComparison): string {
  return `# Agent Black Box Session Comparison

## Sessions

| | Session | Started | Ended | Changes | Commands | Risk score |
| --- | --- | --- | --- | ---: | ---: | ---: |
| From | ${markdownTableCode(comparison.from.id)} | ${comparison.from.startedAt} | ${comparison.from.endedAt} | ${comparison.from.sessionRelevantChangeCount} | ${comparison.from.commandCount} | ${comparison.from.riskScore}/100 |
| To | ${markdownTableCode(comparison.to.id)} | ${comparison.to.startedAt} | ${comparison.to.endedAt} | ${comparison.to.sessionRelevantChangeCount} | ${comparison.to.commandCount} | ${comparison.to.riskScore}/100 |

## HEAD comparison

| Revision | From session | To session |
| --- | --- | --- |
| Start HEAD | ${formatHead(comparison.heads.fromStart)} | ${formatHead(comparison.heads.toStart)} |
| End HEAD | ${formatHead(comparison.heads.fromEnd)} | ${formatHead(comparison.heads.toEnd)} |

- Same end HEAD: ${comparison.heads.sameEndHead ? "yes" : "no"}

## File comparison

### Only in from session

${formatFiles(comparison.files.onlyInFrom)}

### Only in to session

${formatFiles(comparison.files.onlyInTo)}

### Shared paths with changed details

${formatChangedFiles(comparison.files.changed)}

- Shared paths with equivalent reported details: ${comparison.files.sharedEquivalentCount}

## Risk comparison

- From score: ${comparison.risks.fromScore}/100
- To score: ${comparison.risks.toScore}/100
- Score delta: ${formatDelta(comparison.risks.scoreDelta)}

### Risks only in from session

${formatRisks(comparison.risks.onlyInFrom)}

### Risks only in to session

${formatRisks(comparison.risks.onlyInTo)}

## Command comparison

- From commands: ${comparison.commands.fromCount}
- To commands: ${comparison.commands.toCount}
- Count delta: ${formatDelta(comparison.commands.countDelta)}
- Failed commands: ${comparison.commands.fromFailedCount} from, ${comparison.commands.toFailedCount} to

${formatCommandCounts(comparison.commands.changedCounts)}
`;
}

function formatFiles(files: ChangedFile[]): string {
  return files.length > 0
    ? files.map((file) => `- ${file.status}: ${markdownInlineCode(file.path)}`).join("\n")
    : "None.";
}

function formatChangedFiles(files: SessionComparison["files"]["changed"]): string {
  if (files.length === 0) {
    return "None.";
  }

  return [
    "| File | From status | To status | From +/- | To +/- |",
    "| --- | --- | --- | ---: | ---: |",
    ...files.map(
      (file) =>
        `| ${markdownTableCode(file.path)} | ${file.from.status} | ${file.to.status} | ${formatLineStats(file.from)} | ${formatLineStats(file.to)} |`
    )
  ].join("\n");
}

function formatRisks(risks: RiskFinding[]): string {
  return risks.length > 0
    ? risks
        .map(
          (risk) =>
            `- ${risk.severity.toUpperCase()} - ${markdownInlineCode(risk.path)} - ${escapeMarkdownText(risk.category)}: ${escapeMarkdownText(risk.reason)}`
        )
        .join("\n")
    : "None.";
}

function formatCommandCounts(commands: ComparedCommandCount[]): string {
  if (commands.length === 0) {
    return "No command frequency differences were detected.";
  }

  return [
    "| Command | CWD | Context | Exit | From count | To count |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    ...commands.map(
      (command) =>
        `| ${markdownTableCode(command.command)} | ${markdownTableCode(command.cwd)} | ${formatCommandContext(command)} | ${command.exitCode ?? "unknown"} | ${command.fromCount} | ${command.toCount} |`
    )
  ].join("\n");
}

function formatHead(head: string | undefined): string {
  return head ? markdownTableCode(head) : "unavailable";
}

function formatDelta(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function formatLineStats(file: ChangedFile): string {
  return `+${file.insertions ?? "?"}/-${file.deletions ?? "?"}`;
}

function formatCommandContext(command: ComparedCommandCount): string {
  const parts = [command.label, command.group, command.phase].filter(Boolean).map((value) => escapeMarkdownText(value!));
  return parts.length > 0 ? parts.join(" / ") : "none";
}
