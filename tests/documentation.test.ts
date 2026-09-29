import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LANGUAGE_ANCHORS = ["english", "turkce"];

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
  "abb sessions prune",
  "abb sessions show <id>",
  "abb sessions compare <from> <to>",
  "abb sessions verify",
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

describe("bilingual README", () => {
  it("keeps only English and Turkish sections aligned with the documented CLI and report surface", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).not.toContain("pnpm dev -- ");
    expect([...readme.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1])).toEqual([
      "top",
      ...LANGUAGE_ANCHORS,
    ]);

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
    expect(security).toContain("Report a vulnerability");
    expect(workflow).toContain("os: [ubuntu-latest, windows-latest, macos-latest]");
    expect(workflow).toContain("node: [22, 24]");
  });

  it("keeps local documentation links valid in the repository and package", async () => {
    const { files: packagedPaths } = JSON.parse(await readFile("package.json", "utf8")) as { files: string[] };
    const documents = [
      "README.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "CHANGELOG.md",
      ...(await readdir("docs")).filter((name) => name.endsWith(".md")).map((name) => path.join("docs", name)),
    ];

    for (const document of documents) {
      const content = await readFile(document, "utf8");
      for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (/^[a-z][a-z\d+.-]*:/i.test(target)) {
          continue;
        }
        const [file, anchor] = target.split("#");
        const destination = file
          ? path.resolve(path.dirname(document), decodeURIComponent(file))
          : path.resolve(document);
        const destinationInfo = await stat(destination);
        expect(destinationInfo.isFile() || destinationInfo.isDirectory(), `${document}: ${target}`).toBe(true);
        const relativeDestination = path.relative(process.cwd(), destination).split(path.sep).join("/");
        expect(
          packagedPaths.some((entry) => relativeDestination === entry || relativeDestination.startsWith(`${entry}/`)),
          `${document}: ${target} is omitted from the package`
        ).toBe(true);
        if (anchor) {
          const linkedContent = destination === path.resolve(document) ? content : await readFile(destination, "utf8");
          const anchors = [
            ...[...linkedContent.matchAll(/<a id="([^"]+)"/g)].map((entry) => entry[1]),
            ...[...linkedContent.matchAll(/^#{1,6}\s+(.+)$/gm)].map((entry) =>
              entry[1]
                .trim()
                .toLowerCase()
                .replace(/[^\p{L}\p{N}_ -]/gu, "")
                .replace(/ /g, "-")
            ),
          ];
          expect(anchors, `${document}: ${target}`).toContain(decodeURIComponent(anchor));
        }
      }
    }
  });
});
