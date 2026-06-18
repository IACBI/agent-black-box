import { describe, expect, it } from "vitest";
import {
  buildWindowsCommandLine,
  formatCommand,
  normalizeCommandParts,
  redactCommandParts
} from "../src/commands/commandRecorder.js";

describe("command recorder", () => {
  it("redacts sensitive assignments and flags", () => {
    const tokenAssignment = ["API", "_TOKEN", "=", "plain", "-text", "-token"].join("");
    const passwordFlag = ["--pass", "word"].join("");
    const passwordValue = ["super", "-secret"].join("");
    const clientSecretFlag = ["--client", "-secret", "=another", "-secret"].join("");
    const parts = redactCommandParts([
      "deploy",
      tokenAssignment,
      passwordFlag,
      passwordValue,
      clientSecretFlag,
      "safe"
    ]);

    expect(parts).toEqual([
      "deploy",
      "API_TOKEN=<redacted>",
      "--password",
      "<redacted>",
      "--client-secret=<redacted>",
      "safe"
    ]);
    expect(parts.join(" ")).not.toContain(passwordValue);
    expect(parts.join(" ")).not.toContain("another-secret");
  });

  it("quotes command parts for readable reports", () => {
    expect(formatCommand(["pnpm", "test", "--", "name with spaces"])).toBe('pnpm test -- "name with spaces"');
  });

  it("strips a leading passthrough separator", () => {
    expect(normalizeCommandParts(["--", "node", "--version"])).toEqual(["node", "--version"]);
    expect(normalizeCommandParts(["node", "--version"])).toEqual(["node", "--version"]);
  });

  it("quotes Windows command-script arguments without enabling shell mode", () => {
    expect(buildWindowsCommandLine(["pnpm.cmd", "run", "name with spaces", "a&b"])).toBe(
      'pnpm.cmd run "name with spaces" a^&b'
    );
  });
});
