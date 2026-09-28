import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const LANGUAGE_ANCHORS = [
  "english",
  "turkce",
  "espanol",
  "deutsch",
  "francais",
  "portugues",
  "zhongwen",
  "hindi",
  "arabic",
  "russkiy",
  "nihongo",
  "bahasa-indonesia",
];

const REQUIRED_COMMANDS = [
  "abb init",
  "abb config validate",
  "abb config migrate",
  "abb start",
  "abb doctor",
  "abb run",
  "abb stop",
  "abb recover",
  "abb status",
  "abb analyze",
  "abb sessions list",
  "abb sessions browse",
  "abb sessions archive",
  "abb sessions show <id>",
  "abb sessions compare <from> <to>",
  "abb report",
  "abb summary",
  "abb commands",
  "abb timeline",
  "abb risks",
  "abb export",
  "abb rollback",
];

const REQUIRED_REPORTS = [
  "session.json",
  "session-metadata.json",
  "summary.md",
  "commands.md",
  "timeline.md",
  "diff-summary.md",
  "risks.md",
  "rollback.md",
];

describe("multilingual README", () => {
  it("keeps every language section aligned with the documented CLI and report surface", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).not.toContain("pnpm dev -- ");

    for (const [index, anchor] of LANGUAGE_ANCHORS.entries()) {
      const startMarker = `<a id="${anchor}"></a>`;
      const start = readme.indexOf(startMarker);
      const nextAnchor = LANGUAGE_ANCHORS[index + 1];
      const end = nextAnchor ? readme.indexOf(`<a id="${nextAnchor}"></a>`, start + startMarker.length) : readme.length;

      expect(start, `missing language anchor ${anchor}`).toBeGreaterThanOrEqual(0);
      expect(end, `invalid language section ${anchor}`).toBeGreaterThan(start);
      const section = readme.slice(start, end);

      for (const command of REQUIRED_COMMANDS) {
        expect(section, `${anchor} is missing ${command}`).toContain(command);
      }
      for (const report of REQUIRED_REPORTS) {
        expect(section, `${anchor} is missing ${report}`).toContain(report);
      }

      expect(section).toContain("HEAD");
      expect(section).toContain("SARIF");
      expect(section).toContain("--session <id>");
      expect(section).toContain("pnpm dev init");
      expect(section).toContain("docs/USAGE.md");
      expect(section).toContain("docs/REPORTS.md");
      expect(section).toContain("docs/ARCHITECTURE.md");
    }
  });

  it("keeps runtime, quality, and CI documentation aligned with executable configuration", async () => {
    const [packageRaw, usage, contributing, security, workflow] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("docs/USAGE.md", "utf8"),
      readFile("CONTRIBUTING.md", "utf8"),
      readFile("SECURITY.md", "utf8"),
      readFile(".github/workflows/ci.yml", "utf8"),
    ]);
    const packageJson = JSON.parse(packageRaw) as {
      engines?: { node?: string };
      scripts?: Record<string, string>;
    };

    expect(packageJson.engines?.node).toBe(">=22");
    expect(packageJson.scripts).toMatchObject({ deadcode: expect.any(String), perf: expect.any(String) });
    expect(usage).toContain("Node.js 22 or newer");
    expect(contributing).toContain("pnpm perf");
    expect(security).toContain("security_best_practices_report.md");
    expect(workflow).toContain("os: [ubuntu-latest, windows-latest, macos-latest]");
    expect(workflow).toContain("node: [22, 24]");
  });
});
