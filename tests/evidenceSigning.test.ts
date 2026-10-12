import { generateKeyPairSync } from "node:crypto";
import { appendFile, chmod, cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildSessionReport } from "../src/reports/markdown.js";
import { writeReports } from "../src/reports/reportWriter.js";
import {
  EVIDENCE_SIGNATURE_FILE,
  evidenceKeyFingerprint,
  loadEvidenceKeyFile,
  signSessionEvidence,
} from "../src/session/evidenceSigning.js";
import { listSessionCatalog, type SessionCatalogEntry } from "../src/session/sessionCatalog.js";
import { verifySessions } from "../src/session/sessionVerification.js";
import { runCli } from "./cliRunner.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

async function fixture(repo: string): Promise<SessionCatalogEntry> {
  const id = "session-signed";
  const sessionDir = path.join(repo, DEFAULT_CONFIG.sessionDir, id);
  const timestamp = "2026-01-05T00:00:00.000Z";
  const report = buildSessionReport(
    { id, repoRoot: repo, sessionDir, startedAt: timestamp },
    timestamp,
    "test",
    [],
    [],
    { repoRoot: repo, statusText: "clean", diffSummaryText: "none", changedFiles: [] },
    [],
    []
  );
  await writeReports(report);
  await writeFile(path.join(sessionDir, "events.ndjson"), "");
  await writeFile(path.join(sessionDir, "commands.ndjson"), "");
  return { id, sessionDir, state: "complete" };
}

