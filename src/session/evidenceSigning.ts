import { createPrivateKey, createPublicKey, KeyObject, sign, verify } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { readFileLimited, writeTextFileAtomic } from "../utils/files.js";
import { isPathInside } from "../utils/paths.js";
import { isRecord } from "../utils/records.js";
import { digestBuffer, digestRegularFile, MAX_REPORT_BYTES } from "./reportStorage.js";
import { verifyCatalogSessionReportFile, type SessionCatalogEntry } from "./sessionCatalog.js";

export const EVIDENCE_SIGNATURE_FILE = "evidence-signature.json";
// Fixed names prevent the manifest from choosing what to authenticate or introducing path traversal.
const EVIDENCE_FILES = [
  ["session.json", MAX_REPORT_BYTES],
  ["session-start.json", 1024 * 1024],
  ["git-start.json", 32 * 1024 * 1024],
  ["events.ndjson", 1024 * 1024 * 1024],
  ["commands.ndjson", 1024 * 1024 * 1024],
  ["session-replay.json", 32 * 1024 * 1024],
] as const;
type FileSeal = { name: string; bytes: number; digest: string } | { name: string; absent: true };
interface EvidenceSeal {
  version: 1;
  algorithm: "Ed25519";
  id: string;
  keyFingerprint: string;
  files: FileSeal[];
  signature: string;
}

export function evidenceKeyFingerprint(key: KeyObject): string {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  requireEd25519Key(publicKey, "public");
  return digestBuffer(publicKey.export({ type: "spki", format: "der" }));
}

function requireEd25519Key(key: KeyObject, type: "private" | "public"): void {
  if (!(key instanceof KeyObject) || key.type !== type || key.asymmetricKeyType !== "ed25519") {
    throw new Error("Evidence signing requires an Ed25519 " + type + " key.");
  }
}

function sealPayload(seal: Omit<EvidenceSeal, "signature">): Buffer {
  return Buffer.from("Agent Black Box evidence seal v1\n" + JSON.stringify(seal));
}

async function snapshotEvidence(entry: SessionCatalogEntry): Promise<FileSeal[]> {
  const files: FileSeal[] = [];
  for (const [name, limit] of EVIDENCE_FILES) {
    const filePath = path.join(entry.sessionDir, name);
    try {
      files.push({ name, ...(await digestRegularFile(filePath, limit)) });
    } catch (error) {
      if (name !== "session.json" && (error as NodeJS.ErrnoException).code === "ENOENT") {
        files.push({ name, absent: true });
      } else {
        throw error;
      }
    }
  }
  return files;
}

/** Attests to the current finalized bytes, not to their history before this call. Never stores a key. */
export async function signSessionEvidence(entry: SessionCatalogEntry, privateKey: KeyObject): Promise<string> {
  requireEd25519Key(privateKey, "private");
  const files = await snapshotEvidence(entry);
  await verifyCatalogSessionReportFile(entry, { verifyEventLogs: true });
  // Refuse evidence changed while structural validation was running.
  if (JSON.stringify(files) !== JSON.stringify(await snapshotEvidence(entry))) {
    throw new Error("Evidence changed during signing.");
  }
  const seal: Omit<EvidenceSeal, "signature"> = {
    version: 1,
    algorithm: "Ed25519",
    id: entry.id,
    keyFingerprint: evidenceKeyFingerprint(privateKey),
    files,
  };
  const signature = sign(null, sealPayload(seal), privateKey).toString("base64");
  await writeTextFileAtomic(
    path.join(entry.sessionDir, EVIDENCE_SIGNATURE_FILE),
    JSON.stringify({ ...seal, signature }, null, 2) + "\n",
    { overwrite: false }
  );
  return seal.keyFingerprint;
}

