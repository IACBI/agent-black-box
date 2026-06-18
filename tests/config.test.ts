import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultConfig, getConfigPath, loadConfig } from "../src/config/config.js";
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
      await import("node:fs/promises").then((fs) =>
        fs.writeFile(configPath, JSON.stringify({ maxFileSizeKb: 42, exclude: ["tmp"] }), "utf8")
      );

      await expect(loadConfig(dir)).resolves.toEqual({
        ...DEFAULT_CONFIG,
        exclude: ["tmp"],
        maxFileSizeKb: 42
      });
    } finally {
      await removeTempDir(dir);
    }
  });
});
