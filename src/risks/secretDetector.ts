import { availableParallelism } from "node:os";
import type { AgentBlackBoxConfig, ChangedFile, SecretFinding } from "../types.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { inspectTextFile } from "../utils/fileInspection.js";
import { resolveRepoPath } from "../utils/paths.js";
import {
  compileSecretRules,
  isLineAllowlisted,
  matchCustomSecretPatterns,
  NO_SECRET_RULES,
  type CompiledSecretRules,
} from "./secretRules.js";

const FILE_SCAN_CONCURRENCY = Math.min(8, availableParallelism());

const SECRET_KEYWORD_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key)/i;

const AWS_ACCESS_KEY = /AKIA[0-9A-Z]{16}/;
const GITHUB_TOKEN = /gh[pousr]_[A-Za-z0-9_]{20,}/;
const SLACK_TOKEN = /xox[baprs]-[A-Za-z0-9-]{20,}/;
// Real keys are random, so requiring a digit rejects long kebab-case identifiers that merely start with "sk-".
const LLM_API_KEY = /\bsk-(?:ant-|proj-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}/;
const STRIPE_LIVE_KEY = /\b[sr]k_live_[A-Za-z0-9]{16,}/;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}/;
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

const SECRET_PATTERNS: Array<{ name: string; matches: (line: string) => boolean }> = [
  { name: "AWS access key-like value", matches: (line) => AWS_ACCESS_KEY.test(line) },
  { name: "GitHub token-like value", matches: (line) => GITHUB_TOKEN.test(line) },
  { name: "Slack token-like value", matches: (line) => SLACK_TOKEN.test(line) },
  { name: "LLM API key-like value", matches: (line) => LLM_API_KEY.test(line) },
  { name: "Stripe live key-like value", matches: (line) => STRIPE_LIVE_KEY.test(line) },
  { name: "Google API key-like value", matches: (line) => GOOGLE_API_KEY.test(line) },
  { name: "JWT-like value", matches: hasJwtLikeValue },
  { name: "Private key block", matches: (line) => PRIVATE_KEY_HEADER.test(line) },
  {
    name: "Secret assignment-like value",
    matches: (line) =>
      /(?<![A-Za-z0-9])(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key)\b["']?\s*[:=]\s*["']?([A-Za-z0-9_./+=:-]{12,})["']?/i.test(
        line
      ),
  },
];

const REDACTABLE_TOKENS = [
  AWS_ACCESS_KEY,
  GITHUB_TOKEN,
  SLACK_TOKEN,
  LLM_API_KEY,
  STRIPE_LIVE_KEY,
  GOOGLE_API_KEY,
  JWT_SHAPE,
].map((expression) => new RegExp(expression.source, "g"));

export interface SecretLineScan {
  findings: SecretFinding[];
  /** Findings that matched but were suppressed by the configured allowlist. */
  allowlisted: number;
}

export interface SecretScanResult {
  findings: SecretFinding[];
  allowlisted: number;
}

/**
 * Replaces provider-issued token shapes (cloud keys, API tokens, JWTs) with `<redacted>`. Used to scrub
 * recorded command text, where a bare token has no variable name or flag to give it away.
 */
export function redactKnownSecretTokens(text: string): string {
  let result = text;
  for (const expression of REDACTABLE_TOKENS) {
    result = result.replace(expression, "<redacted>");
  }
  return result;
}

export async function detectPossibleSecrets(
  repoRoot: string,
  changedFiles: ChangedFile[],
  config: AgentBlackBoxConfig
): Promise<SecretFinding[]> {
  return (await scanChangedFilesForSecrets(repoRoot, changedFiles, config)).findings;
}

/** Like {@link detectPossibleSecrets}, but also reports how many findings the allowlist suppressed. */
export async function scanChangedFilesForSecrets(
  repoRoot: string,
  changedFiles: ChangedFile[],
  config: AgentBlackBoxConfig
): Promise<SecretScanResult> {
  const rules = compileSecretRules(config);
  const scannableFiles = changedFiles.filter((file) => file.status !== "deleted");
  const results = await mapWithConcurrency(scannableFiles, FILE_SCAN_CONCURRENCY, async (file) => {
    const absolutePath = resolveRepoPath(repoRoot, file.path);
    if (!absolutePath) {
      return { findings: [], allowlisted: 0 };
    }
    return scanSecretsInFile(absolutePath, file.path, config.maxFileSizeKb, repoRoot, rules);
  });

  return {
    findings: dedupeSecretFindings(results.flatMap((result) => result.findings)),
    allowlisted: results.reduce((total, result) => total + result.allowlisted, 0),
  };
}

export async function detectSecretsInFile(
  absolutePath: string,
  relativePath: string,
  maxFileSizeKb: number,
  trustedRoot?: string,
  rules: CompiledSecretRules = NO_SECRET_RULES
): Promise<SecretFinding[]> {
  return (await scanSecretsInFile(absolutePath, relativePath, maxFileSizeKb, trustedRoot, rules)).findings;
}

async function scanSecretsInFile(
  absolutePath: string,
  relativePath: string,
  maxFileSizeKb: number,
  trustedRoot: string | undefined,
  rules: CompiledSecretRules
): Promise<SecretScanResult> {
  const inspection = await inspectTextFile(absolutePath, maxFileSizeKb * 1024, undefined, trustedRoot);
  if (inspection.kind !== "text" || inspection.text === undefined) {
    return { findings: [], allowlisted: 0 };
  }

  const findings: SecretFinding[] = [];
  let allowlisted = 0;
  inspection.text.split(/\r?\n/).forEach((line, index) => {
    const scan = scanSecretsInLine(relativePath, line, index + 1, rules);
    findings.push(...scan.findings);
    allowlisted += scan.allowlisted;
  });

  return { findings: dedupeSecretFindings(findings), allowlisted };
}

export function detectSecretsInLine(
  relativePath: string,
  line: string,
  lineNumber: number,
  rules: CompiledSecretRules = NO_SECRET_RULES
): SecretFinding[] {
  return scanSecretsInLine(relativePath, line, lineNumber, rules).findings;
}

export function scanSecretsInLine(
  relativePath: string,
  line: string,
  lineNumber: number,
  rules: CompiledSecretRules = NO_SECRET_RULES
): SecretLineScan {
  const findings: SecretFinding[] = [];
  const addFinding = (reason: string): void => {
    findings.push({ path: relativePath, line: lineNumber, reason, redacted: "<redacted>" });
  };

  for (const { name, matches } of SECRET_PATTERNS) {
    if (matches(line)) {
      addFinding(`Possible ${name} detected.`);
    }
  }

  for (const name of matchCustomSecretPatterns(rules, line)) {
    addFinding(`Possible ${name} detected.`);
  }

  if (SECRET_KEYWORD_PATTERN.test(line)) {
    const tokens = line.match(/[A-Za-z0-9_./+=:-]{32,}/g) ?? [];
    for (const token of tokens) {
      if (looksLikeCodeIdentifierPath(token)) {
        continue;
      }

      if (shannonEntropy(token) >= 4.0) {
        addFinding("Possible high-entropy secret-like value near a sensitive keyword.");
        break;
      }
    }
  }

  if (findings.length > 0 && isLineAllowlisted(rules, relativePath, line)) {
    return { findings: [], allowlisted: findings.length };
  }

  return { findings, allowlisted: 0 };
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
