import chokidar from "chokidar";
import type { ActiveSession, AgentBlackBoxConfig, FileEvent, FileEventType } from "../types.js";
import { appendFileEvent, finalizeSession, markCaptureLoss, readStopRequest } from "../session/sessionManager.js";
import { isPathExcluded, toRepoRelative } from "../utils/paths.js";
import { formatTerminalValue } from "../utils/terminal.js";

const WATCH_EVENTS = new Set<string>(["add", "change", "unlink"]);
export const MAX_PENDING_FILE_EVENTS = 10_000;

export async function runWatcher(session: ActiveSession, config: AgentBlackBoxConfig): Promise<void> {
  let finalized = false;
  const pendingFileEvents: FileEvent[] = [];
  let droppedFileEventCount = 0;
  let failedFileEventWriteCount = 0;
  let eventFlushPromise: Promise<void> | undefined;
  let finalizePromise: Promise<void> | undefined;
  let stopPoll: ReturnType<typeof setInterval> | undefined;
  let stopPollPending = false;
  const lossMarkerWrites: Promise<void>[] = [];

  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: unknown) => void) | undefined;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const watcher = chokidar.watch(".", {
    cwd: session.repoRoot,
    ignored: (candidatePath) => {
      const relativePath = toRepoRelative(session.repoRoot, candidatePath);
      return isPathExcluded(relativePath, config.exclude);
    },
    ignoreInitial: true,
    followSymlinks: false,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
    persistent: true,
  });

  const cleanup = (): void => {
    if (stopPoll) {
      clearInterval(stopPoll);
      stopPoll = undefined;
    }
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
  };

  const finalizeOnce = (reason: string): Promise<void> => {
    if (finalizePromise) {
      return finalizePromise;
    }

    finalized = true;
    finalizePromise = (async () => {
      cleanup();
      await watcher.close();
      do {
        await flushPendingFileEvents();
      } while (pendingFileEvents.length > 0);
      await Promise.all(lossMarkerWrites);
      if (droppedFileEventCount > 0) {
        console.error(`Dropped ${droppedFileEventCount} file events because the watcher queue reached its limit.`);
      }
      const report = await finalizeSession(session, config, reason, {
        droppedFileEvents: droppedFileEventCount,
        failedFileEventWrites: failedFileEventWriteCount,
      });
      console.log(`Agent Black Box session stopped: ${formatTerminalValue(report.id)}`);
      console.log(`Reports written to ${formatTerminalValue(report.sessionDir)}`);
    })();

    void finalizePromise.then(
      () => resolveCompletion?.(),
      (error: unknown) => rejectCompletion?.(error)
    );

    return finalizePromise;
  };

  watcher.on("all", (eventName, changedPath) => {
    if (!WATCH_EVENTS.has(eventName)) {
      return;
    }

    const relativePath = toRepoRelative(session.repoRoot, changedPath);
    if (isPathExcluded(relativePath, config.exclude)) {
      return;
    }

    if (pendingFileEvents.length >= MAX_PENDING_FILE_EVENTS) {
      droppedFileEventCount += 1;
      if (droppedFileEventCount === 1) {
        lossMarkerWrites.push(recordCaptureLoss("overflow"));
      }
      return;
    }

    pendingFileEvents.push({
      timestamp: new Date().toISOString(),
      eventType: eventName as FileEventType,
      path: relativePath,
    });
    void flushPendingFileEvents();
  });

  function flushPendingFileEvents(): Promise<void> {
    if (eventFlushPromise) {
      return eventFlushPromise;
    }

    eventFlushPromise = (async () => {
      while (pendingFileEvents.length > 0) {
        const event = pendingFileEvents.shift();
        if (!event) {
          continue;
        }
        try {
          await appendFileEvent(session, event);
        } catch (error) {
          failedFileEventWriteCount += 1;
          if (failedFileEventWriteCount === 1) {
            lossMarkerWrites.push(recordCaptureLoss("writeFailure"));
          }
          console.error(`Failed to record file event: ${formatTerminalValue(String((error as Error).message))}`);
        }
      }
    })().finally(() => {
      eventFlushPromise = undefined;
    });

    return eventFlushPromise;
  }

  watcher.on("error", (error) => {
    console.error(`Watcher error: ${formatTerminalValue(String((error as Error).message))}`);
    if (!finalized) {
      void recordCaptureLoss("watcherError").finally(() => rejectCompletion?.(error));
    }
  });

  async function recordCaptureLoss(kind: "overflow" | "writeFailure" | "watcherError"): Promise<void> {
    try {
      await markCaptureLoss(session, kind);
    } catch (error) {
      console.error(`Failed to record capture loss: ${formatTerminalValue(String((error as Error).message))}`);
    }
  }

  stopPoll = setInterval(() => {
    if (stopPollPending) {
      return;
    }
    stopPollPending = true;
    void readStopRequest(session.repoRoot, config)
      .then((request) => {
        if (request?.sessionId === session.id) {
          return finalizeOnce("stop-request");
        }
        return undefined;
      })
      .catch((error: unknown) => {
        console.error(`Failed to read stop request: ${formatTerminalValue(String((error as Error).message))}`);
      })
      .finally(() => {
        stopPollPending = false;
      });
  }, 500);

  const handleSigint = (): void => {
    void finalizeOnce("sigint").catch((error: unknown) => {
      console.error(`Failed to finalize session: ${formatTerminalValue(String((error as Error).message))}`);
      process.exitCode = 1;
    });
  };

  const handleSigterm = (): void => {
    void finalizeOnce("sigterm").catch((error: unknown) => {
      console.error(`Failed to finalize session: ${formatTerminalValue(String((error as Error).message))}`);
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  watcher.once("ready", () => {
    console.log(`Agent Black Box session started: ${formatTerminalValue(session.id)}`);
    console.log("Recording observable repository changes. Run `abb stop` from another terminal to finalize.");
  });

  try {
    await completion;
  } finally {
    cleanup();
    if (!finalized) {
      await watcher.close();
    }
  }
}
