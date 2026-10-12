import type { SessionCatalogEntry } from "../session/sessionCatalog.js";
import { formatTerminalValue } from "../utils/terminal.js";

export function renderSessionCatalog(
  entries: SessionCatalogEntry[],
  latestCompleteId = entries.find((entry) => entry.state === "complete")?.id
): string {
  if (entries.length === 0) {
    return "No Agent Black Box sessions were found.\n";
  }

  const knownLatestId = getKnownLatestCompleteId(entries, latestCompleteId);
  const lines = ["Agent Black Box Sessions", ""];
  for (const entry of entries) {
    const latest = entry.id === knownLatestId ? ", latest" : "";
    const details =
      entry.state === "complete" && !entry.metadataUnavailable
        ? [
            `started ${entry.startedAt}`,
            `changes ${entry.sessionRelevantChangeCount ?? 0}`,
            `commands ${entry.commandCount ?? 0}`,
            `risk ${entry.riskScore ?? 0}/100 (${entry.maxRiskSeverity ?? "none"})`,
          ].join(" | ")
        : formatTerminalValue(
            entry.warning ??
              (entry.metadataUnavailable
                ? "Session metadata is unavailable."
                : `started ${entry.startedAt ?? "unknown"}`)
          );
    lines.push(`- ${formatTerminalValue(entry.id)} [${entry.state}${latest}] | ${details}`);
  }

  return `${lines.join("\n")}\n`;
}

export function toPublicSessionCatalog(
  entries: SessionCatalogEntry[],
  latestCompleteId = entries.find((entry) => entry.state === "complete")?.id
): Array<Omit<SessionCatalogEntry, "sessionDir"> & { latest: boolean }> {
  const knownLatestId = getKnownLatestCompleteId(entries, latestCompleteId);
  return entries.map(({ sessionDir: _sessionDir, ...entry }) => ({
    ...entry,
    latest: entry.id === knownLatestId,
  }));
}

function getKnownLatestCompleteId(
  entries: readonly SessionCatalogEntry[],
  latestCompleteId: string | undefined
): string | undefined {
  return entries.some((entry) => entry.state === "complete" && entry.metadataUnavailable)
    ? undefined
    : latestCompleteId;
}
