import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getConfigPath, loadConfig, loadConfigWithMeta, migrateConfigFile } from "../src/config/config.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

const validRules = {
  secretPatterns: [{ name: "Internal service token", pattern: "corp_[a-z0-9]{16}", ignoreCase: true }],
  secretAllowlist: [
    { path: "tests/fixtures", reason: "synthetic credentials" },
    { contains: "AKIAIOSFODNN7EXAMPLE", reason: "documented AWS example key" },
  ],
};

describe("secret rules in .agentblackbox.json", () => {
  it("loads valid rules without an unknown-key warning and keeps them through a migration", async () => {
    const dir = await createTempDir();
    try {
      await writeFile(getConfigPath(dir), JSON.stringify(validRules));
      const loaded = await loadConfigWithMeta(dir);

      expect(loaded.errors).toEqual([]);
      expect(loaded.warnings.join("\n")).not.toContain("secretPatterns");
      expect(loaded.warnings.join("\n")).not.toContain("secretAllowlist");
      expect(loaded.config.secretPatterns).toEqual(validRules.secretPatterns);
      expect(loaded.config.secretAllowlist).toEqual(validRules.secretAllowlist);

      await migrateConfigFile(dir);
      const rewritten = JSON.parse(await readFile(getConfigPath(dir), "utf8")) as Record<string, unknown>;
      expect(rewritten.secretPatterns).toEqual(validRules.secretPatterns);
      expect(rewritten.secretAllowlist).toEqual(validRules.secretAllowlist);
      expect((await loadConfig(dir)).secretAllowlist).toEqual(validRules.secretAllowlist);
    } finally {
      await removeTempDir(dir);
    }
  });

  it("omits both keys when they are not configured", async () => {
    const dir = await createTempDir();
    try {
      await writeFile(getConfigPath(dir), JSON.stringify({ maxFileSizeKb: 10 }));
      const config = await loadConfig(dir);

      expect(config).not.toHaveProperty("secretPatterns");
      expect(config).not.toHaveProperty("secretAllowlist");
    } finally {
      await removeTempDir(dir);
    }
  });

  it.each([
    ["a catastrophic pattern", { secretPatterns: [{ name: "x", pattern: "(a+)+b" }] }, "nest quantifiers"],
    ["an allowlist entry without a reason", { secretAllowlist: [{ path: "tests" }] }, "reason is required"],
    [
      "an allowlist entry that is too broad",
      { secretAllowlist: [{ contains: "a", reason: "r" }] },
      "contains must be 8",
    ],
    [
      "a misspelled field",
      { secretPatterns: [{ name: "x", pattrn: "abc" }] },
      'Unknown secretPatterns[0] key "pattrn"',
    ],
  ])("fails loading for %s instead of ignoring it", async (_label, rules, expected) => {
    const dir = await createTempDir();
    try {
      await writeFile(getConfigPath(dir), JSON.stringify(rules));

      await expect(loadConfig(dir)).rejects.toThrow(expected);
      await expect(migrateConfigFile(dir)).rejects.toThrow("Cannot migrate invalid");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("keeps the JSON schema in step with the keys the loader understands", async () => {
    const schema = JSON.parse(await readFile(path.resolve("schema", "agentblackbox.schema.json"), "utf8")) as {
      properties: Record<string, unknown>;
    };
    const dir = await createTempDir();
    try {
      const everyKey = {
        configVersion: 1,
        sessionDir: ".agent-black-box/sessions",
        exclude: ["dist"],
        riskPatterns: ["auth"],
        maxFileSizeKb: 10,
        analysisPolicies: { team: {} },
        retention: { days: 5 },
        ...validRules,
      };
      await writeFile(getConfigPath(dir), JSON.stringify({ $schema: "x", ...everyKey }));
      const loaded = await loadConfigWithMeta(dir);

      expect(loaded.warnings.filter((warning) => warning.startsWith("Unknown config key"))).toEqual([]);
      for (const key of ["$schema", ...Object.keys(everyKey)]) {
        expect(Object.keys(schema.properties), `schema property ${key}`).toContain(key);
      }
    } finally {
      await removeTempDir(dir);
    }
  });
});
