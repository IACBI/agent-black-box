import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig, getConfigPath, loadConfig, loadConfigWithMeta, migrateConfigFile } from "../src/config/config.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

describe("config", () => {
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
        maxFileSizeKb: 42
      });
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
      await writeFile(path.join(dir, ".agentblackbox.json"), JSON.stringify({ ...DEFAULT_CONFIG, configVersion: 99 }), "utf8");

      await expect(loadConfig(dir)).rejects.toThrow("configVersion must be 1");
    } finally {
      await removeTempDir(dir);
    }
  });
});
