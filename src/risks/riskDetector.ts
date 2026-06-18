import path from "node:path";
import type { AgentBlackBoxConfig, ChangedFile, RiskFinding, RiskSeverity, RiskSummary, SecretFinding } from "../types.js";
import { pathMatchesPattern } from "../utils/paths.js";

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "go.sum"
]);

const PACKAGE_FILES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "Pipfile"
]);

export function detectRisks(changedFiles: ChangedFile[], config: AgentBlackBoxConfig): RiskFinding[] {
  const findings: RiskFinding[] = [];

  for (const file of changedFiles) {
    findings.push(...detectRiskForPath(file.path, config.riskPatterns).map((finding) => scoreFinding(finding, file)));
  }

  return dedupeFindings(findings);
}

export function detectRiskForPath(relativePath: string, riskPatterns: string[]): RiskFinding[] {
  const normalized = relativePath.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const baseName = path.posix.basename(normalized);
  const lowerBaseName = baseName.toLowerCase();
  const findings: RiskFinding[] = [];

  if (lowerBaseName === ".env" || lowerBaseName.startsWith(".env.")) {
    findings.push(finding(normalized, "Environment file", "high", "Environment files often contain credentials or private runtime settings."));
  }

  if (LOCKFILES.has(baseName) || LOCKFILES.has(lowerBaseName)) {
    findings.push(finding(normalized, "Lockfile", "medium", "Lockfile changes can alter installed dependency versions."));
  }

  if (PACKAGE_FILES.has(baseName) || PACKAGE_FILES.has(lowerBaseName)) {
    findings.push(finding(normalized, "Package manager file", "medium", "Dependency or runtime metadata changed."));
  }

  if (
    lower.startsWith(".github/workflows/") ||
    lower.includes("/.github/workflows/") ||
    lowerBaseName === ".gitlab-ci.yml" ||
    lowerBaseName === "azure-pipelines.yml" ||
    lower.includes(".circleci/") ||
    lowerBaseName === "jenkinsfile"
  ) {
    findings.push(finding(normalized, "CI/CD file", "medium", "CI/CD changes can affect build, test, release, or deployment behavior."));
  }

  if (lowerBaseName === "dockerfile" || lowerBaseName.startsWith("dockerfile.") || lowerBaseName.startsWith("docker-compose")) {
    findings.push(finding(normalized, "Docker file", "medium", "Container build or runtime behavior changed."));
  }

  if (lower.split("/").includes("migrations")) {
    findings.push(finding(normalized, "Migration file", "medium", "Database migration changes can affect persistent data."));
  }

  if (/(^|\/)(auth|security|oauth|jwt)(\/|[-_.]|$)/i.test(normalized)) {
    findings.push(finding(normalized, "Auth/security-related file", "high", "Authentication or security-related code appears to have changed."));
  }

  if (
    !hasSpecificOperationalCategory(findings) &&
    (/(^|\/)(config|settings)(\/|[-_.]|$)/i.test(normalized) || /\.(config|conf|ini|toml|yaml|yml)$/i.test(normalized))
  ) {
    findings.push(finding(normalized, "Config file", "medium", "Configuration changes can alter runtime behavior."));
  }

  if (findings.length === 0) {
    for (const pattern of riskPatterns) {
      if (pathMatchesPattern(normalized, pattern)) {
        findings.push(finding(normalized, "Configured risk pattern", "medium", `Matched configured risk pattern "${pattern}".`));
      }
    }
  }

  return dedupeFindings(findings);
}

function hasSpecificOperationalCategory(findings: RiskFinding[]): boolean {
  return findings.some((finding) =>
    ["CI/CD file", "Docker file", "Lockfile", "Package manager file"].includes(finding.category)
  );
}

function finding(pathName: string, category: string, severity: RiskSeverity, reason: string): RiskFinding {
  return {
    path: pathName,
    category,
    severity,
    score: baseScoreForSeverity(severity),
    reason
  };
}

export function summarizeRisks(risks: RiskFinding[], possibleSecrets: SecretFinding[] = []): RiskSummary {
  const severityCounts: Record<RiskSeverity, number> = {
    low: 0,
    medium: 0,
    high: 0
  };

  for (const risk of risks) {
    severityCounts[risk.severity] += 1;
  }

  const maxRiskScore = risks.reduce((max, risk) => Math.max(max, risk.score), 0);
  const score = Math.max(maxRiskScore, possibleSecrets.length > 0 ? 95 : 0);

  return {
    score,
    maxSeverity: score >= 80 ? "high" : score >= 50 ? "medium" : score > 0 ? "low" : "none",
    possibleSecretCount: possibleSecrets.length,
    severityCounts
  };
}

function scoreFinding(finding: RiskFinding, file: ChangedFile): RiskFinding {
  const changedLines = (file.insertions ?? 0) + (file.deletions ?? 0);
  const churnBonus = Math.min(10, Math.floor(changedLines / 50));
  const statusBonus = file.status === "deleted" ? 5 : file.status === "added" ? 3 : 0;

  return {
    ...finding,
    score: Math.min(100, finding.score + churnBonus + statusBonus)
  };
}

function baseScoreForSeverity(severity: RiskSeverity): number {
  if (severity === "high") {
    return 90;
  }

  if (severity === "medium") {
    return 60;
  }

  return 30;
}

function dedupeFindings(findings: RiskFinding[]): RiskFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.path}:${finding.category}:${finding.reason}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
