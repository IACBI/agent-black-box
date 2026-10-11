import { selectSessionRelevantChanges } from "../session/changeEvidence.js";
import type { CommandEvent, RiskFinding, RiskSeverity, SecretFinding, SessionReport } from "../types.js";
import {
  escapeMarkdownTableCell,
  escapeMarkdownText,
  markdownInlineCode,
  markdownTableCode,
} from "../utils/markdown.js";
import { formatTerminalValue } from "../utils/terminal.js";

/** First line of every generated comment, so tooling can find and update an earlier comment. */
export const PR_COMMENT_MARKER = "<!-- agent-black-box:session-summary -->";

/** GitHub rejects comment bodies above 65,536 characters; leave headroom. */
export const DEFAULT_PR_COMMENT_MAX_LENGTH = 60_000;

const MAX_TABLE_ROWS = 15;
const MAX_SECRET_LINES = 20;
const MAX_CHANGED_FILES = 30;
const MAX_INTEGRITY_WARNINGS = 10;
const MAX_COMMAND_LENGTH = 160;
const MAX_PATH_LENGTH = 200;
const MAX_REASON_LENGTH = 300;
const MAX_CATEGORY_LENGTH = 80;

const FOOTER =
  "---\n<sub>Generated locally by Agent Black Box. Findings are heuristic review signals, not a security scan.</sub>";
const TRUNCATION_NOTICE =
  "> **Truncated:** this comment was cut to fit the size limit. Run `abb export` locally for the full report.";
const SHORT_TRUNCATION_NOTICE = "> **Truncated.**";

// Bidirectional controls and zero-width characters can disguise a path or command; show them as text instead.
const INVISIBLE_FORMAT_CHARACTERS = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

const SEVERITY_RANK: Record<RiskSeverity, number> = { high: 3, medium: 2, low: 1 };

export interface PullRequestCommentOptions {
  /** Hard cap on the returned string length. Defaults to {@link DEFAULT_PR_COMMENT_MAX_LENGTH}. */
  maxLength?: number;
}

/** A piece of output that truncation never splits. */
interface Unit {
  text: string;
  opensDetails?: boolean;
  closesDetails?: boolean;
}

/**
 * Renders a compact GitHub-flavoured Markdown summary of a session, intended for
 * `gh pr comment --body-file -`. The result starts with {@link PR_COMMENT_MARKER}, ends with a newline and
 * never exceeds `maxLength` characters. Over-long output is cut between lines and flagged with a notice; a
 * `maxLength` too small for even the marker and the notice yields a cut-off prefix of them.
 */
export function generatePullRequestComment(report: SessionReport, options: PullRequestCommentOptions = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_PR_COMMENT_MAX_LENGTH;
  if (!Number.isInteger(maxLength) || maxLength < 1) {
    throw new RangeError("maxLength must be a positive integer.");
  }

  const units = buildUnits(report);
  const full = `${[...units, { text: "" }, { text: FOOTER }].map((unit) => unit.text).join("\n")}\n`;
  if (full.length <= maxLength) {
    return full;
  }

  return truncate(units, maxLength);
}

