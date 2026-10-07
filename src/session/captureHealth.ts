import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import type { ActiveSession } from "../types.js";
import { formatTerminalValue } from "../utils/terminal.js";
import { isProcessRunning } from "./sessionManager.js";

export const MAX_CAPTURE_HEALTH_ENTRIES = 10_000;
const MAX_CAPTURE_HEALTH_REASONS = 20;
const COMMAND_MARKER_PATTERN = /^command-(inflight|failed|completed)-(\d+)-[0-9a-f-]+$/;
const WATCHER_MARKERS = {
  "capture-loss-overflow": "watcherOverflow",
  "capture-loss-write-failure": "watcherWriteFailures",
  "capture-loss-watcher-error": "watcherErrors",
} as const;
const CAPTURE_HEALTH_NOTE =
  "Only persisted markers are inspected; watcher buffers, pending writes, and unrecorded losses are not observable.";

export interface SessionCaptureHealth {
  sessionId: string;
  status: "healthy" | "degraded" | "unknown";
  scope: "persisted-markers";
  counters: {
    watcherOverflow: number;
    watcherWriteFailures: number;
    watcherErrors: number;
    failedCommands: number;
    interruptedCommands: number;
    liveCommands: number;
  };
  closing: boolean | null;
  inspectedEntries: number;
  inspectionComplete: boolean;
  truncated: boolean;
  reasons: string[];
  note: string;
}

/** Inspect durable capture diagnostics without reading event logs or modifying session storage. */
export async function inspectSessionCaptureHealth(active: ActiveSession): Promise<SessionCaptureHealth> {
  const health: SessionCaptureHealth = {
    sessionId: active.id,
    status: "unknown",
    scope: "persisted-markers",
    counters: {
      watcherOverflow: 0,
      watcherWriteFailures: 0,
      watcherErrors: 0,
      failedCommands: 0,
      interruptedCommands: 0,
      liveCommands: 0,
    },
    closing: null,
    inspectedEntries: 0,
    inspectionComplete: false,
    truncated: false,
    reasons: [],
    note: CAPTURE_HEALTH_NOTE,
  };
  let complete = true;
  const unknown = (reason: string): void => {
    complete = false;
    if (health.reasons.length < MAX_CAPTURE_HEALTH_REASONS && !health.reasons.includes(reason)) {
      health.reasons.push(reason);
    }
  };

  try {
    const directoryInfo = await lstat(active.sessionDir);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      unknown("The session directory is linked or is not a regular directory.");
    } else {
      const directory = await opendir(active.sessionDir);
      for await (const entry of directory) {
        if (health.inspectedEntries >= MAX_CAPTURE_HEALTH_ENTRIES) {
          health.truncated = true;
          unknown("The directory entry limit was reached; capture diagnostics may be incomplete.");
          break;
        }
        health.inspectedEntries += 1;
        const watcherCounter = Object.hasOwn(WATCHER_MARKERS, entry.name)
          ? WATCHER_MARKERS[entry.name as keyof typeof WATCHER_MARKERS]
          : undefined;
        const closing = entry.name === "commands-closing";
        const command = COMMAND_MARKER_PATTERN.exec(entry.name);
        if (!watcherCounter && !closing && !command) {
          if (entry.name.startsWith("capture-loss-") || /^command-(?:inflight|failed|completed)-/.test(entry.name)) {
            unknown("An unrecognized capture marker was found.");
          }
          continue;
        }

        let markerInfo;
        try {
          markerInfo = await lstat(path.join(active.sessionDir, entry.name));
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            unknown(`A capture marker could not be inspected (${errorCode(error)}).`);
          }
          continue;
        }
        if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size !== 0) {
          unknown("A capture marker is linked, non-regular, or has unexpected contents.");
          continue;
        }
        if (watcherCounter) {
          health.counters[watcherCounter] += 1;
        } else if (closing) {
          health.closing = true;
        } else if (command) {
          const pid = Number(command[2]);
          if (!Number.isSafeInteger(pid) || pid <= 0) {
            unknown("A command capture marker has an invalid process ID.");
          } else if (command[1] === "failed") {
            health.counters.failedCommands += 1;
          } else if (command[1] === "inflight") {
            if (isProcessRunning(pid)) {
              health.counters.liveCommands += 1;
            } else {
              health.counters.interruptedCommands += 1;
            }
          }
        }
      }
    }
  } catch (error) {
    unknown(`The session directory could not be inspected (${errorCode(error)}).`);
  }

  const counters = health.counters;
  const failures =
    counters.watcherOverflow +
    counters.watcherWriteFailures +
    counters.watcherErrors +
    counters.failedCommands +
    counters.interruptedCommands;
  if (failures > 0) {
    health.status = "degraded";
    if (counters.watcherOverflow > 0)
      health.reasons.push("Watcher queue overflow was recorded; the lost-event count is unknown.");
    if (counters.watcherWriteFailures > 0)
      health.reasons.push("File event write failures were recorded; the lost-event count is unknown.");
    if (counters.watcherErrors > 0) health.reasons.push("A watcher error was recorded.");
    if (counters.failedCommands > 0)
      health.reasons.push(`${counters.failedCommands} wrapped command completion(s) could not be persisted.`);
    if (counters.interruptedCommands > 0)
      health.reasons.push(`${counters.interruptedCommands} wrapped command(s) no longer have a live wrapper process.`);
  } else if (complete) {
    health.status = "healthy";
    health.reasons.push("No persisted capture-loss or interrupted-command markers were observed.");
  }
  if (complete && health.closing === null) {
    health.closing = false;
  }
  health.reasons = health.reasons.slice(0, MAX_CAPTURE_HEALTH_REASONS);
  health.inspectionComplete = complete;
  return health;
}

export function renderSessionCaptureHealth(health: SessionCaptureHealth): string {
  const counters = health.counters;
  return [
    `Capture health: ${health.status}.`,
    `Live wrapped commands: ${counters.liveCommands}; failed: ${counters.failedCommands}; interrupted: ${counters.interruptedCommands}.`,
    `Closing: ${health.closing === null ? "unknown" : health.closing ? "yes" : "no"}.`,
    ...(health.inspectionComplete ? [] : ["Persisted marker inspection was incomplete."]),
    ...health.reasons.map((reason) => formatTerminalValue(reason)),
    formatTerminalValue(health.note),
  ].join(" ");
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,32}$/.test(error.code)
  ) {
    return error.code;
  }
  return "unknown error";
}
