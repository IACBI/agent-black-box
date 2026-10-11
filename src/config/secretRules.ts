import type { AgentBlackBoxConfig, ConfiguredSecretAllowlistEntry, ConfiguredSecretPattern } from "../types.js";
import { isRecord } from "../utils/records.js";

export const MAX_SECRET_PATTERNS = 32;
const MAX_SECRET_PATTERN_LENGTH = 256;
export const MAX_SECRET_ALLOWLIST_ENTRIES = 256;
const MIN_ALLOWLIST_CONTAINS_LENGTH = 8;
const MAX_NAME_LENGTH = 80;
const MAX_REASON_LENGTH = 200;
const MAX_ALLOWLIST_TEXT_LENGTH = 256;
const PATTERN_FIELDS = new Set(["name", "pattern", "ignoreCase"]);
const ALLOWLIST_FIELDS = new Set(["path", "contains", "reason"]);
// eslint-disable-next-line no-control-regex -- Names and reasons are rendered in reports and must not carry controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// A quantified group that itself contains a quantifier, such as (a+)+ or (\w+\s?)*, is the classic
// catastrophic-backtracking shape. This is a best-effort screen, not a proof of linear-time matching.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/;
const BACKREFERENCE = /\\[1-9]|\\k</;

/**
 * Validates `secretPatterns` and `secretAllowlist`. Both are optional and independent; an invalid entry
 * rejects the whole key so a typo can never silently weaken detection or widen an allowlist.
 */
export function normalizeSecretRules(
  patterns: unknown,
  allowlist: unknown,
  errors: string[]
): Pick<AgentBlackBoxConfig, "secretPatterns" | "secretAllowlist"> {
  return {
    ...normalizePatterns(patterns, errors),
    ...normalizeAllowlist(allowlist, errors),
  };
}

/** Returns why a pattern is refused, or undefined when it is acceptable. */
export function describeUnsafeSecretPattern(source: string, ignoreCase: boolean): string | undefined {
  if (source.length === 0 || source.length > MAX_SECRET_PATTERN_LENGTH) {
    return `must be 1 to ${MAX_SECRET_PATTERN_LENGTH} characters`;
  }
  let expression: RegExp;
  try {
    expression = new RegExp(source, ignoreCase ? "i" : "");
  } catch (error) {
    return `is not a valid regular expression (${error instanceof Error ? error.message : "unknown error"})`;
  }
  if (expression.test("")) {
    return "must not match an empty string";
  }
  if (BACKREFERENCE.test(source)) {
    return "must not use backreferences";
  }
  if (NESTED_QUANTIFIER.test(source)) {
    return "must not nest quantifiers inside a quantified group (risk of catastrophic backtracking)";
  }
  return undefined;
}

function normalizePatterns(value: unknown, errors: string[]): Pick<AgentBlackBoxConfig, "secretPatterns"> {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value) || value.length > MAX_SECRET_PATTERNS) {
    errors.push(`secretPatterns must be an array of at most ${MAX_SECRET_PATTERNS} objects.`);
    return {};
  }

  const initialErrorCount = errors.length;
  const normalized: ConfiguredSecretPattern[] = [];
  const names = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const label = `secretPatterns[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    for (const field of Object.keys(entry)) {
      if (!PATTERN_FIELDS.has(field)) {
        errors.push(`Unknown ${label} key "${field}".`);
      }
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH || CONTROL_CHARACTERS.test(name)) {
      errors.push(`${label}.name must be 1 to ${MAX_NAME_LENGTH} printable characters.`);
    } else if (names.has(name.toLowerCase())) {
      errors.push(`${label}.name "${name}" is duplicated.`);
    } else {
      names.add(name.toLowerCase());
    }
    if (entry.ignoreCase !== undefined && typeof entry.ignoreCase !== "boolean") {
      errors.push(`${label}.ignoreCase must be a boolean.`);
    }
    if (typeof entry.pattern !== "string") {
      errors.push(`${label}.pattern must be a string.`);
      continue;
    }
    const problem = describeUnsafeSecretPattern(entry.pattern, entry.ignoreCase === true);
    if (problem) {
      errors.push(`${label}.pattern ${problem}.`);
      continue;
    }
    normalized.push({
      name,
      pattern: entry.pattern,
      ...(entry.ignoreCase === true ? { ignoreCase: true } : {}),
    });
  }
  return errors.length === initialErrorCount ? { secretPatterns: normalized } : {};
}

function normalizeAllowlist(value: unknown, errors: string[]): Pick<AgentBlackBoxConfig, "secretAllowlist"> {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value) || value.length > MAX_SECRET_ALLOWLIST_ENTRIES) {
    errors.push(`secretAllowlist must be an array of at most ${MAX_SECRET_ALLOWLIST_ENTRIES} objects.`);
    return {};
  }

  const initialErrorCount = errors.length;
  const normalized: ConfiguredSecretAllowlistEntry[] = [];
  for (const [index, entry] of value.entries()) {
    const label = `secretAllowlist[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object.`);
      continue;
    }
    for (const field of Object.keys(entry)) {
      if (!ALLOWLIST_FIELDS.has(field)) {
        errors.push(`Unknown ${label} key "${field}".`);
      }
    }
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (!reason || reason.length > MAX_REASON_LENGTH || CONTROL_CHARACTERS.test(reason)) {
      errors.push(`${label}.reason is required and must be 1 to ${MAX_REASON_LENGTH} printable characters.`);
    }
    const pathText = optionalText(entry.path, `${label}.path`, 1, errors);
    const contains = optionalText(entry.contains, `${label}.contains`, MIN_ALLOWLIST_CONTAINS_LENGTH, errors);
    if (entry.path === undefined && entry.contains === undefined) {
      errors.push(`${label} needs a path, contains, or both.`);
    }
    normalized.push({
      ...(pathText === undefined ? {} : { path: pathText }),
      ...(contains === undefined ? {} : { contains }),
      reason,
    });
  }
  return errors.length === initialErrorCount ? { secretAllowlist: normalized } : {};
}

function optionalText(value: unknown, label: string, minimumLength: number, errors: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > MAX_ALLOWLIST_TEXT_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    errors.push(
      `${label} must be ${minimumLength} to ${MAX_ALLOWLIST_TEXT_LENGTH} printable characters${
        minimumLength > 1 ? " (a short value would allow far too much)" : ""
      }.`
    );
    return undefined;
  }
  return value;
}
