import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDockerIsolationSupport,
  buildIsolatedAuditRunArgs,
  parseIsolatedAuditOptions,
  resolveIsolatedAuditRepository,
  selectIsolatedAuditUser,
  runIsolatedAudit,
} from "../scripts/isolated-audit.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

describe("isolated analysis runner", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("forwards analyze arguments and accepts only an explicitly bounded memory allowance", () => {
    expect(parseIsolatedAuditOptions(["--", "--staged", "--format", "json"])).toEqual({
      memoryMb: 512,
      analyzeArgs: ["--staged", "--format", "json"],
    });
    expect(parseIsolatedAuditOptions(["--memory-mb", "64", "--initial"])).toEqual({
      memoryMb: 64,
      analyzeArgs: ["--initial"],
    });
    expect(parseIsolatedAuditOptions(["--staged", "--memory-mb=4096"])).toEqual({
      memoryMb: 4096,
      analyzeArgs: ["--staged"],
    });
    expect(() => parseIsolatedAuditOptions(["--memory-mb=128", "--memory-mb=256"])).toThrow("once");
  });

  it.each(["0", "63", "4097", "1.5", "-1", "NaN", "9007199254740992", "", undefined])(
    "rejects invalid memory value %s before Git or Docker can start",
    async (value) => {
      const args = value === undefined ? ["--memory-mb"] : ["--memory-mb", value];
      await expect(runIsolatedAudit(args, path.resolve("nonexistent-isolated-audit-target"))).rejects.toThrow(
        "--memory-mb must be an integer between 64 and 4096"
      );
    }
  );

  it("pins isolation options before the immutable image and always invokes analyze", () => {
    const repository = path.resolve("repository with spaces");
    const forwarded = ["--staged", "--format", "json", "--privileged", "--mount", "src=/"];
    const args = buildIsolatedAuditRunArgs(repository, IMAGE_ID, { memoryMb: 128, analyzeArgs: forwarded });
    expect(args).toEqual([
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
      "128m",
      "--memory-swap",
      "128m",
      "--tmpfs",
      "/tmp:size=16m,nosuid,nodev,noexec",
      "--user",
      selectIsolatedAuditUser(),
      "--env",
      "HTTP_PROXY=",
      "--env",
      "HTTPS_PROXY=",
      "--env",
      "ALL_PROXY=",
      "--env",
      "FTP_PROXY=",
      "--env",
      "NO_PROXY=",
      "--env",
      "http_proxy=",
      "--env",
      "https_proxy=",
      "--env",
      "all_proxy=",
      "--env",
      "ftp_proxy=",
      "--env",
      "no_proxy=",
      "--workdir",
      "/workspace",
      "--mount",
      `type=bind,src=${repository},dst=/workspace,readonly`,
      IMAGE_ID,
      "analyze",
      ...forwarded,
    ]);
    expect(args.slice(0, args.indexOf(IMAGE_ID))).not.toContain("--privileged");
    expect(args.slice(0, args.indexOf(IMAGE_ID)).filter((value) => value === "--env")).toHaveLength(10);
    expect(args.slice(args.indexOf(IMAGE_ID) + 1)).not.toContain("--env");
    expect(() => buildIsolatedAuditRunArgs(repository, "--privileged", { memoryMb: 128, analyzeArgs: [] })).toThrow(
      "image ID"
    );
    expect(() => buildIsolatedAuditRunArgs(repository, IMAGE_ID, { memoryMb: 0, analyzeArgs: [] })).toThrow(
      "--memory-mb"
    );
  });

  it("uses a non-root native Linux UID and GID so private repository modes remain readable", () => {
    expect(selectIsolatedAuditUser("linux", 1000, 1000)).toBe("1000:1000");
    expect(selectIsolatedAuditUser("linux", 1234, 5678)).toBe("1234:5678");
    expect(selectIsolatedAuditUser("linux", 1000, 0)).toBe("1000:0");
    expect(selectIsolatedAuditUser("linux", 0, 0)).toBe("10001:10001");
    expect(selectIsolatedAuditUser("linux", undefined, undefined)).toBe("10001:10001");
    expect(selectIsolatedAuditUser("linux", 1000, undefined)).toBe("10001:10001");
    expect(selectIsolatedAuditUser("win32", 1000, 1000)).toBe("10001:10001");
    for (const [uid, gid] of [
      [-1, 1000],
      [1.5, 1000],
      [0x1_0000_0000, 1000],
      [1000, -1],
      [1000, 1.5],
    ] as const) {
      expect(selectIsolatedAuditUser("linux", uid, gid)).toBe("10001:10001");
    }
  });

  it.skipIf(process.platform !== "linux")("does not change private source directory permissions", async () => {
    const repo = await createTempDir("abb-isolated-private-source-");
    try {
      await chmod(repo, 0o700);
      const modeBefore = (await stat(repo)).mode;
      buildIsolatedAuditRunArgs(repo, IMAGE_ID, { memoryMb: 512, analyzeArgs: [] });
      expect((await stat(repo)).mode).toBe(modeBefore);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("quotes a comma-bearing source as one CSV mount field", () => {
    const repository = path.resolve('repo,with"quotes');
    const args = buildIsolatedAuditRunArgs(repository, IMAGE_ID, { memoryMb: 512, analyzeArgs: [] });
    expect(args[args.indexOf("--mount") + 1]).toBe(
      `type=bind,"src=${repository.replace(/"/g, '""')}",dst=/workspace,readonly`
    );
  });

  it("requires actual Linux memory, swap, and PID support instead of an unbounded fallback", () => {
    const supported = { OSType: "linux", CgroupVersion: "2", MemoryLimit: true, SwapLimit: true, PidsLimit: true };
    expect(() => assertDockerIsolationSupport(supported)).not.toThrow();
    for (const field of ["MemoryLimit", "SwapLimit", "PidsLimit"]) {
      expect(() => assertDockerIsolationSupport({ ...supported, [field]: false })).toThrow("isolation was refused");
    }
    for (const unsupported of [
      null,
      {},
      { ...supported, OSType: "windows" },
      { ...supported, MemoryLimit: "true" },
      { ...supported, CgroupVersion: "1" },
      { ...supported, CgroupVersion: undefined },
    ]) {
      expect(() => assertDockerIsolationSupport(unsupported)).toThrow("isolation was refused");
    }
  });

  it("accepts a standalone root and refuses a subdirectory or inherited repository override", async () => {
    const repo = await createTempDir("abb-isolated-root-");
    try {
      initGitRepo(repo);
      expect(await resolveIsolatedAuditRepository(repo)).toBe(await realpath(repo));
      await mkdir(path.join(repo, "nested"));
      await expect(resolveIsolatedAuditRepository(path.join(repo, "nested"))).rejects.toThrow("working-tree root");
      vi.stubEnv("GIT_OBJECT_DIRECTORY", path.join(repo, "outside-objects"));
      await expect(resolveIsolatedAuditRepository(repo)).rejects.toThrow("overrides");
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each(["alternates", "http-alternates"])("refuses an object %s file without contacting Docker", async (name) => {
    const repo = await createTempDir("abb-isolated-alternates-");
    try {
      initGitRepo(repo);
      await writeFile(path.join(repo, ".git", "objects", "info", name), "/outside/object-directory\n");
      await expect(resolveIsolatedAuditRepository(repo)).rejects.toThrow("alternate Git object directories");
    } finally {
      await removeTempDir(repo);
    }
  });

  it.each(["common", "objects"])("refuses an external Git %s directory", async (placement) => {
    const repo = await createTempDir("abb-isolated-contained-");
    const outside = await createTempDir("abb-isolated-outside-");
    try {
      initGitRepo(repo);
      if (placement === "common") {
        initGitRepo(outside);
        await writeFile(path.join(repo, ".git", "commondir"), `${path.join(outside, ".git").replace(/\\/g, "/")}\n`);
      } else {
        const objects = path.join(repo, ".git", "objects");
        const externalObjects = path.join(outside, "objects");
        await rename(objects, externalObjects);
        await symlink(externalObjects, objects, process.platform === "win32" ? "junction" : "dir");
      }
      await expect(resolveIsolatedAuditRepository(repo)).rejects.toThrow("directories must stay inside");
    } finally {
      await removeTempDir(repo);
      await removeTempDir(outside);
    }
  });

  it("refuses a linked worktree instead of mounting its external common directory", async () => {
    const repo = await createTempDir("abb-isolated-worktree-");
    const parent = await createTempDir("abb-isolated-worktree-target-");
    try {
      initGitRepo(repo);
      await writeFile(path.join(repo, "source.txt"), "ordinary\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync(
        "git",
        ["-c", "user.name=Tests", "-c", "user.email=tests@example.invalid", "commit", "-qm", "baseline"],
        { cwd: repo }
      );
      const worktree = path.join(parent, "linked");
      execFileSync("git", ["worktree", "add", "--detach", worktree], { cwd: repo, stdio: "ignore" });
      await expect(resolveIsolatedAuditRepository(worktree)).rejects.toThrow("linked worktrees are unsupported");
    } finally {
      await removeTempDir(parent);
      await removeTempDir(repo);
    }
  });

  it("builds only trusted source into a production-only unprivileged runtime", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    const context = await readFile(".dockerignore", "utf8");
    expect(dockerfile).toContain("node:24-bookworm-slim@sha256:");
    expect(dockerfile).toContain("pnpm install --prod --frozen-lockfile --ignore-scripts");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/app/dist/cli.js"]');
    expect(dockerfile).not.toContain("COPY . ");
    expect(context.split(/\r?\n/)[0]).toBe("**");
    expect(context.split(/\r?\n/).filter((line) => line.startsWith("!"))).toEqual([
      "!Dockerfile",
      "!.dockerignore",
      "!package.json",
      "!pnpm-lock.yaml",
      "!tsconfig.json",
      "!tsconfig.build.json",
      "!src/*.ts",
      "!src/analyze/*.ts",
      "!src/commands/*.ts",
      "!src/config/*.ts",
      "!src/doctor/*.ts",
      "!src/export/*.ts",
      "!src/git/*.ts",
      "!src/hooks/*.ts",
      "!src/reports/*.ts",
      "!src/risks/*.ts",
      "!src/rollback/*.ts",
      "!src/session/*.ts",
      "!src/utils/*.ts",
      "!src/watcher/*.ts",
    ]);
  });
});
