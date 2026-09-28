import path from "node:path";
import type { ChangedFile, RiskSeverity } from "../types.js";
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
  /(?:api[-_]?key|access[-_]?token|auth(?:orization)?|password|passphrase|secret(?:[-_]?key)?|client[-_]?secret|private[-_]?key)/i;
const TOKEN_VALUE =
  /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/;
const PRIVATE_KEY_HEADER = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/;

export interface AnalysisInputFile extends ChangedFile {
  content?: string;
  analysisSkipReason?: string;
  baselineSourcePath?: string;
}

export interface AnalysisCoverage {
  source: "worktree" | "index";
  scannedTextFiles: number;
  skipped: Array<{ path: string; reason: string }>;
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
  baselineComparison?: {
    commit: string;
    suppressedExistingSecrets: number;
    scannedTextFiles: number;
    absentFiles: number;
    skipped: Array<{ path: string; reason: string }>;
    renameSources: Array<{ path: string; sourcePath: string; suppressedExistingSecrets: number }>;
  };
  policyEvaluation?: AnalysisPolicyEvaluation;
}

export interface AnalyzeChangedFilesOptions {
  maxContentCharacters?: number;
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
  const findings = files.flatMap((file) => analyzeFile(file, maxContentCharacters));
  const sortedFindings = dedupeFindings(findings).sort(compareFindings);

  return {
    findings: sortedFindings,
    summary: summarizeAnalysisFindings(sortedFindings),
  };
}

function analyzeFile(file: AnalysisInputFile, maxContentCharacters: number): AnalysisFinding[] {
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
  findings.push(...detectPossibleSecrets(normalizedPath, contentToInspect));
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

  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
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

  if (/(^|\/)(auth|security|oauth|jwt)(\/|[-_.]|$)/i.test(relativePath)) {
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

function detectPossibleSecrets(relativePath: string, content: string): AnalysisFinding[] {
  const findings: AnalysisFinding[] = [];
  const lines = content.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    if (!looksLikeSecret(line)) {
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

function looksLikeSecret(line: string): boolean {
  if (PRIVATE_KEY_HEADER.test(line) || TOKEN_VALUE.test(line)) {
    return true;
  }

  const assignment =
    /(?:^|[,{;\s])(?:export\s+)?(?:const|let|var)?\s*["']?([A-Za-z][\w.-]*)["']?\s*(?::|=)\s*["']?([^"'`\s,;]+)/i.exec(
      line
    );
  if (!assignment || !SENSITIVE_KEY_NAMES.test(assignment[1])) {
    return false;
  }

  return isPlausibleCredentialValue(assignment[2]);
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
