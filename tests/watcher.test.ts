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

  it("escapes session paths and capture errors while retaining raw event and finalization values", async () => {
    const controlSession = { ...session, id: "session-test\u001b[2J\n", sessionDir: "/repo/session\u009b31m\n" };
    const fileError = new Error("write failed\u001b[2J\n");
    const captureError = new Error("capture failed\u009b31m\n");
    mocks.appendFileEvent.mockRejectedValueOnce(fileError);
    mocks.markCaptureLoss.mockRejectedValueOnce(captureError);
    mocks.finalizeSession.mockResolvedValueOnce({ id: controlSession.id, sessionDir: controlSession.sessionDir });
    mocks.readStopRequest.mockResolvedValue({ sessionId: controlSession.id, requestedAt: "2026-01-01T00:00:01.000Z" });
    const completion = runWatcher(controlSession, DEFAULT_CONFIG);
    mocks.watcher.emit("ready");
    mocks.watcher.emit("all", "change", "src/a\u001b[2J\n.ts");

    await vi.advanceTimersByTimeAsync(500);
    await completion;

    expect(console.log).toHaveBeenCalledWith(`Agent Black Box session started: ${JSON.stringify(controlSession.id)}`);
    expect(console.log).toHaveBeenCalledWith(`Agent Black Box session stopped: ${JSON.stringify(controlSession.id)}`);
    expect(console.log).toHaveBeenCalledWith('Reports written to "/repo/session\\u009b31m\\n"');
    expect(console.error).toHaveBeenCalledWith(`Failed to record file event: ${JSON.stringify(fileError.message)}`);
    expect(console.error).toHaveBeenCalledWith('Failed to record capture loss: "capture failed\\u009b31m\\n"');
    expect(mocks.appendFileEvent).toHaveBeenCalledWith(
      controlSession,
      expect.objectContaining({ path: "src/a\u001b[2J\n.ts" })
    );
    expect(mocks.finalizeSession).toHaveBeenCalledWith(
      controlSession,
      DEFAULT_CONFIG,
      "stop-request",
      expect.objectContaining({ failedFileEventWrites: 1 })
    );
  });

  it("escapes watcher diagnostics while rejecting with the original error", async () => {
    const completion = runWatcher(session, DEFAULT_CONFIG);
    const error = new Error("watch failed\u001b[2J\n");
    mocks.watcher.emit("error", error);

    await expect(completion).rejects.toBe(error);
    expect(console.error).toHaveBeenCalledWith(`Watcher error: ${JSON.stringify(error.message)}`);
    expect(mocks.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("preserves a plain-value watcher rejection without failing while formatting its diagnostic", async () => {
    const completion = runWatcher(session, DEFAULT_CONFIG);
    const rejection = "plain rejection";
    mocks.watcher.emit("error", rejection);

    await expect(completion).rejects.toBe(rejection);
    expect(console.error).toHaveBeenCalledWith("Watcher error: undefined");
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

  it("waits for an in-flight stop request read before polling again", async () => {
    let resolvePendingRead: (() => void) | undefined;
    mocks.readStopRequest.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        resolvePendingRead = () => resolve(undefined);
      })
    );
    mocks.readStopRequest.mockResolvedValue({ sessionId: session.id, requestedAt: "2026-01-01T00:00:01.000Z" });
    const completion = runWatcher(session, DEFAULT_CONFIG);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.readStopRequest).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeSession).not.toHaveBeenCalled();

    resolvePendingRead?.();
    await vi.advanceTimersByTimeAsync(500);
    await completion;

    expect(mocks.readStopRequest).toHaveBeenCalledTimes(2);
    expect(mocks.finalizeSession).toHaveBeenCalledTimes(1);
  });

  it("resumes stop polling after a failed read", async () => {
    mocks.readStopRequest.mockRejectedValueOnce(new Error("temporary read failure"));
    mocks.readStopRequest.mockResolvedValue({ sessionId: session.id, requestedAt: "2026-01-01T00:00:01.000Z" });
    const completion = runWatcher(session, DEFAULT_CONFIG);

    await vi.advanceTimersByTimeAsync(1_000);
    await completion;

    expect(mocks.readStopRequest).toHaveBeenCalledTimes(2);
    expect(mocks.finalizeSession).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith("Failed to read stop request: temporary read failure");
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
