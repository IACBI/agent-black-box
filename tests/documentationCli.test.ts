import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCli } from "./cliRunner.js";

interface CliCommand {
  path: string[];
  options: string[];
}

/** Walks `abb --help` and every command group's help, returning each command with its long options. */
async function readCliCommandTree(): Promise<CliCommand[]> {
  const commands: CliCommand[] = [];
  const visit = async (commandPath: string[]): Promise<void> => {
    const help = await runCli(process.cwd(), [...commandPath, "--help"]);
    expect(help.exitCode, `abb ${commandPath.join(" ")} --help`).toBe(0);
    const options = [...help.stdout.matchAll(/^\s+(?:-[A-Za-z], )?(--[a-z][a-z0-9-]*)/gm)].map(
      (match) => match[1] as string
    );
    if (commandPath.length > 0) {
      commands.push({ path: commandPath, options });
    }
    const lines = help.stdout.split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith("Commands:"));
    if (start === -1) {
      return;
    }
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "") {
        break;
      }
      const name = /^ {2}([a-z][a-z-]*)/.exec(line)?.[1];
      if (name && name !== "help") {
        await visit([...commandPath, name]);
      }
    }
  };
  await visit([]);
  return commands;
}

function isLeaf(command: CliCommand, all: readonly CliCommand[]): boolean {
  return !all.some(
    (other) =>
      other.path.length > command.path.length && command.path.every((part, index) => other.path[index] === part)
  );
}

describe("documentation matches the compiled CLI", () => {
  it("documents every command in the usage guide and both README sections, and every long option in the usage guide", async () => {
    const [usage, readme, commands] = await Promise.all([
      readFile("docs/USAGE.md", "utf8"),
      readFile("README.md", "utf8"),
      readCliCommandTree(),
    ]);
    const leaves = commands.filter((command) => isLeaf(command, commands));

    expect(leaves.map((command) => command.path.join(" "))).toEqual(
      expect.arrayContaining([
        "init",
        "analyze",
        "export",
        "pr-comment",
        "hook install",
        "hook uninstall",
        "hook status",
        "sessions archive",
        "sessions verify",
      ])
    );

    const turkishStart = readme.indexOf('<a id="turkce"></a>');
    expect(turkishStart).toBeGreaterThan(0);
    for (const command of leaves) {
      const invocation = `abb ${command.path.join(" ")}`;
      expect(usage, `docs/USAGE.md is missing ${invocation}`).toContain(invocation);
      expect(readme.slice(0, turkishStart), `English README is missing ${invocation}`).toContain(invocation);
      expect(readme.slice(turkishStart), `Turkish README is missing ${invocation}`).toContain(invocation);
    }

    const undocumented = commands
      .flatMap((command) => command.options.map((option) => ({ command: command.path.join(" "), option })))
      .filter(({ option }) => option !== "--help" && option !== "--version" && !usage.includes(option));
    expect(undocumented).toEqual([]);
  }, 120_000);
});
