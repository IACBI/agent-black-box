import { describe, expect, it } from "vitest";
import {
  describeUnsafeSecretPattern,
  MAX_SECRET_ALLOWLIST_ENTRIES,
  MAX_SECRET_PATTERNS,
  normalizeSecretRules,
} from "../src/config/secretRules.js";
import {
  compileSecretRules,
  isLineAllowlisted,
  matchCustomSecretPatterns,
  MAX_CUSTOM_PATTERN_LINE_LENGTH,
  NO_SECRET_RULES,
  redactCustomSecretPatterns,
} from "../src/risks/secretRules.js";

describe("secret rule configuration", () => {
  it("leaves both keys absent when nothing is configured", () => {
    const errors: string[] = [];
    expect(normalizeSecretRules(undefined, undefined, errors)).toEqual({});
    expect(errors).toEqual([]);
  });

  it("normalizes valid patterns and allowlist entries without touching the input", () => {
    const patterns = [{ name: "  Internal token ", pattern: "corp_[A-Za-z0-9]{24}", ignoreCase: true }];
    const allowlist = [{ path: "tests/fixtures", reason: " synthetic credentials used by the tests " }];
    const before = JSON.stringify({ patterns, allowlist });
    const errors: string[] = [];

    expect(normalizeSecretRules(patterns, allowlist, errors)).toEqual({
      secretPatterns: [{ name: "Internal token", pattern: "corp_[A-Za-z0-9]{24}", ignoreCase: true }],
      secretAllowlist: [{ path: "tests/fixtures", reason: "synthetic credentials used by the tests" }],
    });
    expect(errors).toEqual([]);
    expect(JSON.stringify({ patterns, allowlist })).toBe(before);
  });

  it.each([
    ["not an array", { name: "x", pattern: "abc" }, "secretPatterns must be an array"],
    ["an array entry that is not an object", ["abc"], "secretPatterns[0] must be an object."],
    ["an unknown key", [{ name: "x", pattern: "abc", flags: "g" }], 'Unknown secretPatterns[0] key "flags".'],
    ["a missing name", [{ pattern: "abc" }], "secretPatterns[0].name must be 1 to 80 printable characters."],
    [
      "a name containing a control character",
      [{ name: "bad\nname", pattern: "abc" }],
      "secretPatterns[0].name must be 1 to 80 printable characters.",
    ],
    ["a missing pattern", [{ name: "x" }], "secretPatterns[0].pattern must be a string."],
    ["a non-boolean ignoreCase", [{ name: "x", pattern: "abc", ignoreCase: "yes" }], "ignoreCase must be a boolean."],
    ["an invalid expression", [{ name: "x", pattern: "(unclosed" }], "is not a valid regular expression"],
    ["an expression matching the empty string", [{ name: "x", pattern: "a*" }], "must not match an empty string"],
    ["a backreference", [{ name: "x", pattern: "(a)\\1" }], "must not use backreferences"],
    ["a nested quantifier", [{ name: "x", pattern: "(a+)+b" }], "must not nest quantifiers"],
    ["an over-long pattern", [{ name: "x", pattern: "a".repeat(257) }], "must be 1 to 256 characters"],
    [
      "duplicate names ignoring case",
      [
        { name: "Token", pattern: "abc" },
        { name: "token", pattern: "def" },
      ],
      'secretPatterns[1].name "token" is duplicated.',
    ],
  ])("rejects %s", (_label, patterns, expected) => {
    const errors: string[] = [];
    expect(normalizeSecretRules(patterns, undefined, errors)).toEqual({});
    expect(errors.join("\n")).toContain(expected);
  });

  it("rejects the whole key when any entry is invalid, so a typo cannot silently drop a pattern", () => {
    const errors: string[] = [];
    const result = normalizeSecretRules(
      [
        { name: "good", pattern: "abc" },
        { name: "bad", pattern: "(a+)+" },
      ],
      undefined,
      errors
    );
    expect(result).toEqual({});
    expect(errors).toHaveLength(1);
  });

  it(`enforces the limit of ${MAX_SECRET_PATTERNS} patterns and ${MAX_SECRET_ALLOWLIST_ENTRIES} allowlist entries`, () => {
    const manyPatterns = Array.from({ length: MAX_SECRET_PATTERNS + 1 }, (_, index) => ({
      name: `p${index}`,
      pattern: `x${index}y`,
    }));
    const manyEntries = Array.from({ length: MAX_SECRET_ALLOWLIST_ENTRIES + 1 }, (_, index) => ({
      path: `dir${index}`,
      reason: "r",
    }));
    const errors: string[] = [];
    expect(normalizeSecretRules(manyPatterns, manyEntries, errors)).toEqual({});
    expect(errors).toEqual([
      `secretPatterns must be an array of at most ${MAX_SECRET_PATTERNS} objects.`,
      `secretAllowlist must be an array of at most ${MAX_SECRET_ALLOWLIST_ENTRIES} objects.`,
    ]);
  });

  it.each([
    ["no reason", [{ path: "tests" }], "secretAllowlist[0].reason is required"],
    ["a blank reason", [{ path: "tests", reason: "   " }], "secretAllowlist[0].reason is required"],
    ["neither path nor contains", [{ reason: "because" }], "secretAllowlist[0] needs a path, contains, or both."],
    [
      "a contains value too short to be specific",
      [{ contains: "short", reason: "because" }],
      "secretAllowlist[0].contains must be 8 to 256 printable characters (a short value would allow far too much).",
    ],
    ["an unknown key", [{ path: "tests", reason: "because", glob: "**" }], 'Unknown secretAllowlist[0] key "glob".'],
    ["a non-string path", [{ path: 5, reason: "because" }], "secretAllowlist[0].path must be 1 to 256"],
    ["a non-array value", { path: "tests", reason: "because" }, "secretAllowlist must be an array"],
  ])("rejects an allowlist with %s", (_label, allowlist, expected) => {
    const errors: string[] = [];
    expect(normalizeSecretRules(undefined, allowlist, errors)).toEqual({});
    expect(errors.join("\n")).toContain(expected);
  });

  it("describes why a pattern is refused and accepts ordinary ones", () => {
    expect(describeUnsafeSecretPattern("corp_[a-z0-9]{24}", false)).toBeUndefined();
    expect(describeUnsafeSecretPattern("AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}", false)).toBeUndefined();
    expect(describeUnsafeSecretPattern("^x(\\w+\\s?)*$", false)).toContain("nest quantifiers");
    expect(describeUnsafeSecretPattern("b(a*)*c", false)).toContain("nest quantifiers");
    expect(describeUnsafeSecretPattern("(?:ab){2,}c", false)).toBeUndefined();
    expect(describeUnsafeSecretPattern("", false)).toContain("1 to 256");
  });
});

