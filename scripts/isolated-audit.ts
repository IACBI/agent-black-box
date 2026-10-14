import { execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gitExecutable } from "../src/git/executable.js";
import { resolveWindowsExecutable } from "../src/utils/executables.js";
import { isPathInside } from "../src/utils/paths.js";

const execFileAsync = promisify(execFile);
const IMAGE_TAG = "agent-black-box-isolated:local";
const REPOSITORY_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

interface IsolatedAuditOptions {
  memoryMb: number;
  analyzeArgs: string[];
}

export function parseIsolatedAuditOptions(args: readonly string[]): IsolatedAuditOptions {
  const input = args[0] === "--" ? args.slice(1) : args;
  const analyzeArgs: string[] = [];
  let memoryMb = 512;
  let memorySpecified = false;
  for (let index = 0; index < input.length; index += 1) {
    const argument = input[index]!;
    if (argument === "--memory-mb" || argument.startsWith("--memory-mb=")) {
      if (memorySpecified) throw new Error("--memory-mb may only be supplied once.");
      const value = argument === "--memory-mb" ? input[++index] : argument.slice("--memory-mb=".length);
      if (!value || !/^[1-9]\d*$/.test(value)) throw new Error("--memory-mb must be an integer between 64 and 4096.");
      memoryMb = Number(value);
      validateMemoryLimit(memoryMb);
      memorySpecified = true;
    } else {
      analyzeArgs.push(argument);
    }
  }
  return { memoryMb, analyzeArgs };
}

function validateMemoryLimit(memoryMb: number): void {
  if (!Number.isSafeInteger(memoryMb) || memoryMb < 64 || memoryMb > 4096) {
    throw new Error("--memory-mb must be an integer between 64 and 4096.");
  }
}

export async function resolveIsolatedAuditRepository(cwd: string): Promise<string> {
  if (REPOSITORY_OVERRIDES.some((name) => process.env[name])) {
    throw new Error(
      "Isolated analysis does not support inherited Git repository, index, or object-directory overrides."
    );
  }
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))
  );
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
  const git = async (argument: string): Promise<string> => {
    const result = await execFileAsync(gitExecutable(), ["rev-parse", argument], {
      cwd,
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    return result.stdout.replace(/\r?\n$/, "");
  };
  const root = await realpath(await git("--show-toplevel"));
  if ((await realpath(cwd)) !== root) {
    throw new Error("Run isolated analysis from the Git working-tree root.");
  }
  const gitDirectory = path.join(root, ".git");
  const info = await lstat(gitDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(
      "Isolated analysis requires a standalone repository with a regular .git directory; linked worktrees are unsupported."
    );
  }
  const commonDirectory = await realpath(path.resolve(root, await git("--git-common-dir")));
  const objectDirectory = await realpath(path.join(gitDirectory, "objects"));
  if (commonDirectory !== gitDirectory || !isPathInside(gitDirectory, objectDirectory)) {
    throw new Error("Git common and object directories must stay inside the mounted .git directory.");
  }
  for (const name of ["alternates", "http-alternates"]) {
    try {
      await lstat(path.join(objectDirectory, "info", name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Isolated analysis does not support alternate Git object directories.");
  }
  return root;
}

export function buildIsolatedAuditRunArgs(
  repository: string,
  imageId: string,
  options: IsolatedAuditOptions
): string[] {
  validateMemoryLimit(options.memoryMb);
  if (!path.isAbsolute(repository) || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error("Isolated analysis requires an absolute repository path and a built image ID.");
  }
  const source = `src=${repository}`;
  // --mount is CSV, even when arguments are passed directly without a shell.
  const sourceField = /[,"\r\n]/.test(source) ? `"${source.replace(/"/g, '""')}"` : source;
  const memory = `${options.memoryMb}m`;
  return [
    "run",
    "--rm",
    "--init",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    memory,
    "--memory-swap",
    memory,
    "--tmpfs",
    "/tmp:size=16m,nosuid,nodev,noexec",
    "--user",
    "10001:10001",
    "--workdir",
    "/workspace",
    "--mount",
    `type=bind,${sourceField},dst=/workspace,readonly`,
    imageId,
    "analyze",
    ...options.analyzeArgs,
  ];
}

export function assertDockerIsolationSupport(info: unknown): void {
  const capabilities = info as Record<string, unknown> | null;
  if (
    !capabilities ||
    capabilities.OSType !== "linux" ||
    capabilities.MemoryLimit !== true ||
    capabilities.SwapLimit !== true ||
    capabilities.PidsLimit !== true
  ) {
    throw new Error(
      "Docker must use Linux containers with memory, swap, and PID limit support; isolation was refused."
    );
  }
}

async function verifyDockerIsolationSupport(docker: string): Promise<void> {
  let output: string;
  try {
    output = (
      await execFileAsync(docker, ["info", "--format", "{{json .}}"], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    throw new Error(
      "Docker is unavailable. Start its Linux-container engine with memory, swap, and PID limit support.",
      { cause: error }
    );
  }
  let info: unknown;
  try {
    info = JSON.parse(output);
  } catch {
    throw new Error("Docker did not return valid isolation capability information; isolation was refused.");
  }
  assertDockerIsolationSupport(info);
}

export async function buildIsolatedAuditImage(docker: string): Promise<string> {
  const context = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  console.error("Building the trusted Agent Black Box analysis image...");
  let imageId: string;
  try {
    const result = await execFileAsync(
      docker,
      ["build", "--quiet", "--file", path.join(context, "Dockerfile"), "--tag", IMAGE_TAG, context],
      {
        cwd: context,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      }
    );
    imageId = result.stdout.trim();
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(
      `Docker image build failed. Ensure the Linux-container engine is running: ${(failure.stderr || failure.message).trim().slice(0, 2000)}`,
      { cause: error }
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Docker did not return an immutable built image ID.");
  return imageId;
}

export async function runIsolatedAudit(args: readonly string[], cwd = process.cwd()): Promise<number> {
  const options = parseIsolatedAuditOptions(args);
  const repository = await resolveIsolatedAuditRepository(cwd);
  const context = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const docker = process.platform === "win32" ? resolveWindowsExecutable("docker", context) : "docker";
  if (!docker) throw new Error("Docker was not found in PATH. Install Docker and start its Linux-container engine.");
  await verifyDockerIsolationSupport(docker);
  const imageId = await buildIsolatedAuditImage(docker);
  const runArgs = buildIsolatedAuditRunArgs(repository, imageId, options);
  return new Promise<number>((resolve, reject) => {
    const child = spawn(docker, runArgs, { cwd: context, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.once("error", (error) =>
      reject(new Error("Docker could not start isolated analysis; no unisolated fallback was run.", { cause: error }))
    );
    child.once("close", (code) => {
      if (code === 137)
        console.error(
          "Isolated analysis was terminated; its memory limit may have been reached. Review --memory-mb before retrying."
        );
      resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runIsolatedAudit(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}
