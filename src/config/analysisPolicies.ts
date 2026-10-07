import type {
  AgentBlackBoxConfig,
  ConfiguredAnalysisPolicies,
  ConfiguredAnalysisPolicy,
  RiskSeverity,
} from "../types.js";

const PROFILE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const RESERVED_PROFILES = new Set(["new-secrets", "complete-review"]);
const MAX_PROFILES = 32;
const MAX_CATEGORIES = 32;
const MAX_CATEGORY_LENGTH = 128;
const PROFILE_FIELDS = new Set(["failOnNewSecrets", "requireCompleteCoverage", "minSeverity", "categories"]);

export function normalizeAnalysisPolicies(
  value: unknown,
  errors: string[]
): Pick<AgentBlackBoxConfig, "analysisPolicies"> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    errors.push("analysisPolicies must be an object.");
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PROFILES) {
    errors.push(`analysisPolicies must contain at most ${MAX_PROFILES} profiles.`);
    return {};
  }

  const initialErrorCount = errors.length;
  const policies: ConfiguredAnalysisPolicies = {};
  for (const [name, definition] of entries) {
    if (!PROFILE_NAME.test(name)) {
      errors.push("analysisPolicies profile names must match ^[a-z][a-z0-9-]{0,63}$.");
      continue;
    }
    if (RESERVED_PROFILES.has(name)) {
      errors.push(`analysisPolicies cannot override built-in profile "${name}".`);
      continue;
    }
    if (!isRecord(definition)) {
      errors.push(`analysisPolicies.${name} must be an object.`);
      continue;
    }
    for (const field of Object.keys(definition)) {
      if (!PROFILE_FIELDS.has(field)) {
        errors.push(`Unknown analysisPolicies.${name} key "${field}".`);
      }
    }
    for (const field of ["failOnNewSecrets", "requireCompleteCoverage"] as const) {
      if (definition[field] !== undefined && typeof definition[field] !== "boolean") {
        errors.push(`analysisPolicies.${name}.${field} must be a boolean.`);
      }
    }
    const minSeverity = definition.minSeverity;
    if (minSeverity !== undefined && minSeverity !== "low" && minSeverity !== "medium" && minSeverity !== "high") {
      errors.push(`analysisPolicies.${name}.minSeverity must be low, medium, or high.`);
    }
    const categories = definition.categories;
    let normalizedCategories: string[] | undefined;
    if (categories !== undefined) {
      if (minSeverity === undefined) {
        errors.push(`analysisPolicies.${name}.categories requires minSeverity.`);
      }
      if (
        !Array.isArray(categories) ||
        categories.length === 0 ||
        categories.length > MAX_CATEGORIES ||
        !categories.every(
          (category) =>
            typeof category === "string" && category.trim().length > 0 && category.length <= MAX_CATEGORY_LENGTH
        )
      ) {
        errors.push(
          `analysisPolicies.${name}.categories must contain 1 to ${MAX_CATEGORIES} non-empty strings of at most ${MAX_CATEGORY_LENGTH} characters.`
        );
      } else {
        normalizedCategories = [...new Set(categories.map((category: string) => category.trim()))];
      }
    }
    const policy: ConfiguredAnalysisPolicy = {
      failOnNewSecrets: definition.failOnNewSecrets === undefined ? true : definition.failOnNewSecrets === true,
      requireCompleteCoverage: definition.requireCompleteCoverage === true,
      ...(minSeverity === undefined ? {} : { minSeverity: minSeverity as RiskSeverity }),
      ...(normalizedCategories === undefined ? {} : { categories: normalizedCategories }),
    };
    policies[name] = policy;
  }
  return errors.length === initialErrorCount ? { analysisPolicies: policies } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