describe("compiled secret rules", () => {
  it("returns the shared empty rules when nothing is configured", () => {
    expect(compileSecretRules({})).toBe(NO_SECRET_RULES);
    expect(matchCustomSecretPatterns(NO_SECRET_RULES, "anything corp_abcdefghijklmnopqrstuvwx")).toEqual([]);
    expect(isLineAllowlisted(NO_SECRET_RULES, "a.ts", "line")).toBe(false);
    expect(redactCustomSecretPatterns(NO_SECRET_RULES, "text")).toBe("text");
  });

  it("throws on an unvalidated config so library callers cannot bypass validation", () => {
    expect(() => compileSecretRules({ secretPatterns: [{ name: "x", pattern: "(a+)+" }] })).toThrow(
      "Invalid secret rules"
    );
    expect(() => compileSecretRules({ secretAllowlist: [{ reason: "no scope" }] })).toThrow("Invalid secret rules");
  });

  it("matches configured patterns, honouring ignoreCase, and reports the pattern names", () => {
    const rules = compileSecretRules({
      secretPatterns: [
        { name: "Internal token", pattern: "corp_[a-z0-9]{12}" },
        { name: "Legacy token", pattern: "legacy-[a-z]{6}", ignoreCase: true },
      ],
    });
    expect(matchCustomSecretPatterns(rules, "x = corp_abcdef012345")).toEqual(["Internal token"]);
    expect(matchCustomSecretPatterns(rules, "x = CORP_ABCDEF012345")).toEqual([]);
    expect(matchCustomSecretPatterns(rules, "LEGACY-ABCDEF and corp_abcdef012345")).toEqual([
      "Internal token",
      "Legacy token",
    ]);
  });

  it("only inspects the leading characters of an enormous line", () => {
    const rules = compileSecretRules({ secretPatterns: [{ name: "Internal token", pattern: "corp_[a-z0-9]{12}" }] });
    const padding = "x ".repeat(MAX_CUSTOM_PATTERN_LINE_LENGTH);
    expect(matchCustomSecretPatterns(rules, `${padding}corp_abcdef012345`)).toEqual([]);
    expect(matchCustomSecretPatterns(rules, `corp_abcdef012345${padding}`)).toEqual(["Internal token"]);
  });

  it("allowlists by path, by text, or by both together", () => {
    const rules = compileSecretRules({
      secretAllowlist: [
        { path: "tests/fixtures", reason: "fixtures" },
        { contains: "AKIAIOSFODNN7EXAMPLE", reason: "documented AWS example key" },
        { path: "docs", contains: "sk-example-only", reason: "documentation placeholder" },
      ],
    });
    expect(isLineAllowlisted(rules, "tests/fixtures/a.env", "TOKEN=real-looking")).toBe(true);
    expect(isLineAllowlisted(rules, "TESTS/Fixtures/deep/a.env", "anything")).toBe(true);
    expect(isLineAllowlisted(rules, "src/a.ts", "key = AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(isLineAllowlisted(rules, "src/a.ts", "key = AKIAOTHERKEY0000000")).toBe(false);
    expect(isLineAllowlisted(rules, "docs/guide.md", "use sk-example-only here")).toBe(true);
    expect(isLineAllowlisted(rules, "src/guide.ts", "use sk-example-only here")).toBe(false);
    expect(isLineAllowlisted(rules, "docs/guide.md", "something else")).toBe(false);
    expect(isLineAllowlisted(rules, "src/fixtures/a.env", "x")).toBe(false);
  });

  it("redacts every match of every configured pattern and never injects text for zero-width matches", () => {
    const rules = compileSecretRules({
      secretPatterns: [
        { name: "Internal token", pattern: "corp_[a-z0-9]{12}" },
        { name: "Lookahead only", pattern: "(?=zzz)" },
      ],
    });
    expect(redactCustomSecretPatterns(rules, "a corp_abcdef012345 b corp_000000000000 zzz")).toBe(
      "a <redacted> b <redacted> zzz"
    );
  });
});
