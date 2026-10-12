import * as fs from "node:fs/promises";
import { appendFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  digestRegularFile,
  digestRecords,
  digestText,
  FILE_DIGEST_STREAM_BYTES,
  MaterializationBudgetError,
  readCanonicalReportCore,
  readJsonFileWithinBudget,
} from "../src/session/reportStorage.js";
import * as files from "../src/utils/files.js";
import { createTempDir, removeTempDir } from "./testUtils.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

describe("report storage input quotas", () => {
  it("preserves verification and close failures together while closing the actual file", async () => {
    const directory = await createTempDir("abb-report-close-failure-");
    const filePath = path.join(directory, "session.json");
    try {
      await writeFile(filePath, "invalid JSON");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const closeFailure = new Error("Descriptor close failed.");
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "close").mockImplementationOnce(async () => {
          await close();
          throw closeFailure;
        });
        return handle;
      });
      const failure: unknown = await readCanonicalReportCore(filePath).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toBeInstanceOf(SyntaxError);
      expect((failure as AggregateError).errors[1]).toBe(closeFailure);
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(directory);
    }
  });

  it("preserves format limits and malformed JSON errors instead of reporting corruption as quota refusal", async () => {
    const directory = await createTempDir("abb-report-storage-");
    const filePath = path.join(directory, "session.json");
    try {
      await writeFile(filePath, "{ invalid }");
      await expect(readJsonFileWithinBudget(filePath, 64, 64)).rejects.toBeInstanceOf(SyntaxError);
      await writeFile(filePath, " ".repeat(65));
      await expect(readJsonFileWithinBudget(filePath, 64, 32)).rejects.toThrow("64 bytes size limit");
      await writeFile(filePath, JSON.stringify({ value: "x".repeat(32) }));
      await expect(readJsonFileWithinBudget(filePath, 64, 32)).rejects.toBeInstanceOf(MaterializationBudgetError);
    } finally {
      await removeTempDir(directory);
    }
  });

  it("bounds a file that grows after quota preflight and keeps its quota failure distinct", async () => {
    const directory = await createTempDir("abb-report-growth-");
    const filePath = path.join(directory, "session.json");
    const readFileLimited = files.readFileLimited;
    let restoreReader: (() => void) | undefined;
    try {
      await writeFile(filePath, "{}");
      const reader = vi.spyOn(files, "readFileLimited").mockImplementation(async (target, maxBytes) => {
        await appendFile(target, " ".repeat(32));
        return readFileLimited(target, maxBytes);
      });
      restoreReader = () => reader.mockRestore();
      await expect(readJsonFileWithinBudget(filePath, 64, 16)).rejects.toBeInstanceOf(MaterializationBudgetError);
    } finally {
      restoreReader?.();
      await removeTempDir(directory);
    }
  });

  it("hashes the exact file bytes and refuses unsupported digest size before streaming", async () => {
    const directory = await createTempDir("abb-report-digest-");
    const filePath = path.join(directory, "session.json");
    const text = '{"name":"Türkçe"}\n';
    try {
      await writeFile(filePath, text);
      const bytes = Buffer.byteLength(text);
      await expect(digestRegularFile(filePath, bytes)).resolves.toEqual({ bytes, digest: digestText(text) });
      await expect(digestRegularFile(filePath, bytes - 1)).rejects.toThrow("digest size limit");
      await expect(digestRegularFile(filePath, -1)).rejects.toThrow("non-negative safe integer");
      await writeFile(filePath, "");
      await expect(digestRegularFile(filePath, 0)).resolves.toEqual({ bytes: 0, digest: digestText("") });
    } finally {
      await removeTempDir(directory);
    }
  });

  it("refuses a same-size replacement between inspection and open and closes the replaced descriptor", async () => {
    const directory = await createTempDir("abb-report-replaced-");
    const filePath = path.join(directory, "session.json");
    try {
      await writeFile(filePath, "original");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let close: ReturnType<typeof vi.spyOn> | undefined;
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        await rename(filePath, `${filePath}.old`);
        await writeFile(filePath, "replaced");
        const handle = await actual.open(...args);
        close = vi.spyOn(handle, "close");
        return handle;
      });
      await expect(digestRegularFile(filePath)).rejects.toThrow("changed during verification");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(directory);
    }
  });

  it("distinguishes file identities that collide when rounded to numbers", async () => {
    const directory = await createTempDir("abb-report-large-inode-");
    const filePath = path.join(directory, "session.json");
    const originalIdentity = 2n ** 60n;
    const replacementIdentity = originalIdentity + 1n;
    expect(Number(originalIdentity)).toBe(Number(replacementIdentity));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let inspections = 0;
    try {
      await writeFile(filePath, "original");
      vi.mocked(fs.lstat).mockImplementation(async (...args) => {
        const details = await actual.lstat(...args);
        const identity = inspections++ === 0 ? originalIdentity : replacementIdentity;
        return Object.assign(details, {
          ino: args[1]?.bigint ? identity : Number(identity),
        });
      });
      let close: ReturnType<typeof vi.spyOn> | undefined;
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (options) => {
          const details = await stat(options);
          return Object.assign(details, {
            ino: options?.bigint ? replacementIdentity : Number(replacementIdentity),
          });
        });
        close = vi.spyOn(handle, "close");
        return handle;
      });
      await expect(digestRegularFile(filePath)).rejects.toThrow("changed during verification");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      vi.mocked(fs.lstat).mockImplementation(actual.lstat);
      await removeTempDir(directory);
    }
  });

  it("refuses file lengths that cannot be streamed with exact numeric offsets", async () => {
    const directory = await createTempDir("abb-report-unsafe-size-");
    const filePath = path.join(directory, "session.json");
    try {
      await writeFile(filePath, "original");
      const handle = await fs.open(filePath, "r");
      const details = await handle.stat({ bigint: true });
      vi.spyOn(handle, "stat").mockResolvedValueOnce(
        Object.assign(details, { size: BigInt(Number.MAX_SAFE_INTEGER) + 1n })
      );
      const read = vi.spyOn(handle, "read");
      const close = vi.spyOn(handle, "close");
      vi.mocked(fs.open).mockResolvedValueOnce(handle);
      await expect(digestRegularFile(filePath)).rejects.toThrow("supported digest size limit");
      expect(read).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(directory);
    }
  });

  it("bounds growing file reads to the opened size and closes the descriptor on refusal", async () => {
    const directory = await createTempDir("abb-report-growing-digest-");
    const filePath = path.join(directory, "session.json");
    try {
      await writeFile(filePath, "initial");
      const handle = await fs.open(filePath, "r");
      const originalRead = handle.read.bind(handle);
      const read = vi.spyOn(handle, "read").mockImplementation(async (...args) => {
        await appendFile(filePath, " appended");
        return originalRead(...args);
      });
      const close = vi.spyOn(handle, "close");
      vi.mocked(fs.open).mockResolvedValueOnce(handle);
      await expect(digestRegularFile(filePath)).rejects.toThrow("changed during verification");
      expect(read).toHaveBeenCalledOnce();
      expect(read.mock.calls[0]).toEqual([expect.any(Buffer), 0, Buffer.byteLength("initial") + 1, null]);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      await removeTempDir(directory);
    }
  });
});

