import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildSessionReport } from "../src/reports/markdown.js";
import type { SessionCatalogEntry } from "../src/session/sessionCatalog.js";

const probe = vi.hoisted(() => ({ active: 0, peak: 0, calls: 0 }));

vi.mock("../src/session/sessionCatalog.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/session/sessionCatalog.js")>();
  return {
    ...original,
    readCatalogSessionReport: async (entry: SessionCatalogEntry) => {
      probe.calls += 1;
      probe.active += 1;
      probe.peak = Math.max(probe.peak, probe.active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      probe.active -= 1;
      return buildSessionReport(
        { id: entry.id, repoRoot: "/repo", sessionDir: entry.sessionDir, startedAt: "2026-01-01T00:00:00.000Z" },
        "2026-01-01T00:01:00.000Z",
        "test",
        [],
        [],
        {
          repoRoot: "/repo",
          statusText: "",
          diffSummaryText: "",
          changedFiles: [{ path: "src/a.ts", status: "modified" }],
        },
        [],
        []
      );
    },
  };
});

const { filterSessionCatalog } = await import("../src/session/sessionSearch.js");

describe("history search report fallback", () => {
  it("materializes at most one fallback report at a time while still matching every session", async () => {
    const entries: SessionCatalogEntry[] = Array.from({ length: 6 }, (_, index) => ({
      id: `session-${index}`,
      sessionDir: path.join(path.sep, "missing", `session-${index}`),
      state: "complete",
      startedAt: "2026-01-01T00:00:00.000Z",
    }));

    const matches = await filterSessionCatalog(entries, { file: "src/a.ts" });

    expect(matches.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    expect(probe.calls).toBe(entries.length);
    expect(probe.peak).toBe(1);
  });
});
