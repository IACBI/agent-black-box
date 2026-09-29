import { availableParallelism } from "node:os";
import type { AgentBlackBoxConfig, ChangedFile, SecretFinding } from "../types.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { inspectTextFile } from "../utils/fileInspection.js";
import { resolveRepoPath } from "../utils/paths.js";

const FILE_SCAN_CONCURRENCY = Math.min(8, availableParallelism());

const SECRET_KEYWORD_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key)/i;

const SECRET_PATTERNS: Array<{ name: string; matches: (line: string) => boolean }> = [
  { name: "AWS access key-like value", matches: (line) => /AKIA[0-9A-Z]{16}/.test(line) },
  { name: "GitHub token-like value", matches: (line) => /gh[pousr]_[A-Za-z0-9_]{20,}/.test(line) },
  { name: "Slack token-like value", matches: (line) => /xox[baprs]-[A-Za-z0-9-]{20,}/.test(line) },
  { name: "JWT-like value", matches: hasJwtLikeValue },
  {
    name: "Secret assignment-like value",
    matches: (line) =>
      /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9_./+=:-]{12,})["']?/i.test(
        line
      ),
  },
];

export async function detectPossibleSecrets(
  repoRoot: string,
  changedFiles: ChangedFile[],
  config: AgentBlackBoxConfig
): Promise<SecretFinding[]> {
  const scannableFiles = changedFiles.filter((file) => file.status !== "deleted");
  const findings = (
    await mapWithConcurrency(scannableFiles, FILE_SCAN_CONCURRENCY, async (file) => {
      const absolutePath = resolveRepoPath(repoRoot, file.path);
      if (!absolutePath) {
        return [];
      }
      return detectSecretsInFile(absolutePath, file.path, config.maxFileSizeKb, repoRoot);
    })
  ).flat();

  return dedupeSecretFindings(findings);
}

export async function detectSecretsInFile(
  absolutePath: string,
  relativePath: string,
  maxFileSizeKb: number,
  trustedRoot?: string
): Promise<SecretFinding[]> {
  const inspection = await inspectTextFile(absolutePath, maxFileSizeKb * 1024, undefined, trustedRoot);
  if (inspection.kind !== "text" || inspection.text === undefined) {
    return [];
  }

  const findings: SecretFinding[] = [];
  const lines = inspection.text.split(/\r?\n/);

  lines.forEach((line, index) => {
    findings.push(...detectSecretsInLine(relativePath, line, index + 1));
  });

  return dedupeSecretFindings(findings);
}

export function detectSecretsInLine(relativePath: string, line: string, lineNumber: number): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const { name, matches } of SECRET_PATTERNS) {
    if (matches(line)) {
      findings.push({
        path: relativePath,
        line: lineNumber,
        reason: `Possible ${name} detected.`,
        redacted: "<redacted>",
      });
    }
  }

  if (SECRET_KEYWORD_PATTERN.test(line)) {
    const tokens = line.match(/[A-Za-z0-9_./+=:-]{32,}/g) ?? [];
    for (const token of tokens) {
      if (looksLikeCodeIdentifierPath(token)) {
        continue;
      }

      if (shannonEntropy(token) >= 4.0) {
        findings.push({
          path: relativePath,
          line: lineNumber,
          reason: "Possible high-entropy secret-like value near a sensitive keyword.",
          redacted: "<redacted>",
        });
        break;
      }
    }
  }

  return findings;
}

function hasJwtLikeValue(line: string): boolean {
  let previousEnd = -1;
  let previousCanBeHeader = false;
  let previousCanBePayload = false;

  // Scan each component once; retrying a greedy regex at every "eyJ" is quadratic.
  for (const match of line.matchAll(/[A-Za-z0-9_-]+/g)) {
    const component = match[0];
    const followsDot = match.index === previousEnd + 1 && line[previousEnd] === ".";
    if (followsDot && previousCanBePayload && component.length >= 10) {
      return true;
    }

    previousCanBePayload = followsDot && previousCanBeHeader && component.length >= 10;
    const headerStart = component.indexOf("eyJ");
    previousCanBeHeader = headerStart >= 0 && component.length - headerStart >= 13;
    previousEnd = match.index + component.length;
  }

  return false;
}

function looksLikeCodeIdentifierPath(value: string): boolean {
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const segments = value.split(".");

  return segments.length > 1 && segments.every((segment) => identifier.test(segment));
}

export function shannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const frequencies = new Map<string, number>();
  let characterCount = 0;
  for (const char of value) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
    characterCount += 1;
  }

  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / characterCount;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

function dedupeSecretFindings(findings: SecretFinding[]): SecretFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.path}:${finding.line}:${finding.reason}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
