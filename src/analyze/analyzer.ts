import path from "node:path";
import { hasKnownCredentialMaterial } from "../risks/secretDetector.js";
import type { ChangedFile, RiskSeverity } from "../types.js";
import {
  describeCustomSecretPatternLimit,
  isLineAllowlisted,
  matchCustomSecretPatternsInLines,
  NO_SECRET_RULES,
  type CompiledSecretRules,
} from "../risks/secretRules.js";
import type { AnalysisPolicyEvaluation } from "./policy.js";

const DEFAULT_MAX_CONTENT_CHARACTERS = 256 * 1024;

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "gemfile.lock",
  "go.sum",
]);

const PACKAGE_FILES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "gemfile",
  "pipfile",
]);

const SENSITIVE_KEY_NAMES =
  /(?:api[-_]?key|access[-_]?token|auth(?!ors?(?![a-z])|ority)(?:orization)?|password|passphrase|secret(?:[-_]?key)?|client[-_]?secret|private[-_]?key)/i;
const TOKEN_VALUE =
  /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/;
const PRIVATE_KEY_HEADER = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY(?: BLOCK)?-----/;
// Start at each key's boundary rather than retrying a whitespace prefix at every character.
const ASSIGNMENT_PATTERN = /(?:^|[,{;\s])["']?([A-Za-z][\w.-]*)["']?\s*(?::|=)\s*["']?([^"'`\s,;]+)/gi;

export interface AnalysisInputFile extends ChangedFile {
  content?: string;
  analysisSkipReason?: string;
  baselineSourcePath?: string;
}

export interface AnalysisCoverage {
  source: "worktree" | "index";
  scannedTextFiles: number;
  skipped: Array<{ path: string; reason: string }>;
  /** Text files whose configured custom patterns could not inspect complete lines. */
  limited?: Array<{ path: string; reason: string; truncatedLines: number }>;
}

type AnalysisFindingKind = "metadata-risk" | "possible-secret" | "analysis-limit";

export interface AnalysisFinding {
  path: string;
  line?: number;
  category: string;
  kind: AnalysisFindingKind;
  severity: RiskSeverity;
  score: number;
  reason: string;
}

export interface AnalysisSummary {
  findingCount: number;
  maxSeverity: RiskSeverity | "none";
  score: number;
  severityCounts: Record<RiskSeverity, number>;
}

export interface WatcherlessAnalysisResult {
  findings: AnalysisFinding[];
  summary: AnalysisSummary;
  coverage?: AnalysisCoverage;
  /** Explicit initial-commit analysis: no prior content exists, so all staged findings are new. */
  initialCommitAnalysis?: true;
  baselineComparison?: {
    commit: string;
    suppressedExistingSecrets: number;
    scannedTextFiles: number;
    absentFiles: number;
    skipped: Array<{ path: string; reason: string }>;
    limited?: Array<{ path: string; reason: string }>;
    renameSources: Array<{ path: string; sourcePath: string; suppressedExistingSecrets: number }>;
  };
  policyEvaluation?: AnalysisPolicyEvaluation;
  /** Present only when a secret allowlist was applied; counts findings it hid from this result. */
  secretAllowlist?: { suppressedFindings: number };
}

export interface AnalyzeChangedFilesOptions {
  maxContentCharacters?: number;
  /** Compiled custom secret patterns and allowlist; see `compileSecretRules`. */
  secretRules?: CompiledSecretRules;
}

/**
 * Analyzes already-collected change metadata and optional text content. The
 * result deliberately contains only fixed descriptions; it never includes a
 * matched line or credential value.
 */
export function analyzeChangedFiles(
  files: readonly AnalysisInputFile[],
  options: AnalyzeChangedFilesOptions = {}
): WatcherlessAnalysisResult {
  const maxContentCharacters = normalizeContentLimit(options.maxContentCharacters);
  const rules = options.secretRules ?? NO_SECRET_RULES;
  const allowlist = { suppressed: 0 };
  const findings = files.flatMap((file) => analyzeFile(file, maxContentCharacters, rules, allowlist));
  const sortedFindings = dedupeFindings(findings).sort(compareFindings);

  return {
    findings: sortedFindings,
    summary: summarizeAnalysisFindings(sortedFindings),
    ...(rules.allowlist.length > 0 ? { secretAllowlist: { suppressedFindings: allowlist.suppressed } } : {}),
  };
}

function analyzeFile(
  file: AnalysisInputFile,
  maxContentCharacters: number,
  rules: CompiledSecretRules,
  allowlist: { suppressed: number }
): AnalysisFinding[] {
  const normalizedPath = normalizeAnalysisPath(file.path);
  if (!normalizedPath) {
    return [
      createFinding(
        "[invalid path]",
        "Invalid change metadata",
        "metadata-risk",
        "high",
        "Change metadata uses an unsafe path."
      ),
    ];
  }

  const findings = detectMetadataRisks(normalizedPath);
  if (!shouldInspectContent(file)) {
    return findings;
  }

  const content = file.content;
  if (content.length > maxContentCharacters) {
    findings.push(
      createFinding(
        normalizedPath,
        "Content analysis limit",
        "analysis-limit",
        "low",
        "Content analysis was limited before the end of the file."
      )
    );
  }

  const contentToInspect = content.slice(0, maxContentCharacters);
  for (const finding of detectPossibleSecrets(normalizedPath, contentToInspect, rules, allowlist)) {
    findings.push(finding);
  }
  return findings;
}

function normalizeContentLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_CONTENT_CHARACTERS;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("maxContentCharacters must be a positive safe integer.");
  }

  return value;
}

function normalizeAnalysisPath(value: string): string | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || path.isAbsolute(value)) {
    return null;
  }

  const platformPath = path.sep === "\\" ? value.replace(/\\/g, "/") : value;
  const normalized = platformPath.replace(/^\.\//, "");
  if (!normalized || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }

  return normalized;
}

