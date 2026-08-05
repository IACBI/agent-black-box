import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  buildWindowsCommandLine,
  formatCommand,
  normalizeCommandParts,
  recordAndRunCommand,
  redactCommandParts,
  resolveRunCwd,
} from "../src/commands/commandRecorder.js";
import { createSession, readCommandEvents } from "../src/session/sessionManager.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("command recorder", () => {
  it("redacts sensitive assignments and flags", () => {
    const tokenAssignment = ["API", "_TOKEN", "=", "plain", "-text", "-token"].join("");
    const passwordFlag = ["--pass", "word"].join("");
    const passwordValue = ["super", "-secret"].join("");
    const clientSecretFlag = ["--client", "-secret", "=another", "-secret"].join("");
    const parts = redactCommandParts([
      "deploy",
      tokenAssignment,
      passwordFlag,
      passwordValue,
      clientSecretFlag,
      "safe",
    ]);

    expect(parts).toEqual([
      "deploy",
      "API_TOKEN=<redacted>",
      "--password",
      "<redacted>",
      "--client-secret=<redacted>",
      "safe",
    ]);
    expect(parts.join(" ")).not.toContain(passwordValue);
    expect(parts.join(" ")).not.toContain("another-secret");
  });

  it("redacts nested assignments, headers, URL credentials, and query parameters", () => {
    const rawValue = ["do", "-not", "-store"].join("");
    const parts = redactCommandParts([
      `--env=API_TOKEN=${rawValue}`,
      `Authorization:Bearer ${rawValue}`,
      `https://user:${rawValue}@example.test/deploy?api_key=${rawValue}&mode=safe`,
    ]);

    expect(parts.join(" ")).not.toContain(rawValue);
    expect(parts[0]).toBe("--env=API_TOKEN=<redacted>");
    expect(parts[1]).toBe("Authorization:<redacted>");
    expect(parts[2]).toContain("mode=safe");
  });

  it("quotes command parts for readable reports", () => {
    expect(formatCommand(["pnpm", "test", "--", "name with spaces"])).toBe('pnpm test -- "name with spaces"');
  });

  it("strips a leading passthrough separator", () => {
    expect(normalizeCommandParts(["--", "node", "--version"])).toEqual(["node", "--version"]);
    expect(normalizeCommandParts(["node", "--version"])).toEqual(["node", "--version"]);
  });

  it("quotes Windows command-script arguments without enabling shell mode", () => {
    expect(buildWindowsCommandLine(["pnpm.cmd", "run", "name with spaces", "a&b"])).toBe(
      'pnpm.cmd run "name with spaces" a^&b'
    );
    expect(buildWindowsCommandLine(["pnpm.cmd", "a!b"])).toBe("pnpm.cmd a^!b");
  });

  it("resolves command working directories inside the repository", async () => {
    const dir = await createTempDir();
    try {
      await mkdir(`${dir}/packages/app`, { recursive: true });

      await expect(resolveRunCwd(dir, "packages/app")).resolves.toContain("packages");
      await expect(resolveRunCwd(dir, "../outside")).rejects.toThrow("inside the repository");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("rejects working directories that escape through a symbolic link", async () => {
    const repoDir = await createTempDir();
    const outsideDir = await createTempDir();
    try {
      const linkPath = path.join(repoDir, "outside-link");
      await symlink(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");

      await expect(resolveRunCwd(repoDir, "outside-link")).rejects.toThrow("symbolic links");
    } finally {
      await removeTempDir(repoDir);
      await removeTempDir(outsideDir);
    }
  });

  it("runs bare package-manager commands on Windows without enabling shell mode", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      await writeFile(path.join(dir, "package.json"), '{"packageManager":"pnpm@10.30.3"}\n', "utf8");
      const session = await createSession(dir, DEFAULT_CONFIG);

      await expect(recordAndRunCommand(["pnpm", "--version"], dir)).resolves.toBe(0);
      await expect(readCommandEvents(session.sessionDir)).resolves.toContainEqual(
        expect.objectContaining({ command: "pnpm --version", exitCode: 0 })
      );
    } finally {
      await removeTempDir(dir);
    }
  }, 15_000);
});
