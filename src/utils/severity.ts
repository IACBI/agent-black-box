import type { RiskSeverity } from "../types.js";

export type SeverityLevel = RiskSeverity | "none";

const SEVERITY_RANKS: Record<SeverityLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };

/** Orders severities for threshold checks; "none" ranks below every real severity. */
export function severityRank(severity: SeverityLevel): number {
  return SEVERITY_RANKS[severity];
}

/** True when `actual` is at or above `threshold`. */
export function meetsSeverity(actual: SeverityLevel, threshold: SeverityLevel): boolean {
  return severityRank(actual) >= severityRank(threshold);
}