function buildUnits(report: SessionReport): Unit[] {
  const units: Unit[] = [];
  const add = (...texts: string[]): void => {
    units.push(...texts.map((text) => ({ text })));
  };
  const gap = (): void => add("");

  const risks = sortRisks(report.risks);
  const secrets = sortSecrets(report.possibleSecrets);
  const changedFiles = selectSessionRelevantChanges(report.git, report.changeEvidence);
  const failedCommands = report.commands.filter((command) => command.exitCode !== 0).length;

  add(PR_COMMENT_MARKER, `## Agent Black Box session ${code(shortSessionId(report.id))}`);
  gap();
  add(buildMetaLine(report));
  gap();
  add(buildVerdictLine(report, changedFiles.length, failedCommands));

  // A reviewer must know when the configured allowlist hid findings, or the comment would look cleaner than it is.
  const hiddenSecrets = report.riskSummary.allowlistedSecretCount ?? 0;
  if (hiddenSecrets > 0) {
    gap();
    add(`${plural(hiddenSecrets, "possible secret")} hidden by the configured allowlist.`);
  }

  if (hasIntegrityIssues(report.integrity)) {
    gap();
    units.push(...buildIntegrityUnits(report.integrity));
  }

  if (risks.length === 0 && secrets.length === 0) {
    gap();
    add(
      hiddenSecrets > 0
        ? "No risk signals or unsuppressed possible secrets were detected in this session's changes."
        : "No risk signals or possible secrets were detected in this session's changes."
    );
  }

  if (risks.length > 0) {
    gap();
    add(`### Risks (${risks.length})`);
    gap();
    units.push({ text: "| Severity | Category | Path | Reason |\n| --- | --- | --- | --- |" });
    for (const risk of risks.slice(0, MAX_TABLE_ROWS)) {
      add(
        `| ${risk.severity.toUpperCase()} | ${cell(risk.category, MAX_CATEGORY_LENGTH)} | ${tableCode(risk.path, MAX_PATH_LENGTH)} | ${cell(risk.reason, MAX_REASON_LENGTH)} |`
      );
    }
    addOverflow(units, risks.length, MAX_TABLE_ROWS, "risks");
  }

  if (secrets.length > 0) {
    gap();
    add(`### Possible secrets (${secrets.length})`);
    gap();
    add("Locations only; values are never included. Rotate any real credential.");
    gap();
    for (const secret of secrets.slice(0, MAX_SECRET_LINES)) {
      add(`- ${code(`${truncateText(secret.path, MAX_PATH_LENGTH)}:${secret.line}`)}`);
    }
    addOverflow(units, secrets.length, MAX_SECRET_LINES, "locations");
  }

  gap();
  if (report.commands.length === 0) {
    add("No commands were recorded. Only commands run through `abb run -- <command>` are captured.");
  } else {
    const shown = selectCommands(report.commands);
    add(`### Commands (${report.commands.length})`);
    gap();
    units.push({ text: "| Command | Exit | Duration |\n| --- | --- | --- |" });
    for (const command of shown) {
      add(
        `| ${tableCode(command.command, MAX_COMMAND_LENGTH)} | ${formatExit(command)} | ${formatDuration(command.durationMs)} |`
      );
    }
    addOverflow(units, report.commands.length, shown.length, "commands");
  }

  if (changedFiles.length > 0) {
    gap();
    units.push({
      text: `<details>\n<summary>Session-relevant changed files (${changedFiles.length})</summary>`,
      opensDetails: true,
    });
    gap();
    for (const file of changedFiles.slice(0, MAX_CHANGED_FILES)) {
      add(`- ${escapeMarkdownText(file.status)}: ${code(truncateText(file.path, MAX_PATH_LENGTH))}`);
    }
    addOverflow(units, changedFiles.length, MAX_CHANGED_FILES, "files");
    gap();
    units.push({ text: "</details>", closesDetails: true });
  }

  return units;
}

function buildMetaLine(report: SessionReport): string {
  const parts: string[] = [];
  if (report.git.branch) {
    parts.push(`Branch ${code(report.git.branch)}`);
  }

  const startHead = report.baseline?.git.head;
  const endHead = report.git.head;
  if (startHead && endHead && startHead !== endHead) {
    parts.push(`HEAD ${code(shortSha(startHead))} to ${code(shortSha(endHead))}`);
  } else if (endHead ?? startHead) {
    const head = endHead ?? startHead ?? "";
    parts.push(`HEAD ${code(shortSha(head))}${startHead && endHead ? " (unchanged)" : ""}`);
  }

  if (!report.changeEvidence?.baselineAvailable) {
    parts.push("start baseline unavailable, so pre-existing changes cannot be separated");
  }

  return parts.length > 0 ? parts.join(" - ") : "No Git branch or HEAD information was recorded.";
}

function buildVerdictLine(report: SessionReport, changedFileCount: number, failedCommands: number): string {
  const counts: Record<RiskSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const risk of report.risks) {
    counts[risk.severity] += 1;
  }

  const secretCount = report.possibleSecrets.length;
  const label =
    secretCount > 0 || counts.high > 0
      ? "HIGH"
      : counts.medium > 0
        ? "MEDIUM"
        : counts.low > 0
          ? "LOW"
          : "no risks detected";
  const commandSummary =
    report.commands.length === 0
      ? "no commands recorded"
      : `${plural(report.commands.length, "command")} run, ${failedCommands} failed`;

  return `**Verdict: ${label}** - ${counts.high} high, ${counts.medium} medium, ${counts.low} low risks; ${plural(secretCount, "possible secret")}; ${plural(changedFileCount, "session-relevant changed file")}; ${commandSummary}.`;
}

function hasIntegrityIssues(integrity: SessionReport["integrity"]): boolean {
  return (
    integrity.warnings.length > 0 ||
    integrity.discardedFileEventLines > 0 ||
    integrity.discardedCommandEventLines > 0 ||
    (integrity.droppedFileEvents ?? 0) > 0 ||
    (integrity.failedFileEventWrites ?? 0) > 0
  );
}

function buildIntegrityUnits(integrity: SessionReport["integrity"]): Unit[] {
  const lines: string[] = [];
  const counters: Array<[string, number | undefined]> = [
    ["Dropped watcher file events", integrity.droppedFileEvents],
    ["Failed file event writes", integrity.failedFileEventWrites],
    ["Discarded file event lines", integrity.discardedFileEventLines],
    ["Discarded command event lines", integrity.discardedCommandEventLines],
  ];
  for (const [label, value] of counters) {
    if (value !== undefined && value > 0) {
      lines.push(`- ${label}: ${value}`);
    }
  }
  for (const warning of integrity.warnings.slice(0, MAX_INTEGRITY_WARNINGS)) {
    lines.push(`- ${text(warning, MAX_REASON_LENGTH)}`);
  }
  if (integrity.warnings.length > MAX_INTEGRITY_WARNINGS) {
    lines.push(`- +${integrity.warnings.length - MAX_INTEGRITY_WARNINGS} more warnings not shown`);
  }

  return [
    { text: "### Integrity / capture warnings" },
    { text: "" },
    { text: "> Capture was incomplete for this session. Treat the lists below as a lower bound." },
    { text: "" },
    ...lines.map((line) => ({ text: line })),
  ];
}

