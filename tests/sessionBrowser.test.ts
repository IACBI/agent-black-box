import { describe, expect, it } from "vitest";
import { browseSessionCatalog, type SessionBrowserIO } from "../src/session/sessionBrowser.js";
import type { SessionCatalogEntry } from "../src/session/sessionCatalog.js";
import { MaterializationBudgetError } from "../src/session/reportStorage.js";

const entries: SessionCatalogEntry[] = [
  { id: "session-one", sessionDir: "one", state: "complete", startedAt: "2026-01-03T00:00:00Z", riskScore: 3 },
  { id: "session-two", sessionDir: "two", state: "incomplete", startedAt: "2026-01-02T00:00:00Z" },
  { id: "session-three", sessionDir: "three", state: "complete", startedAt: "2026-01-01T00:00:00Z" },
];

describe("session browser", () => {
  it("pages through matching sessions and opens only completed reports", async () => {
    const answers = ["n", "1", "p", "2", "q"];
    const output: string[] = [];
    const opened: string[] = [];
    const io: SessionBrowserIO = {
      ask: async () => answers.shift() ?? "q",
      write: (value) => output.push(value),
    };

    await browseSessionCatalog(entries, 2, io, async (entry) => {
      opened.push(entry.id);
      return `Summary for ${entry.id}`;
    });

    expect(opened).toEqual(["session-three"]);
    expect(output.join("")).toContain("page 2/2 (3 matches)");
    expect(output.join("")).toContain("Summary for session-three");
    expect(output.join("")).toContain("Session session-two is incomplete");
  });

  it("handles empty results and rejects oversized pages", async () => {
    const output: string[] = [];
    const io: SessionBrowserIO = { ask: async () => "q", write: (value) => output.push(value) };
    await browseSessionCatalog([], 10, io, async () => "unused");
    expect(output).toEqual(["No matching Agent Black Box sessions were found.\n"]);
    await expect(browseSessionCatalog(entries, 51, io, async () => "unused")).rejects.toThrow("between 1 and 50");
  });

  it("shows unavailable metadata and keeps browsing after a report quota refusal", async () => {
    const answers = ["1", "2", "q"];
    const output: string[] = [];
    const deferred: SessionCatalogEntry = {
      ...entries[0]!,
      metadataUnavailable: true,
      warning: "Catalog metadata unavailable under the working-data policy.",
    };
    await browseSessionCatalog(
      [deferred, entries[2]!],
      2,
      { ask: async () => answers.shift() ?? "q", write: (value) => output.push(value) },
      async (entry) => {
        if (entry.id === deferred.id) {
          throw new MaterializationBudgetError("session.json", 2048, 1024);
        }
        return `Summary for ${entry.id}`;
      }
    );
    expect(output.join("")).toContain("Catalog metadata unavailable");
    expect(output.join("")).toContain("session.json requires 2048");
    expect(output.join("")).toContain("Summary for session-three");
  });

  it("propagates report corruption instead of treating it as a quota refusal", async () => {
    const failure = new Error("session.json changed after finalization.");
    await expect(
      browseSessionCatalog([entries[0]!], 1, { ask: async () => "1", write: () => {} }, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });
});
