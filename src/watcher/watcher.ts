import chokidar from "chokidar";
import type { ActiveSession, AgentBlackBoxConfig, FileEventType } from "../types.js";
import { appendFileEvent, finalizeSession, readStopRequest } from "../session/sessionManager.js";
import { isPathExcluded, toRepoRelative } from "../utils/paths.js";

const WATCH_EVENTS = new Set<string>(["add", "change", "unlink"]);

export async function runWatcher(session: ActiveSession, config: AgentBlackBoxConfig): Promise<void> {
  let finalized = false;
  let eventWriteQueue = Promise.resolve();

  const watcher = chokidar.watch(".", {
    cwd: session.repoRoot,
    ignored: (candidatePath) => {
      const relativePath = toRepoRelative(session.repoRoot, candidatePath);
      return isPathExcluded(relativePath, config.exclude);
    },
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50
    },
    persistent: true
  });

  const finalizeOnce = async (reason: string): Promise<void> => {
    if (finalized) {
      return;
    }

    finalized = true;
    clearInterval(stopPoll);
    await watcher.close();
    await eventWriteQueue;
    const report = await finalizeSession(session, config, reason);
    console.log(`Agent Black Box session stopped: ${report.id}`);
    console.log(`Reports written to ${report.sessionDir}`);
  };

  watcher.on("all", (eventName, changedPath) => {
    if (!WATCH_EVENTS.has(eventName)) {
      return;
    }

    const relativePath = toRepoRelative(session.repoRoot, changedPath);
    if (isPathExcluded(relativePath, config.exclude)) {
      return;
    }

    eventWriteQueue = eventWriteQueue
      .then(() =>
        appendFileEvent(session, {
          timestamp: new Date().toISOString(),
          eventType: eventName as FileEventType,
          path: relativePath
        })
      )
      .catch((error: unknown) => {
        console.error(`Failed to record file event: ${(error as Error).message}`);
      })
  });

  watcher.on("error", (error) => {
    console.error(`Watcher error: ${(error as Error).message}`);
  });

  const stopPoll = setInterval(() => {
    void (async () => {
      const request = await readStopRequest(session.repoRoot, config);
      if (request?.sessionId === session.id) {
        await finalizeOnce("stop-request");
      }
    })();
  }, 500);

  process.once("SIGINT", () => {
    void finalizeOnce("sigint").finally(() => process.exit(0));
  });

  process.once("SIGTERM", () => {
    void finalizeOnce("sigterm").finally(() => process.exit(0));
  });

  await new Promise<void>((resolve, reject) => {
    watcher.once("ready", () => {
      console.log(`Agent Black Box session started: ${session.id}`);
      console.log("Recording observable repository changes. Run `abb stop` from another terminal to finalize.");
    });
    watcher.once("error", reject);

    const completionPoll = setInterval(() => {
      if (finalized) {
        clearInterval(completionPoll);
        resolve();
      }
    }, 100);
  });
}
