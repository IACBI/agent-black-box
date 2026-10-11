import { normalizeSecretRules } from "../config/secretRules.js";
import type { AgentBlackBoxConfig } from "../types.js";
import { pathMatchesPattern } from "../utils/paths.js";

/**
 * Custom patterns only ever see this many leading characters of a line. Combined with the pattern screening
 * in config validation, it bounds the work a repository-supplied expression can cause on minified files.
 */
export const MAX_CUSTOM_PATTERN_LINE_LENGTH = 4096;
const MAX_REDACTED_TEXT_LENGTH = 65_536;

export interface CompiledSecretRules {
  patterns: ReadonlyArray<{ name: string; test: RegExp; redact: RegExp }>;
  allowlist: ReadonlyArray<{ path?: string; contains?: string }>;
}

export const NO_SECRET_RULES: CompiledSecretRules = { patterns: [], allowlist: [] };

/**
 * Compiles the user-configured secret patterns and allowlist. Library callers may hand over an unvalidated
 * config object, so this validates with the same rules as config loading and throws on any problem.
 */
export function compileSecretRules(
  config: Pick<AgentBlackBoxConfig, "secretPatterns" | "secretAllowlist">
): CompiledSecretRules {
  if (config.secretPatterns === undefined && config.secretAllowlist === undefined) {
    return NO_SECRET_RULES;
  }

  const errors: string[] = [];
  const normalized = normalizeSecretRules(config.secretPatterns, config.secretAllowlist, errors);
  if (errors.length > 0) {
    throw new Error(`Invalid secret rules: ${errors.join(" ")}`);
  }

  return {
    patterns: (normalized.secretPatterns ?? []).map((entry) => {
      const flags = entry.ignoreCase ? "i" : "";
      return {
        name: entry.name,
        test: new RegExp(entry.pattern, flags),
        redact: new RegExp(entry.pattern, `${flags}g`),
      };
    }),
    allowlist: (normalized.secretAllowlist ?? []).map(({ path, contains }) => ({
      ...(path === undefined ? {} : { path }),
      ...(contains === undefined ? {} : { contains }),
    })),
  };
}

/** Names of the configured patterns that match the line. */
export function matchCustomSecretPatterns(rules: CompiledSecretRules, line: string): string[] {
  if (rules.patterns.length === 0) {
    return [];
  }
  const bounded = line.length > MAX_CUSTOM_PATTERN_LINE_LENGTH ? line.slice(0, MAX_CUSTOM_PATTERN_LINE_LENGTH) : line;
  return rules.patterns.filter((pattern) => pattern.test.test(bounded)).map((pattern) => pattern.name);
}

/** True when an allowlist entry covers this file and line. An entry with both fields needs both to match. */
export function isLineAllowlisted(rules: CompiledSecretRules, relativePath: string, line: string): boolean {
  return rules.allowlist.some(
    (entry) =>
      (entry.path === undefined || pathMatchesPattern(relativePath, entry.path)) &&
      (entry.contains === undefined || line.includes(entry.contains))
  );
}

/** Replaces every match of a configured pattern with `<redacted>`. */
export function redactCustomSecretPatterns(rules: CompiledSecretRules, text: string): string {
  if (rules.patterns.length === 0) {
    return text;
  }
  let result = text.length > MAX_REDACTED_TEXT_LENGTH ? text.slice(0, MAX_REDACTED_TEXT_LENGTH) : text;
  for (const pattern of rules.patterns) {
    // A lookahead-only pattern can match zero-width positions; those must not inject text.
    result = result.replace(pattern.redact, (match) => (match === "" ? match : "<redacted>"));
  }
  return result;
}
