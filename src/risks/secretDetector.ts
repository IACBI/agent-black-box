import { availableParallelism } from "node:os";
import type { AgentBlackBoxConfig, ChangedFile, SecretFinding } from "../types.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { inspectTextFile } from "../utils/fileInspection.js";
import { resolveRepoPath } from "../utils/paths.js";
import {
  compileSecretRules,
  describeCustomSecretPatternLimit,
  isLineAllowlisted,
  matchCustomSecretPatterns,
  matchCustomSecretPatternsInLines,
  MAX_CUSTOM_PATTERN_LINE_LENGTH,
  NO_SECRET_RULES,
  redactCustomSecretPatternsWithMask,
  type CompiledSecretRules,
} from "./secretRules.js";

const FILE_SCAN_CONCURRENCY = Math.min(8, availableParallelism());

const SECRET_KEYWORD_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key|(?<![A-Za-z0-9])(?:passphrase|pwd|credentials?|cookie)\b)/i;

const AWS_ACCESS_KEY = /(?:AKIA|ASIA)[0-9A-Z]{16}/;
const GITHUB_TOKEN = /gh[pousr]_[A-Za-z0-9_]{20,}/;
const SLACK_TOKEN = /xox[baprs]-[A-Za-z0-9-]{20,}/;
// Real keys are random, so requiring a digit rejects long kebab-case identifiers that merely start with "sk-".
const LLM_API_KEY = /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/;
const STRIPE_LIVE_KEY = /\b[sr]k_live_[A-Za-z0-9]{16,}/;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}/;

const PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

const GITHUB_FINE_GRAINED_TOKEN = /github_pat_[A-Za-z0-9_]{22,}/;
const GITLAB_TOKEN = /glpat-[A-Za-z0-9_-]{20,}/;
const NPM_TOKEN = /npm_[A-Za-z0-9]{36,}/;
const PYPI_TOKEN = /pypi-[A-Za-z0-9_-]{50,}/;
const AUTHORIZATION_VALUE = /\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Basic|Bearer)\s+[A-Za-z0-9_./+=-]{8,}/i;
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]{0,31}:\/\/)(?:[^\s/@:]{1,128}:[^\s/@]{1,512}@)/i;
const HTTP_USER_CREDENTIAL = /(https?:\/\/)[^\s/@]{1,512}@/i;
const MAX_BUILTIN_REDACTION_LENGTH = 65_536;

const KNOWN_CREDENTIAL_PATTERNS: Array<{ name: string; matches: (line: string) => boolean }> = [
  { name: "AWS access key-like value", matches: (line) => AWS_ACCESS_KEY.test(line) },
  { name: "GitHub token-like value", matches: (line) => GITHUB_TOKEN.test(line) },
  { name: "Slack token-like value", matches: (line) => SLACK_TOKEN.test(line) },
  {
    name: "LLM API key-like value",
    matches: hasLlmApiKey,
  },
  { name: "Stripe live key-like value", matches: (line) => STRIPE_LIVE_KEY.test(line) },
  { name: "Google API key-like value", matches: (line) => GOOGLE_API_KEY.test(line) },
  { name: "GitHub fine-grained token-like value", matches: (line) => GITHUB_FINE_GRAINED_TOKEN.test(line) },
  { name: "GitLab token-like value", matches: (line) => GITLAB_TOKEN.test(line) },
  { name: "npm token-like value", matches: (line) => NPM_TOKEN.test(line) },
  { name: "PyPI token-like value", matches: (line) => PYPI_TOKEN.test(line) },
  { name: "Authorization credential", matches: (line) => AUTHORIZATION_VALUE.test(line) },
  { name: "URL credential", matches: (line) => URL_CREDENTIAL.test(line) || HTTP_USER_CREDENTIAL.test(line) },
  { name: "JWT-like value", matches: hasJwtLikeValue },
  { name: "Private key block", matches: (line) => PRIVATE_KEY_HEADER.test(line) },
];

const SECRET_PATTERNS: typeof KNOWN_CREDENTIAL_PATTERNS = [
  ...KNOWN_CREDENTIAL_PATTERNS,
  { name: "JSON-escaped credential", matches: hasJsonEscapedCredential },
  {
    name: "Secret assignment-like value",
    matches: (line) =>
      hasEscapedSecretAssignment(line) ||
      /(?<![A-Za-z0-9])(?:api[_-]?key|secret|token|password|passwd|passphrase|pwd|credentials?|cookie|private[_-]?key|client[_-]?secret|access[_-]?key)\b["']?\s*[:=]\s*["']?([A-Za-z0-9_./+=:-]{12,})["']?/i.test(
        line
      ),
  },
];

