import { describe, expect, it } from "vitest";
import { browseSessionCatalog, type SessionBrowserIO } from "../src/session/sessionBrowser.js";
import type { SessionCatalogEntry } from "../src/session/sessionCatalog.js";

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
});
