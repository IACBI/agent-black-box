import type { SessionCatalogEntry } from "../session/sessionCatalog.js";
import { formatTerminalValue } from "../utils/terminal.js";

export function renderSessionCatalog(
  entries: SessionCatalogEntry[],
  latestCompleteId = entries.find((entry) => entry.state === "complete")?.id
): string {
  if (entries.length === 0) {
    return "No Agent Black Box sessions were found.\n";
  }

  const lines = ["Agent Black Box Sessions", ""];
  for (const entry of entries) {
    const latest = entry.id === latestCompleteId ? ", latest" : "";
    const details =
      entry.state === "complete"
        ? [
            `started ${entry.startedAt}`,
            `changes ${entry.sessionRelevantChangeCount ?? 0}`,
            `commands ${entry.commandCount ?? 0}`,
            `risk ${entry.riskScore ?? 0}/100 (${entry.maxRiskSeverity ?? "none"})`,
          ].join(" | ")
        : formatTerminalValue(entry.warning ?? `started ${entry.startedAt ?? "unknown"}`);
    lines.push(`- ${formatTerminalValue(entry.id)} [${entry.state}${latest}] | ${details}`);
  }

  return `${lines.join("\n")}\n`;
}

export function toPublicSessionCatalog(
  entries: SessionCatalogEntry[],
  latestCompleteId = entries.find((entry) => entry.state === "complete")?.id
): Array<Omit<SessionCatalogEntry, "sessionDir"> & { latest: boolean }> {
  return entries.map(({ sessionDir: _sessionDir, ...entry }) => ({
    ...entry,
    latest: entry.id === latestCompleteId,
  }));
}
