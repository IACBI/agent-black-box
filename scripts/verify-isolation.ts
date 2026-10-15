import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gitExecutable } from "../src/git/executable.js";
import { resolveWindowsExecutable } from "../src/utils/executables.js";
import { assertDockerIsolationSupport, buildIsolatedAuditImage, buildIsolatedAuditRunArgs } from "./isolated-audit.js";

const execFileAsync = promisify(execFile);
const docker = process.platform === "win32" ? resolveWindowsExecutable("docker", process.cwd()) : "docker";
if (!docker) throw new Error("Docker is required to verify OS isolation.");
const directory = await mkdtemp(path.join(os.tmpdir(), "abb-isolation,-"));
const container = `abb-isolation-${randomUUID()}`;
const failures: unknown[] = [];
let clientConfiguration: string | undefined;
let dockerPrefix: string[] = [];
let dockerEnvironment: NodeJS.ProcessEnv | undefined;
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))
);
Object.assign(environment, {
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});
const runDocker = (args: string[], timeout = 30_000) =>
  execFileAsync(docker, [...dockerPrefix, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout,
    maxBuffer: 1024 * 1024,
    env: dockerEnvironment,
  });
try {
  assertDockerIsolationSupport(JSON.parse((await runDocker(["info", "--format", "{{json .}}"])).stdout));
  const endpoint =
    process.env.DOCKER_HOST ||
    (await runDocker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])).stdout.trim();
  clientConfiguration = await mkdtemp(path.join(os.tmpdir(), "abb-proxy-fixture-"));
  await writeFile(
    path.join(clientConfiguration, "config.json"),
    JSON.stringify({
      proxies: {
        default: {
          httpProxy: "http://synthetic-user:synthetic-pass@proxy.invalid:8080",
          httpsProxy: "http://synthetic-user:synthetic-pass@proxy.invalid:8080",
          ftpProxy: "http://synthetic-user:synthetic-pass@proxy.invalid:8080",
          allProxy: "http://synthetic-user:synthetic-pass@proxy.invalid:8080",
          noProxy: "synthetic-internal.invalid",
        },
      },
    })
  );
  dockerPrefix = ["--config", clientConfiguration];
  dockerEnvironment = { ...process.env, DOCKER_HOST: endpoint };
  delete dockerEnvironment.DOCKER_CONTEXT;
  const privateCheckout = process.platform === "linux" && process.getuid?.() !== 0;
  await chmod(directory, privateCheckout ? 0o700 : 0o755);
  const git = (args: string[]) =>
    execFileAsync(gitExecutable(), args, { cwd: directory, env: environment, windowsHide: true });
  await git(["init", "--template="]);
  await writeFile(path.join(directory, "source.ts"), "export const value = 1;\n", { mode: 0o600 });
  await git(["add", "source.ts"]);
  await git([
    "-c",
    "user.name=Isolation Test",
    "-c",
    "user.email=isolation@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  ]);
  await writeFile(path.join(directory, "source.ts"), "export const value = 2;\n");
  const image = await buildIsolatedAuditImage(docker);
  const args = buildIsolatedAuditRunArgs(directory, image, { memoryMb: 128, analyzeArgs: ["--format", "json"] });
  const analysis = JSON.parse((await runDocker(args)).stdout) as { coverage?: { scannedTextFiles: number } };
  assert.equal(analysis.coverage?.scannedTextFiles, 1, "The isolated CLI must inspect the mounted repository.");
  const beforeImage = args.slice(0, args.indexOf(image));
  const identity = args[args.indexOf("--user") + 1]!.split(":").map(Number);
  assert.ok(identity[0]! > 0, "The audit must never run as root.");
  const probe = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    for (const source of ['/app/src', '/app/.git', '/app/.cache', '/app/.env']) assert.equal(fs.existsSync(source), false);
    assert.equal(process.getuid(), ${identity[0]});
    assert.equal(process.getgid(), ${identity[1]});
    for (const name of ['HTTP_PROXY','HTTPS_PROXY','FTP_PROXY','ALL_PROXY','NO_PROXY']) {
      assert.equal(process.env[name], '');
      assert.equal(process.env[name.toLowerCase()], '');
    }
    assert.equal(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), '134217728');
    assert.equal(fs.readFileSync('/sys/fs/cgroup/memory.swap.max', 'utf8').trim(), '0');
    assert.equal(fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(), '128');
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    assert.match(status, /^CapEff:\\s+0+$/m);
    assert.match(status, /^NoNewPrivs:\\s+1$/m);
    assert.deepEqual(Object.keys(require('node:os').networkInterfaces()), ['lo']);
    const mount = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').find(line => line.split(' ')[4] === '/workspace');
    assert.ok(mount && mount.split(' ')[5].split(',').includes('ro'));
    assert.throws(() => fs.writeFileSync('/workspace/unexpected-write', 'refused'), e => ['EROFS', 'EACCES'].includes(e.code));
    fs.writeFileSync('/tmp/allowed', 'bounded temporary scratch');
    console.log('Kernel limits, proxy exclusion, user, privileges, network and read-only source verified.');
  `;
  console.log((await runDocker([...beforeImage, "--entrypoint", "node", image, "-e", probe])).stdout.trim());
  const oomArgs = [
    ...beforeImage.filter((value) => value !== "--rm"),
    "--name",
    container,
    "--entrypoint",
    "node",
    image,
    "-e",
    "const retained=[]; setInterval(() => retained.push(Buffer.alloc(8*1024*1024, 0x5a)), 5);",
  ];
  await assert.rejects(runDocker(oomArgs), (error: unknown) => (error as { code?: number }).code === 137);
  const state = JSON.parse((await runDocker(["inspect", "--format", "{{json .State}}", container])).stdout) as {
    OOMKilled: boolean;
  };
  assert.equal(state.OOMKilled, true, "The kernel, not a heuristic RSS checkpoint, must enforce the budget.");
  console.log("Actual kernel OOM termination verified; source repository remained read-only.");
} catch (error) {
  failures.push(error);
} finally {
  // This random name and directory were created exclusively for this disposable verification fixture.
  try {
    await runDocker(["rm", "--force", container]);
  } catch (error) {
    if (!/No such container/i.test((error as { stderr?: string }).stderr ?? "")) failures.push(error);
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (clientConfiguration) {
    try {
      await rm(clientConfiguration, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length > 1) throw new AggregateError(failures, "Isolation verification and fixture cleanup failed.");
