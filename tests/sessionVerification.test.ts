import { mkdir, rm, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { listSessionCatalog } from "../src/session/sessionCatalog.js";
import { createSession, finalizeSession } from "../src/session/sessionManager.js";
import { renderSessionVerification, verifySessions } from "../src/session/sessionVerification.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

async function verifyRepository(repo: string) {
  return verifySessions(await listSessionCatalog(repo, DEFAULT_CONFIG));
}

describe("session verification", () => {
  it("verifies a finalized session without missing reports", async () => {
    const repo = await createTempDir("abb-verify-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      await finalizeSession(session, DEFAULT_CONFIG, "test");

      const summary = await verifyRepository(repo);

      expect(summary).toMatchObject({ verified: 1, failed: 0, skipped: 0 });
      expect(summary.sessions).toEqual([{ id: session.id, status: "verified" }]);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("reports absent derived reports without failing the session", async () => {
    const repo = await createTempDir("abb-verify-missing-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      await finalizeSession(session, DEFAULT_CONFIG, "test");
      await rm(path.join(session.sessionDir, "summary.md"));
      await rm(path.join(session.sessionDir, "risks.md"));

      const summary = await verifyRepository(repo);

      expect(summary.failed).toBe(0);
      expect(summary.sessions[0]).toMatchObject({
        status: "verified",
        missingReports: ["summary.md", "risks.md"],
      });
      expect(renderSessionVerification(summary)).toContain("missing reports: summary.md, risks.md");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("fails a session whose stored report was damaged", async () => {
    const repo = await createTempDir("abb-verify-damaged-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      await finalizeSession(session, DEFAULT_CONFIG, "test");
      await truncate(path.join(session.sessionDir, "session.json"), 20);

      const summary = await verifyRepository(repo);

      expect(summary).toMatchObject({ verified: 0, failed: 1, skipped: 0 });
      expect(summary.sessions[0]).toMatchObject({ id: session.id, status: "failed" });
      expect(summary.sessions[0]?.message).toBeTruthy();
    } finally {
      await removeTempDir(repo);
    }
  });

  it("skips incomplete sessions and fails corrupt catalog entries", async () => {
    const repo = await createTempDir("abb-verify-states-");
    try {
      initGitRepo(repo);
      const sessionRoot = path.join(repo, DEFAULT_CONFIG.sessionDir);
      const incompleteId = "session-2026-01-04T00-00-00-000Z";
      const corruptId = "session-2026-01-02T00-00-00-000Z";
      await mkdir(path.join(sessionRoot, incompleteId), { recursive: true });
      await writeFile(
        path.join(sessionRoot, incompleteId, "session-start.json"),
        JSON.stringify({ id: incompleteId, startedAt: "2026-01-04T00:00:00.000Z" })
      );
      await mkdir(path.join(sessionRoot, corruptId), { recursive: true });
      await writeFile(path.join(sessionRoot, corruptId, "session.json"), JSON.stringify({ id: corruptId }));

      const summary = await verifyRepository(repo);

      expect(summary).toMatchObject({ verified: 0, failed: 1, skipped: 1 });
      expect(summary.sessions.map((session) => [session.id, session.status])).toEqual([
        [incompleteId, "skipped"],
        [corruptId, "failed"],
      ]);
      expect(renderSessionVerification(summary)).toContain("Verified: 0, failed: 1, skipped: 1.");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("renders an explicit message when there are no sessions", async () => {
    expect(renderSessionVerification(await verifySessions([]))).toBe("No Agent Black Box sessions were found.\n");
  });
});
