import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../src/config/config.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { renderDoctorReport, runDoctor, type DoctorReport } from "../src/doctor/doctor.js";
import {
  createSession,
  getActiveSessionPath,
  getSessionLockPath,
  readSessionLock,
  markCaptureLoss,
} from "../src/session/sessionManager.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("doctor", () => {
  it.each(["healthy", "degraded", "unknown"])(
    "reports %s persisted capture health for an active session",
    async (status) => {
      const dir = await createTempDir();
      try {
        initGitRepo(dir);
        const session = await createSession(dir, DEFAULT_CONFIG);
        if (status === "degraded") {
          await markCaptureLoss(session, "overflow");
        } else if (status === "unknown") {
          await writeFile(path.join(session.sessionDir, "capture-loss-overflow"), "corrupt marker");
        }
        const report = await runDoctor(dir);
        const check = report.checks.find((entry) => entry.name === "Capture health");
        expect(report.ok).toBe(true);
        expect(check?.status).toBe(status === "healthy" ? "pass" : "warn");
        expect(check?.message).toContain(`Capture health: ${status}`);
        expect(check?.message).toContain("Only persisted markers");
        expect(report.checks.find((entry) => entry.name === "Session state")?.status).toBe("pass");
      } finally {
        await removeTempDir(dir);
      }
    }
  );

  it("reports capture health alongside an existing stale-session recovery warning", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      const session = await createSession(dir, DEFAULT_CONFIG);
      const lock = await readSessionLock(dir, DEFAULT_CONFIG);
      await markCaptureLoss(session, "watcherError");
      await writeFile(getActiveSessionPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...session, pid: 999_999 }));
      await writeFile(getSessionLockPath(dir, DEFAULT_CONFIG), JSON.stringify({ ...lock, pid: 999_999 }));
      const report = await runDoctor(dir);
      expect(report.checks.find((entry) => entry.name === "Session state")?.status).toBe("warn");
      expect(report.checks.find((entry) => entry.name === "Capture health")?.message).toContain("degraded");
    } finally {
      await removeTempDir(dir);
    }
  });
  it("preserves printable diagnostics for missing fields from non-Error failures", () => {
    const report = {
      ok: false,
      repoRoot: null,
      checks: [{ name: undefined, status: "fail", message: undefined }],
    } as unknown as DoctorReport;
    expect(renderDoctorReport(report)).toContain("FAIL undefined: undefined");
  });

  it("renders distinct visible control messages without changing the structured report", () => {
    const messages = ["Writable: /repo/a\u001b[2J\n", "Writable: /repo/a\\u001b[2J\\n"];
    const report = {
      ok: true,
      repoRoot: "/repo",
      checks: messages.map((message) => ({ name: "Repository\u009b31m", status: "pass" as const, message })),
    };
    const before = JSON.stringify(report);
    const rendered = renderDoctorReport(report);
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u009b");
    expect(rendered).toContain('"Repository\\u009b31m"');
    for (const message of messages) {
      expect(rendered).toContain(JSON.stringify(message));
    }
    expect(rendered.split("\n")).toHaveLength(7);
    expect(JSON.stringify(report)).toBe(before);
  });

  it("fails outside a Git repository", async () => {
    const dir = await createTempDir();
    try {
      const report = await runDoctor(dir);

      expect(report.ok).toBe(false);
      expect(renderDoctorReport(report)).toContain("FAIL Git repository");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("checks a configured Git repository", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      await createDefaultConfig(dir);

      const report = await runDoctor(dir);
      const rendered = renderDoctorReport(report);

      expect(report.ok).toBe(true);
      expect(rendered).toContain("PASS Node.js");
      expect(rendered).toContain("PASS Config");
      expect(rendered).toContain("PASS Session state");
      expect(report.checks.some((check) => check.name === "Capture health")).toBe(false);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("reports invalid config as a doctor failure", async () => {
    const dir = await createTempDir();
    try {
      initGitRepo(dir);
      await writeFile(path.join(dir, ".agentblackbox.json"), "{not-json}", "utf8");

      const report = await runDoctor(dir);
      const rendered = renderDoctorReport(report);

      expect(report.ok).toBe(false);
      expect(rendered).toContain("FAIL Config");
      expect(rendered).toContain("Failed to parse");
    } finally {
      await removeTempDir(dir);
    }
  });

  it.each([".agent-black-box", ".agent-black-box/sessions", ".agent-black-box/missing/sessions"])(
    "reports a file blocking session directory %s as a doctor failure",
    async (sessionDir) => {
      const dir = await createTempDir();
      try {
        initGitRepo(dir);
        await writeFile(path.join(dir, ".agentblackbox.json"), JSON.stringify({ ...DEFAULT_CONFIG, sessionDir }));
        await writeFile(path.join(dir, ".agent-black-box"), "accidental file\n", "utf8");

        const report = await runDoctor(dir);

        expect(report.ok).toBe(false);
        expect(renderDoctorReport(report)).toContain("FAIL Session directory");
        expect(renderDoctorReport(report)).toContain("Not a directory");
      } finally {
        await removeTempDir(dir);
      }
    }
  );
});