const REDACTABLE_TOKENS = [
  AWS_ACCESS_KEY,
  GITHUB_TOKEN,
  SLACK_TOKEN,
  STRIPE_LIVE_KEY,
  GOOGLE_API_KEY,
  GITHUB_FINE_GRAINED_TOKEN,
  GITLAB_TOKEN,
  NPM_TOKEN,
  PYPI_TOKEN,
].map((expression) => new RegExp(expression.source, "g"));

export interface SecretLineScan {
  findings: SecretFinding[];
  /** Present when configured patterns could not inspect the entire line. */
  customPatternTruncated?: true;
  /** Findings that matched but were suppressed by the configured allowlist. */
  allowlisted: number;
}

export interface SecretScanResult {
  findings: SecretFinding[];
  allowlisted: number;
  /** Partial custom-pattern scans; built-in detectors still inspect the complete line. */
  limitations?: Array<{ path: string; reason: string; truncatedLines: number }>;
}

/**
 * Replaces provider-issued token shapes (cloud keys, API tokens, JWTs) with `<redacted>`. Used to scrub
 * recorded command text, where a bare token has no variable name or flag to give it away.
 */
export function redactKnownSecretTokens(text: string): string {
  if (text.length > MAX_BUILTIN_REDACTION_LENGTH || hasJsonEscapedCredential(text)) return "<redacted>";
  let result = text;
  // Component scanning avoids the quadratic JWT regex retry at each repeated "eyJ" prefix.
  const spans = findJwtSpans(result);
  const pieces: string[] = [];
  let offset = 0;
  for (const span of spans) {
    pieces.push(result.slice(offset, span.start), "<redacted>");
    offset = span.end;
  }
  pieces.push(result.slice(offset));
  result = pieces.join("");
  result = result.replace(new RegExp(LLM_API_KEY.source, "g"), (match) => (/\d/.test(match) ? "<redacted>" : match));
  for (const expression of REDACTABLE_TOKENS) {
    result = result.replace(expression, "<redacted>");
  }
  result = result
    .replace(
      new RegExp(AUTHORIZATION_VALUE.source, "gi"),
      (match) => match.slice(0, match.indexOf(":") + 1) + " <redacted>"
    )
    .replace(new RegExp(URL_CREDENTIAL.source, "gi"), "$1<redacted>@")
    .replace(new RegExp(HTTP_USER_CREDENTIAL.source, "gi"), "$1<redacted>@");
  // Key material can span lines; dropping the whole argument avoids retaining its body.
  if (PRIVATE_KEY_HEADER.test(result) || hasEscapedSecretAssignment(result)) return "<redacted>";
  return result;
}