/** The caller supplies the trust anchor; a key embedded in evidence is never accepted. */
export async function verifySessionEvidenceSignature(
  entry: SessionCatalogEntry,
  trustedKey: KeyObject
): Promise<string> {
  requireEd25519Key(trustedKey, "public");
  const signaturePath = path.join(entry.sessionDir, EVIDENCE_SIGNATURE_FILE);
  if (!(await lstat(signaturePath)).isFile()) {
    throw new Error("Evidence signature must be a regular file.");
  }
  const value: unknown = JSON.parse((await readFileLimited(signaturePath, 16 * 1024)).toString("utf8"));
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.algorithm !== "Ed25519" ||
    value.id !== entry.id ||
    value.keyFingerprint !== evidenceKeyFingerprint(trustedKey) ||
    typeof value.signature !== "string" ||
    !/^[A-Za-z0-9+/]{86}==$/.test(value.signature) ||
    !Array.isArray(value.files) ||
    value.files.length !== EVIDENCE_FILES.length ||
    Object.keys(value).sort().join() !== "algorithm,files,id,keyFingerprint,signature,version"
  ) {
    throw new Error("Invalid evidence signature or untrusted signing key.");
  }
  const files: FileSeal[] = value.files.map((file: unknown, index: number) => {
    if (!isRecord(file) || file.name !== EVIDENCE_FILES[index]![0]) {
      throw new Error("Invalid evidence signature manifest.");
    }
    if (index > 0 && file.absent === true && Object.keys(file).sort().join() === "absent,name") {
      return { name: file.name as string, absent: true };
    }
    if (
      !Number.isSafeInteger(file.bytes) ||
      Number(file.bytes) < 0 ||
      Number(file.bytes) > EVIDENCE_FILES[index]![1] ||
      typeof file.digest !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.digest) ||
      Object.keys(file).sort().join() !== "bytes,digest,name"
    ) {
      throw new Error("Invalid evidence signature manifest.");
    }
    return { name: file.name as string, bytes: file.bytes as number, digest: file.digest };
  });
  const seal: Omit<EvidenceSeal, "signature"> = {
    version: 1,
    algorithm: "Ed25519",
    id: entry.id,
    keyFingerprint: value.keyFingerprint as string,
    files,
  };
  if (!verify(null, sealPayload(seal), trustedKey, Buffer.from(value.signature, "base64"))) {
    throw new Error("Evidence signature verification failed.");
  }
  if (JSON.stringify(files) !== JSON.stringify(await snapshotEvidence(entry))) {
    throw new Error("Signed evidence no longer matches its manifest.");
  }
  return seal.keyFingerprint;
}

async function readProtectedKeyFile(filePath: string, privateKey: boolean): Promise<Buffer> {
  const inspected = await lstat(filePath);
  if (!inspected.isFile()) {
    throw new Error("Evidence key must be a regular file, not a symbolic link.");
  }
  const handle = await open(filePath, "r");
  const bytes = Buffer.alloc(16 * 1024 + 1);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== inspected.dev || opened.ino !== inspected.ino) {
      throw new Error("Evidence key changed while opening.");
    }
    if (process.platform !== "win32" && (opened.mode & (privateKey ? 0o077 : 0o022)) !== 0) {
      throw new Error(
        "Evidence key permissions are too broad; use 0600 for private keys and protect public keys from writes."
      );
    }
    if (opened.size > 16 * 1024) throw new Error("Evidence key exceeds the 16 KiB size limit.");
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const [finished, current] = await Promise.all([handle.stat(), lstat(filePath)]);
    if (length > 16 * 1024) throw new Error("Evidence key exceeds the 16 KiB size limit.");
    if (
      length !== opened.size ||
      finished.size !== opened.size ||
      finished.mtimeMs !== opened.mtimeMs ||
      finished.ctimeMs !== opened.ctimeMs ||
      !current.isFile() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.mtimeMs !== finished.mtimeMs ||
      current.ctimeMs !== finished.ctimeMs
    ) {
      throw new Error("Evidence key changed while reading.");
    }
    return Buffer.from(bytes.subarray(0, length));
  } finally {
    bytes.fill(0);
    await handle.close();
  }
}

/** CLI key files must be independently provisioned outside both repository and session storage. */
export async function loadEvidenceKeyFile(
  filePath: string,
  repoRoot: string,
  sessionRoot: string,
  options: { privateKey?: boolean; passphrase?: string } = {}
): Promise<KeyObject> {
  const [physicalKey, physicalRepo, physicalSessions] = await Promise.all([
    realpath(filePath),
    realpath(repoRoot),
    realpath(sessionRoot),
  ]);
  if (
    [repoRoot, sessionRoot].some((dir) => isPathInside(path.resolve(dir), path.resolve(filePath))) ||
    [physicalRepo, physicalSessions].some((dir) => isPathInside(dir, physicalKey))
  ) {
    throw new Error("Evidence key files must be outside the repository and session storage.");
  }
  const pem = await readProtectedKeyFile(filePath, options.privateKey === true);
  try {
    if (
      options.privateKey &&
      (!options.passphrase || !pem.toString("utf8").startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----"))
    ) {
      throw new Error("Signing requires encrypted PKCS8 PEM and a non-empty passphrase.");
    }
    if (!options.privateKey && !pem.toString("utf8").startsWith("-----BEGIN PUBLIC KEY-----")) {
      throw new Error("Verification requires a public SPKI PEM key.");
    }
    const key = options.privateKey
      ? createPrivateKey({ key: pem, format: "pem", passphrase: options.passphrase })
      : createPublicKey(pem);
    requireEd25519Key(key, options.privateKey ? "private" : "public");
    return key;
  } finally {
    pem.fill(0);
  }
}
