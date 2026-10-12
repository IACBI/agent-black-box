import { describe, expect, it } from "vitest";
import { renderSessionCatalog, toPublicSessionCatalog } from "../src/reports/sessionCatalog.js";
import type { SessionCatalogEntry } from "../src/session/sessionCatalog.js";

function knownSession(id = "session-known"): SessionCatalogEntry {
  return {
    id,
    sessionDir: `private-sessions/${id}`,
    state: "complete",
    startedAt: "2026-01-05T00:00:00.000Z",
    sessionRelevantChangeCount: 3,
    commandCount: 2,
    riskScore: 25,
    maxRiskSeverity: "medium",
  };
}

describe("session catalog presentation", () => {
  it("preserves known counts, timestamps, states and the default latest marker", () => {
    const entries: SessionCatalogEntry[] = [
      { id: "session-active", sessionDir: "private-active", state: "incomplete", warning: "Recording incomplete." },
      knownSession(),
      { id: "session-broken", sessionDir: "private-broken", state: "corrupt", warning: "Invalid report." },
    ];

    expect(renderSessionCatalog(entries)).toBe(
      "Agent Black Box Sessions\n\n" +
        "- session-active [incomplete] | Recording incomplete.\n" +
        "- session-known [complete, latest] | started 2026-01-05T00:00:00.000Z | changes 3 | commands 2 | risk 25/100 (medium)\n" +
        "- session-broken [corrupt] | Invalid report.\n"
    );
    expect(toPublicSessionCatalog(entries)).toEqual([
      { id: "session-active", state: "incomplete", warning: "Recording incomplete.", latest: false },
      {
        id: "session-known",
        state: "complete",
        startedAt: "2026-01-05T00:00:00.000Z",
        sessionRelevantChangeCount: 3,
        commandCount: 2,
        riskScore: 25,
        maxRiskSeverity: "medium",
        latest: true,
      },
      { id: "session-broken", state: "corrupt", warning: "Invalid report.", latest: false },
    ]);
  });

  it.each([undefined, "session-known", "session-unknown"])(
    "shows a quota refusal without inventing metadata or a latest marker, including selector %s",
    (latestCompleteId) => {
      const warning = "Cannot read metadata\u001b[2J\nunder the working-data policy.\u202e";
      const entries: SessionCatalogEntry[] = [
        knownSession(),
        {
          id: "session-unknown",
          sessionDir: "private-unknown",
          state: "complete",
          metadataUnavailable: true,
          warning,
        },
      ];
      const text = renderSessionCatalog(entries, latestCompleteId);
      const publicEntries = toPublicSessionCatalog(entries, latestCompleteId);
      const unknown = publicEntries.find((entry) => entry.id === "session-unknown");

      expect(text).toContain(
        '- session-unknown [complete] | "Cannot read metadata\\u001b[2J\\nunder the working-data policy.\\u202e"\n'
      );
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\u202e");
      expect(text).not.toContain(", latest");
      expect(text).not.toContain("started undefined");
      expect(text).not.toContain("changes 0");
      expect(text).not.toContain("commands 0");
      expect(text).not.toContain("risk 0/100");
      expect(publicEntries.every((entry) => !entry.latest)).toBe(true);
      expect(unknown).toEqual({
        id: "session-unknown",
        state: "complete",
        metadataUnavailable: true,
        warning,
        latest: false,
      });
      expect(publicEntries.every((entry) => !("sessionDir" in entry))).toBe(true);
    }
  );

  it("does not let an incomplete session with unavailable metadata obscure the latest completed session", () => {
    const entries: SessionCatalogEntry[] = [
      {
        id: "session-active",
        sessionDir: "private-active",
        state: "incomplete",
        metadataUnavailable: true,
        warning: "Start metadata exceeds the working-data policy.",
      },
      knownSession(),
    ];

    expect(renderSessionCatalog(entries)).toContain("session-known [complete, latest]");
    expect(toPublicSessionCatalog(entries).map((entry) => entry.latest)).toEqual([false, true]);
  });

  it("retains an explicit known marker and the empty-catalog contract", () => {
    const entries = [knownSession(), knownSession("session-older")];

    expect(renderSessionCatalog(entries, "session-older")).toContain("session-older [complete, latest]");
    expect(toPublicSessionCatalog(entries, "session-older").map((entry) => entry.latest)).toEqual([false, true]);
    expect(renderSessionCatalog([])).toBe("No Agent Black Box sessions were found.\n");
    expect(toPublicSessionCatalog([])).toEqual([]);
  });

  it("still describes unavailable metadata when no detailed warning was retained", () => {
    const unknown: SessionCatalogEntry = {
      id: "session-unknown",
      sessionDir: "private-unknown",
      state: "complete",
      metadataUnavailable: true,
    };

    expect(renderSessionCatalog([unknown])).toBe(
      "Agent Black Box Sessions\n\n- session-unknown [complete] | Session metadata is unavailable.\n"
    );
  });
});
