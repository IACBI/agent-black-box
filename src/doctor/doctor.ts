import { access, constants } from "node:fs/promises";
import path from "node:path";
import type { AgentBlackBoxConfig } from "../types.js";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG } from "../config/defaults.js";
import { configExists, loadConfigWithMeta } from "../config/config.js";
import { getRepositoryRoot } from "../git/git.js";
import { getSessionLockPath, getSessionRoot, isProcessRunning, readActiveSessionState, readSessionLock } from "../session/sessionManager.js";
import { pathExists } from "../utils/files.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  repoRoot: string | null;
  checks: DoctorCheck[];
}

export async function runDoctor(cwd: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(checkNodeVersion(process.versions.node));

  let repoRoot: string | null = null;
  try {
    repoRoot = await getRepositoryRoot(cwd);
    checks.push(
      repoRoot
        ? pass("Git repository", `Repository root: ${repoRoot}`)
        : fail("Git repository", "Run Agent Black Box inside a Git repository.")
    );
  } catch (error) {
    checks.push(fail("Git repository", (error as Error).message));
  }

  if (!repoRoot) {
    return {
      ok: false,
      repoRoot,
      checks
    };
  }

  let config: AgentBlackBoxConfig = DEFAULT_CONFIG;
  try {
    const configResult = await loadConfigWithMeta(repoRoot);
    config = configResult.config;
    checks.push(await checkConfig(repoRoot, configResult));
  } catch (error) {
    checks.push(fail("Config", (error as Error).message));
  }

  checks.push(await checkWritable(repoRoot, "Repository write access"));
  checks.push(await checkSessionDirectory(repoRoot, config));
  checks.push(await checkSessionState(repoRoot, config));
  checks.push(await checkSessionLock(repoRoot, config));

  return {
    ok: checks.every((check) => check.status !== "fail"),
    repoRoot,
    checks
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = ["Agent Black Box Doctor", ""];

  for (const check of report.checks) {
    lines.push(`${formatStatus(check.status)} ${check.name}: ${check.message}`);
  }

  lines.push("");
  lines.push(report.ok ? "Result: ready" : "Result: attention required");

  return `${lines.join("\n")}\n`;
}

function checkNodeVersion(version: string): DoctorCheck {
  const major = Number.parseInt(version.split(".")[0] ?? "0", 10);

  if (major >= 20) {
    return pass("Node.js", `Detected ${version}.`);
  }

  return fail("Node.js", `Detected ${version}. Node.js 20 or newer is required.`);
}

async function checkConfig(repoRoot: string, configResult: Awaited<ReturnType<typeof loadConfigWithMeta>>): Promise<DoctorCheck> {
  if (configResult.errors.length > 0) {
    return fail("Config", configResult.errors.join(" "));
  }

  if (configResult.warnings.length > 0 || configResult.migrated) {
    return warn("Config", `${CONFIG_FILE_NAME} should be migrated or cleaned up. ${configResult.warnings.join(" ")}`);
  }

  if (await configExists(repoRoot)) {
    return pass("Config", `${CONFIG_FILE_NAME} exists and is valid.`);
  }

  return warn("Config", `${CONFIG_FILE_NAME} was not found. Run \`abb init\` to create it.`);
}

async function checkSessionDirectory(repoRoot: string, config: AgentBlackBoxConfig): Promise<DoctorCheck> {
  const sessionRoot = getSessionRoot(repoRoot, config);
  const existingPath = (await pathExists(sessionRoot)) ? sessionRoot : path.dirname(sessionRoot);

  if (!(await pathExists(existingPath))) {
    return warn("Session directory", `${sessionRoot} does not exist yet. It will be created by \`abb start\`.`);
  }

  return checkWritable(existingPath, "Session directory");
}

async function checkSessionState(repoRoot: string, config: AgentBlackBoxConfig): Promise<DoctorCheck> {
  const state = await readActiveSessionState(repoRoot, config);

  if (state.corrupted) {
    return warn("Session state", `Active session state is unreadable: ${state.error ?? "unknown error"}. Run \`abb start\` to recover or \`abb stop\` if a watcher is still running.`);
  }

  if (!state.value) {
    return pass("Session state", "No active session.");
  }

  if (isProcessRunning(state.value.pid)) {
    return pass("Session state", `Session ${state.value.id} is active.`);
  }

  return warn("Session state", `Session ${state.value.id} appears stale. Run \`abb stop\` to finalize it.`);
}

async function checkSessionLock(repoRoot: string, config: AgentBlackBoxConfig): Promise<DoctorCheck> {
  const lockPath = getSessionLockPath(repoRoot, config);
  if (!(await pathExists(lockPath))) {
    return pass("Session lock", "No active lock.");
  }

  const lock = await readSessionLock(repoRoot, config);
  if (!lock) {
    return warn("Session lock", `Lock file is unreadable: ${lockPath}.`);
  }

  if (isProcessRunning(lock.pid)) {
    return pass("Session lock", `Lock is active for ${lock.sessionId}.`);
  }

  return warn("Session lock", `Lock for ${lock.sessionId} appears stale and will be recovered by \`abb start\`.`);
}

async function checkWritable(targetPath: string, name: string): Promise<DoctorCheck> {
  try {
    await access(targetPath, constants.W_OK);
    return pass(name, `Writable: ${targetPath}`);
  } catch {
    return fail(name, `Not writable: ${targetPath}`);
  }
}

function pass(name: string, message: string): DoctorCheck {
  return { name, status: "pass", message };
}

function warn(name: string, message: string): DoctorCheck {
  return { name, status: "warn", message };
}

function fail(name: string, message: string): DoctorCheck {
  return { name, status: "fail", message };
}

function formatStatus(status: DoctorStatus): string {
  if (status === "pass") {
    return "PASS";
  }

  if (status === "warn") {
    return "WARN";
  }

  return "FAIL";
}