describe("canonical report core streaming", () => {
  it("binds exact bytes while omitting only top-level record arrays across chunk boundaries", async () => {
    const directory = await createTempDir("abb-report-core-");
    const filePath = path.join(directory, "session.json");
    const events = [
      {
        timestamp: "2026-01-06T00:00:01.000Z",
        eventType: "change",
        path: "src/file.ts",
        extra: {
          padding: "x".repeat(FILE_DIGEST_STREAM_BYTES * 2),
          events: ["nested"],
          quote: '" } ] \\',
          number: -1.25e30,
        },
      },
      { timestamp: "2026-01-06T00:00:01.000Z", eventType: "change", path: "Türkçe/🙂.ts", flags: [true, false, null] },
    ];
    const records = JSON.stringify(events);
    const text = ` { "id": "session-test", "ev\\u0065nts" : ${records}, "commands": [], "extra": { "events": ["retained"] }, "note": ${JSON.stringify("Türkçe 🙂 \n \\")} } \n`;
    const encodedCore = text.replace(records, "[]");
    const coreBytes = Buffer.byteLength(encodedCore);
    const budget = Math.max(
      coreBytes,
      Buffer.byteLength(text.slice(0, text.indexOf(records))) + 2 + Buffer.byteLength(JSON.stringify(events[0]))
    );
    try {
      await writeFile(filePath, text);
      await expect(readCanonicalReportCore(filePath, budget)).resolves.toMatchObject({
        bytes: Buffer.byteLength(text),
        digest: digestText(text),
        core: JSON.parse(encodedCore),
        eventCount: events.length,
        commandCount: 0,
        eventsDigest: digestRecords(events),
        commandsDigest: digestRecords([]),
      });
      await expect(readCanonicalReportCore(filePath, budget - 1)).rejects.toBeInstanceOf(MaterializationBudgetError);
    } finally {
      await removeTempDir(directory);
    }
  });

  it("retains multibyte core strings and escape sequences split across read buffers", async () => {
    const directory = await createTempDir("abb-report-core-utf8-");
    const filePath = path.join(directory, "session.json");
    const prefix = '{"note":"';
    const note = `${"x".repeat(FILE_DIGEST_STREAM_BYTES - Buffer.byteLength(prefix) - 1)}🙂Türkçe`;
    const report = {
      note,
      events: [{ timestamp: "2026-01-06T00:00:01.000Z", eventType: "change", path: '\\"{}[]' }],
      commands: [],
      extra: { commands: ["keep"] },
    };
    const text = JSON.stringify(report);
    try {
      await writeFile(filePath, text);
      expect((await readCanonicalReportCore(filePath)).core).toEqual({ ...report, events: [] });
      const escapeBoundary = `${prefix}${"x".repeat(FILE_DIGEST_STREAM_BYTES - Buffer.byteLength(prefix) - 1)}\\u0061", "events":[], "commands":[]}`;
      await writeFile(filePath, escapeBoundary);
      expect((await readCanonicalReportCore(filePath)).core).toEqual(JSON.parse(escapeBoundary));
    } finally {
      await removeTempDir(directory);
    }
  });

  it("hashes all canonical command fields across equivalent JSON formatting and number encodings", async () => {
    const directory = await createTempDir("abb-report-command-digests-");
    const filePath = path.join(directory, "session.json");
    const command = {
      startedAt: "2026-01-06T00:00:01.000Z",
      endedAt: "2026-01-06T00:00:02.000Z",
      command: 'printf "Türkçe🙂"',
      cwd: "/repository",
      exitCode: 0,
      durationMs: 15,
      extension: { nested: { events: [true, false, null], commands: [1, 2] }, text: '\\"{}[]' },
    };
    const commands = [command, { ...command, command: "exit 1", exitCode: 1, durationMs: 0 }];
    const text = JSON.stringify({ events: [], commands, id: "session-test" }, null, 2)
      .replace('"durationMs": 15', '"durationMs": 1.5e1')
      .replace("Türkçe", "T\\u00fcrk\\u00e7e");
    try {
      await writeFile(filePath, text);
      expect(await readCanonicalReportCore(filePath)).toMatchObject({
        eventCount: 0,
        commandCount: 2,
        eventsDigest: digestRecords([]),
        commandsDigest: digestRecords(commands),
        core: { events: [], commands: [], id: "session-test" },
        digest: digestText(text),
      });
      await writeFile(
        filePath,
        JSON.stringify({ events: [{ timestamp: "invalid", eventType: "change", path: "file.ts" }], commands: [] })
      );
      await expect(readCanonicalReportCore(filePath)).rejects.toThrow("invalid file event");
    } finally {
      await removeTempDir(directory);
    }
  });

  it.each([
    '[{"path":"\\q"}]',
    '[{"path":"\\u12xz"}]',
    '[{"path":"raw\nnewline"}]',
    '[{"number":01}]',
    '[{"number":1e+}]',
    '[{"timestamp":"2026-01-06T00:00:01.000Z","eventType":"change","path":"x"},]',
    "[true false]",
    '[{"path":"x" "other":1}]',
    '[{"path":"x"]]',
    '[{"timestamp":"2026-01-06T00:00:01.000Z","eventType":"change","path":"x"}',
  ])("rejects malformed JSON in omitted records: %s", async (records) => {
    const directory = await createTempDir("abb-report-invalid-core-");
    try {
      const filePath = path.join(directory, "session.json");
      await writeFile(filePath, `{"events":${records},"commands":[],"id":"session-test"}`);
      await expect(readCanonicalReportCore(filePath)).rejects.toBeInstanceOf(SyntaxError);
    } finally {
      await removeTempDir(directory);
    }
  });

  it("rejects ambiguous top-level keys, non-array records and excessive discarded nesting", async () => {
    const directory = await createTempDir("abb-report-invalid-structure-");
    const filePath = path.join(directory, "session.json");
    try {
      for (const text of ['{"events":[],"ev\\u0065nts":[]}', '{"commands":null}', '{"events":{},"commands":[]}']) {
        await writeFile(filePath, text);
        await expect(readCanonicalReportCore(filePath)).rejects.toBeInstanceOf(SyntaxError);
      }
      await writeFile(filePath, `{"events":[{"extra":${"[".repeat(1024)}0${"]".repeat(1024)}}]}`);
      await expect(readCanonicalReportCore(filePath)).rejects.toThrow("JSON nesting limit");
    } finally {
      await removeTempDir(directory);
    }
  });
});
