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
    appendFileEvents: vi.fn(async (_session: unknown, _events: Array<{ path: string }>) => undefined),
    markCaptureLoss: vi.fn(async () => undefined),
    finalizeSession: vi.fn(async () => ({ id: "session-test", sessionDir: "C:/repo/.agent-black-box/session-test" })),
    readStopRequest: vi.fn(),
    watch: vi.fn(() => watcher),
    watcher,
    reset() {
      listeners.clear();
      watcher.close.mockClear();
      this.appendFileEvents.mockClear();
      this.markCaptureLoss.mockClear();
      this.finalizeSession.mockClear();
      this.readStopRequest.mockReset();
      this.watch.mockClear();
    },
  };
});

vi.mock("chokidar", () => ({ default: { watch: mocks.watch } }));
vi.mock("../src/session/sessionManager.js", () => ({
  appendFileEvents: mocks.appendFileEvents,
  markCaptureLoss: mocks.markCaptureLoss,
  finalizeSession: mocks.finalizeSession,
  readStopRequest: mocks.readStopRequest,
}));

import { FILE_EVENT_BATCH_SIZE, MAX_PENDING_FILE_EVENTS, runWatcher } from "../src/watcher/watcher.js";

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

    expect(mocks.appendFileEvents).toHaveBeenCalledTimes(1);
    expect(mocks.appendFileEvents).toHaveBeenCalledWith(session, [
      expect.objectContaining({ eventType: "change", path: "src/index.ts" }),
    ]);
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
    mocks.appendFileEvents.mockRejectedValueOnce(fileError);
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
    expect(mocks.appendFileEvents).toHaveBeenCalledWith(controlSession, [
      expect.objectContaining({ path: "src/a\u001b[2J\n.ts" }),
    ]);
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

  it("ignores a pending stop response after the watcher has failed", async () => {
    let releaseStopRead: ((request: { sessionId: string }) => void) | undefined;
    mocks.readStopRequest.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseStopRead = resolve;
      })
    );
    const completion = runWatcher(session, DEFAULT_CONFIG);
    await vi.advanceTimersByTimeAsync(500);
    const failure = new Error("watcher failed");
    mocks.watcher.emit("error", failure);
    await expect(completion).rejects.toBe(failure);

    releaseStopRead?.({ sessionId: session.id });
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.finalizeSession).not.toHaveBeenCalled();
    expect(mocks.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("stops accepting events and polling while recording a watcher failure", async () => {
    let releaseFailureMarker: (() => void) | undefined;
    mocks.markCaptureLoss.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        releaseFailureMarker = () => resolve(undefined);
      })
    );
    const completion = runWatcher(session, DEFAULT_CONFIG);
    const outcome = completion.then(
      () => ({ rejected: false, reason: undefined }),
      (reason: unknown) => ({ rejected: true, reason })
    );
    const failure = new Error("watcher failed");
    mocks.watcher.emit("error", failure);
    mocks.watcher.emit("all", "change", "src/after-failure.ts");
    mocks.watcher.emit("error", new Error("another watcher failure"));

    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.appendFileEvents).not.toHaveBeenCalled();
      expect(mocks.readStopRequest).not.toHaveBeenCalled();
      expect(mocks.markCaptureLoss).toHaveBeenCalledTimes(1);
    } finally {
      releaseFailureMarker?.();
      expect(await outcome).toEqual({ rejected: true, reason: failure });
    }

    expect(mocks.finalizeSession).not.toHaveBeenCalled();
    expect(mocks.watcher.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { scenario: "a successful close", closeFailure: undefined },
    { scenario: "a failed close", closeFailure: new Error("close failed") },
  ])("drains accepted events and their failure markers after $scenario", async ({ closeFailure }) => {
    if (closeFailure) {
      mocks.watcher.close.mockRejectedValueOnce(closeFailure);
    }
    let rejectPendingWrite: ((error: Error) => void) | undefined;
    mocks.appendFileEvents.mockReturnValueOnce(
      new Promise<undefined>((_resolve, reject) => {
        rejectPendingWrite = reject;
      })
    );
    let releaseWriteFailureMarker: (() => void) | undefined;
    mocks.markCaptureLoss.mockResolvedValueOnce(undefined);
    mocks.markCaptureLoss.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        releaseWriteFailureMarker = () => resolve(undefined);
      })
    );
    const completion = runWatcher(session, DEFAULT_CONFIG);
    let settled = false;
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    mocks.watcher.emit("all", "change", "src/first.ts");
    mocks.watcher.emit("all", "change", "src/second.ts");
    const failure = new Error("watcher failed");
    mocks.watcher.emit("error", failure);

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      rejectPendingWrite?.(new Error("write failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(mocks.appendFileEvents.mock.calls.flatMap(([, events]) => events.map((event) => event.path))).toEqual([
        "src/first.ts",
        "src/second.ts",
      ]);
      expect(mocks.markCaptureLoss).toHaveBeenCalledWith(session, "writeFailure");
    } finally {
      rejectPendingWrite?.(new Error("write failed"));
      releaseWriteFailureMarker?.();
      await expect(completion).rejects.toBe(closeFailure ?? failure);
    }

    expect(mocks.finalizeSession).not.toHaveBeenCalled();
    expect(mocks.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("drains accepted events and loss markers when closing a normal stop fails", async () => {
    const closeFailure = new Error("close failed");
    mocks.watcher.close.mockRejectedValueOnce(closeFailure);
    mocks.readStopRequest.mockResolvedValue({ sessionId: session.id, requestedAt: "2026-01-01T00:00:01.000Z" });
    let rejectPendingWrite: ((error: Error) => void) | undefined;
    mocks.appendFileEvents.mockReturnValueOnce(
      new Promise<undefined>((_resolve, reject) => {
        rejectPendingWrite = reject;
      })
    );
    let releaseFailureMarker: (() => void) | undefined;
    mocks.markCaptureLoss.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        releaseFailureMarker = () => resolve(undefined);
      })
    );
    let settled = false;
    const completion = runWatcher(session, DEFAULT_CONFIG);
    const outcome = completion.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      }
    );
    mocks.watcher.emit("all", "change", "src/first.ts");
    mocks.watcher.emit("all", "change", "src/second.ts");

    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);
      mocks.watcher.emit("all", "change", "src/after-close-failure.ts");
      rejectPendingWrite?.(new Error("write failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(mocks.appendFileEvents.mock.calls.flatMap(([, events]) => events.map((event) => event.path))).toEqual([
        "src/first.ts",
        "src/second.ts",
      ]);
      expect(mocks.markCaptureLoss).toHaveBeenCalledWith(session, "writeFailure");
    } finally {
      rejectPendingWrite?.(new Error("write failed"));
      await vi.advanceTimersByTimeAsync(0);
      releaseFailureMarker?.();
      expect(await outcome).toBe(closeFailure);
    }

    expect(mocks.finalizeSession).not.toHaveBeenCalled();
    expect(mocks.watcher.close).toHaveBeenCalledTimes(1);
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

    // The first event is written immediately; the queue then holds at most MAX_PENDING_FILE_EVENTS more.
    const written = mocks.appendFileEvents.mock.calls.flatMap(([, events]) => events);
    expect(written).toHaveLength(MAX_PENDING_FILE_EVENTS + 1);
    expect(written.map((event) => event.path)).toEqual(
      Array.from({ length: MAX_PENDING_FILE_EVENTS + 1 }, (_, index) => `src/file-${index}.ts`)
    );
    expect(mocks.markCaptureLoss).toHaveBeenCalledWith(session, "overflow");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("watcher queue reached its limit"));
    expect(mocks.finalizeSession).toHaveBeenCalledWith(
      session,
      DEFAULT_CONFIG,
      "stop-request",
      expect.objectContaining({ droppedFileEvents: 9, failedFileEventWrites: 0 })
    );
  });

  it("writes a burst in ordered batches no larger than the batch size", async () => {
    mocks.readStopRequest.mockResolvedValue({ sessionId: session.id, requestedAt: "2026-01-01T00:00:01.000Z" });
    const completion = runWatcher(session, DEFAULT_CONFIG);
    const total = FILE_EVENT_BATCH_SIZE * 2 + 50;

    for (let index = 0; index < total; index += 1) {
      mocks.watcher.emit("all", "change", `src/file-${index}.ts`);
    }

    await vi.advanceTimersByTimeAsync(500);
    await completion;

    const batches = mocks.appendFileEvents.mock.calls.map(([, events]) => events);
    // The event that starts a flush goes out alone; everything that arrives meanwhile is coalesced.
    expect(batches[0]).toHaveLength(1);
    expect(batches.length).toBeLessThan(total);
    expect(Math.max(...batches.map((batch) => batch.length))).toBe(FILE_EVENT_BATCH_SIZE);
    expect(batches.flat().map((event) => event.path)).toEqual(
      Array.from({ length: total }, (_, index) => `src/file-${index}.ts`)
    );
    expect(mocks.finalizeSession).toHaveBeenCalledWith(session, DEFAULT_CONFIG, "stop-request", {
      droppedFileEvents: 0,
      failedFileEventWrites: 0,
    });
  });

  it("counts every event of a failed batch, records the loss once, and keeps writing later events", async () => {
    mocks.readStopRequest.mockResolvedValue({ sessionId: session.id, requestedAt: "2026-01-01T00:00:01.000Z" });
    let releaseFirstWrite: (() => void) | undefined;
    mocks.appendFileEvents.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (releaseFirstWrite = () => resolve(undefined)))
    );
    mocks.appendFileEvents.mockRejectedValueOnce(new Error("disk unavailable"));
    const completion = runWatcher(session, DEFAULT_CONFIG);

    mocks.watcher.emit("all", "change", "src/first.ts");
    for (const name of ["a", "b", "c", "d"]) {
      mocks.watcher.emit("all", "change", `src/${name}.ts`);
    }
    releaseFirstWrite?.();
    await vi.advanceTimersByTimeAsync(10);
    mocks.watcher.emit("all", "change", "src/later.ts");

    await vi.advanceTimersByTimeAsync(500);
    await completion;

    expect(mocks.appendFileEvents.mock.calls.map(([, events]) => events.map((event) => event.path))).toEqual([
      ["src/first.ts"],
      ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
      ["src/later.ts"],
    ]);
    expect(mocks.markCaptureLoss).toHaveBeenCalledTimes(1);
    expect(mocks.markCaptureLoss).toHaveBeenCalledWith(session, "writeFailure");
    expect(mocks.finalizeSession).toHaveBeenCalledWith(session, DEFAULT_CONFIG, "stop-request", {
      droppedFileEvents: 0,
      failedFileEventWrites: 4,
    });
  });

  it("includes failed file-event writes in finalization diagnostics", async () => {
    mocks.appendFileEvents.mockRejectedValueOnce(new Error("disk unavailable"));
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
