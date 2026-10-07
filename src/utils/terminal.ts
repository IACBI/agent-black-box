// eslint-disable-next-line no-control-regex -- Identify terminal controls before displaying untrusted values.
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const CONTROL_CHARACTERS = new RegExp(CONTROL_PATTERN.source, "g");

/** Keep unusual values distinct from literal escape text, without emitting terminal controls. */
export function formatTerminalValue(value: string): string {
  if (!value.includes('"') && !value.includes("\\") && !CONTROL_PATTERN.test(value)) {
    return value;
  }
  return JSON.stringify(value).replace(CONTROL_CHARACTERS, escapeCodePoint);
}

/** Preserve report layout while making embedded terminal controls visible. */
export function escapeTerminalControls(value: string): string {
  return value.replace(CONTROL_CHARACTERS, (character) =>
    character === "\n" ? character : escapeCodePoint(character)
  );
}

export function renderPosixCommand(command: string, args: readonly string[]): string {
  const assignments: string[] = [];
  const quotedArgs = args.map((argument, index) => {
    if (!CONTROL_PATTERN.test(argument)) {
      return quoteShellText(argument);
    }
    const variable = `abb_arg_${index + 1}`;
    const escaped = argument
      .replace(/\\/g, "\\\\")
      .replace(CONTROL_CHARACTERS, (character) =>
        [...Buffer.from(character)].map((byte) => `\\0${byte.toString(8).padStart(3, "0")}`).join("")
      );
    // A sentinel prevents command substitution from stripping filename-ending newlines.
    assignments.push(`${variable}=$(printf '%b_' ${quoteShellText(escaped)})`);
    return `"\${${variable}%_}"`;
  });
  return [...assignments, `${command} ${quotedArgs.join(" ")}`].join("\n");
}

function quoteShellText(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeCodePoint(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}
