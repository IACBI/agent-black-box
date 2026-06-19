export function normalizeMarkdownText(value: string): string {
  let result = "";

  for (const character of value) {
    if (character === "\r" || character === "\n" || character === "\t" || isUnsafeControl(character)) {
      result += " ";
      continue;
    }

    result += character;
  }

  return result;
}

export function escapeMarkdownText(value: string): string {
  let result = "";

  for (const character of normalizeMarkdownText(value)) {
    switch (character) {
      case "\\":
      case "`":
      case "*":
      case "_":
      case "{":
      case "}":
      case "[":
      case "]":
      case "(":
      case ")":
      case "#":
      case "+":
      case "!":
      case "|":
        result += `\\${character}`;
        break;
      case "&":
        result += "&amp;";
        break;
      case "<":
        result += "&lt;";
        break;
      case ">":
        result += "&gt;";
        break;
      default:
        result += character;
        break;
    }
  }

  return result;
}

export function markdownInlineCode(value: string): string {
  const normalized = normalizeMarkdownText(value);
  const longestRun = longestBacktickRun(normalized);

  if (normalized.length === 0) {
    return "``";
  }

  if (longestRun === 0) {
    return `\`${normalized}\``;
  }

  const fence = "`".repeat(longestRun + 1);
  return `${fence} ${normalized} ${fence}`;
}

export function markdownTableCode(value: string): string {
  return `<code>${escapeHtmlForTable(normalizeMarkdownText(value))}</code>`;
}

export function escapeMarkdownTableCell(value: string): string {
  let result = "";

  for (const character of normalizeMarkdownText(value)) {
    switch (character) {
      case "\\":
      case "`":
      case "|":
      case "[":
      case "]":
        result += `\\${character}`;
        break;
      case "&":
        result += "&amp;";
        break;
      case "<":
        result += "&lt;";
        break;
      case ">":
        result += "&gt;";
        break;
      default:
        result += character;
        break;
    }
  }

  return result;
}

function escapeHtmlForTable(value: string): string {
  let result = "";

  for (const character of value) {
    switch (character) {
      case "&":
        result += "&amp;";
        break;
      case "<":
        result += "&lt;";
        break;
      case ">":
        result += "&gt;";
        break;
      case "|":
        result += "&#124;";
        break;
      case "`":
        result += "&#96;";
        break;
      default:
        result += character;
        break;
    }
  }

  return result;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;

  for (const character of value) {
    if (character === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

function isUnsafeControl(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
}
