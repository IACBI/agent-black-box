import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  buildWindowsCommandLine,
  formatCommand,
  normalizeCommandParts,
  recordAndRunCommand,
  redactCommandParts,
  resolveRunCwd,
} from "../src/commands/commandRecorder.js";
import {
  createSession,
  getActiveSessionPath,
  getSessionLockPath,
  readCommandEvents,
  finalizeSession,
} from "../src/session/sessionManager.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("command recorder", () => {
  it("redacts the whole header value even when it contains an equals sign", () => {
    expect(
      redactCommandParts([
        "Authorization:Bearer confidential=value",
        "--header=Cookie:session=private",
        "--header=X-Api-Key:do-not-store",
      ])
    ).toEqual(["Authorization:<redacted>", "--header=Cookie:<redacted>", "--header=X-Api-Key:<redacted>"]);
  });

  it.each(["directory", "owner"])("rejects tampered session %s before running a command", async (field) => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      if (field === "directory") {
        await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...session, sessionDir: dir }));
      } else {
        const lockPath = getSessionLockPath(dir, DEFAULT_CONFIG);
        const lock = JSON.parse(await readFile(lockPath, "utf8"));
        await writeFile(lockPath, JSON.stringify({ ...lock, ownerToken: "00000000-0000-4000-8000-000000000000" }));
      }
      await expect(recordAndRunCommand([process.execPath, "--version"], dir)).rejects.toThrow("abb doctor");
      await expect(readCommandEvents(session.sessionDir)).resolves.toEqual([]);
    } finally {
      await removeTempDir(dir);
    }
  });

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

  it("redacts credentials in option URLs and sensitive JSON arguments", () => {
    const credential = ["do", "-not", "-store"].join("");
    const parts = redactCommandParts([
      `--url=https://${credential}@example.test/path?access_token=${credential}&mode=safe`,
      `--data={"client_secret":"${credential}","mode":"safe"}`,
      `{"password":"${credential}"}`,
      '{"mode":"safe"}',
    ]);

    expect(parts[0]).toContain("mode=safe");
    expect(parts[1]).toBe("--data=<redacted>");
    expect(parts[2]).toBe("<redacted>");
    expect(parts[3]).toBe('{"mode":"safe"}');
    expect(parts.join(" ")).not.toContain(credential);
  });

  it("redacts sensitive command metadata before persisting it", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const credential = ["do", "-not", "-store"].join("");
      expect(
        await recordAndRunCommand([process.execPath, "--version"], dir, {
          label: `Review API_TOKEN=${credential}`,
          group: `{"client_secret": "${credential}"}`,
          phase: `https://${credential}@example.test/check`,
        })
      ).toBe(0);
      const [event] = await readCommandEvents(session.sessionDir);
      expect(event?.label).toBe("<redacted>");
      expect(event?.group).toBe("<redacted>");
      expect(event?.phase).not.toContain(credential);
      expect(JSON.stringify(event)).not.toContain(credential);
    } finally {
      await removeTempDir(dir);
    }
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
      '"pnpm.cmd run "name with spaces" "a&b""'
    );
    expect(buildWindowsCommandLine(["pnpm.cmd", "a!b"])).toBe('"pnpm.cmd "a!b""');
    expect(buildWindowsCommandLine(["pnpm.cmd", "path with spaces\\"])).toBe('"pnpm.cmd "path with spaces\\\\""');
    expect(() => buildWindowsCommandLine(["pnpm.cmd", "%USERNAME%"])).toThrow("percent signs");
  });

  it("handles long runs of backslashes in Windows command-script arguments", () => {
    const backslashes = "\\".repeat(20_000);
    const commandLine = buildWindowsCommandLine(["pnpm.cmd", `has space ${backslashes}x`, `ends with ${backslashes}`]);

    expect(commandLine).toContain(`"has space ${backslashes}x"`);
    expect(commandLine).toContain(`"ends with ${backslashes}${backslashes}"`);
  });

  it.skipIf(process.platform !== "win32")(
    "passes Windows batch arguments without changing their values",
    async () => {
      const dir = await createTempDir();
      try {
        initGitRepo(dir);
        const scriptDir = path.join(dir, "batch scripts");
        await mkdir(scriptDir);
        const scriptPath = path.join(scriptDir, "capture.cmd");
        const receiverPath = path.join(dir, "receiver.cjs");
        const outputPath = path.join(dir, "args.json");
        await writeFile(
          receiverPath,
          'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n',
          "utf8"
        );
        await writeFile(
          scriptPath,
          `@echo off\r\n"${process.execPath}" "${receiverPath}" "${outputPath}" %*\r\n`,
          "utf8"
        );
        await createSession(dir, DEFAULT_CONFIG);

        const args = [
          "plain",
          "with spaces",
          "a&b",
          "a!b",
          "a^b",
          'a"b',
          'literal" & echo injected>injected.txt & "text',
          "path with spaces\\",
        ];
        expect(await recordAndRunCommand([scriptPath, ...args], dir)).toBe(0);
        expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(args);
        await expect(readFile(path.join(dir, "injected.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(await recordAndRunCommand([scriptPath, "%USERNAME%"], dir)).toBe(1);
        expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(args);
      } finally {
        await removeTempDir(dir);
      }
    },
    15_000
  );

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

  it("includes a command still running when finalization starts", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const running = recordAndRunCommand([process.execPath, "-e", "setTimeout(() => process.exit(0), 500)"], dir);
      await vi.waitFor(async () => {
        expect((await readdir(session.sessionDir)).some((name) => name.startsWith("command-inflight-"))).toBe(true);
      });

      const finalizing = finalizeSession(session, DEFAULT_CONFIG, "test");
      expect(await running).toBe(0);
      const report = await finalizing;
      expect(report.commands).toHaveLength(1);
      expect(report.commands[0]?.exitCode).toBe(0);
    } finally {
      await removeTempDir(dir);
    }
  }, 15_000);
});
