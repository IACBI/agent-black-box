import type { SessionCatalogEntry } from "../session/sessionCatalog.js";

export function renderSessionCatalog(entries: SessionCatalogEntry[]): string {
  if (entries.length === 0) {
    return "No Agent Black Box sessions were found.\n";
  }

  const latestCompleteId = entries.find((entry) => entry.state === "complete")?.id;
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
        : (entry.warning ?? `started ${entry.startedAt ?? "unknown"}`);
    lines.push(`- ${entry.id} [${entry.state}${latest}] | ${details}`);
  }

  return `${lines.join("\n")}\n`;
}

export function toPublicSessionCatalog(
  entries: SessionCatalogEntry[]
): Array<Omit<SessionCatalogEntry, "sessionDir"> & { latest: boolean }> {
  const latestCompleteId = entries.find((entry) => entry.state === "complete")?.id;
  return entries.map(({ sessionDir: _sessionDir, ...entry }) => ({
    ...entry,
    latest: entry.id === latestCompleteId,
  }));
}