/** @internal Provider and custom command matches share original-text positions. */
export function redactKnownSecretTokensWithRules(
  text: string,
  rules: CompiledSecretRules,
  matchEnds: Uint32Array
): { text: string; customMatched: boolean } {
  if (text.length > MAX_BUILTIN_REDACTION_LENGTH) return { text: "<redacted>", customMatched: true };
  const mark = (start: number, end: number): void => {
    matchEnds[start] = Math.max(matchEnds[start] ?? 0, end);
  };
  for (const span of findJwtSpans(text)) mark(span.start, span.end);
  for (const match of text.matchAll(new RegExp(LLM_API_KEY.source, "g"))) {
    if (/\d/.test(match[0])) mark(match.index, match.index + match[0].length);
  }
  for (const expression of REDACTABLE_TOKENS) {
    for (const match of text.matchAll(expression)) mark(match.index, match.index + match[0].length);
  }
  for (const match of text.matchAll(new RegExp(AUTHORIZATION_VALUE.source, "gi"))) {
    const valueOffset = match[0].indexOf(":") + 1;
    const whitespaceLength = /^\s*/.exec(match[0].slice(valueOffset))?.[0].length ?? 0;
    mark(match.index + valueOffset + whitespaceLength, match.index + match[0].length);
  }
  for (const expression of [URL_CREDENTIAL, HTTP_USER_CREDENTIAL]) {
    for (const match of text.matchAll(new RegExp(expression.source, "gi"))) {
      mark(match.index + match[1]!.length, match.index + match[0].length - 1);
    }
  }
  if (PRIVATE_KEY_HEADER.test(text) || hasEscapedSecretAssignment(text) || hasJsonEscapedCredential(text))
    mark(0, text.length);
  return redactCustomSecretPatternsWithMask(rules, text, matchEnds);
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

  const limitations = results.flatMap((result) => result.limitations ?? []);
  return {
    findings: dedupeSecretFindings(results.flatMap((result) => result.findings)),
    allowlisted: results.reduce((total, result) => total + result.allowlisted, 0),
    ...(limitations.length > 0 ? { limitations } : {}),
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
  const lines = inspection.text.split(/\r?\n/);
  const customMatches = rules.patterns.length > 0 ? matchCustomSecretPatternsInLines(rules, lines) : [];
  lines.forEach((line, index) => {
    const scan = scanSecretsInLineWithMatches(relativePath, line, index + 1, rules, customMatches[index] ?? []);
    findings.push(...scan.findings);
    allowlisted += scan.allowlisted;
  });
  const limit = describeCustomSecretPatternLimit(rules, lines);
  return {
    findings: dedupeSecretFindings(findings),
    allowlisted,
    ...(limit ? { limitations: [{ path: relativePath, ...limit }] } : {}),
  };
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
  return scanSecretsInLineWithMatches(relativePath, line, lineNumber, rules, matchCustomSecretPatterns(rules, line));
}

function scanSecretsInLineWithMatches(
  relativePath: string,
  line: string,
  lineNumber: number,
  rules: CompiledSecretRules,
  customMatches: readonly string[]
): SecretLineScan {
  const limited = rules.patterns.length > 0 && line.length > MAX_CUSTOM_PATTERN_LINE_LENGTH;
  const diagnostics = limited ? { customPatternTruncated: true as const } : {};
  const findings: SecretFinding[] = [];
  const addFinding = (reason: string): void => {
    findings.push({ path: relativePath, line: lineNumber, reason, redacted: "<redacted>" });
  };

  for (const { name, matches } of SECRET_PATTERNS) {
    if (matches(line)) {
      addFinding(`Possible ${name} detected.`);
    }
  }

  for (const name of customMatches) {
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
    return { findings: [], allowlisted: findings.length, ...diagnostics };
  }

  return { findings, allowlisted: 0, ...diagnostics };
}

/** Provider and structured credential signals shared by recording and watcherless analysis. */
export function hasKnownCredentialMaterial(line: string): boolean {
  return (
    KNOWN_CREDENTIAL_PATTERNS.some(({ matches }) => matches(line)) ||
    hasJsonEscapedCredential(line) ||
    hasEscapedSecretAssignment(line)
  );
}

/** Decode one bounded JSON string layer, never evaluate code or recursively expand encoded input. */
function hasJsonEscapedCredential(text: string): boolean {
  let start = -1;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    if (start < 0) {
      if (text[index] === '"') {
        start = index;
        escaped = false;
      }
      continue;
    }
    if (text[index] === "\\") {
      escaped = true;
      index += 1;
      continue;
    }
    if (text[index] !== '"') continue;
    if (escaped && index - start + 1 <= MAX_BUILTIN_REDACTION_LENGTH) {
      const literal = text.slice(start, index + 1);
      let decoded: unknown;
      try {
        decoded = JSON.parse(literal);
      } catch {
        // A malformed literal must not abort analysis or command execution.
      }
      if (typeof decoded === "string" && KNOWN_CREDENTIAL_PATTERNS.some(({ matches }) => matches(decoded))) return true;
    }
    start = -1;
  }
  return false;
}

function hasLlmApiKey(line: string): boolean {
  for (const match of line.matchAll(new RegExp(LLM_API_KEY.source, "g"))) {
    if (/\d/.test(match[0])) return true;
  }
  return false;
}

function hasJwtLikeValue(line: string): boolean {
  return findJwtSpans(line).length > 0;
}

function findJwtSpans(line: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let previousEnd = -1;
  let headerStart = -1;
  let payloadStart = -1;
  for (const match of line.matchAll(/[A-Za-z0-9_-]+/g)) {
    const component = match[0];
    const followsDot = match.index === previousEnd + 1 && line[previousEnd] === ".";
    if (followsDot && payloadStart >= 0 && component.length >= 10) {
      const end = match.index + component.length;
      const previous = spans.at(-1);
      if (previous && payloadStart <= previous.end) previous.end = end;
      else spans.push({ start: payloadStart, end });
    }
    payloadStart = followsDot && headerStart >= 0 && component.length >= 10 ? headerStart : -1;
    const offset = component.indexOf("eyJ");
    headerStart = offset >= 0 && component.length - offset >= 13 ? match.index + offset : -1;
    previousEnd = match.index + component.length;
  }
  return spans;
}

function hasEscapedSecretAssignment(line: string): boolean {
  const keys = /"((?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})){1,128})"\s*:\s*"([^"\r\n]{12,})/g;
  for (const match of line.matchAll(keys)) {
    const encoded = match[1]!;
    if (!encoded.includes("\\")) continue;
    let key: string;
    try {
      key = JSON.parse('"' + encoded + '"') as string;
    } catch {
      // Malformed JSON keys must not abort scanning or command recording.
      continue;
    }
    if (
      /(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key|(?<![A-Za-z0-9])(?:passphrase|pwd|credentials?|cookie))$/i.test(
        key
      )
    ) {
      return true;
    }
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
