import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { generateSummaryMarkdown } from "../src/reports/markdown.js";
import { appendFileEvent, createSession, finalizeSession } from "../src/session/sessionManager.js";
import { readCatalogSessionReport, resolveSession } from "../src/session/sessionCatalog.js";
import type { AgentBlackBoxConfig, SessionReport } from "../src/types.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

const config: AgentBlackBoxConfig = {
  ...DEFAULT_CONFIG,
  secretPatterns: [{ name: "Internal service token", pattern: "corp_[a-z0-9]{16}" }],
  secretAllowlist: [{ path: "tests/fixtures", reason: "synthetic credentials used by the test-suite" }],
};

async function recordSession(
  repo: string,
  sessionConfig: AgentBlackBoxConfig,
  files: Record<string, string>
): Promise<SessionReport> {
  const session = await createSession(repo, sessionConfig);
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, relativePath)), { recursive: true });
    await writeFile(path.join(repo, relativePath), content);
    await appendFileEvent(session, { timestamp: new Date().toISOString(), eventType: "add", path: relativePath });
  }
  return finalizeSession(session, sessionConfig, "test");
}

describe("recorded sessions with secret rules", () => {
  it("reports configured patterns, hides allowlisted lines, and says how many it hid", async () => {
    const repo = await createTempDir("abb-session-secrets-");
    try {
      initGitRepo(repo);
      const value = "corp_0123456789abcdef";
      const report = await recordSession(repo, config, {
        "src/client.ts": `export const id = "${value}";\n`,
        "tests/fixtures/seed.env": `PASSWORD=${"hunter2".repeat(3)}\nCORP=${value}\n`,
      });

      expect(report.possibleSecrets).toEqual([
        {
          path: "src/client.ts",
          line: 1,
          reason: "Possible Internal service token detected.",
          redacted: "<redacted>",
        },
      ]);
      expect(report.riskSummary.possibleSecretCount).toBe(1);
      expect(report.riskSummary.allowlistedSecretCount).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(report)).not.toContain(value);
      expect(generateSummaryMarkdown(report)).toContain("Possible secrets hidden by the configured allowlist:");
      expect(await readFile(path.join(report.sessionDir, "summary.md"), "utf8")).toContain(
        "Possible secrets hidden by the configured allowlist:"
      );

      const reloaded = await readCatalogSessionReport(await resolveSession(repo, config, report.id));
      expect(reloaded.riskSummary).toEqual(report.riskSummary);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("leaves the report unchanged in shape when nothing was allowlisted", async () => {
    const repo = await createTempDir("abb-session-secrets-");
    try {
      initGitRepo(repo);
      const report = await recordSession(repo, config, { "src/client.ts": "export const id = 1;\n" });

      expect(report.possibleSecrets).toEqual([]);
      expect(report.riskSummary).not.toHaveProperty("allowlistedSecretCount");
      expect(generateSummaryMarkdown(report)).not.toContain("allowlist");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("finds nothing extra without the rules, proving they come from configuration", async () => {
    const repo = await createTempDir("abb-session-secrets-");
    try {
      initGitRepo(repo);
      const report = await recordSession(repo, DEFAULT_CONFIG, {
        "src/client.ts": 'export const id = "corp_0123456789abcdef";\n',
      });

      expect(report.possibleSecrets).toEqual([]);
    } finally {
      await removeTempDir(repo);
    }
  });
});
