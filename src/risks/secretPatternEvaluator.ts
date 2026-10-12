import { Worker } from "node:worker_threads";
import type { CompiledSecretRules } from "./secretRules.js";

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const state = new Int32Array(workerData.state);
const output = new Uint8Array(workerData.output);
Atomics.store(state, 0, 1);
Atomics.notify(state, 0);
parentPort.on("message", ({ patterns, text, redact }) => {
  try {
    let result = redact ? text : [];
    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      if (redact) {
        result = result.replace(regex, match => match === "" ? match : "<redacted>");
        if (result.length > 131072) throw new Error("output limit");
      } else if (regex.test(text)) result.push(pattern.name);
    }
    const bytes = Buffer.from(JSON.stringify(result));
    if (bytes.length > output.length) throw new Error("output limit");
    output.set(bytes);
    Atomics.store(state, 1, bytes.length);
    Atomics.store(state, 0, 1);
  } catch {
    Atomics.store(state, 0, 2);
  }
  Atomics.notify(state, 0);
});
`;
const EXECUTION_TIMEOUT_MS = 500;
const STARTUP_TIMEOUT_MS = 5000;
const OUTPUT_BYTES = 1024 * 1024;
const failedRules = new WeakSet<CompiledSecretRules>();
let evaluator: { worker: Worker; state: Int32Array; output: Uint8Array } | undefined;

/** Preserve synchronous APIs while keeping repository regexes off the calling thread. */
export function evaluateSecretPatterns(rules: CompiledSecretRules, text: string, redact: false): string[];
export function evaluateSecretPatterns(rules: CompiledSecretRules, text: string, redact: true): string;
export function evaluateSecretPatterns(rules: CompiledSecretRules, text: string, redact: boolean): string | string[] {
  if (failedRules.has(rules)) return failEvaluation(redact, false);
  if (!evaluator) {
    const state = new Int32Array(new SharedArrayBuffer(8));
    const output = new Uint8Array(new SharedArrayBuffer(OUTPUT_BYTES));
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { state: state.buffer, output: output.buffer },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
      // Do not inherit loaders, debug flags, or worker-specific runtime options.
      execArgv: [],
    });
    worker.unref();
    // Worker failures are reported synchronously through the deadline, never as unhandled events.
    worker.on("error", () => {});
    evaluator = { worker, state, output };
    if (Atomics.wait(state, 0, 0, STARTUP_TIMEOUT_MS) === "timed-out") {
      failedRules.add(rules);
      return failEvaluation(redact);
    }
  }
  const { worker, state, output } = evaluator;
  const patterns = rules.patterns.map((pattern) => ({
    name: pattern.name,
    source: (redact ? pattern.redact : pattern.test).source,
    flags: (redact ? pattern.redact : pattern.test).flags,
  }));
  if (patterns.length > 32 || patterns.some((pattern) => pattern.source.length > 256) || text.length > 65536) {
    failedRules.add(rules);
    return failEvaluation(redact);
  }
  Atomics.store(state, 0, 0);
  worker.postMessage({ patterns, text, redact });
  if (Atomics.wait(state, 0, 0, EXECUTION_TIMEOUT_MS) === "timed-out" || Atomics.load(state, 0) !== 1) {
    failedRules.add(rules);
    return failEvaluation(redact);
  }
  return JSON.parse(Buffer.from(output.subarray(0, Atomics.load(state, 1))).toString("utf8")) as string | string[];
}

function failEvaluation(redact: boolean, terminateWorker = true): string {
  if (terminateWorker && evaluator) {
    void evaluator.worker.terminate();
    evaluator = undefined;
  }
  // Redaction fails closed; scanning fails explicitly so an incomplete scan cannot appear clean.
  if (redact) return "<redacted>";
  throw new Error("Custom secret pattern evaluation exceeded its resource limit; secret scanning was not completed.");
}