describe("independently anchored evidence signatures", () => {
  it("requires signing only when a trusted key is supplied and never overwrites a seal", async () => {
    const repo = await createTempDir();
    try {
      const entry = await fixture(repo);
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      expect(await verifySessions([entry])).toMatchObject({ verified: 1 });
      expect(await verifySessions([entry], { trustedKey: publicKey })).toMatchObject({ failed: 1 });
      expect(await signSessionEvidence(entry, privateKey)).toBe(evidenceKeyFingerprint(publicKey));
      await expect(signSessionEvidence(entry, privateKey)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await verifySessions([entry], { trustedKey: publicKey, memoryBudgetMb: 8 })).toMatchObject({
        verified: 1,
        failed: 0,
        sessions: [{ signatureVerified: true, keyFingerprint: evidenceKeyFingerprint(publicKey) }],
      });
      const seal = await readFile(path.join(entry.sessionDir, EVIDENCE_SIGNATURE_FILE), "utf8");
      expect(seal).not.toContain("PRIVATE KEY");
      expect(seal).not.toContain("PUBLIC KEY");

      // Derived indexes and Markdown are deliberately outside the signature's scope.
      await writeFile(path.join(entry.sessionDir, "summary.md"), "changed derived text");
      await rm(path.join(entry.sessionDir, "session-metadata.json"));
      expect(await verifySessions([entry], { trustedKey: publicKey, repairIndexes: true })).toMatchObject({
        verified: 1,
      });
      const archive = path.join(repo, "archive", entry.id);
      await cp(entry.sessionDir, archive, { recursive: true });
      expect(await verifySessions([{ ...entry, sessionDir: archive }], { trustedKey: publicKey })).toMatchObject({
        verified: 1,
      });
    } finally {
      await removeTempDir(repo);
    }
  });

  it("detects raw log edits, additions of formerly absent files, report edits, and signature stripping", async () => {
    const repo = await createTempDir();
    try {
      const entry = await fixture(repo);
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      await signSessionEvidence(entry, privateKey);
      for (const name of [
        "events.ndjson",
        "commands.ndjson",
        "git-start.json",
        "session-start.json",
        "session-replay.json",
        "session.json",
      ]) {
        const file = path.join(entry.sessionDir, name);
        const original = await readFile(file).catch(() => undefined);
        await appendFile(file, " ");
        expect(await verifySessions([entry], { trustedKey: publicKey }), name).toMatchObject({ failed: 1 });
        if (original) await writeFile(file, original);
        else await rm(file);
      }
      await rm(path.join(entry.sessionDir, EVIDENCE_SIGNATURE_FILE));
      expect(await verifySessions([entry], { trustedKey: publicKey })).toMatchObject({ failed: 1 });
      expect(await verifySessions([{ ...entry, state: "incomplete" }], { trustedKey: publicKey })).toMatchObject({
        failed: 1,
        skipped: 0,
      });
    } finally {
      await removeTempDir(repo);
    }
  });

  it("rejects a coherent replacement signed by an attacker unless the caller also replaces its trust anchor", async () => {
    const repo = await createTempDir();
    try {
      const entry = await fixture(repo);
      const trusted = generateKeyPairSync("ed25519");
      const attacker = generateKeyPairSync("ed25519");
      await signSessionEvidence(entry, trusted.privateKey);
      await rm(path.join(entry.sessionDir, EVIDENCE_SIGNATURE_FILE));
      await fixture(repo);
      const replacement = JSON.parse(await readFile(path.join(entry.sessionDir, "session.json"), "utf8"));
      replacement.git.statusText = "Attacker-controlled replacement evidence";
      await writeReports(replacement);
      expect(await verifySessions([entry])).toMatchObject({ verified: 1 });
      await signSessionEvidence(entry, attacker.privateKey);
      expect(await verifySessions([entry], { trustedKey: trusted.publicKey })).toMatchObject({ failed: 1 });
      // This passing result demonstrates why attacker-controlled anchors provide no authenticity.
      expect(await verifySessions([entry], { trustedKey: attacker.publicKey })).toMatchObject({ verified: 1 });
      expect(
        await verifySessions([{ ...entry, id: "session-other" }], { trustedKey: attacker.publicKey })
      ).toMatchObject({ failed: 1 });
      await expect(signSessionEvidence(entry, trusted.publicKey)).rejects.toThrow("private key");
    } finally {
      await removeTempDir(repo);
    }
  });

  it("rejects tampered, oversized, ambiguous, and symlinked signature files", async () => {
    const repo = await createTempDir();
    try {
      const entry = await fixture(repo);
      const keys = generateKeyPairSync("ed25519");
      await signSessionEvidence(entry, keys.privateKey);
      const file = path.join(entry.sessionDir, EVIDENCE_SIGNATURE_FILE);
      const original = await readFile(file, "utf8");
      const parsed = JSON.parse(original);
      for (const changed of [
        { ...parsed, signature: "A".repeat(86) + "==" },
        { ...parsed, files: parsed.files.slice(1) },
        { ...parsed, files: [{ ...parsed.files[0], name: "../session.json" }, ...parsed.files.slice(1)] },
        { ...parsed, files: [{ ...parsed.files[0], digest: "0".repeat(64) }, ...parsed.files.slice(1)] },
        { ...parsed, files: [{ ...parsed.files[0], bytes: -1 }, ...parsed.files.slice(1)] },
        { ...parsed, publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) },
      ]) {
        await writeFile(file, JSON.stringify(changed));
        expect(await verifySessions([entry], { trustedKey: keys.publicKey })).toMatchObject({ failed: 1 });
      }
      await writeFile(file, original + " ".repeat(16 * 1024));
      expect(await verifySessions([entry], { trustedKey: keys.publicKey })).toMatchObject({ failed: 1 });
      await rm(file);
      const target = path.join(repo, "seal.json");
      await writeFile(target, original);
      try {
        await symlink(target, file, "file");
      } catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }
      expect(await verifySessions([entry], { trustedKey: keys.publicKey })).toMatchObject({ failed: 1 });
    } finally {
      await removeTempDir(repo);
    }
  });

  it("loads only external protected keys and exercises signing and verification through the CLI", async () => {
    const workspace = await createTempDir();
    try {
      const repo = path.join(workspace, "repo");
      await mkdir(repo);
      initGitRepo(repo);
      const entry = await fixture(repo);
      const keys = generateKeyPairSync("ed25519");
      const privatePath = path.join(workspace, "private.pem");
      const publicPath = path.join(workspace, "public.pem");
      const passphrase = "synthetic-fixture-passphrase";
      await writeFile(
        privatePath,
        keys.privateKey.export({
          type: "pkcs8",
          format: "pem",
          cipher: "aes-256-cbc",
          passphrase,
        }),
        { mode: 0o600 }
      );
      await writeFile(publicPath, keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
      const sessionRoot = path.dirname(entry.sessionDir);
      await expect(loadEvidenceKeyFile(privatePath, repo, sessionRoot, { privateKey: true })).rejects.toThrow(
        "passphrase"
      );
      await expect(loadEvidenceKeyFile(privatePath, repo, sessionRoot)).rejects.toThrow("public SPKI");
      await expect(
        loadEvidenceKeyFile(privatePath, repo, sessionRoot, { privateKey: true, passphrase: "wrong" })
      ).rejects.toThrow();
      const inRepo = path.join(repo, "key.pem");
      await cp(publicPath, inRepo);
      await expect(loadEvidenceKeyFile(inRepo, repo, sessionRoot)).rejects.toThrow("outside");
      if (process.platform !== "win32") {
        await chmod(privatePath, 0o644);
        await expect(
          loadEvidenceKeyFile(privatePath, repo, sessionRoot, { privateKey: true, passphrase })
        ).rejects.toThrow("permissions");
        await chmod(privatePath, 0o600);
      }
      const unsigned = await runCli(repo, ["sessions", "verify", "--trusted-key", publicPath, "--json"]);
      expect(unsigned.exitCode).toBe(1);
      const signed = await runCli(repo, ["sessions", "sign", entry.id, "--private-key", privatePath], {
        env: { ABB_SIGNING_PASSPHRASE: passphrase },
      });
      expect(signed.exitCode, signed.stderr).toBe(0);
      expect(signed.stdout + signed.stderr).not.toContain(passphrase);
      const verified = await runCli(repo, ["sessions", "verify", "--trusted-key", publicPath, "--json"]);
      expect(verified.exitCode, verified.stderr).toBe(0);
      expect(JSON.parse(verified.stdout).sessions[0].signatureVerified).toBe(true);
      expect(await listSessionCatalog(repo, DEFAULT_CONFIG)).toHaveLength(1);
      await writeFile(publicPath, "x".repeat(16 * 1024 + 1));
      await expect(loadEvidenceKeyFile(publicPath, repo, sessionRoot)).rejects.toThrow("size limit");
      const directoryKey = path.join(workspace, "directory-key");
      await mkdir(directoryKey);
      await expect(loadEvidenceKeyFile(directoryKey, repo, sessionRoot)).rejects.toThrow("regular file");
      await writeFile(privatePath, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
      await expect(
        loadEvidenceKeyFile(privatePath, repo, sessionRoot, { privateKey: true, passphrase })
      ).rejects.toThrow("encrypted");
    } finally {
      await removeTempDir(workspace);
    }
  }, 30_000);
});
