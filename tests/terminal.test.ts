import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { escapeTerminalControls, formatTerminalValue, renderPosixCommand } from "../src/utils/terminal.js";

describe("terminal presentation", () => {
  it("preserves ordinary values and distinguishes controls from literal escape strings", () => {
    expect(formatTerminalValue("src/index.ts")).toBe("src/index.ts");
    const values = ["src/a\n.ts", "src/a\\n.ts", '"src/a\\n.ts"', "src/a\u001b[2J.ts", "src/a\\u001b[2J.ts"];
    const displayed = values.map(formatTerminalValue);
    expect(new Set(displayed).size).toBe(values.length);
    for (let index = 0; index < values.length; index++) {
      expect(JSON.parse(displayed[index])).toBe(values[index]);
    }
  });

  it("escapes C0/C1 controls and Unicode line separators while preserving report newlines", () => {
    const controls = "\u001b[2J\u009b31m\r\t\0\u2028\u2029";
    const formatted = formatTerminalValue(controls);
    expect(JSON.parse(formatted)).toBe(controls);
    expect(formatted).not.toContain("\u001b");
    expect(formatted).not.toContain("\u009b");
    expect(escapeTerminalControls(`one\n${controls}`)).toBe(
      "one\n\\u001b[2J\\u009b31m\\u000d\\u0009\\u0000\\u2028\\u2029"
    );
  });

  it("preserves ordinary command previews and escapes control-bearing arguments visibly", () => {
    expect(renderPosixCommand("git diff --", ["src/index.ts", "src/a'b.ts"])).toBe(
      "git diff -- 'src/index.ts' 'src/a'\\''b.ts'"
    );
    const preview = renderPosixCommand("git diff --", ["src/a\n.ts", "src/\u001b[2J.ts"]);
    expect(preview).toContain("abb_arg_1=$(printf '%b_' 'src/a\\0012.ts')");
    expect(preview).toContain("abb_arg_2=$(printf '%b_' 'src/\\0033[2J.ts')");
    expect(preview).toContain('git diff -- "${abb_arg_1%_}" "${abb_arg_2%_}"');
    expect(preview).not.toContain("\u001b");
  });

  it.skipIf(process.platform === "win32")(
    "round-trips POSIX arguments including trailing newlines and shell syntax",
    () => {
      const args = ["plain", "src/a\n.ts", "ends\n\n", "\u001b[2J", "a\\b\n", "a'$(echo injected)\n", "\u009b31m"];
      const command = renderPosixCommand("printf '%s\\0'", args);
      const output = execFileSync("sh", ["-c", command]);
      expect(output.toString("utf8").split("\0").slice(0, -1)).toEqual(args);
    }
  );
});
