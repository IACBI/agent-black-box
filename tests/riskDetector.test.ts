import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { detectRiskForPath, detectRisks } from "../src/risks/riskDetector.js";

describe("risk detector", () => {
  it("detects env files including .env variants", () => {
    const findings = detectRiskForPath(".env.local", DEFAULT_CONFIG.riskPatterns);
    expect(findings.some((finding) => finding.category === "Environment file" && finding.severity === "high")).toBe(true);
  });

  it("detects dependency and CI changes", () => {
    const findings = detectRisks(
      [
        { path: "package.json", status: "modified" },
        { path: ".github/workflows/ci.yml", status: "modified" }
      ],
      DEFAULT_CONFIG
    );

    expect(findings.some((finding) => finding.category === "Package manager file")).toBe(true);
    expect(findings.some((finding) => finding.category === "CI/CD file")).toBe(true);
  });

  it("detects auth and migration changes", () => {
    const findings = detectRisks(
      [
        { path: "src/auth/session.ts", status: "modified" },
        { path: "db/migrations/001_create_users.sql", status: "added" }
      ],
      DEFAULT_CONFIG
    );

    expect(findings.some((finding) => finding.category === "Auth/security-related file")).toBe(true);
    expect(findings.some((finding) => finding.category === "Migration file")).toBe(true);
  });
});