/** Failed commands take priority for the limited rows, but rows stay in recorded order. */
function selectCommands(commands: CommandEvent[]): CommandEvent[] {
  const indexed = commands.map((command, index) => ({ command, index, failed: command.exitCode !== 0 }));
  return [...indexed.filter((entry) => entry.failed), ...indexed.filter((entry) => !entry.failed)]
    .slice(0, MAX_TABLE_ROWS)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.command);
}

function addOverflow(units: Unit[], total: number, shown: number, noun: string): void {
  if (total > shown) {
    units.push({ text: "" }, { text: `+${total - shown} more ${noun} not shown.` });
  }
}

function truncate(units: Unit[], maxLength: number): string {
  const variants: Array<{ notice: string; footer: boolean }> = [
    { notice: TRUNCATION_NOTICE, footer: true },
    { notice: TRUNCATION_NOTICE, footer: false },
    { notice: SHORT_TRUNCATION_NOTICE, footer: false },
  ];

  for (const variant of variants) {
    for (let keep = units.length - 1; keep >= 1; keep -= 1) {
      const candidate = renderTruncated(units.slice(0, keep), variant.notice, variant.footer);
      if (candidate.length <= maxLength) {
        return candidate;
      }
    }
  }

  const minimal = `${PR_COMMENT_MARKER}\n${SHORT_TRUNCATION_NOTICE}`;
  return `${minimal.slice(0, maxLength - 1)}\n`;
}

function renderTruncated(kept: Unit[], notice: string, footer: boolean): string {
  const trimmed = [...kept];
  while (trimmed.length > 1) {
    const last = trimmed[trimmed.length - 1] as Unit;
    // An orphaned heading or separator blank line would read as a broken section.
    if (last.text === "" || last.text.startsWith("#")) {
      trimmed.pop();
    } else {
      break;
    }
  }

  const openDetails = trimmed.reduce(
    (depth, unit) => depth + (unit.opensDetails ? 1 : 0) - (unit.closesDetails ? 1 : 0),
    0
  );
  const lines = trimmed.map((unit) => unit.text);
  if (openDetails > 0) {
    lines.push("", ...Array.from({ length: openDetails }, () => "</details>"));
  }
  lines.push("", notice);
  if (footer) {
    lines.push("", FOOTER);
  }

  return `${lines.join("\n")}\n`;
}

function sortRisks(risks: RiskFinding[]): RiskFinding[] {
  return [...risks].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.score - a.score ||
      compareText(a.path, b.path) ||
      compareText(a.category, b.category) ||
      compareText(a.reason, b.reason)
  );
}

function sortSecrets(secrets: SecretFinding[]): SecretFinding[] {
  return [...secrets].sort((a, b) => compareText(a.path, b.path) || a.line - b.line);
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

function shortSessionId(id: string): string {
  const shortened = id.replace(/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "$1");
  return truncateText(shortened, 48);
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatExit(command: CommandEvent): string {
  if (command.exitCode === null) {
    return "unknown (failed)";
  }

  return command.exitCode === 0 ? "0" : `${command.exitCode} (failed)`;
}

function formatDuration(durationMs: number): string {
  return Number.isFinite(durationMs) && durationMs >= 0 ? `${(durationMs / 1000).toFixed(1)}s` : "unknown";
}

function revealInvisible(value: string): string {
  return value.replace(
    INVISIBLE_FORMAT_CHARACTERS,
    (character) => `<U+${(character.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}>`
  );
}

/** Cuts by code point so a surrogate pair is never split. */
function truncateText(value: string, maxLength: number): string {
  const characters = [...value];
  return characters.length > maxLength ? `${characters.slice(0, maxLength).join("")}...` : value;
}

// A zero-width space after "@" stops GitHub from turning repository text into a user or team mention.
function defuseMentions(value: string): string {
  return value.replace(/@/g, "@\u200b");
}

function code(value: string): string {
  return markdownInlineCode(formatTerminalValue(revealInvisible(value)));
}

function tableCode(value: string, maxLength: number): string {
  return markdownTableCode(formatTerminalValue(revealInvisible(truncateText(value, maxLength))));
}

function text(value: string, maxLength: number): string {
  return defuseMentions(escapeMarkdownText(revealInvisible(truncateText(value, maxLength))));
}

function cell(value: string, maxLength: number): string {
  return defuseMentions(escapeMarkdownTableCell(revealInvisible(truncateText(value, maxLength))));
}
