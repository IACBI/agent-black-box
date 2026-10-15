import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { detectRiskForPath, detectRisks } from "../src/risks/riskDetector.js";

describe("risk detector", () => {
  it("detects env files including .env variants", () => {
    const findings = detectRiskForPath(".env.local", DEFAULT_CONFIG.riskPatterns);
    expect(findings.some((finding) => finding.category === "Environment file" && finding.severity === "high")).toBe(
      true
    );
  });

  it("detects dependency and CI changes", () => {
    const findings = detectRisks(
      [
        { path: "package.json", status: "modified" },
        { path: ".github/workflows/ci.yml", status: "modified" },
      ],
      DEFAULT_CONFIG
    );

    expect(findings.some((finding) => finding.category === "Package manager file")).toBe(true);
    expect(findings.some((finding) => finding.category === "CI/CD file")).toBe(true);
    expect(findings.every((finding) => finding.score >= 60)).toBe(true);
  });

  it.each([
    ["Cargo.lock", "Lockfile"],
    ["Pipfile.lock", "Lockfile"],
    ["Gemfile.lock", "Lockfile"],
    ["Cargo.toml", "Package manager file"],
    ["Gemfile", "Package manager file"],
    ["Pipfile", "Package manager file"],
  ])("detects %s consistently across filename casing", (fileName, category) => {
    for (const variant of [fileName, fileName.toUpperCase(), fileName.toLowerCase()]) {
      const relativePath = `src/${variant}`;
      expect(detectRiskForPath(relativePath, [])).toEqual([
        expect.objectContaining({ path: relativePath, category, severity: "medium" }),
      ]);
    }
  });

  it("detects auth and migration changes", () => {
    const findings = detectRisks(
      [
        { path: "src/auth/session.ts", status: "modified" },
        { path: "db/migrations/001_create_users.sql", status: "added" },
      ],
      DEFAULT_CONFIG
    );

    expect(findings.some((finding) => finding.category === "Auth/security-related file")).toBe(true);
    expect(findings.some((finding) => finding.category === "Migration file")).toBe(true);
  });

  it.each(["src/authentication/login.ts", "src/authorization/policy.ts", "lib/oauth2/client.ts", "src/authz.ts"])(
    "treats %s as an auth/security path",
    (filePath) => {
      const findings = detectRisks([{ path: filePath, status: "modified" }], DEFAULT_CONFIG);

      expect(findings.map((finding) => finding.category)).toContain("Auth/security-related file");
    }
  );

  it("does not treat an authors directory as an auth/security path", () => {
    const findings = detectRisks([{ path: "src/authors/list.ts", status: "modified" }], DEFAULT_CONFIG);

    expect(findings.map((finding) => finding.category)).not.toContain("Auth/security-related file");
  });

  it("adds a bounded score bonus for larger risky changes", () => {
    const [finding] = detectRisks([{ path: ".env", status: "added", insertions: 600, deletions: 0 }], DEFAULT_CONFIG);

    expect(finding?.severity).toBe("high");
    expect(finding?.score).toBe(100);
  });
});
