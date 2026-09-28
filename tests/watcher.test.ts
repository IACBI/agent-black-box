import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import type { ActiveSession } from "../src/types.js";

const mocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const listeners = new Map<string, Listener[]>();

  const watcher = {
    on(event: string, listener: Listener) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
      return watcher;
    },
    once(event: string, listener: Listener) {
      return watcher.on(event, listener);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
    close: vi.fn(async () => undefined),
  };

  return {
    appendFileEvent: vi.fn(async () => undefined),
    markCaptureLoss: vi.fn(async () => undefined),
    finalizeSession: vi.fn(async () => ({ id: "session-test", sessionDir: "C:/repo/.agent-black-box/session-test" })),
    readStopRequest: vi.fn(),
    watch: vi.fn(() => watcher),
    watcher,
    reset() {
      listeners.clear();
      watcher.close.mockClear();
      this.appendFileEvent.mockClear();
      this.markCaptureLoss.mockClear();
      this.finalizeSession.mockClear();
      this.readStopRequest.mockReset();
      this.watch.mockClear();
    },
  };
});

vi.mock("chokidar", () => ({ default: { watch: mocks.watch } }));
vi.mock("../src/session/sessionManager.js", () => ({
  appendFileEvent: mocks.appendFileEvent,
  markCaptureLoss: mocks.markCaptureLoss,
  finalizeSession: mocks.finalizeSession,
  readStopRequest: mocks.readStopRequest,
}));

import { MAX_PENDING_FILE_EVENTS, runWatcher } from "../src/watcher/watcher.js";

const session: ActiveSession = {
  id: "session-test",
  repoRoot: "C:/repo",
  sessionDir: "C:/repo/.agent-black-box/session-test",
  startedAt: "2026-01-01T00:00:00.000Z",
  pid: 1234,
};

describe("watcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.reset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("records supported non-excluded events before finalizing a stop request", async () => {
    mocks.readStopRequest.mockResolvedValue({ sessionId: session.id, requestedAt: "2026-01-01T00:00:01.000Z" });

    const completion = runWatcher(session, DEFAULT_CONFIG);
    expect(mocks.watch).toHaveBeenCalledWith(".", expect.objectContaining({ followSymlinks: false }));
    mocks.watcher.emit("all", "change", "src/index.ts");
    mocks.watcher.emit("all", "addDir", "src");
    mocks.watcher.emit("all", "change", "node_modules/package.json");

    await vi.advanceTimersByTimeAsync(500);
    await completion;

    expect(mocks.appendFileEvent).toHaveBeenCalledTimes(1);
    expect(mocks.appendFileEvent).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ eventType: "change", path: "src/index.ts" })
    );
    expect(mocks.finalizeSession).toHaveBeenCalledWith(session, DEFAULT_CONFIG, "stop-request", {
      droppedFileEvents: 0,
      failedFileEventWrites: 0,
    });
    expect(mocks.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("closes the watcher and rejects when chokidar reports an error", async () => {
    const completion = runWatcher(session, DEFAULT_CONFIG);
    const error = new Error("permission denied");

    mocks.watcher.emit("error", error);

    await expect(completion).rejects.toThrow("permission denied");
    expect(mocks.finalizeSession).not.toHaveBeenCalled();
    expect(mocks.watcher.close).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("Watcher error: permission denied");
    expect(mocks.markCaptureLoss).toHaveBeenCalledWith(session, "watcherError");
  });

  it("bounds pending file events during a burst", async () => {
    mocks.readStopRequest.mockResolvedValue({ sessionId: session.id, requestedAt: "2026-01-01T00:00:01.000Z" });
    const completion = runWatcher(session, DEFAULT_CONFIG);

    for (let index = 0; index < MAX_PENDING_FILE_EVENTS + 10; index += 1) {
      mocks.watcher.emit("all", "change", `src/file-${index}.ts`);
    }

    await vi.advanceTimersByTimeAsync(500);
    await completion;

    expect(mocks.appendFileEvent.mock.calls.length).toBeLessThanOrEqual(MAX_PENDING_FILE_EVENTS + 1);
    expect(mocks.markCaptureLoss).toHaveBeenCalledWith(session, "overflow");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("watcher queue reached its limit"));
    expect(mocks.finalizeSession).toHaveBeenCalledWith(
      session,
      DEFAULT_CONFIG,
      "stop-request",
      expect.objectContaining({ droppedFileEvents: expect.any(Number) })
    );
  });

  it("includes failed file-event writes in finalization diagnostics", async () => {
    mocks.appendFileEvent.mockRejectedValueOnce(new Error("disk unavailable"));
    mocks.readStopRequest.mockResolvedValue({ sessionId: session.id, requestedAt: "2026-01-01T00:00:01.000Z" });
    const completion = runWatcher(session, DEFAULT_CONFIG);
    mocks.watcher.emit("all", "change", "src/index.ts");

    await vi.advanceTimersByTimeAsync(500);
    await completion;

    expect(mocks.finalizeSession).toHaveBeenCalledWith(session, DEFAULT_CONFIG, "stop-request", {
      droppedFileEvents: 0,
      failedFileEventWrites: 1,
    });
    expect(mocks.markCaptureLoss).toHaveBeenCalledWith(session, "writeFailure");
  });
});
