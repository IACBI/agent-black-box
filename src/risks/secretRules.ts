import {
  evaluateSecretPatternLines,
  evaluateSecretPatterns,
  evaluateSecretPatternRedaction,
  type PatternRedactionResult,
  MAX_CUSTOM_PATTERN_BATCH_CHARACTERS,
  MAX_CUSTOM_PATTERN_BATCH_LINES,
  MAX_CUSTOM_PATTERN_LINE_LENGTH,
} from "./secretPatternEvaluator.js";
import { normalizeSecretRules } from "../config/secretRules.js";
import type { AgentBlackBoxConfig } from "../types.js";
import { pathMatchesPattern } from "../utils/paths.js";

/**
 * Custom patterns only ever see this many leading characters of a line. Combined with the pattern screening
 * in config validation, it bounds the work a repository-supplied expression can cause on minified files.
 */
export { MAX_CUSTOM_PATTERN_LINE_LENGTH } from "./secretPatternEvaluator.js";
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
  return evaluateSecretPatterns(rules, bounded, false);
}

/** Names matching each independent line, with bounded worker messages instead of one wait per line. */
export function matchCustomSecretPatternsInLines(rules: CompiledSecretRules, lines: readonly string[]): string[][] {
  if (rules.patterns.length === 0) return lines.map(() => []);
  const matches: string[][] = [];
  let batch: string[] = [];
  let characters = 0;
  const flush = (): void => {
    if (batch.length === 0) return;
    for (const names of evaluateSecretPatternLines(rules, batch)) matches.push(names);
    batch = [];
    characters = 0;
  };
  for (const line of lines) {
    const bounded = line.slice(0, MAX_CUSTOM_PATTERN_LINE_LENGTH);
    if (
      batch.length >= MAX_CUSTOM_PATTERN_BATCH_LINES ||
      characters + bounded.length > MAX_CUSTOM_PATTERN_BATCH_CHARACTERS
    ) {
      flush();
    }
    batch.push(bounded);
    characters += bounded.length;
  }
  flush();
  return matches;
}

export interface CustomSecretPatternLimit {
  truncatedLines: number;
  reason: string;
}

/** Describes incomplete custom scans without including any source content or credential material. */
export function describeCustomSecretPatternLimit(
  rules: CompiledSecretRules,
  lines: readonly string[]
): CustomSecretPatternLimit | undefined {
  if (rules.patterns.length === 0) return undefined;
  let truncatedLines = 0;
  for (const line of lines) {
    if (line.length > MAX_CUSTOM_PATTERN_LINE_LENGTH) truncatedLines += 1;
  }
  if (truncatedLines === 0) return undefined;
  return {
    truncatedLines,
    reason: `Custom secret patterns inspected only the first ${MAX_CUSTOM_PATTERN_LINE_LENGTH} characters of ${truncatedLines} line(s); content after that limit was not scanned by custom patterns.`,
  };
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
  if (text.length > MAX_REDACTED_TEXT_LENGTH) return "<redacted>";
  return evaluateSecretPatterns(rules, text, true);
}

/** @internal All masks refer to the original bounded text. */
export function redactCustomSecretPatternsWithMask(
  rules: CompiledSecretRules,
  text: string,
  matchEnds: Uint32Array
): PatternRedactionResult {
  return evaluateSecretPatternRedaction(rules, text, matchEnds);
}
