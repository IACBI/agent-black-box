import type { RiskSeverity } from "../types.js";

export const SARIF_VERSION = "2.1.0";
export const SARIF_SCHEMA_URL = "https://json.schemastore.org/sarif-2.1.0.json";
export const TOOL_INFORMATION_URI = "https://github.com/IACBI/agent-black-box";

export type SarifLevel = "error" | "warning" | "note";

/** Maps an Agent Black Box severity to the SARIF result level. */
export function sarifLevel(severity: RiskSeverity): SarifLevel {
  if (severity === "high") {
    return "error";
  }

  return severity === "medium" ? "warning" : "note";
}

/** Encodes a repository-relative, slash-separated path as a SARIF artifact URI reference. */
export function sarifArtifactUri(repoRelativePath: string): string {
  return repoRelativePath.split("/").map(encodeURIComponent).join("/");
}
