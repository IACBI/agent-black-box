import { describe, expect, it } from "vitest";
import { normalizeAnalysisPolicies } from "../src/config/analysisPolicies.js";

describe("configured analysis policies", () => {
  it("leaves absent policies optional and supplies secure defaults for named profiles", () => {
    const errors: string[] = [];
    expect(normalizeAnalysisPolicies(undefined, errors)).toEqual({});
    expect(normalizeAnalysisPolicies({ team: {} }, errors)).toEqual({
      analysisPolicies: { team: { failOnNewSecrets: true, requireCompleteCoverage: false } },
    });
    expect(errors).toEqual([]);
  });

  it("normalizes bounded categories without changing the supplied configuration", () => {
    const value = {
      team: {
        failOnNewSecrets: false,
        requireCompleteCoverage: true,
        minSeverity: "medium",
        categories: [" Config file ", "Config file", "Custom category"],
      },
    };
    const before = JSON.stringify(value);
    const errors: string[] = [];
    expect(normalizeAnalysisPolicies(value, errors)).toEqual({
      analysisPolicies: {
        team: {
          failOnNewSecrets: false,
          requireCompleteCoverage: true,
          minSeverity: "medium",
          categories: ["Config file", "Custom category"],
        },
      },
    });
    expect(errors).toEqual([]);
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([null, [], "team", 1])("rejects non-object policy maps %j", (value) => {
    const errors: string[] = [];
    expect(normalizeAnalysisPolicies(value, errors)).toEqual({});
    expect(errors).toEqual(["analysisPolicies must be an object."]);
  });

  it.each(["new-secrets", "complete-review", "Team", "has_underscore", "", "a".repeat(65)])(
    "rejects reserved or invalid profile name %s",
    (name) => {
      const errors: string[] = [];
      expect(normalizeAnalysisPolicies({ [name]: {} }, errors)).toEqual({});
      expect(errors.length).toBeGreaterThan(0);
    }
  );

  it.each([
    null,
    [],
    "profile",
    { unknown: true },
    { failOnNewSecrets: "false" },
    { requireCompleteCoverage: 1 },
    { minSeverity: "critical" },
    { categories: [] },
    { categories: ["Config file"] },
    { minSeverity: "low", categories: [""] },
    { minSeverity: "low", categories: [" "] },
    { minSeverity: "low", categories: [1] },
    { minSeverity: "low", categories: "Config file" },
    { minSeverity: "low", categories: ["a".repeat(129)] },
    { minSeverity: "low", categories: Array.from({ length: 33 }, () => "Config file") },
  ])("rejects invalid profile definitions %j without accepting a permissive fallback", (definition) => {
    const errors: string[] = [];
    expect(normalizeAnalysisPolicies({ team: definition }, errors)).toEqual({});
    expect(errors.length).toBeGreaterThan(0);
  });

  it("enforces profile bounds and accepts valid boundary lengths", () => {
    const profiles = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`team-${index}`, {}]));
    const errors: string[] = [];
    expect(Object.keys(normalizeAnalysisPolicies(profiles, errors).analysisPolicies ?? {})).toHaveLength(32);
    expect(normalizeAnalysisPolicies({ ...profiles, additional: {} }, errors)).toEqual({});
    expect(errors).toContain("analysisPolicies must contain at most 32 profiles.");
    const boundaryErrors: string[] = [];
    expect(
      normalizeAnalysisPolicies(
        {
          ["a".repeat(64)]: {
            minSeverity: "low",
            categories: Array.from({ length: 32 }, (_, index) => `${index}`.padEnd(128, "a")),
          },
        },
        boundaryErrors
      ).analysisPolicies
    ).toBeDefined();
    expect(boundaryErrors).toEqual([]);
  });

  it("supports own constructor profiles while rejecting prototype names and ignoring inherited profiles", () => {
    const errors: string[] = [];
    const policies = normalizeAnalysisPolicies({ constructor: {} }, errors).analysisPolicies!;
    expect(Object.hasOwn(policies, "constructor")).toBe(true);
    expect(policies.constructor).toEqual({ failOnNewSecrets: true, requireCompleteCoverage: false });
    expect(normalizeAnalysisPolicies(JSON.parse('{"__proto__":{}}'), errors)).toEqual({});
    expect(errors.length).toBeGreaterThan(0);
    const inheritedErrors: string[] = [];
    expect(normalizeAnalysisPolicies(Object.create({ inherited: {} }), inheritedErrors)).toEqual({
      analysisPolicies: {},
    });
  });
});
