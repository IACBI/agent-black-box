import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentBlackBoxConfig, ChangedFile, SecretFinding } from "../types.js";

const SECRET_KEYWORD_PATTERN = /(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key)/i;

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "AWS access key-like value", pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "GitHub token-like value", pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: "Slack token-like value", pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/g },
  { name: "JWT-like value", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: "Secret assignment-like value",
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9_./+=:-]{12,})["']?/gi
  }
];

export async function detectPossibleSecrets(
  repoRoot: string,
  changedFiles: ChangedFile[],
  config: AgentBlackBoxConfig
): Promise<SecretFinding[]> {
  const findings: SecretFinding[] = [];

  for (const file of changedFiles) {
    if (file.status === "deleted") {
      continue;
    }

    const absolutePath = path.join(repoRoot, file.path);
    const fileFindings = await detectSecretsInFile(absolutePath, file.path, config.maxFileSizeKb);
    findings.push(...fileFindings);
  }

  return dedupeSecretFindings(findings);
}

export async function detectSecretsInFile(
  absolutePath: string,
  relativePath: string,
  maxFileSizeKb: number
): Promise<SecretFinding[]> {
  let stats;
  try {
    stats = await stat(absolutePath);
  } catch {
    return [];
  }

  if (!stats.isFile() || stats.size > maxFileSizeKb * 1024) {
    return [];
  }

  let content: string;
  try {
    content = await readFile(absolutePath, "utf8");
  } catch {
    return [];
  }

  if (content.includes("\u0000")) {
    return [];
  }

  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    findings.push(...detectSecretsInLine(relativePath, line, index + 1));
  });

  return dedupeSecretFindings(findings);
}

export function detectSecretsInLine(relativePath: string, line: string, lineNumber: number): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(line)) {
      findings.push({
        path: relativePath,
        line: lineNumber,
        reason: `Possible ${name} detected.`,
        redacted: "<redacted>"
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
          redacted: "<redacted>"
        });
        break;
      }
    }
  }

  return dedupeSecretFindings(findings);
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
  for (const char of value) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
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
