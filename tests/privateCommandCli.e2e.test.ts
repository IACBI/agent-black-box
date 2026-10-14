import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { createSession, readCommandEvents } from "../src/session/sessionManager.js";
import { runCli } from "./cliRunner.js";
import { createTempDir, initGitRepo, removeTempDir } from "./testUtils.js";

describe("private command CLI", () => {
  it("withholds arbitrary command metadata and preserves original execution and failure status", async () => {
    const repo = await createTempDir("abb-private-command-");
    try {
      initGitRepo(repo);
      const session = await createSession(repo, DEFAULT_CONFIG);
      await mkdir(path.join(repo, "work"));
      const values = ["unknown-synthetic-material", "split", "opaque", "ZW5jb2RlZC1zeW50aGV0aWM="];
      const script =
        "require('node:fs').writeFileSync('received.json',JSON.stringify(process.argv.slice(1)));process.exit(6)";
      const result = await runCli(repo, [
        "run",
        "--private",
        "--cwd",
        "work",
        "--label",
        values[0]!,
        "--group",
        values[1]!,
        "--phase",
        values[3]!,
        "--",
        process.execPath,
        "-e",
        script,
        ...values,
      ]);
      expect(result.exitCode).toBe(6);
      expect(JSON.parse(await readFile(path.join(repo, "work", "received.json"), "utf8"))).toEqual(values);
      const [event] = await readCommandEvents(session.sessionDir);
      expect(event).toMatchObject({ command: "<redacted>", cwd: "work", exitCode: 6 });
      for (const field of ["label", "group", "phase"]) expect(event).not.toHaveProperty(field);
      const persisted = await readFile(path.join(session.sessionDir, "commands.ndjson"), "utf8");
      for (const value of values) expect(persisted).not.toContain(value);
    } finally {
      await removeTempDir(repo);
    }
  });
});
