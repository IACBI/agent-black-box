import type { ChangedFile, CommandEvent, RiskFinding, SessionReport } from "../types.js";
import { selectSessionRelevantChanges } from "./changeEvidence.js";

export interface ComparedSessionSummary {
  id: string;
  startedAt: string;
  endedAt: string;
  sessionRelevantChangeCount: number;
  commandCount: number;
  riskScore: number;
}

export interface ComparedFileChange {
  path: string;
  from: ChangedFile;
  to: ChangedFile;
}

export interface ComparedCommandCount {
  command: string;
  cwd: string;
  label?: string;
  group?: string;
  phase?: string;
  exitCode: number | null;
  fromCount: number;
  toCount: number;
}

export interface SessionComparison {
  from: ComparedSessionSummary;
  to: ComparedSessionSummary;
  heads: {
    fromStart?: string;
    fromEnd?: string;
    toStart?: string;
    toEnd?: string;
    sameEndHead: boolean;
  };
  files: {
    onlyInFrom: ChangedFile[];
    onlyInTo: ChangedFile[];
    changed: ComparedFileChange[];
    sharedEquivalentCount: number;
  };
  risks: {
    fromScore: number;
    toScore: number;
    scoreDelta: number;
    onlyInFrom: RiskFinding[];
    onlyInTo: RiskFinding[];
  };
  commands: {
    fromCount: number;
    toCount: number;
    countDelta: number;
    fromFailedCount: number;
    toFailedCount: number;
    changedCounts: ComparedCommandCount[];
  };
}

export function buildSessionComparison(fromReport: SessionReport, toReport: SessionReport): SessionComparison {
  if (fromReport.id === toReport.id) {
    throw new Error("Session comparison requires two different sessions.");
  }

  const fromFiles = selectSessionRelevantChanges(fromReport.git, fromReport.changeEvidence);
  const toFiles = selectSessionRelevantChanges(toReport.git, toReport.changeEvidence);
  const fromFilesByPath = new Map(fromFiles.map((file) => [file.path, file]));
  const toFilesByPath = new Map(toFiles.map((file) => [file.path, file]));
  const sharedPaths = [...fromFilesByPath.keys()].filter((filePath) => toFilesByPath.has(filePath));
  const changed = sharedPaths
    .filter((filePath) => !sameChangedFile(fromFilesByPath.get(filePath)!, toFilesByPath.get(filePath)!))
    .map((filePath) => ({
      path: filePath,
      from: fromFilesByPath.get(filePath)!,
      to: toFilesByPath.get(filePath)!
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const fromRisksByKey = new Map(fromReport.risks.map((risk) => [riskKey(risk), risk]));
  const toRisksByKey = new Map(toReport.risks.map((risk) => [riskKey(risk), risk]));
  const changedCommandCounts = compareCommandCounts(fromReport.commands, toReport.commands);

  return {
    from: summarizeSession(fromReport, fromFiles.length),
    to: summarizeSession(toReport, toFiles.length),
    heads: {
      ...(fromReport.baseline?.git.head ? { fromStart: fromReport.baseline.git.head } : {}),
      ...(fromReport.git.head ? { fromEnd: fromReport.git.head } : {}),
      ...(toReport.baseline?.git.head ? { toStart: toReport.baseline.git.head } : {}),
      ...(toReport.git.head ? { toEnd: toReport.git.head } : {}),
      sameEndHead: fromReport.git.head === toReport.git.head
    },
    files: {
      onlyInFrom: fromFiles.filter((file) => !toFilesByPath.has(file.path)).sort(compareChangedFiles),
      onlyInTo: toFiles.filter((file) => !fromFilesByPath.has(file.path)).sort(compareChangedFiles),
      changed,
      sharedEquivalentCount: sharedPaths.length - changed.length
    },
    risks: {
      fromScore: fromReport.riskSummary.score,
      toScore: toReport.riskSummary.score,
      scoreDelta: toReport.riskSummary.score - fromReport.riskSummary.score,
      onlyInFrom: fromReport.risks.filter((risk) => !toRisksByKey.has(riskKey(risk))).sort(compareRisks),
      onlyInTo: toReport.risks.filter((risk) => !fromRisksByKey.has(riskKey(risk))).sort(compareRisks)
    },
    commands: {
      fromCount: fromReport.commands.length,
      toCount: toReport.commands.length,
      countDelta: toReport.commands.length - fromReport.commands.length,
      fromFailedCount: countFailedCommands(fromReport.commands),
      toFailedCount: countFailedCommands(toReport.commands),
      changedCounts: changedCommandCounts
    }
  };
}

function summarizeSession(report: SessionReport, sessionRelevantChangeCount: number): ComparedSessionSummary {
  return {
    id: report.id,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    sessionRelevantChangeCount,
    commandCount: report.commands.length,
    riskScore: report.riskSummary.score
  };
}

function compareCommandCounts(fromCommands: CommandEvent[], toCommands: CommandEvent[]): ComparedCommandCount[] {
  const fromCounts = countCommands(fromCommands);
  const toCounts = countCommands(toCommands);
  const keys = new Set([...fromCounts.keys(), ...toCounts.keys()]);

  return [...keys]
    .map((key) => {
      const from = fromCounts.get(key);
      const to = toCounts.get(key);
      const command = from?.command ?? to!.command;
      return {
        command: command.command,
        cwd: command.cwd,
        ...(command.label ? { label: command.label } : {}),
        ...(command.group ? { group: command.group } : {}),
        ...(command.phase ? { phase: command.phase } : {}),
        exitCode: command.exitCode,
        fromCount: from?.count ?? 0,
        toCount: to?.count ?? 0
      };
    })
    .filter((command) => command.fromCount !== command.toCount)
    .sort((left, right) => left.command.localeCompare(right.command) || left.cwd.localeCompare(right.cwd));
}

function countCommands(commands: CommandEvent[]): Map<string, { command: CommandEvent; count: number }> {
  const counts = new Map<string, { command: CommandEvent; count: number }>();
  for (const command of commands) {
    const key = JSON.stringify([
      command.command,
      command.cwd,
      command.label ?? "",
      command.group ?? "",
      command.phase ?? "",
      command.exitCode
    ]);
    const current = counts.get(key);
    counts.set(key, { command, count: (current?.count ?? 0) + 1 });
  }
  return counts;
}

function countFailedCommands(commands: CommandEvent[]): number {
  return commands.filter((command) => command.exitCode !== null && command.exitCode !== 0).length;
}

function riskKey(risk: RiskFinding): string {
  return JSON.stringify([risk.path, risk.category, risk.severity, risk.score, risk.reason]);
}

function sameChangedFile(left: ChangedFile, right: ChangedFile): boolean {
  return (
    left.status === right.status &&
    left.insertions === right.insertions &&
    left.deletions === right.deletions &&
    left.kind === right.kind &&
    left.sizeBytes === right.sizeBytes &&
    left.lineStatsSource === right.lineStatsSource
  );
}

function compareChangedFiles(left: ChangedFile, right: ChangedFile): number {
  return left.path.localeCompare(right.path) || left.status.localeCompare(right.status);
}

function compareRisks(left: RiskFinding, right: RiskFinding): number {
  return left.path.localeCompare(right.path) || left.category.localeCompare(right.category);
}