function detectMetadataRisks(relativePath: string): AnalysisFinding[] {
  const lowerPath = relativePath.toLowerCase();
  const baseName = path.posix.basename(lowerPath);
  const findings: AnalysisFinding[] = [];

  if (baseName === ".env" || baseName.startsWith(".env.")) {
    findings.push(
      createFinding(
        relativePath,
        "Environment file",
        "metadata-risk",
        "high",
        "Environment files can contain credentials."
      )
    );
  }

  if (LOCKFILES.has(baseName)) {
    findings.push(createFinding(relativePath, "Lockfile", "metadata-risk", "medium", "Dependency lockfile changed."));
  }

  if (PACKAGE_FILES.has(baseName)) {
    findings.push(
      createFinding(
        relativePath,
        "Package manager file",
        "metadata-risk",
        "medium",
        "Dependency or runtime metadata changed."
      )
    );
  }

  if (isContinuousIntegrationPath(lowerPath, baseName)) {
    findings.push(createFinding(relativePath, "CI/CD file", "metadata-risk", "medium", "CI/CD behavior changed."));
  }

  if (baseName === "dockerfile" || baseName.startsWith("dockerfile.") || baseName.startsWith("docker-compose")) {
    findings.push(createFinding(relativePath, "Docker file", "metadata-risk", "medium", "Container behavior changed."));
  }

  if (lowerPath.split("/").includes("migrations")) {
    findings.push(
      createFinding(relativePath, "Migration file", "metadata-risk", "medium", "Persistent data may be affected.")
    );
  }

  if (/(^|\/)(auth|authn|authz|authentication|authorization|security|oauth2?|jwt)(\/|[-_.]|$)/i.test(relativePath)) {
    findings.push(
      createFinding(
        relativePath,
        "Auth/security-related file",
        "metadata-risk",
        "high",
        "Authentication or security code changed."
      )
    );
  }

  if (
    findings.length === 0 &&
    (/(^|\/)(config|settings)(\/|[-_.]|$)/i.test(relativePath) ||
      /\.(config|conf|ini|toml|yaml|yml)$/i.test(relativePath))
  ) {
    findings.push(
      createFinding(relativePath, "Config file", "metadata-risk", "medium", "Configuration behavior changed.")
    );
  }

  return findings;
}

function isContinuousIntegrationPath(lowerPath: string, baseName: string): boolean {
  return (
    lowerPath.startsWith(".github/workflows/") ||
    lowerPath.includes("/.github/workflows/") ||
    baseName === ".gitlab-ci.yml" ||
    baseName === "azure-pipelines.yml" ||
    lowerPath.includes(".circleci/") ||
    baseName === "jenkinsfile"
  );
}

