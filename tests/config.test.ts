import { readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultConfig,
  getConfigPath,
  loadConfig,
  loadConfigWithMeta,
  migrateConfigFile,
} from "../src/config/config.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("config", () => {
  it("validates the default storage path even without a config file", async () => {
    const dir = await createTempDir();
    const outside = await createTempDir();
    try {
      await symlink(outside, path.join(dir, ".agent-black-box"), process.platform === "win32" ? "junction" : "dir");
      await expect(loadConfig(dir)).rejects.toThrow("must stay inside the repository");
    } finally {
      await removeTempDir(dir);
      await removeTempDir(outside);
    }
  });

  it("rejects storage at the repository root because state files would escape to its parent", async () => {
    const dir = await createTempDir();
    try {
      await writeFile(getConfigPath(dir), JSON.stringify({ ...DEFAULT_CONFIG, sessionDir: "." }));
      await expect(loadConfig(dir)).rejects.toThrow("must stay inside the repository");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("loads defaults when no config file exists", async () => {
    const dir = await createTempDir();
    try {
      await expect(loadConfig(dir)).resolves.toEqual(DEFAULT_CONFIG);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("creates the default config and refuses to overwrite it", async () => {
    const dir = await createTempDir();
    try {
      const configPath = await createDefaultConfig(dir);
      const raw = await readFile(configPath, "utf8");

      expect(configPath).toBe(getConfigPath(dir));
      expect(JSON.parse(raw)).toEqual(DEFAULT_CONFIG);
      await expect(createDefaultConfig(dir)).rejects.toThrow(".agentblackbox.json already exists");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("merges partial config with defaults", async () => {
    const dir = await createTempDir();
    try {
      await createDefaultConfig(dir);
      const configPath = path.join(dir, ".agentblackbox.json");
      await writeFile(configPath, JSON.stringify({ maxFileSizeKb: 42, exclude: ["tmp"] }), "utf8");

      await expect(loadConfig(dir)).resolves.toEqual({
        ...DEFAULT_CONFIG,
        exclude: ["tmp"],
        maxFileSizeKb: 42,
      });
    } finally {
      await removeTempDir(dir);
    }
  });

  it("accepts optional retention defaults and rejects unsafe policy values", async () => {
    const dir = await createTempDir();
    try {
      const configPath = getConfigPath(dir);
      await writeFile(configPath, JSON.stringify({ retention: { days: 30, keep: 2, archiveDir: "archive" } }));
      expect((await loadConfig(dir)).retention).toEqual({ days: 30, keep: 2, archiveDir: "archive" });

      await writeFile(configPath, JSON.stringify({ retention: { days: 0, keep: 2 } }));
      await expect(loadConfig(dir)).rejects.toThrow("retention.days must be an integer");
      await writeFile(configPath, JSON.stringify({ retention: { days: 30, unknown: true } }));
      await expect(loadConfig(dir)).rejects.toThrow('Unknown retention key "unknown"');
    } finally {
      await removeTempDir(dir);
    }
  });

  it("migrates legacy configs in memory and can rewrite them", async () => {
    const dir = await createTempDir();
    try {
      const configPath = path.join(dir, ".agentblackbox.json");
      await writeFile(configPath, JSON.stringify({ exclude: ["tmp", "tmp", ""], maxFileSizeKb: 12 }), "utf8");

      const loaded = await loadConfigWithMeta(dir);

      expect(loaded.migrated).toBe(true);
      expect(loaded.warnings.join("\n")).toContain("Legacy config");
      expect(loaded.config.configVersion).toBe(1);
      expect(loaded.config.exclude).toEqual(["tmp"]);

      await migrateConfigFile(dir);
      const migrated = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      expect(migrated.configVersion).toBe(1);
      expect(migrated.$schema).toBe(DEFAULT_CONFIG.$schema);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("rejects unsupported future config versions", async () => {
    const dir = await createTempDir();
    try {
      await writeFile(
        path.join(dir, ".agentblackbox.json"),
        JSON.stringify({ ...DEFAULT_CONFIG, configVersion: 99 }),
        "utf8"
      );

      await expect(loadConfig(dir)).rejects.toThrow("configVersion must be 1");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("rejects an external session directory unless the caller explicitly allows it", async () => {
    const dir = await createTempDir();
    const externalDir = await createTempDir();
    try {
      await writeFile(
        path.join(dir, ".agentblackbox.json"),
        JSON.stringify({ ...DEFAULT_CONFIG, sessionDir: externalDir }),
        "utf8"
      );

      const result = await loadConfigWithMeta(dir);

      expect(result.config.sessionDir).toBe(externalDir);
      expect(result.errors.join("\n")).toContain("must stay inside the repository");
      await expect(loadConfig(dir)).rejects.toThrow("must stay inside the repository");

      const allowed = await loadConfigWithMeta(dir, { allowExternalSessionDir: true });

      expect(allowed.errors).toEqual([]);
      expect(allowed.warnings.join("\n")).toContain("explicitly allowed");
      await expect(loadConfig(dir, { allowExternalSessionDir: true })).resolves.toMatchObject({
        sessionDir: externalDir,
      });
    } finally {
      await removeTempDir(dir);
      await removeTempDir(externalDir);
    }
  });

  it("rejects session directories that escape through relative traversal or UNC paths", async () => {
    const dir = await createTempDir();
    const externalDir = await createTempDir();
    try {
      await writeFile(
        path.join(dir, ".agentblackbox.json"),
        JSON.stringify({ ...DEFAULT_CONFIG, sessionDir: path.relative(dir, externalDir) }),
        "utf8"
      );
      await expect(loadConfig(dir)).rejects.toThrow("must stay inside the repository");

      await writeFile(
        path.join(dir, ".agentblackbox.json"),
        JSON.stringify({ ...DEFAULT_CONFIG, sessionDir: "\\\\server\\share\\sessions" }),
        "utf8"
      );
      await expect(loadConfig(dir, { allowExternalSessionDir: true })).rejects.toThrow("network or UNC path");
    } finally {
      await removeTempDir(dir);
      await removeTempDir(externalDir);
    }
  });

  it("rejects oversized config files before parsing them", async () => {
    const dir = await createTempDir();
    try {
      await writeFile(path.join(dir, ".agentblackbox.json"), " ".repeat(1024 * 1024 + 1), "utf8");

      await expect(loadConfig(dir)).rejects.toThrow("exceeds the 1 MiB size limit");
    } finally {
      await removeTempDir(dir);
    }
  });
});
