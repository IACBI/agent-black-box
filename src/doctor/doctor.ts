import { access, constants, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentBlackBoxConfig } from "../types.js";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG } from "../config/defaults.js";
import { configExists, type ConfigLoadOptions, loadConfigWithMeta } from "../config/config.js";
import { getRepositoryRoot } from "../git/git.js";
import { getSessionRoot, inspectSessionRecoveryState } from "../session/sessionManager.js";

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

export async function runDoctor(cwd: string, configOptions?: ConfigLoadOptions): Promise<DoctorReport> {
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
      checks,
    };
  }

  let config: AgentBlackBoxConfig = DEFAULT_CONFIG;
  try {
    const configResult = await loadConfigWithMeta(repoRoot, configOptions);
    config = configResult.config;
    checks.push(await checkConfig(repoRoot, configResult));
  } catch (error) {
    checks.push(fail("Config", (error as Error).message));
  }

  checks.push(await checkWritable(repoRoot, "Repository write access"));
  checks.push(await checkSessionDirectory(repoRoot, config));
  checks.push(await checkSessionRecovery(repoRoot, config));

  return {
    ok: checks.every((check) => check.status !== "fail"),
    repoRoot,
    checks,
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

  if (major >= 22) {
    return pass("Node.js", `Detected ${version}.`);
  }

  return fail("Node.js", `Detected ${version}. Node.js 22 or newer is required.`);
}

async function checkConfig(
  repoRoot: string,
  configResult: Awaited<ReturnType<typeof loadConfigWithMeta>>
): Promise<DoctorCheck> {
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
  let existingPath = sessionRoot;

  while (true) {
    try {
      const details = await stat(existingPath);
      if (!details.isDirectory()) {
        return fail("Session directory", `Not a directory: ${existingPath}`);
      }
      const writable = await checkWritable(existingPath, "Session directory");
      if (writable.status === "fail" || existingPath === sessionRoot || existingPath === path.dirname(sessionRoot)) {
        return writable;
      }
      return warn("Session directory", `${sessionRoot} does not exist yet. It will be created by \`abb start\`.`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return fail("Session directory", `Cannot inspect ${existingPath}: ${(error as Error).message}`);
      }
      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) {
        return fail("Session directory", `No existing directory found for ${sessionRoot}.`);
      }
      existingPath = parentPath;
    }
  }
}

async function checkSessionRecovery(repoRoot: string, config: AgentBlackBoxConfig): Promise<DoctorCheck> {
  const state = await inspectSessionRecoveryState(repoRoot, config);
  if (state.status === "no-active-session" || state.status === "active") {
    return pass("Session state", state.message);
  }
  if (state.status === "recoverable" || state.status === "already-complete") {
    return warn("Session state", `${state.message} Run \`abb recover\` or \`abb doctor --repair\`.`);
  }
  return fail("Session state", `${state.message} Inspect the state files before taking manual action.`);
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