function shouldInspectContent(file: AnalysisInputFile): file is AnalysisInputFile & { content: string } {
  return (
    file.status !== "deleted" &&
    file.kind !== "binary" &&
    file.kind !== "large" &&
    file.kind !== "missing" &&
    file.kind !== "not-file" &&
    typeof file.content === "string"
  );
}

function detectPossibleSecrets(
  relativePath: string,
  content: string,
  rules: CompiledSecretRules,
  allowlist: { suppressed: number }
): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  const lines = content.split(/\r?\n/);
  const limit = describeCustomSecretPatternLimit(rules, lines);
  if (limit) {
    findings.push(
      createFinding(relativePath, "Custom secret pattern analysis limit", "analysis-limit", "low", limit.reason)
    );
  }
  // Preserve the existing short circuit: known built-in credentials need no custom-pattern evaluation.
  const knownSecrets = lines.map(looksLikeKnownSecret);
  const customSecrets = new Set<number>();
  if (rules.patterns.length > 0) {
    const candidatePositions: number[] = [];
    const candidateLines = lines.filter((_line, index) => {
      if (knownSecrets[index]) return false;
      candidatePositions.push(index);
      return true;
    });
    const customMatches = matchCustomSecretPatternsInLines(rules, candidateLines);
    candidatePositions.forEach((position, index) => {
      if ((customMatches[index]?.length ?? 0) > 0) customSecrets.add(position);
    });
  }

  for (const [index, line] of lines.entries()) {
    if (!knownSecrets[index] && !customSecrets.has(index) && !looksLikeSecretAssignment(line)) {
      continue;
    }
    if (isLineAllowlisted(rules, relativePath, line)) {
      allowlist.suppressed += 1;
      continue;
    }

    findings.push({
      ...createFinding(
        relativePath,
        "Possible secret",
        "possible-secret",
        "high",
        "Potential credential material was detected; inspect the source locally."
      ),
      line: index + 1,
    });
  }

  return findings;
}

function looksLikeKnownSecret(line: string): boolean {
  return hasKnownCredentialMaterial(line) || PRIVATE_KEY_HEADER.test(line) || TOKEN_VALUE.test(line);
}

function looksLikeSecretAssignment(line: string): boolean {
  for (const assignment of line.matchAll(ASSIGNMENT_PATTERN)) {
    if (SENSITIVE_KEY_NAMES.test(assignment[1] ?? "") && isPlausibleCredentialValue(assignment[2] ?? "")) {
      return true;
    }
  }
  return false;
}

function isPlausibleCredentialValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length < 6) {
    return false;
  }

  return !(
    normalized.startsWith("process.env") ||
    normalized.startsWith("import.meta.env") ||
    normalized.startsWith("${") ||
    normalized.startsWith("$env:") ||
    normalized === "redacted" ||
    normalized === "[redacted]" ||
    normalized === "***" ||
    normalized === "null" ||
    normalized === "undefined" ||
    normalized.startsWith("example") ||
    normalized.startsWith("your_") ||
    normalized.startsWith("your-") ||
    normalized.startsWith("<")
  );
}

function createFinding(
  pathName: string,
  category: string,
  kind: AnalysisFindingKind,
  severity: RiskSeverity,
  reason: string
): AnalysisFinding {
  return {
    path: pathName,
    category,
    kind,
    severity,
    score: scoreForSeverity(severity),
    reason,
  };
}

function scoreForSeverity(severity: RiskSeverity): number {
  if (severity === "high") {
    return 90;
  }

  if (severity === "medium") {
    return 60;
  }

  return 30;
}

function dedupeFindings(findings: AnalysisFinding[]): AnalysisFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.path}\0${finding.line ?? ""}\0${finding.category}\0${finding.kind}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function compareFindings(left: AnalysisFinding, right: AnalysisFinding): number {
  return (
    compareStrings(left.path, right.path) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    compareStrings(left.category, right.category) ||
    compareStrings(left.kind, right.kind)
  );
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

export function summarizeAnalysisFindings(findings: readonly AnalysisFinding[]): AnalysisSummary {
  const severityCounts: Record<RiskSeverity, number> = { low: 0, medium: 0, high: 0 };
  let score = 0;

  for (const finding of findings) {
    severityCounts[finding.severity] += 1;
    score = Math.max(score, finding.score);
  }

  return {
    findingCount: findings.length,
    maxSeverity: score >= 80 ? "high" : score >= 50 ? "medium" : score > 0 ? "low" : "none",
    score,
    severityCounts,
  };
}
