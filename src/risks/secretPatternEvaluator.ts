import { Worker } from "node:worker_threads";
import type { CompiledSecretRules } from "./secretRules.js";

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const state = new Int32Array(workerData.state);
const output = new Uint8Array(workerData.output);
Atomics.store(state, 0, 1);
Atomics.notify(state, 0);
function redactOriginalMatches(compiled, text, initialMatchEnds, withMetadata) {
  // Index original match endpoints by code unit, so masking one pattern cannot invalidate another.
  const matchEnds = initialMatchEnds ? new Uint32Array(initialMatchEnds) : new Uint32Array(text.length);
  let customMatched = false;
  for (const { regex } of compiled) {
    text.replace(regex, (match, ...args) => {
      if (match !== "") {
        customMatched = true;
        const offset = typeof args.at(-1) === "object" ? args.at(-3) : args.at(-2);
        matchEnds[offset] = Math.max(matchEnds[offset], offset + match.length);
      }
      return match;
    });
  }
  const pieces = [];
  let copiedThrough = 0;
  let outputLength = 0;
  for (let start = 0; start < text.length; start += 1) {
    let end = matchEnds[start];
    if (end === 0) continue;
    for (let inner = start + 1; inner < end; inner += 1) {
      end = Math.max(end, matchEnds[inner]);
    }
    outputLength += start - copiedThrough + "<redacted>".length;
    if (outputLength > 131072) throw new Error("output limit");
    pieces.push(text.slice(copiedThrough, start), "<redacted>");
    copiedThrough = end;
    // Adjacent matches remain separate replacements; only overlapping spans are merged.
    start = end - 1;
  }
  outputLength += text.length - copiedThrough;
  if (outputLength > 131072) throw new Error("output limit");
  pieces.push(text.slice(copiedThrough));
  const redacted = pieces.join("");
  return withMetadata ? { text: redacted, customMatched } : redacted;
}
parentPort.on("message", ({ patterns, text, lines, redact, initialMatchEnds, withMetadata }) => {
  try {
    const compiled = patterns.map(pattern => ({ name: pattern.name, regex: new RegExp(pattern.source, pattern.flags) }));
    let result;
    if (lines) {
      result = lines.map(line => {
        const names = [];
        for (const { name, regex } of compiled) {
          regex.lastIndex = 0;
          if (regex.test(line)) names.push(name);
        }
        return names;
      });
    } else if (redact) {
      result = redactOriginalMatches(compiled, text, initialMatchEnds, withMetadata);
    } else {
      result = [];
      for (const { name, regex } of compiled) {
        if (regex.test(text)) result.push(name);
      }
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
export const MAX_CUSTOM_PATTERN_LINE_LENGTH = 4096;
export const MAX_CUSTOM_PATTERN_BATCH_LINES = 64;
export const MAX_CUSTOM_PATTERN_BATCH_CHARACTERS = 65_536;
const failedRules = new WeakSet<CompiledSecretRules>();
let evaluator: { worker: Worker; state: Int32Array; output: Uint8Array } | undefined;

export interface PatternRedactionResult {
  text: string;
  customMatched: boolean;
}

type EvaluationInput =
  | { text: string; redact: boolean; initialMatchEnds?: Uint32Array; withMetadata?: true }
  | { lines: readonly string[]; redact: false };

/** Preserve synchronous APIs while keeping repository regexes off the calling thread. */
export function evaluateSecretPatterns(rules: CompiledSecretRules, text: string, redact: false): string[];
export function evaluateSecretPatterns(rules: CompiledSecretRules, text: string, redact: true): string;
export function evaluateSecretPatterns(rules: CompiledSecretRules, text: string, redact: boolean): string | string[] {
  return runEvaluation(rules, { text, redact }) as string | string[];
}

/** Each line is independent; the entire bounded batch shares the existing execution deadline. */
export function evaluateSecretPatternLines(rules: CompiledSecretRules, lines: readonly string[]): string[][] {
  return runEvaluation(rules, { lines, redact: false }) as string[][];
}

/** @internal Combines trusted original-text masks with custom matches in one bounded worker call. */
export function evaluateSecretPatternRedaction(
  rules: CompiledSecretRules,
  text: string,
  initialMatchEnds: Uint32Array
): PatternRedactionResult {
  const result = runEvaluation(rules, { text, redact: true, initialMatchEnds, withMetadata: true });
  return typeof result === "string" ? { text: result, customMatched: true } : (result as PatternRedactionResult);
}

function runEvaluation(
  rules: CompiledSecretRules,
  input: EvaluationInput
): string | string[] | string[][] | PatternRedactionResult {
  const { redact } = input;
  if (failedRules.has(rules)) return failEvaluation(redact, false);
  const patterns = rules.patterns.map((pattern) => ({
    name: pattern.name,
    source: (redact ? pattern.redact : pattern.test).source,
    flags: (redact ? pattern.redact : pattern.test).flags,
  }));
  const inputTooLarge =
    "lines" in input
      ? input.lines.length > MAX_CUSTOM_PATTERN_BATCH_LINES ||
        input.lines.some((line) => line.length > MAX_CUSTOM_PATTERN_LINE_LENGTH) ||
        input.lines.reduce((total, line) => total + line.length, 0) > MAX_CUSTOM_PATTERN_BATCH_CHARACTERS
      : input.text.length > MAX_CUSTOM_PATTERN_BATCH_CHARACTERS;
  const invalidMask =
    "initialMatchEnds" in input &&
    input.initialMatchEnds !== undefined &&
    (!(input.initialMatchEnds instanceof Uint32Array) ||
      input.initialMatchEnds.length !== input.text.length ||
      input.initialMatchEnds.some((end, start) => end !== 0 && (end <= start || end > input.text.length)));
  if (patterns.length > 32 || patterns.some((pattern) => pattern.source.length > 256) || inputTooLarge || invalidMask) {
    failedRules.add(rules);
    return failEvaluation(redact);
  }
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
  Atomics.store(state, 0, 0);
  worker.postMessage({ patterns, ...input });
  if (Atomics.wait(state, 0, 0, EXECUTION_TIMEOUT_MS) === "timed-out" || Atomics.load(state, 0) !== 1) {
    failedRules.add(rules);
    return failEvaluation(redact);
  }
  return JSON.parse(Buffer.from(output.subarray(0, Atomics.load(state, 1))).toString("utf8")) as
    string | string[] | string[][] | PatternRedactionResult;
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
