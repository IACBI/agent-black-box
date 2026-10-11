import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import {
  appendFileEvent,
  appendFileEvents,
  createSession,
  getEventsPath,
  readFileEvents,
} from "../src/session/sessionManager.js";
import type { FileEvent } from "../src/types.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

function event(path: string, eventType: FileEvent["eventType"] = "change"): FileEvent {
  return { timestamp: "2026-01-01T00:00:00.000Z", eventType, path };
}

describe("file event log appends", () => {
  it("writes a batch in order as one NDJSON record per event and reads it back unchanged", async () => {
    const repo = await createTempDir("abb-append-events-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      const events = [event("src/a.ts", "add"), event("src/b with space.ts"), event("src/é中.ts", "unlink")];

      await appendFileEvents(session, events);
      await appendFileEvent(session, event("src/last.ts"));

      const raw = await readFile(getEventsPath(session.sessionDir), "utf8");
      const lines = raw.split("\n");
      expect(lines.at(-1)).toBe("");
      expect(lines.slice(0, -1).map((line) => (JSON.parse(line) as FileEvent).path)).toEqual([
        "src/a.ts",
        "src/b with space.ts",
        "src/é中.ts",
        "src/last.ts",
      ]);
      expect(await readFileEvents(session.sessionDir)).toEqual([...events, event("src/last.ts")]);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("does not touch the log for an empty batch", async () => {
    const repo = await createTempDir("abb-append-events-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      const before = await stat(getEventsPath(session.sessionDir)).catch(() => undefined);

      await appendFileEvents(session, []);

      const after = await stat(getEventsPath(session.sessionDir)).catch(() => undefined);
      expect(after?.size).toBe(before?.size);
    } finally {
      await removeTempDir(repo);
    }
  });

  it("keeps concurrent appends intact: every record stays a complete line", async () => {
    const repo = await createTempDir("abb-append-events-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      const batches = Array.from({ length: 8 }, (_, batch) =>
        Array.from({ length: 50 }, (_, index) => event(`src/b${batch}-${index}.ts`))
      );

      await Promise.all(batches.map((batch) => appendFileEvents(session, batch)));

      const records = await readFileEvents(session.sessionDir);
      expect(records).toHaveLength(400);
      expect(new Set(records.map((record) => record.path)).size).toBe(400);
    } finally {
      await removeTempDir(repo);
    }
  });
});
