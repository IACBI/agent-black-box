import { access, constants } from "node:fs/promises";
import path from "node:path";
import type { AgentBlackBoxConfig } from "../types.js";
import { CONFIG_FILE_NAME } from "../config/defaults.js";
import { configExists, loadConfig } from "../config/config.js";
import { getRepositoryRoot } from "../git/git.js";
import { getSessionRoot, isProcessRunning, readActiveSession } from "../session/sessionManager.js";
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

  const config = await loadConfig(repoRoot);
  checks.push(await checkConfig(repoRoot));
  checks.push(await checkWritable(repoRoot, "Repository write access"));
  checks.push(await checkSessionDirectory(repoRoot, config));
  checks.push(await checkSessionState(repoRoot, config));

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

async function checkConfig(repoRoot: string): Promise<DoctorCheck> {
  if (await configExists(repoRoot)) {
    return pass("Config", `${CONFIG_FILE_NAME} exists.`);
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
  const active = await readActiveSession(repoRoot, config);

  if (!active) {
    return pass("Session state", "No active session.");
  }

  if (isProcessRunning(active.pid)) {
    return pass("Session state", `Session ${active.id} is active.`);
  }

  return warn("Session state", `Session ${active.id} appears stale. Run \`abb stop\` to finalize it.`);
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
