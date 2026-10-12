import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/config.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { DoctorReport } from "../src/doctor/doctor.js";
import { createSession, getActiveSessionPath, getSessionLockPath } from "../src/session/sessionManager.js";
import { runCli } from "./cliRunner.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("doctor JSON CLI", () => {
  it.each([false, true])("prints one report with repair=%s when no recovery is needed", async (repair) => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      await createDefaultConfig(dir);
      const result = await runCli(dir, ["doctor", "--json", ...(repair ? ["--repair"] : [])]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout) as DoctorReport;
      expect(report.ok).toBe(true);
      expect(report.checks.find((check) => check.name === "Config")?.status).toBe("pass");
      expect(report.checks.find((check) => check.name === "Session state")?.message).toBe("No active session.");
      const text = await runCli(dir, ["doctor"]);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain("Agent Black Box Doctor");
      expect(text.stdout).toContain("Result: ready");
    } finally {
      await removeTempDir(dir);
    }
  });

  it.each(["outside Git", "invalid config"])("returns failure details as JSON for %s", async (failure) => {
    const dir = await createTempDir();
    try {
      if (failure === "invalid config") {
        initGitRepo(dir);
        await writeFile(path.join(dir, ".agentblackbox.json"), "{not-json}");
      }
      const result = await runCli(dir, ["doctor", "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout) as DoctorReport;
      expect(report.ok).toBe(false);
      expect(
        report.checks.find((check) => check.name === (failure === "outside Git" ? "Git repository" : "Config"))?.status
      ).toBe("fail");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("requires external storage authorization and escapes controls without changing JSON values", async () => {
    const dir = await createTempDir();
    const externalDir = await createTempDir();
    try {
      initGitRepo(dir);
      const sessionDir = path.join(externalDir, "sessions\u009b\u2028\u2029");
      await mkdir(sessionDir);
      await writeFile(path.join(dir, ".agentblackbox.json"), JSON.stringify({ ...DEFAULT_CONFIG, sessionDir }));
      const denied = await runCli(dir, ["doctor", "--json"]);
      expect(denied.exitCode).toBe(1);
      expect((JSON.parse(denied.stdout) as DoctorReport).checks.find((check) => check.name === "Config")?.status).toBe(
        "fail"
      );
      const allowed = await runCli(dir, ["--allow-external-session-dir", "doctor", "--json"]);
      expect(allowed.exitCode).toBe(0);
      const report = JSON.parse(allowed.stdout) as DoctorReport;
      expect(report.checks.find((check) => check.name === "Session directory")?.message).toBe(
        `Writable: ${sessionDir}`
      );
      for (const control of ["\u009b", "\u2028", "\u2029"]) {
        expect(allowed.stdout).not.toContain(control);
      }
    } finally {
      await removeTempDir(dir);
      await removeTempDir(externalDir);
    }
  });

  it("repairs a stale session and prints only the resulting doctor report", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      await createDefaultConfig(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const activePath = getActiveSessionPath(dir, DEFAULT_CONFIG);
      const lockPath = getSessionLockPath(dir, DEFAULT_CONFIG);
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
      await writeFile(activePath, JSON.stringify({ ...session, pid: 999_999 }));
      await writeFile(lockPath, JSON.stringify({ ...lock, pid: 999_999 }));
      const result = await runCli(dir, ["doctor", "--repair", "--json"]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout) as DoctorReport;
      expect(report.ok).toBe(true);
      expect(report.checks.find((check) => check.name === "Session state")?.message).toBe("No active session.");
      expect(JSON.parse(await readFile(path.join(session.sessionDir, "session.json"), "utf8"))).toMatchObject({
        id: session.id,
      });
    } finally {
      await removeTempDir(dir);
    }
  });
});
