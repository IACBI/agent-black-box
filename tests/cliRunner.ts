import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { inject } from "vitest";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCliOptions {
  /** Extra environment variables, merged over `process.env`. Use `undefined` values to unset one. */
  env?: Record<string, string | undefined>;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Kill the child after this many milliseconds. The result then carries a non-zero `exitCode`. */
  timeoutMs?: number;
}

const WAIT_TIMEOUT_MS = 15_000;

/**
 * Absolute path of the compiled CLI (`cli.js`) built once per vitest run by `tests/globalSetup.ts`.
 * The e2e suite exercises the same JavaScript that ships in the package, not the tsx dev entry.
 */
function getCompiledCliPath(): string {
  const buildError = inject("abbE2eBuildError");
  if (buildError) {
    throw new Error(buildError);
  }
  const distDir = inject("abbE2eDistDir");
  if (!distDir) {
    throw new Error("The compiled CLI is unavailable: tests/globalSetup.ts must be registered in vitest.config.ts.");
  }
  return path.join(distDir, "cli.js");
}

function buildEnvironment(overrides: RunCliOptions["env"]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Runs the compiled CLI (`node <dist>/cli.js ...args`) in `cwd` and resolves once it exits.
 * Never rejects: a failing command resolves with its non-zero `exitCode`, so tests can assert on
 * `stderr`. A signal or timeout kill yields exit code 1. Git settings are isolated by `tests/setup.ts`.
 */
export function runCli(cwd: string, args: string[], options: RunCliOptions = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [getCompiledCliPath(), ...args],
      { cwd, env: buildEnvironment(options.env), timeout: options.timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
        });
      }
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/**
 * Starts the compiled CLI as a long-running child (for example `start`, the file watcher) with piped stdio.
 * Pair with {@link waitForOutput}, {@link waitForExit} and {@link stopChild}.
 */
export function spawnCli(
  cwd: string,
  args: string[],
  options: Pick<RunCliOptions, "env"> = {}
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [getCompiledCliPath(), ...args], {
    cwd,
    env: buildEnvironment(options.env),
    stdio: "pipe",
  });
}

/** Resolves when `child` has printed `expected` on stdout; rejects if it exits first or 15 seconds pass. */
export function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for output: ${expected}\n${output}`)),
      WAIT_TIMEOUT_MS
    );

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Process exited with ${code} while waiting for output: ${expected}\n${output}`));
    });
  });
}

/** Resolves when `child` has exited; rejects after 15 seconds. */
export function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for CLI process to exit.")), WAIT_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Best-effort cleanup for a spawned child. SIGTERM terminates the process abruptly on Windows (no signal
 * handlers run), so tests must stop sessions through `abb stop` and never rely on cleanup here.
 */
export function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }

  child.kill("SIGTERM");
  return waitForExit(child).catch(() => undefined);
}
